// Прикидка предложенной матрицы балла на опубликованных данных, без записи и
// без изменения действующей модели. Печатает вклад каждого показателя, итог по
// филиалу, по зоне РМ и по сети, и отдельно перечисляет показатели, которые
// посчитать нельзя. Ничего не домысливает: отсутствующий показатель исключается
// из взвешивания, а не считается нулём.
import { withTransaction, closePool } from '../src/db/pool';
import { branchAffiliations } from '../src/metrics/orgHierarchy';
import { funnelConversions, buyback45Shares } from '../src/metrics/derived';
import { monthProgress } from '../src/metrics/scoring';

const [start, end, ...extra] = process.argv.slice(2);
const CAP = 120;

/** Веса предложенной матрицы. Сумма 105 — взвешенное среднее это допускает. */
const WEIGHTS = {
  revenue: 30, margin: 20, kso: 15, stockTurnover: 25, conversion: 5, credits: 5, buyback45: 5,
} as const;

const runRate = (fact: number | null, plan: number | null, k: number): number | null =>
  fact === null || plan === null || plan <= 0 || k <= 0 ? null : Math.min(CAP, (fact / (plan * k)) * 100);

/** Полосы доли 45+: чем меньше, тем лучше. До 10% зелёный, до 15% жёлтый. */
const buybackScore = (share: number | null): number | null =>
  share === null ? null : share <= 0.10 ? 110 : share <= 0.15 ? 90 : 50;
/** Полосы конверсии: от 17% зелёный, от 14% жёлтый. */
const conversionScore = (v: number | null): number | null =>
  v === null ? null : v >= 0.17 ? 110 : v >= 0.14 ? 90 : 50;

async function main() {
  if (extra.length || !start || !end) throw new Error('Usage: previewMatrixVariant <start> <end>');
  await withTransaction(async c => {
    const k = monthProgress(end);
    const branches = (await c.query(`SELECT u.id, n.display_name FROM org_directory_units u
      JOIN org_directory_name_history n ON n.org_unit_id=u.id
        AND $1::date >= n.effective_from AND (n.effective_to IS NULL OR $1::date < n.effective_to)
      WHERE u.kind='ORG_UNIT' AND u.lifecycle_state<>'CLOSED'`, [end])).rows;
    const ids = branches.map((b: any) => b.id as string);
    const names = new Map<string, string>(branches.map((b: any) => [b.id, b.display_name]));
    const aff = await branchAffiliations(c, ids, end);
    const buyback = await buyback45Shares(c, ids, end);
    console.log(`Период ${start} — ${end}, K = ${(k * 100).toFixed(1)}% месяца`);
    console.log(`Веса: ${Object.entries(WEIGHTS).map(([m, w]) => `${m} ${w}`).join(', ')}`
      + ` — сумма ${Object.values(WEIGHTS).reduce((a, b) => a + b, 0)}`);

    const missing = new Map<string, number>();
    const perBranch = new Map<string, number>();
    const zones = new Map<string, number[]>();

    for (const id of ids) {
      const rows = (await c.query(`SELECT s.metric, s.value::text value FROM report_fact_snapshots s
        JOIN report_fact_current p ON p.snapshot_id=s.id
        WHERE s.org_unit_id=$1 AND s.period_start=$2 AND s.period_end=$3`, [id, start, end])).rows;
      if (!rows.length) continue;
      const v = new Map<string, number>(rows.map((r: any) => [r.metric, Number(r.value)]));
      for (const [m, x] of funnelConversions(v)) v.set(m, x);
      const get = (m: string) => (v.has(m) ? (v.get(m) as number) : null);

      const parts: { metric: string; weight: number; score: number | null }[] = [
        // Выручка в рублях: план выручки источник не публикует, поэтому
        // run-rate по рублям посчитать нечем. Показываем как отсутствующий.
        { metric: 'revenue', weight: WEIGHTS.revenue, score: runRate(get('revenue'), get('planRevenue'), k) },
        { metric: 'margin', weight: WEIGHTS.margin, score: runRate(get('margin'), get('planMargin'), k) },
        { metric: 'kso', weight: WEIGHTS.kso, score: runRate(get('kso'), get('planKso'), k) },
        // Оборачиваемость склада: прогноз продаж итогом к складу на 1 число.
        { metric: 'stockTurnover', weight: WEIGHTS.stockTurnover,
          score: get('forecast') !== null && get('stockStart') !== null && (get('stockStart') as number) > 0
            ? Math.min(CAP, ((get('forecast') as number) / (get('stockStart') as number)) * 100) : null },
        { metric: 'conversion', weight: WEIGHTS.conversion, score: conversionScore(get('funnelTrafficToDeal')) },
        { metric: 'credits', weight: WEIGHTS.credits,
          score: runRate(get('creditShareFact'), get('creditSharePlan'), 1) },
        { metric: 'buyback45', weight: WEIGHTS.buyback45, score: buybackScore(buyback.get(id)?.share ?? null) },
      ];
      for (const p of parts) if (p.score === null) missing.set(p.metric, (missing.get(p.metric) ?? 0) + 1);
      const scored = parts.filter(p => p.score !== null);
      const weight = scored.reduce((s, p) => s + p.weight, 0);
      if (!weight) continue;
      const total = scored.reduce((s, p) => s + (p.score as number) * p.weight, 0) / weight;
      perBranch.set(id, total);
      const zone = aff.get(id)?.cluster_name ?? 'без зоны РМ';
      zones.set(zone, [...(zones.get(zone) ?? []), total]);
    }

    console.log('\nПо зонам РМ:');
    for (const [zone, list] of [...zones.entries()].sort())
      console.log(`  ${zone}: ${(list.reduce((a, b) => a + b, 0) / list.length).toFixed(1)}%`
        + ` по ${list.length} филиалам`);
    const all = [...perBranch.values()];
    console.log(`\nСеть: ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(1)}% по ${all.length} филиалам`);
    console.log('\nНе посчитано (филиалов):');
    for (const [m, n] of [...missing.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${m}: ${n}`);
  });
}
main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; }).finally(closePool);
