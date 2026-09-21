import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import type { ActorContext } from './workItemService';
import { getEffectiveGrants } from './grants';
import { writeAuditAndOutbox } from './auditOutbox';

/**
 * Панели управления отделами: ОП, ОО и КСО.
 *
 * Разделение ответственности жёсткое и намеренное:
 *   — сотрудник вводит ТОЛЬКО свои факты и видит ТОЛЬКО свою строку;
 *   — руководитель отдела ставит планы своим людям и видит всю панель;
 *   — производные величины считает портал и никогда не принимает вводом.
 *
 * Панели устроены по сотруднику, а публикуемые показатели QLIK — по филиалу.
 * Поэтому здесь нет и не может быть автозаполнения из опубликованных фактов:
 * агрегат филиала не является фактом конкретного менеджера, и подставлять его
 * в чужую строку нельзя.
 */
export const PANELS = {
  OP: { fillers: ['MOP', 'SMOP'], managers: ['ROP'], title: 'Панель отдела продаж' },
  OO: { fillers: ['EO', 'SMOO'], managers: ['ROO'], title: 'Панель отдела оценки' },
  KSO: { fillers: ['KSO_STAFF'], managers: ['RKSO'], title: 'Панель КСО' },
} as const;
export type PanelCode = keyof typeof PANELS;

const CHANNELS = ['BUYOUT', 'COMMISSION', 'TRADE_IN', 'TRADE_UP', 'BROKER'] as const;
export const CHANNEL_TITLES: Record<string, string> = {
  BUYOUT: 'Выкуп', COMMISSION: 'Комиссия', TRADE_IN: 'Trade-in',
  TRADE_UP: 'Trade-up', BROKER: 'Брокерские',
};

export function panelCode(raw: unknown): PanelCode {
  if (typeof raw !== 'string' || !(raw in PANELS))
    throw new ApiError('VALIDATION_ERROR', 'Панель не распознана: ожидается ОП, ОО или КСО.');
  return raw as PanelCode;
}

/** Период панели — календарный месяц. */
export function panelMonth(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}$/.test(raw))
    throw new ApiError('VALIDATION_ERROR', 'Период панели задаётся месяцем в виде ГГГГ-ММ.');
  return `${raw}-01`;
}

interface Access { fill: boolean; manage: boolean; roles: string[] }

/**
 * Что человек может делать с панелью этого филиала. Региональный менеджер
 * филиала управляет панелью наравне с руководителем отдела: он и ставит задачи
 * по её отклонениям.
 */
async function access(c: PoolClient, ctx: ActorContext, org: string, panel: PanelCode): Promise<Access> {
  const grants = await getEffectiveGrants(c, ctx.authUser.userId);
  const here = grants.filter(g => g.orgUnitId === org).map(g => g.role);
  const network = grants.filter(g => !g.orgUnitId).map(g => g.role);
  const spec = PANELS[panel];
  const manage = here.some(r => (spec.managers as readonly string[]).includes(r)
      || r === 'REGIONAL_MANAGER' || r === 'RF' || r === 'BH')
    || network.some(r => ['SUPER_ADMIN', 'COMMERCIAL_DIRECTOR', 'DIVISION_MANAGER'].includes(r));
  const fill = here.some(r => (spec.fillers as readonly string[]).includes(r));
  if (!manage && !fill) throw new ApiError('NOT_FOUND', 'Панель или филиал недоступны.');
  return { fill, manage, roles: here };
}

async function catalog(c: PoolClient, panel: PanelCode) {
  return (await c.query(
    `SELECT code,display_name,unit,kind,op,operands,formula_text,by_channel,sort_order
       FROM dept_panel_metrics WHERE panel_code=$1 ORDER BY sort_order`, [panel])).rows;
}

type Cell = number | null;
const key = (metric: string, channel: string | null) => `${metric}|${channel ?? 'ALL'}`;

/**
 * Достраивает производные величины над введёнными.
 *
 * Деление на ноль и на отсутствующую величину даёт «нет значения», а не ноль:
 * отсутствие данных — это не нулевой результат работы. По этой же причине
 * сумма, у которой нет ни одного слагаемого, остаётся пустой.
 */
