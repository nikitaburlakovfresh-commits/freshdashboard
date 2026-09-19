// Фокусы внимания месяца: ровно 5 слотов, настраиваются внутри портала.
// План слота задаётся вручную и историчен; отсутствие плана не равно нулю.
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from '../domain/accessChanges';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { ApiError } from '../util/errors';

const invalid = (s: string) => new ApiError('VALIDATION_ERROR', s);
export const FOCUS_SLOT_COUNT = 5;
const isDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};
const isMonth = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d\d-01$/.test(v) && isDate(v);

export interface FocusSlot {
  slot: number; metric_code: string; label: string;
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
  format: 'COUNT' | 'PCT' | 'RUB' | 'RUB_MLN';
  plan: number | null; requires_vin_level: boolean; requires_daily_logs: boolean;
}
export interface FocusConfiguration {
  id: string; month: string; effective_from: string; effective_to: string | null;
  reason: string; slots: FocusSlot[];
}

/** Действующая на дату конфигурация фокусов месяца среза. */
export async function resolveFocusConfiguration(c: PoolClient, on: string): Promise<FocusConfiguration | null> {
  if (!isDate(on)) throw invalid('Дата среза указана неверно.');
  const month = `${on.slice(0, 7)}-01`;
  const row = (await c.query(`SELECT id,to_char(month,'YYYY-MM-DD') AS "month",
    to_char(effective_from,'YYYY-MM-DD') effective_from,to_char(effective_to,'YYYY-MM-DD') effective_to,reason
    FROM focus_configurations WHERE month=$1::date AND effective_from<=$2
      AND (effective_to IS NULL OR effective_to>$2)`, [month, on])).rows[0];
  if (!row) return null;
  const slots = (await c.query(`SELECT s.slot,s.metric_code,s.plan::text plan,
    k.label,k.direction,k.format,k.requires_vin_level,k.requires_daily_logs
    FROM focus_slots s JOIN focus_metric_catalog k ON k.code=s.metric_code
    WHERE s.configuration_id=$1 ORDER BY s.slot`, [row.id])).rows;
  return {
    ...row,
    slots: slots.map((s: any) => ({ ...s, slot: Number(s.slot), plan: s.plan === null ? null : Number(s.plan) })),
  };
}

export async function listFocusCatalog(auth: AuthedUser, query: any) {
  if (Object.keys(query ?? {}).some(k => !['month', 'history'].includes(k)))
    throw invalid('Фильтры настройки фокусов не принимаются.');
  const history = query?.history === 'true';
  if (query?.month !== undefined && !isMonth(query.month))
    throw invalid('Месяц указывается первым днём в формате ГГГГ-ММ-01.');
  return withTransaction(async c => {
    await authorizeNetworkPermissions(c, auth, ['metric.focus.manage']);
    const catalog = (await c.query(`SELECT code,label,direction,format,default_plan::text default_plan,
      requires_vin_level,requires_daily_logs FROM focus_metric_catalog ORDER BY sort_order`)).rows;
    const configurations = (await c.query(`SELECT c.id,to_char(c.month,'YYYY-MM-DD') AS "month",
      to_char(c.effective_from,'YYYY-MM-DD') effective_from,to_char(c.effective_to,'YYYY-MM-DD') effective_to,
      c.reason,c.created_at,
      COALESCE(jsonb_agg(jsonb_build_object('slot',s.slot,'metric_code',s.metric_code,'plan',s.plan)
        ORDER BY s.slot) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) slots
      FROM focus_configurations c LEFT JOIN focus_slots s ON s.configuration_id=c.id
      WHERE ($1::date IS NULL OR c.month=$1::date) AND ($2 OR c.effective_to IS NULL)
      GROUP BY c.id ORDER BY c.month DESC,c.effective_from DESC LIMIT 201`,
    [query?.month ?? null, history])).rows;
    return { slot_count: FOCUS_SLOT_COUNT, catalog, configurations, history };
  });
}

