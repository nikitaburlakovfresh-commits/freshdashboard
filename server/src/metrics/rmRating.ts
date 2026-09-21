import type { PoolClient } from 'pg';

/**
 * Рейтинг регионального менеджера.
 *
 * Формула восстановлена из работающей сборки старого портала:
 *
 *   a = дней в месяце / прошедших дней
 *   по филиалам зоны складываются план и факт каждого блока
 *   блок = факт × a / план × 100, если план > 0
 *   рейтинг = Σ(блок × вес) / Σ(вес блоков, которые удалось посчитать)
 *
 * Здесь важны два свойства, которых не было у прежнего показателя рядом с
 * фамилией (среднее арифметическое баллов филиалов):
 *
 * 1. Величины зоны складываются ДО деления. Филиал с планом в 60 машин влияет
 *    на зону сильнее филиала с планом в 10, а не наравне с ним.
 * 2. Вес блока без данных исключается из знаменателя, а не считается нулём.
 *    Непоставленный план поставок не должен выглядеть как их невыполнение.
 */
export interface RmRatingBlock {
  code: string; label: string; weight: number;
  fact_metric: string; plan_metric: string;
  method: 'RUN_RATE' | 'POINT_IN_TIME'; direction: 'HIGHER' | 'LOWER';
  cap_pct: number | null; sort_order: number;
}
export interface RmRatingModel {
  id: string; green_from: number; amber_from: number; note: string | null; blocks: RmRatingBlock[];
}

export async function resolveRmRatingModel(c: PoolClient, on: string): Promise<RmRatingModel | null> {
  const version = (await c.query(
    `SELECT id,green_from::float8 green_from,amber_from::float8 amber_from,note
       FROM rm_rating_versions
      WHERE effective_from<=$1::date AND (effective_to IS NULL OR effective_to>$1::date)
      ORDER BY effective_from DESC LIMIT 1`, [on])).rows[0];
  if (!version) return null;
  const blocks = (await c.query(
    `SELECT code,label,weight::float8 weight,fact_metric,plan_metric,method,direction,
            cap_pct::float8 cap_pct,sort_order
       FROM rm_rating_blocks WHERE version_id=$1 ORDER BY sort_order`, [version.id])).rows;
  return { ...version, blocks };
}

export interface RmRatingComponent {
  code: string; label: string; weight: number; value: number | null;
  fact: number | null; plan: number | null; reason: string | null;
}
export interface RmRating {
  rating: number | null; rag: 'GREEN' | 'AMBER' | 'RED' | 'NONE';
  components: RmRatingComponent[]; weight_used: number; formula: string;
}

/** Ускоритель темпа месяца: дней в месяце / прошедших дней. */
export function monthAccelerator(on: string): number | null {
  const [y, m, d] = on.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d > 0 ? days / d : null;
}

/**
 * Рейтинг зоны по суммам её филиалов.
 *
 * `sums` — сложенные по зоне значения показателей. Показатель, отсутствующий у
 * всех филиалов зоны, в карту не попадает: отсутствие данных не равно нулю, и
 * подставлять ноль в знаменатель или числитель нельзя.
 */
export function computeRmRating(model: RmRatingModel, sums: Map<string, number>, on: string): RmRating {
  const a = monthAccelerator(on);
  const components: RmRatingComponent[] = model.blocks.map(b => {
    const fact = sums.has(b.fact_metric) ? sums.get(b.fact_metric)! : null;
    const plan = sums.has(b.plan_metric) ? sums.get(b.plan_metric)! : null;
    const base = { code: b.code, label: b.label, weight: b.weight, fact, plan };
    if (fact === null) return { ...base, value: null, reason: `FACT_NOT_PUBLISHED:${b.fact_metric}` };
    if (plan === null) return { ...base, value: null, reason: `PLAN_NOT_PUBLISHED:${b.plan_metric}` };
    if (!(plan > 0)) return { ...base, value: null, reason: 'PLAN_NOT_POSITIVE' };
    if (b.method === 'RUN_RATE' && a === null)
      return { ...base, value: null, reason: 'MONTH_PROGRESS_UNKNOWN' };
    const paced = b.method === 'RUN_RATE' ? fact * (a as number) : fact;
    let value = b.direction === 'LOWER'
      ? (paced > 0 ? plan / paced * 100 : null)
      : paced / plan * 100;
    if (value === null) return { ...base, value: null, reason: 'FACT_NOT_POSITIVE' };
    if (b.cap_pct !== null) value = Math.min(value, b.cap_pct);
    return { ...base, value, reason: null };
  });
  let sum = 0, weight = 0;
  for (const cmp of components) if (cmp.value !== null) { sum += cmp.value * cmp.weight; weight += cmp.weight; }
  const rating = weight > 0 ? sum / weight : null;
  const rag = rating === null ? 'NONE'
    : rating >= model.green_from ? 'GREEN'
      : rating >= model.amber_from ? 'AMBER' : 'RED';
  // Человеческая запись расчёта: рядом с числом видно, из чего он собран, и
  // какие блоки в него не вошли.
  const formula = components.map(cmp => cmp.value === null
    ? `${cmp.label.toLowerCase()} — нет данных`
    : `${cmp.label.toLowerCase()} ${Math.round(cmp.value)}% × ${cmp.weight}%`).join(' + ');
  return { rating, rag, components, weight_used: weight, formula };
}