export function computeCells(rows: any[], entered: Map<string, Cell>): Map<string, Cell> {
  const out = new Map(entered);
  const byCode = new Map(rows.map(r => [r.code, r]));
  const resolve = (code: string, channel: string | null, seen: Set<string>): Cell => {
    const k = key(code, channel);
    if (out.has(k)) return out.get(k)!;
    const def = byCode.get(code);
    if (!def || def.kind !== 'COMPUTED') return null;
    if (seen.has(k)) return null;               // ссылка на себя — не считаем
    seen.add(k);
    const parts = (def.operands as string[]).map(o => {
      const operand = byCode.get(o);
      // Показатель без разреза, использованный в канальном расчёте, берётся целиком.
      const ch = operand?.by_channel ? channel : null;
      return resolve(o, ch, seen);
    });
    let value: Cell = null;
    if (def.op === 'SUM') {
      const known = parts.filter((p): p is number => p != null);
      value = known.length ? known.reduce((a, b) => a + b, 0) : null;
    } else if (def.op === 'AVG') {
      const known = parts.filter((p): p is number => p != null);
      value = known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
    } else if (def.op === 'DIFF') {
      value = parts[0] != null && parts[1] != null ? parts[0] - parts[1] : null;
    } else if (def.op === 'RATIO') {
      value = parts[0] != null && parts[1] != null && parts[1] !== 0 ? parts[0] / parts[1] : null;
    }
    out.set(k, value);
    return value;
  };
  for (const r of rows) {
    if (r.kind !== 'COMPUTED') continue;
    if (r.by_channel) for (const ch of CHANNELS) resolve(r.code, ch, new Set());
    resolve(r.code, null, new Set());
  }
  return out;
}

/** Панель за месяц: строки сотрудников, их значения и итог отдела. */
export async function getPanel(ctx: ActorContext, org: string, panelRaw: unknown, monthRaw: unknown) {
  const panel = panelCode(panelRaw), month = panelMonth(monthRaw);
  return withTransaction(async c => {
    const acc = await access(c, ctx, org, panel);
    const metrics = await catalog(c, panel);
    // Руководитель видит весь отдел, сотрудник — только себя. Это не фильтр
    // отображения, а граница выборки: чужие строки не покидают базу.
    const staff = (await c.query(
      `SELECT DISTINCT u.id, u.full_name, g.role_code
         FROM role_grants g JOIN app_users u ON u.id=g.user_id
        WHERE g.org_unit_id=$1 AND g.revoked_at IS NULL AND g.role_code = ANY($2)
          AND u.is_active AND ($3::boolean OR u.id=$4)
        ORDER BY u.full_name`,
      [org, [...PANELS[panel].fillers], acc.manage, ctx.authUser.userId])).rows;
    const values = (await c.query(
      `SELECT user_id,metric_code,channel,value FROM dept_panel_values
        WHERE org_unit_id=$1 AND panel_code=$2 AND period_month=$3
          AND ($4::boolean OR user_id=$5)`,
      [org, panel, month, acc.manage, ctx.authUser.userId])).rows;
    const grades = (await c.query(
      `SELECT user_id,grade FROM dept_panel_grades
        WHERE org_unit_id=$1 AND panel_code=$2 AND period_month=$3`, [org, panel, month])).rows;

    const people = staff.map((person: any) => {
      const entered = new Map<string, Cell>();
      for (const v of values.filter((v: any) => v.user_id === person.id))
        entered.set(key(v.metric_code, v.channel), Number(v.value));
      const cells = computeCells(metrics, entered);
      return {
        user_id: person.id, full_name: person.full_name, role_code: person.role_code,
        grade: grades.find((g: any) => g.user_id === person.id)?.grade ?? null,
        cells: Object.fromEntries(cells),
      };
    });

    // Итог отдела: вводимые величины складываются, производные пересчитываются
    // от сложенных. Складывать доли и конверсии сотрудников нельзя — среднее из
    // процентов не равно проценту от суммы.
    const totalEntered = new Map<string, Cell>();
    for (const m of metrics) {
      if (m.kind === 'COMPUTED' || m.unit === 'PCT') continue;
      for (const ch of m.by_channel ? [...CHANNELS, null] : [null]) {
        const k = key(m.code, ch);
        const known = people.map(p => p.cells[k]).filter((v): v is number => v != null);
        if (known.length) totalEntered.set(k, known.reduce((a, b) => a + b, 0));
      }
    }
    const total = Object.fromEntries(computeCells(metrics, totalEntered));

    return {
      panel, period_month: month.slice(0, 7), title: PANELS[panel].title,
      can_fill: acc.fill, can_manage: acc.manage,
      channels: CHANNELS.map(code => ({ code, title: CHANNEL_TITLES[code] })),
      metrics: metrics.map((m: any) => ({
        code: m.code, name: m.display_name, unit: m.unit, kind: m.kind,
        formula: m.formula_text, by_channel: m.by_channel,
        // Кто вправе вводить именно этот показатель — решает вид, а не экран.
        editable_by: m.kind === 'PLAN' ? 'MANAGER' : m.kind === 'FACT' ? 'STAFF' : 'NONE',
      })),
      people, total,
    };
  });
}

/**
 * Ввод величины. Факт вводит только сам сотрудник за себя, план — только
 * руководитель. Производную величину не вводит никто: она считается.
 */