interface Command { month: string; effective_from: string; reason: string; slots: { slot: number; metric_code: string; plan: number | null }[] }
function parse(raw: any): Command {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(k => !['month', 'effective_from', 'reason', 'slots'].includes(k)))
    throw invalid('Передайте только поля настройки фокусов.');
  if (!isMonth(raw.month)) throw invalid('Месяц указывается первым днём в формате ГГГГ-ММ-01.');
  if (!isDate(raw.effective_from)) throw invalid('Укажите дату вступления в силу в формате ГГГГ-ММ-ДД.');
  if (typeof raw.reason !== 'string' || raw.reason.trim().length < 16 || raw.reason.length > 500)
    throw invalid('Укажите основание изменения фокусов (16–500 символов).');
  if (!Array.isArray(raw.slots) || raw.slots.length !== FOCUS_SLOT_COUNT)
    throw invalid(`Фокусов внимания должно быть ровно ${FOCUS_SLOT_COUNT}.`);
  const slots: Command['slots'] = [];
  const seenSlot = new Set<number>(), seenMetric = new Set<string>();
  for (const s of raw.slots) {
    if (!s || typeof s !== 'object' || Array.isArray(s)
      || Object.keys(s).some(k => !['slot', 'metric_code', 'plan'].includes(k)))
      throw invalid('Передайте только поля слота фокуса.');
    if (!Number.isInteger(s.slot) || s.slot < 1 || s.slot > FOCUS_SLOT_COUNT)
      throw invalid(`Номер слота — целое число от 1 до ${FOCUS_SLOT_COUNT}.`);
    if (seenSlot.has(s.slot)) throw invalid('Номер слота указан дважды.');
    seenSlot.add(s.slot);
    if (typeof s.metric_code !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(s.metric_code))
      throw invalid('Показатель фокуса выбирается из каталога фокусов.');
    if (seenMetric.has(s.metric_code)) throw invalid('Один показатель нельзя поставить в два слота.');
    seenMetric.add(s.metric_code);
    const plan = s.plan ?? null;
    if (plan !== null && (!Number.isFinite(plan) || plan < 0)) throw invalid('План слота — неотрицательное число или отсутствует.');
    slots.push({ slot: s.slot, metric_code: s.metric_code, plan });
  }
  return { month: raw.month, effective_from: raw.effective_from, reason: raw.reason.trim(), slots };
}

/** Новая версия фокусов месяца. Предыдущая закрывается датой вступления в силу новой. */
export async function setFocusConfiguration(auth: AuthedUser, body: any, requestId: string) {
  const cmd = parse(body);
  return withTransaction(async c => {
    await authorizeNetworkPermissions(c, auth, ['metric.focus.manage']);
    await c.query('LOCK TABLE focus_configurations, focus_slots IN SHARE ROW EXCLUSIVE MODE');
    const known = (await c.query('SELECT code FROM focus_metric_catalog WHERE code=ANY($1::text[])',
      [cmd.slots.map(s => s.metric_code)])).rows.map((r: any) => r.code);
    const unknown = cmd.slots.map(s => s.metric_code).filter(code => !known.includes(code));
    if (unknown.length) throw new ApiError('NOT_FOUND', `Показатель фокуса отсутствует в каталоге: ${unknown.join(', ')}.`);
    const previous = (await c.query(`SELECT id,to_char(effective_from,'YYYY-MM-DD') effective_from
      FROM focus_configurations WHERE month=$1::date AND effective_to IS NULL`, [cmd.month])).rows[0] ?? null;
    if (previous && previous.effective_from >= cmd.effective_from)
      throw invalid('Дата вступления в силу должна быть позже текущей версии фокусов месяца.');
    const id = randomUUID();
    const audit = await writeAuditAndOutbox(c, {
      actorUserId: auth.userId, actorRole: null, orgUnitId: null, workItemId: null,
      action: 'metric.focus.set', aggregateType: 'metric_focus', aggregateId: id, aggregateVersion: 1,
      requestId, beforeState: previous, afterState: { id, month: cmd.month, slots: cmd.slots },
      reason: cmd.reason, resolution: 'APPLIED', retentionClass: 'SECURITY_5Y',
      eventType: 'metric.focus.changed', payload: { month: cmd.month, effective_from: cmd.effective_from },
    });
    if (previous) await c.query('UPDATE focus_configurations SET effective_to=$2 WHERE id=$1', [previous.id, cmd.effective_from]);
    await c.query(`INSERT INTO focus_configurations(id,month,effective_from,reason,created_by,audit_id)
      VALUES($1,$2::date,$3,$4,$5,$6)`, [id, cmd.month, cmd.effective_from, cmd.reason, auth.userId, audit]);
    for (const s of cmd.slots)
      await c.query('INSERT INTO focus_slots(id,configuration_id,slot,metric_code,plan) VALUES($1,$2,$3,$4,$5)',
        [randomUUID(), id, s.slot, s.metric_code, s.plan]);
    return { id, previous_id: previous?.id ?? null, audit_id: audit, month: cmd.month, effective_from: cmd.effective_from };
  });
}
