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
  stockTurnover: {
    metric: 'stockTurnover', formula: 'прогноз продаж за месяц / склад на 1 число месяца',
    components: ['forecast', 'stockStart'],
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
/**
 * Оборачиваемость склада: прогноз продаж за месяц, делённый на склад на 1 число
 * этого месяца. Обе части — опубликованные показатели. Если склад на 1 число не
 * опубликован или равен нулю, показателя нет: делить не на что, и нулём это не
 * подменяется.
 */
export function stockTurnover(values: Map<string, number>): number | null {
  const forecast = values.get('forecast');
  const stockStart = values.get('stockStart');
  if (forecast === undefined || stockStart === undefined || stockStart <= 0) return null;
  return forecast / stockStart;
}

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
 * Область склада для расчёта висяков 45+.
 *
 * Висяки считают по-разному, и подменять одну базу другой нельзя:
 *   BUYOUT     — только выкуп. Это основная база: машина выкупа стоит денег
 *                компании, и её себестоимость — суть вопроса.
 *   COMMISSION — комиссия, то есть всё, что не выкуп. Определяется через
 *                отрицание, чтобы не зависеть от написания слова в отчёте.
 *   ALL        — весь склад. Нужна, когда речь о ликвидности склада в целом.
 */
export type AgedScope = 'BUYOUT' | 'COMMISSION' | 'ALL';

/** Мера: штуки или себестоимость этих машин в рублях. */
export type AgedMeasure = 'UNITS' | 'COST';

export interface Aged45 {
  scope: AgedScope;
  /** Доля в штуках. */
  share: number;
  /** Доля по себестоимости: null, если себестоимость в реестре не заполнена. */
  cost_share: number | null;
  aged: number; total: number;
  aged_cost: number | null; total_cost: number | null;
  observed_on: string;
}

function scopeCondition(scope: AgedScope): string {
  if (scope === 'BUYOUT') return "r.supply_type = 'Выкуп'";
  // Комиссия — через отрицание выкупа. Машины без указанного типа поставки в
  // комиссию не попадают: неизвестный тип нельзя выдавать за комиссию.
  if (scope === 'COMMISSION') return "r.supply_type IS NOT NULL AND r.supply_type <> 'Выкуп'";
  return 'TRUE';
}

/**
 * Висяки 45+ по реестру VIN на дату среза, в выбранной области склада.
 *
 * Возвращаются сразу обе меры — штуки и себестоимость, — потому что вопрос
 * «сколько машин зависло» и вопрос «сколько денег в них заморожено» задают по
 * одному и тому же складу, и считать их двумя разными запросами незачем.
 *
 * Филиал без единого среза реестра остаётся без показателя: отсутствие реестра
 * не означает отсутствие склада.
 *
 * Это НЕ показатель `agedShare` из сводного отчёта QLIK: там доля по среднему
 * возрасту остатка. Подменять одно другим нельзя — величины разные.
 */
export async function aged45(
  c: PoolClient, orgUnitIds: string[], observedOn: string, scope: AgedScope = 'BUYOUT',
): Promise<Map<string, Aged45>> {
  const out = new Map<string, Aged45>();
  if (!orgUnitIds.length) return out;
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
     WHERE ${scopeCondition(scope)}
     GROUP BY r.org_unit_id, l.observed_on`,
    [orgUnitIds, observedOn, AGED_DAYS_THRESHOLD])).rows;
  for (const r of rows) {
    const total = Number(r.total), aged = Number(r.aged);
    if (!(total > 0)) continue;
    const totalCost = r.total_cost === null ? null : Number(r.total_cost);
    const agedCost = r.aged_cost === null ? null : Number(r.aged_cost);
    out.set(r.org_unit_id, {
      scope, share: aged / total, aged, total,
      aged_cost: agedCost, total_cost: totalCost,
      // Доля по себестоимости требует обеих сумм: пустая себестоимость не ноль.
      cost_share: totalCost && agedCost !== null ? agedCost / totalCost : null,
      observed_on: String(r.observed_on instanceof Date
        ? r.observed_on.toISOString().slice(0, 10) : r.observed_on),
    });
  }
  return out;
}

/**
 * Доля 45+ в выкупе — частный случай `aged45` с областью «выкуп». Оставлен ради
 * существующих вызовов карточки филиала и сводки.
 */
export async function buyback45Shares(
  c: PoolClient, orgUnitIds: string[], observedOn: string,
): Promise<Map<string, Buyback45>> {
  return aged45(c, orgUnitIds, observedOn, 'BUYOUT');
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
