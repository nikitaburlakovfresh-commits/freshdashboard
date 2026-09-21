import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import type { AuthedUser } from '../auth/session';
import { factAccess } from '../reporting/factAccess';
import { resolveEffectivePeriod } from '../metrics/effectivePeriod';
import { aged45, type AgedScope, type AgedMeasure } from '../metrics/derived';

/**
 * МБО регионального менеджера.
 *
 * Разбор старого модуля (/opt/fresh-dashboard-src/mbo/server.cjs) показал две
 * вещи, которые здесь сделаны иначе.
 *
 * 1. Там МБО держало СВОЮ таблицу задач mbo_tasks, а основной дашборд — свою
 *    branch_tasks. Руководитель филиала видел два независимых списка, и ни один
 *    не был полным. Здесь задача одна — work_items, а МБО только ссылается на
 *    неё. Закрыли задачу в филиале — она закрыта и в МБО.
 *
 * 2. Там факт KPI записывался в строку mbo_kpi при каждом открытии карточки
 *    (fact_source становился 'bi'). После перезагрузки отчёта карточка и
 *    отчётность расходились, и у одного периода оказывалось два факта. Здесь
 *    факт не хранится: он считается из опубликованных показателей при чтении, и
 *    карточка всегда совпадает с отчётностью. Ручной факт возможен, но только
 *    объявленный явно, с комментарием об источнике.
 *
 * Отсутствие данных не равно нулю: невычислимый факт возвращается как null с
 * указанием причины, а не нулём.
 */

export type Horizon = 'MONTH' | 'YEAR';

export interface MboKpiRow {
  id: string; horizon: Horizon; org_unit_id: string | null; org_unit_name: string | null;
  kpi_code: string; kpi_name: string; unit: string; weight: number | null;
  plan_value: number | null; fact_value: number | null;
  fact_source: 'PUBLISHED' | 'MANUAL'; fact_basis: string;
  manual_fact_comment: string | null; completion_pct: number | null;
  direction: 'HIGHER_IS_BETTER' | 'LOWER_IS_BETTER';
}

/** Месяц периода как дата первого числа: в карточке период хранится датой. */
function monthStart(period: string): string {
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(period))
    throw new ApiError('VALIDATION_ERROR', 'Период МБО указывается как YYYY-MM.');
  return `${period.slice(0, 7)}-01`;
}

