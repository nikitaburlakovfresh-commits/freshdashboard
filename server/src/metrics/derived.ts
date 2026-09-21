// Производные показатели: значения, которых нет ни в одной ячейке источника.
//
// Публикация фактов в портале жёстко привязана к ячейке источника: у каждого
// значения в происхождении указан файл, лист и адрес. Конверсия и доля 45+ в
// выкупе такой ячейки не имеют — они считаются из уже опубликованных величин.
// Поэтому они не публикуются как факты, а вычисляются при чтении и помечаются
// как расчётные. Это сохраняет правило «опубликованное значение = значение из
// источника» и одновременно даёт модели балла нужные показатели.
//
// Отсутствие составляющей означает отсутствие производного показателя, а не
// ноль: филиал без опубликованного трафика не получает конверсию 0%.
import type { PoolClient } from 'pg';

/** Как посчитан производный показатель — для объяснения руководителю. */
export interface DerivedBasis {
  metric: string;
  formula: string;
  components: string[];
}
export const DERIVED_METRICS: Record<string, DerivedBasis> = {
  funnelTrafficToDeal: {
    metric: 'funnelTrafficToDeal', formula: 'сделки / трафик',
    components: ['funnelDeals', 'funnelTraffic'],
  },
  funnelTrafficToVisit: {
    metric: 'funnelTrafficToVisit', formula: 'визиты / трафик',
    components: ['funnelVisits', 'funnelTraffic'],
  },
  funnelVisitToDeal: {
    metric: 'funnelVisitToDeal', formula: 'сделки / визиты',
    components: ['funnelDeals', 'funnelVisits'],
  },
  callTrafficToDeal: {
    metric: 'callTrafficToDeal', formula: 'сделки / трафик (звонки)',
    components: ['callDeals', 'callTraffic'],
  },
  buyback45Share: {
    metric: 'buyback45Share', formula: 'авто выкупа с хранением 45+ / все авто выкупа, в штуках',
    components: ['реестр VIN'],
  },
};

