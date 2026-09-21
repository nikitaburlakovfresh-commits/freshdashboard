// Диагностика карточки филиала без браузера: печатает тот же состав данных,
// что отдаёт карточка, — опубликованные показатели, расчётные величины, долю
// 45+ в выкупе, переоценки вверх и разбивку балла. Только чтение.
import { withTransaction, closePool } from '../src/db/pool';
import { funnelConversions, buyback45Shares, upwardRepricing, DERIVED_METRICS } from '../src/metrics/derived';
import { resolveScoringModel, computeBranchScore } from '../src/metrics/scoring';
import { METRIC_NAMES } from '../src/reporting/shared/metricCatalog';

const [branchName, start, end, ...extra] = process.argv.slice(2);
const WINDOW = 30;

async function main() {
  if (extra.length || !branchName || !start || !end)
    throw new Error('Usage: previewBranchCard <branch-display-name> <start> <end>');
  const payload = await withTransaction(async c => {
    const unit = (await c.query(`SELECT u.id, u.code, u.lifecycle_state, n.display_name
      FROM org_directory_units u
      JOIN org_directory_name_history n ON n.org_unit_id=u.id AND n.effective_to IS NULL
      WHERE n.display_name=$1`, [branchName])).rows[0];
    if (!unit) throw new Error(`Филиал «${branchName}» не найден в справочнике`);
    const org = unit.id as string;

    const rows = (await c.query(`SELECT s.metric, s.value::text value, s.unit, s.revision
      FROM report_fact_snapshots s JOIN report_fact_current p ON p.snapshot_id=s.id
      WHERE s.org_unit_id=$1 AND s.period_start=$2 AND s.period_end=$3 ORDER BY s.metric`,
    [org, start, end])).rows;
    const values = new Map<string, number>(rows.map((r: any) => [r.metric, Number(r.value)]));

    const conversions = funnelConversions(values);
    for (const [k, v] of conversions) values.set(k, v);
    const buyback = (await buyback45Shares(c, [org], end)).get(org) ?? null;
    if (buyback) values.set('buyback45Share', buyback.share);
    const repricing = (await upwardRepricing(c, [org], end, WINDOW)).get(org) ?? null;
    const snapshots = Number((await c.query(
      `SELECT count(DISTINCT observed_on)::int n FROM vehicle_stock_rows
       WHERE org_unit_id=$1 AND observed_on<=$2::date
         AND observed_on>$2::date-($3::int||' days')::interval`, [org, end, WINDOW])).rows[0].n);

    const model = await resolveScoringModel(c, end);
    const score = model ? computeBranchScore(model, values, end) : null;

    return {
      branch: { org_unit_id: org, code: unit.code, display_name: unit.display_name,
        lifecycle_state: unit.lifecycle_state },
      period_start: start, period_end: end,
      metrics: rows.map((r: any) => ({ metric: r.metric,
        metric_name: (METRIC_NAMES as Record<string, string>)[r.metric] ?? r.metric,
        value: Number(r.value), unit: r.unit, revision: r.revision })),
      derived: [...conversions.entries()].map(([metric, value]) => ({ metric,
        metric_name: (METRIC_NAMES as Record<string, string>)[metric] ?? metric, value, unit: 'PCT',
        formula: DERIVED_METRICS[metric]?.formula ?? null })),
      buyback45: buyback,
      repricing: { window_days: WINDOW, snapshots,
        vehicles: repricing?.vehicles ?? null, events: repricing?.events ?? null },
      score: score ? { configured: true, value: score.score, rag: score.rag,
        components: score.components, reasons: score.reasons } : { configured: false },
    };
  });
  console.log(JSON.stringify(payload, null, 1));
}
main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; }).finally(closePool);