function monthEnd(monthFirst: string): string {
  const [y, m] = monthFirst.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${monthFirst.slice(0, 7)}-${String(last).padStart(2, '0')}`;
}

/**
 * Зона ответственности сотрудника на дату: филиалы кластеров, где у него есть
 * действующее назначение регионального менеджера.
 *
 * Берётся на дату, а не «сейчас»: перевод филиала к другому РМ не должен задним
 * числом менять уже согласованное МБО прошлого периода.
 */
export async function mboZoneBranches(c: PoolClient, subjectUserId: string, on: string) {
  // Подчинённость филиала зоне лежит в истории привязок, а название — в истории
  // названий: в самом справочнике колонки display_name нет, и обе истории
  // читаются на дату, иначе переименование или перевод филиала задним числом
  // изменит уже согласованное МБО.
  return (await c.query(
    `SELECT DISTINCT u.id,n.display_name
       FROM role_grants g
       JOIN org_directory_affiliation_history a ON a.parent_id=g.org_unit_id
         AND $2::date >= a.effective_from AND (a.effective_to IS NULL OR $2::date < a.effective_to)
       JOIN org_directory_units u ON u.id=a.org_unit_id
       LEFT JOIN org_directory_name_history n ON n.org_unit_id=u.id
         AND $2::date >= n.effective_from AND (n.effective_to IS NULL OR $2::date < n.effective_to)
      WHERE g.user_id=$1 AND g.role_code='REGIONAL_MANAGER' AND g.revoked_at IS NULL
        AND g.valid_from<=$2::date AND (g.valid_until IS NULL OR g.valid_until>$2::date)
        AND u.kind='ORG_UNIT' AND u.lifecycle_state='ACTIVE'
        AND $2::date >= u.effective_from AND (u.effective_to IS NULL OR $2::date < u.effective_to)
      ORDER BY n.display_name`, [subjectUserId, on])).rows as { id: string; display_name: string }[];
}

/**
 * Факт KPI из опубликованных показателей.
 *
 * За месяц берётся последний опубликованный период месяца — тот же выбор, что и
 * на остальных экранах, иначе МБО и сводка назовут разные числа за один период.
 * За год показатели месяцев складываются или усредняются по правилу шаблона: у
 * штук и рублей осмысленна сумма, у процентов и коэффициентов — среднее.
 */
/**
 * Висяки 45+ считаются не из загружаемого отчёта, а из реестра VIN: у каждой
 * машины известен тип поставки, срок хранения и себестоимость. Поэтому область
 * (выкуп, комиссия, весь склад) и мера (штуки, себестоимость) — это разные
 * показатели, а не один. Коды вариантов объявлены в справочнике aged45_variants.
 */
async function aged45Fact(
  c: PoolClient, orgUnits: string[], code: string, on: string,
): Promise<{ value: number | null; basis: string } | null> {
  const row = (await c.query(
    'SELECT scope,measure FROM aged45_variants WHERE code=$1', [code])).rows[0] as
    { scope: AgedScope; measure: AgedMeasure } | undefined;
  if (!row) return null;
  const byBranch = await aged45(c, orgUnits, on, row.scope);
  if (!byBranch.size) return { value: null, basis: 'NO_VIN_REGISTRY_SNAPSHOT' };
  // Доля по зоне считается от сложенных величин, а не средним по филиалам:
  // филиал с большим складом должен влиять на зону сильнее.
  let aged = 0, total = 0, known = false;
  for (const b of byBranch.values()) {
    if (row.measure === 'COST') {
      if (b.aged_cost === null || b.total_cost === null) continue;
      aged += b.aged_cost; total += b.total_cost; known = true;
    } else { aged += b.aged; total += b.total; known = true; }
  }
  if (!known || !total) return { value: null,
    basis: row.measure === 'COST' ? 'NO_COST_IN_VIN_REGISTRY' : 'NO_STOCK_IN_SCOPE' };
  return { value: aged / total * 100, basis: `VIN_REGISTRY_${row.scope}_${row.measure}` };
}

async function publishedFact(
  c: PoolClient, orgUnits: string[], metric: string, base: string | null,
  ratioAsPercent: boolean, horizon: Horizon, monthFirst: string, aggregation: string,
): Promise<{ value: number | null; basis: string }> {
  if (!orgUnits.length) return { value: null, basis: 'NO_ORG_UNITS_IN_ZONE' };
  const months = horizon === 'MONTH' ? [monthFirst]
    : Array.from({ length: Number(monthFirst.slice(5, 7)) }, (_, i) =>
      `${monthFirst.slice(0, 4)}-${String(i + 1).padStart(2, '0')}-01`);
  const values: number[] = [];
  for (const m of months) {
    const period = await resolveEffectivePeriod(c, m, monthEnd(m), orgUnits);
    if (!period) continue;
    const sums = (await c.query(
      `SELECT s.metric,SUM(s.value)::float8 total,COUNT(*)::int units
         FROM report_fact_snapshots s JOIN report_fact_current p ON p.snapshot_id=s.id
        WHERE s.org_unit_id=ANY($1::uuid[]) AND s.period_start=$2 AND s.period_end=$3
          AND s.metric=ANY($4::text[])
        GROUP BY s.metric`,
      [orgUnits, period.start, period.end, base ? [metric, base] : [metric]])).rows as
      { metric: string; total: number; units: number }[];
    const main = sums.find(r => r.metric === metric);
    if (!main) continue;
    if (!base) { values.push(main.total); continue; }
    const div = sums.find(r => r.metric === base);
    // Делить на ноль или на отсутствующий знаменатель нельзя: доля остаётся
    // неопределённой, а не нулевой.
    if (!div || !div.total) continue;
    values.push(main.total / div.total * (ratioAsPercent ? 100 : 1));
  }
  if (!values.length) return { value: null, basis: 'NO_PUBLISHED_FACT' };
  if (horizon === 'MONTH') return { value: values[0], basis: 'PUBLISHED' };
  if (aggregation === 'AVERAGE')
    return { value: values.reduce((s, v) => s + v, 0) / values.length, basis: 'PUBLISHED_YEAR_AVERAGE' };
  if (aggregation === 'LAST') return { value: values[values.length - 1], basis: 'PUBLISHED_YEAR_LAST' };
  return { value: values.reduce((s, v) => s + v, 0), basis: 'PUBLISHED_YEAR_SUM' };
}

/** Процент выполнения с учётом направления: у висяков и оборачиваемости лучше меньше. */
function completion(plan: number | null, fact: number | null, direction: string): number | null {
  if (plan === null || fact === null || plan === 0) return null;
  return direction === 'LOWER_IS_BETTER' ? plan / fact * 100 : fact / plan * 100;
}

/**
 * Право видеть и править карточку. Свою карточку сотрудник видит всегда;
 * чужую — тот, у кого есть доступ к показателям филиалов её зоны. Отдельной
 * роли «смотрящий МБО» не вводится: область видимости уже определена грантами.
 */
async function authorizeCard(
  c: PoolClient, auth: AuthedUser, subjectUserId: string, on: string,
): Promise<{ own: boolean; can_edit_plan: boolean }> {
  if (subjectUserId === auth.userId) return { own: true, can_edit_plan: false };
  const zone = await mboZoneBranches(c, subjectUserId, on);
  const grants = await factAccess(c, auth, 'READ');
  // Гранты без конкретного филиала (сеть, дивизион) сюда не годятся:
  // зона МБО сверяется по филиалам.
  const allowed = new Set(grants.map(g => g.org_unit_id).filter((v): v is string => !!v));
  const overlap = zone.filter(b => allowed.has(b.id));
  if (!overlap.length)
    throw new ApiError('FORBIDDEN', 'Нет доступа к МБО этого сотрудника: его филиалы вне вашей области видимости.');
  // План ставит руководитель, а не сам сотрудник: иначе согласование МБО теряет
  // смысл. Поэтому правка плана доступна тому, кто смотрит чужую карточку и
  // видит всю её зону.
  return { own: false, can_edit_plan: overlap.length === zone.length };
}

export async function ensureMboCard(auth: AuthedUser, subjectUserId: string, period: string) {
  const monthFirst = monthStart(period);
  return withTransaction(async c => {
    const access = await authorizeCard(c, auth, subjectUserId, monthEnd(monthFirst));
    const existing = (await c.query(
      'SELECT id FROM mbo_cards WHERE subject_user_id=$1 AND period_start=$2',
      [subjectUserId, monthFirst])).rows[0];
    if (existing) return { status: 200, body: { card_id: existing.id, created: false } };
    if (!access.own && !access.can_edit_plan)
      throw new ApiError('FORBIDDEN', 'Создать карточку МБО может сам сотрудник или его руководитель.');
    const zone = await mboZoneBranches(c, subjectUserId, monthEnd(monthFirst));
    const card = (await c.query(
      `INSERT INTO mbo_cards(subject_user_id,period_start,created_by,scope_note)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [subjectUserId, monthFirst, auth.userId,
        // Состав зоны фиксируется словами при создании: позже он изменится, а
        // карточка должна помнить, на что её согласовывали.
        zone.length ? `Филиалы зоны на ${monthEnd(monthFirst)}: ${zone.map(b => b.display_name).join(', ')}`
          : 'На момент создания за сотрудником не закреплено действующих филиалов.'])).rows[0];
    // Строки KPI создаются из настраиваемого шаблона, а не из массива в коде.
    await c.query(
      `INSERT INTO mbo_card_kpis(card_id,horizon,org_unit_id,kpi_code,kpi_name,unit,weight,
                                 fact_source,sort_order,updated_by)
       SELECT $1,h.horizon,NULL,t.kpi_code,t.kpi_name,t.unit,t.default_weight,'PUBLISHED',t.sort_order,$2
         FROM mbo_kpi_template t CROSS JOIN (VALUES('MONTH'),('YEAR')) h(horizon)
        WHERE t.active`, [card.id, auth.userId]);
    await c.query(
      `INSERT INTO mbo_card_history(card_id,action,actor_user_id,after_state)
       VALUES($1,'CREATE',$2,$3::jsonb)`,
      [card.id, auth.userId, JSON.stringify({ period: monthFirst, zone_size: zone.length })]);
    return { status: 201, body: { card_id: card.id, created: true } };
  });
}