/** Доля в диапазоне 0..1. Делитель не больше нуля — показателя нет. */
function share(numerator: number | null | undefined, denominator: number | null | undefined): number | null {
  if (numerator == null || denominator == null) return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

/**
 * Конверсии воронки из опубликованных трафика, визитов и сделок.
 * Значения возвращаются долей (0..1), как и остальные показатели-доли портала.
 */
export function funnelConversions(values: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  const get = (k: string) => values.has(k) ? values.get(k)! : null;
  const add = (key: string, v: number | null) => { if (v !== null) out.set(key, v); };
  add('funnelTrafficToVisit', share(get('funnelVisits'), get('funnelTraffic')));
  add('funnelVisitToDeal', share(get('funnelDeals'), get('funnelVisits')));
  add('funnelTrafficToDeal', share(get('funnelDeals'), get('funnelTraffic')));
  add('callTrafficToDeal', share(get('callDeals'), get('callTraffic')));
  return out;
}

/** Доля 45+ в выкупе: доля, штуки и себестоимость этих автомобилей. */
export interface Buyback45 {
  share: number; aged: number; total: number;
  aged_cost: number | null; total_cost: number | null; observed_on: string;
}

/** Порог «залежавшегося» автомобиля в днях хранения. */
export const AGED_DAYS_THRESHOLD = 45;

/**
 * Доля автомобилей выкупа с хранением 45 дней и более, в штуках, по реестру VIN
 * на дату среза. Считается по филиалам, у которых реестр вообще опубликован:
 * филиал без реестра остаётся без показателя.
 *
 * Это НЕ показатель `agedShare` из сводного отчёта QLIK: там доля по среднему
 * возрасту остатка. Подменять одно другим нельзя — величины разные.
 */
export async function buyback45Shares(
  c: PoolClient, orgUnitIds: string[], observedOn: string,
): Promise<Map<string, Buyback45>> {
  const out = new Map<string, Buyback45>();
  if (!orgUnitIds.length) return out;
  // Берётся последний срез реестра на дату или раньше: реестр загружается не
  // каждый день, и отсутствие среза именно за эту дату не означает отсутствие
  // склада. Филиал без единого среза остаётся без показателя.
  const rows = (await c.query(
    `WITH latest AS (
       SELECT org_unit_id, max(observed_on) AS observed_on FROM vehicle_stock_rows
       WHERE org_unit_id = ANY($1::uuid[]) AND observed_on <= $2::date
       GROUP BY org_unit_id)
     SELECT r.org_unit_id, l.observed_on,
       count(*) FILTER (WHERE r.days_on_stock IS NOT NULL) AS total,
       count(*) FILTER (WHERE r.days_on_stock >= $3) AS aged,
       sum(r.cost_rub) FILTER (WHERE r.days_on_stock IS NOT NULL) AS total_cost,
       sum(r.cost_rub) FILTER (WHERE r.days_on_stock >= $3) AS aged_cost
     FROM vehicle_stock_rows r
     JOIN latest l ON l.org_unit_id = r.org_unit_id AND l.observed_on = r.observed_on
     WHERE r.supply_type = 'Выкуп'
     GROUP BY r.org_unit_id, l.observed_on`,
    [orgUnitIds, observedOn, AGED_DAYS_THRESHOLD])).rows;
  for (const r of rows) {
    const total = Number(r.total), aged = Number(r.aged);
    // Ни одной машины выкупа с известным сроком хранения — доли нет.
    if (!(total > 0)) continue;
    out.set(r.org_unit_id, { share: aged / total, aged, total,
      aged_cost: r.aged_cost === null ? null : Number(r.aged_cost),
      total_cost: r.total_cost === null ? null : Number(r.total_cost),
      observed_on: String(r.observed_on instanceof Date ? r.observed_on.toISOString().slice(0, 10) : r.observed_on) });
  }
  return out;
}

/**
 * Автомобили, переоценённые вверх за последние `days` дней, по реестру VIN.
 * Нужны минимум два среза реестра: по одному загруженному дню переоценку
 * определить нельзя, и в этом случае филиала в результате не будет.
 */
export async function upwardRepricing(
  c: PoolClient, orgUnitIds: string[], observedOn: string, days = 30,
): Promise<Map<string, { vehicles: number; events: number }>> {
  const out = new Map<string, { vehicles: number; events: number }>();
  if (!orgUnitIds.length) return out;
  const rows = (await c.query(
    // Проданный автомобиль выбывает из склада, и его переоценки больше не
    // относятся к текущему управлению ценой. Поэтому считаем только те
    // автомобили, которые есть в последнем срезе реестра на дату.
    `WITH latest AS (
       SELECT org_unit_id, max(observed_on) AS observed_on FROM vehicle_stock_rows
       WHERE org_unit_id = ANY($1::uuid[]) AND observed_on <= $2::date
       GROUP BY org_unit_id
     ),
     in_stock AS (
       SELECT r.org_unit_id, r.vehicle_id FROM vehicle_stock_rows r
       JOIN latest l ON l.org_unit_id = r.org_unit_id AND l.observed_on = r.observed_on
     ),
     history AS (
       SELECT r.org_unit_id, r.vehicle_id, r.observed_on, r.sale_price_rub,
         lag(r.sale_price_rub) OVER (PARTITION BY r.org_unit_id, r.vehicle_id ORDER BY r.observed_on) AS previous
       FROM vehicle_stock_rows r
       JOIN in_stock s ON s.org_unit_id = r.org_unit_id AND s.vehicle_id = r.vehicle_id
       WHERE r.org_unit_id = ANY($1::uuid[])
         AND r.observed_on <= $2::date
         AND r.observed_on > $2::date - ($3::int || ' days')::interval
         AND r.sale_price_rub IS NOT NULL
     )
     SELECT org_unit_id, count(DISTINCT vehicle_id) AS vehicles, count(*) AS events
     FROM history WHERE previous IS NOT NULL AND sale_price_rub > previous
     GROUP BY org_unit_id`,
    [orgUnitIds, observedOn, days])).rows;
  for (const r of rows) out.set(r.org_unit_id, { vehicles: Number(r.vehicles), events: Number(r.events) });
  return out;
}