export async function setPanelValue(ctx: ActorContext, body: any) {
  const panel = panelCode(body?.panel), month = panelMonth(body?.period_month);
  const org = String(body?.org_unit_id ?? ''), metric = String(body?.metric_code ?? '');
  const target = String(body?.user_id ?? ctx.authUser.userId);
  const channel = body?.channel == null ? null : String(body.channel);
  if (channel != null && !CHANNELS.includes(channel as any))
    throw new ApiError('VALIDATION_ERROR', 'Канал поставки не распознан.');
  const value = Number(body?.value);
  if (!Number.isFinite(value)) throw new ApiError('VALIDATION_ERROR', 'Значение должно быть числом.');

  return withTransaction(async c => {
    const acc = await access(c, ctx, org, panel);
    const def = (await c.query(
      `SELECT code,kind,unit,by_channel FROM dept_panel_metrics WHERE code=$1 AND panel_code=$2`,
      [metric, panel])).rows[0];
    if (!def) throw new ApiError('NOT_FOUND', 'Показатель не входит в эту панель.');
    if (def.kind === 'COMPUTED')
      throw new ApiError('VALIDATION_ERROR',
        'Эта величина рассчитывается порталом и вводу не подлежит — измените величины, из которых она считается.');
    if (def.by_channel && channel == null)
      throw new ApiError('VALIDATION_ERROR', 'Для этого показателя нужен канал поставки.');
    if (!def.by_channel && channel != null)
      throw new ApiError('VALIDATION_ERROR', 'Этот показатель не разрезается по каналам поставки.');
    if (def.kind === 'PLAN' && !acc.manage)
      throw new ApiError('FORBIDDEN', 'План ставит руководитель отдела.');
    if (def.kind === 'FACT' && target !== ctx.authUser.userId)
      throw new ApiError('FORBIDDEN', 'Свои факты сотрудник вводит сам: за другого их вписать нельзя.');
    if (def.kind === 'FACT' && !acc.fill)
      throw new ApiError('FORBIDDEN', 'Ввод фактов доступен сотруднику отдела.');
    if (value < 0) throw new ApiError('VALIDATION_ERROR', 'Отрицательное значение не принимается.');

    const before = (await c.query(
      `SELECT id,value FROM dept_panel_values
        WHERE org_unit_id=$1 AND panel_code=$2 AND period_month=$3 AND user_id=$4
          AND metric_code=$5 AND coalesce(channel,'ALL')=coalesce($6,'ALL')`,
      [org, panel, month, target, metric, channel])).rows[0] ?? null;
    const saved = (await c.query(
      `INSERT INTO dept_panel_values(org_unit_id,panel_code,period_month,user_id,metric_code,channel,value,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (org_unit_id,panel_code,period_month,user_id,metric_code,coalesce(channel,'ALL'))
       DO UPDATE SET value=EXCLUDED.value,updated_by=EXCLUDED.updated_by,updated_at=now()
       RETURNING id`,
      [org, panel, month, target, metric, channel, value, ctx.authUser.userId])).rows[0];
    await c.query(
      `INSERT INTO dept_panel_value_history(value_id,old_value,new_value,changed_by,reason)
       VALUES($1,$2,$3,$4,$5)`,
      [saved.id, before?.value ?? null, value, ctx.authUser.userId,
        typeof body?.reason === 'string' ? body.reason.slice(0, 500) : null]);
    await writeAuditAndOutbox(c, {
      actorUserId: ctx.authUser.userId, actorRole: acc.roles[0] ?? 'UNKNOWN', orgUnitId: org,
      workItemId: null,
      action: before ? 'UPDATE' : 'CREATE', aggregateType: 'dept_panel_value',
      aggregateId: saved.id, aggregateVersion: 1, requestId: ctx.requestId,
      beforeState: before ? { value: Number(before.value) } : null,
      afterState: { panel, period_month: month, metric, channel, value, user_id: target },
      resolution: 'APPLIED', retentionClass: 'WORK_ITEM_STANDARD',
      eventType: 'dept_panel.value.set', payload: { panel, metric },
    });
    return { id: saved.id, value };
  });
}

/**
 * Категория сотрудника. В рабочей таблице она проставлена руками и формулы не
 * имеет, поэтому здесь это тоже решение руководителя, а не расчёт: выводить
 * категорию из рейтинга самостоятельно означало бы выдумать правило.
 */
export async function setPanelGrade(ctx: ActorContext, body: any) {
  const panel = panelCode(body?.panel), month = panelMonth(body?.period_month);
  const org = String(body?.org_unit_id ?? ''), target = String(body?.user_id ?? '');
  const grade = String(body?.grade ?? '');
  if (!['A', 'B', 'C'].includes(grade))
    throw new ApiError('VALIDATION_ERROR', 'Категория принимает значения А, В или С.');
  return withTransaction(async c => {
    const acc = await access(c, ctx, org, panel);
    if (!acc.manage) throw new ApiError('FORBIDDEN', 'Категорию ставит руководитель отдела.');
    await c.query(
      `INSERT INTO dept_panel_grades(org_unit_id,panel_code,period_month,user_id,grade,set_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_unit_id,panel_code,period_month,user_id)
       DO UPDATE SET grade=EXCLUDED.grade,set_by=EXCLUDED.set_by,set_at=now()`,
      [org, panel, month, target, grade, ctx.authUser.userId]);
    return { user_id: target, grade };
  });
}