export async function getMboCard(auth: AuthedUser, subjectUserId: string, period: string) {
  const monthFirst = monthStart(period);
  const on = monthEnd(monthFirst);
  return withTransaction(async c => {
    const access = await authorizeCard(c, auth, subjectUserId, on);
    const card = (await c.query(
      `SELECT c.*,u.full_name subject_name,u.login subject_login
         FROM mbo_cards c JOIN app_users u ON u.id=c.subject_user_id
        WHERE c.subject_user_id=$1 AND c.period_start=$2`, [subjectUserId, monthFirst])).rows[0];
    const zone = await mboZoneBranches(c, subjectUserId, on);
    if (!card) {
      // Пустая карточка не придумывается: экран должен сказать, что МБО на
      // период ещё не создано, а не показать нули.
      return {
        exists: false, period_start: monthFirst, period_end: on,
        subject_user_id: subjectUserId, zone, access, card: null,
        focuses: [], kpis: [], tasks: [], history: [],
      };
    }
    const orgUnits = zone.map(b => b.id);
    const focuses = (await c.query(
      `SELECT id,focus_code,title,commitment,sort_order FROM mbo_card_focuses
        WHERE card_id=$1 ORDER BY sort_order,created_at`, [card.id])).rows;
    const rows = (await c.query(
      `SELECT k.id,k.horizon,k.org_unit_id,o.display_name org_unit_name,k.kpi_code,k.kpi_name,k.unit,
              k.weight::float8 weight,k.plan_value::float8 plan_value,
              k.manual_fact_value::float8 manual_fact_value,k.manual_fact_comment,k.fact_source,
              t.metric_code,t.metric_code_base,t.ratio_as_percent,
              COALESCE(t.year_aggregation,'SUM') year_aggregation,
              COALESCE(t.direction,'HIGHER_IS_BETTER') direction
         FROM mbo_card_kpis k
         LEFT JOIN mbo_kpi_template t ON t.kpi_code=k.kpi_code
         LEFT JOIN org_directory_name_history o ON o.org_unit_id=k.org_unit_id AND o.effective_to IS NULL
        WHERE k.card_id=$1 ORDER BY k.horizon DESC,k.sort_order,k.id`, [card.id])).rows;
    const kpis: MboKpiRow[] = [];
    for (const r of rows) {
      let fact: number | null = null;
      let basis = 'NOT_MAPPED_TO_PUBLISHED_METRIC';
      if (r.fact_source === 'MANUAL') { fact = r.manual_fact_value; basis = 'MANUAL'; }
      else if (r.metric_code) {
        const units = r.org_unit_id ? [r.org_unit_id] : orgUnits;
        // Висяки берутся из реестра VIN, остальное — из опубликованных отчётов.
        const fromVin = r.metric_code.startsWith('aged45_')
          ? await aged45Fact(c, units, r.metric_code, on) : null;
        const got = fromVin ?? await publishedFact(c, units, r.metric_code, r.metric_code_base,
          r.ratio_as_percent !== false, r.horizon, monthFirst, r.year_aggregation);
        fact = got.value; basis = got.basis;
      }
      kpis.push({
        id: r.id, horizon: r.horizon, org_unit_id: r.org_unit_id, org_unit_name: r.org_unit_name,
        kpi_code: r.kpi_code, kpi_name: r.kpi_name, unit: r.unit, weight: r.weight,
        plan_value: r.plan_value, fact_value: fact, fact_source: r.fact_source, fact_basis: basis,
        manual_fact_comment: r.manual_fact_comment, direction: r.direction,
        completion_pct: completion(r.plan_value, fact, r.direction),
      });
    }
    // Задачи МБО: одна запись work_items, показанная в карточке вместе со своим
    // сроком, переносами и делегированием.
    const tasks = (await c.query(
      `SELECT l.id link_id,l.weight::float8 weight,l.link_origin,l.focus_id,
              w.id work_item_id,w.title,w.status,w.due_at,w.org_unit_id,o.display_name org_unit_name,
              w.migration_count,w.parent_work_item_id,
              w.assignee_user_id,au.full_name assignee_name,
              w.accountable_user_id,cu.full_name accountable_name,
              d.to_user_id delegated_to,du.full_name delegated_to_name,d.reason delegation_reason
         FROM mbo_card_task_links l
         JOIN work_items w ON w.id=l.work_item_id
         LEFT JOIN org_directory_name_history o ON o.org_unit_id=w.org_unit_id AND o.effective_to IS NULL
         LEFT JOIN app_users au ON au.id=w.assignee_user_id
         LEFT JOIN app_users cu ON cu.id=w.accountable_user_id
         LEFT JOIN work_item_delegations d ON d.work_item_id=w.id AND d.revoked_at IS NULL
         LEFT JOIN app_users du ON du.id=d.to_user_id
        WHERE l.card_id=$1 ORDER BY w.due_at,w.title`, [card.id])).rows;
    const history = (await c.query(
      `SELECT h.action,h.comment,h.created_at,u.full_name actor_name
         FROM mbo_card_history h JOIN app_users u ON u.id=h.actor_user_id
        WHERE h.card_id=$1 ORDER BY h.created_at DESC LIMIT 50`, [card.id])).rows;
    return {
      exists: true, period_start: monthFirst, period_end: on,
      subject_user_id: subjectUserId, zone, access,
      card: {
        id: card.id, status: card.status, comment: card.comment, scope_note: card.scope_note,
        entity_version: Number(card.entity_version), subject_name: card.subject_name,
        submitted_at: card.submitted_at, approved_at: card.approved_at,
        returned_reason: card.returned_reason,
      },
      focuses, kpis, tasks, history,
    };
  });
}
