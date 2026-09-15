import { normalize, selectRow, validDate, type Report, type ReportBatch, type MetricKey } from './reportModel';

// File-view selectors, not production Metric Engine or OrgUnit authorization.
// Money and counts are additive; ratios are always derived from components.
export const NETWORK_KEYS = ['sales', 'margin', 'stock', 'aged'] as const;
export type NetworkMetric = typeof NETWORK_KEYS[number];
export type FocusFilter = 'all' | 'sales-gap' | 'aged-gap';
export interface StockTarget { month: string; value: number; revision: number }
export const networkSource = (batch: ReportBatch, metric: MetricKey) =>
  metric === 'stock' || metric === 'aged'
    ? batch.reports.find(r => r.kind === 'summary')
    : batch.reports.find(r => r.kind === 'summary') ?? batch.reports.find(r => r.kind === 'sales');
export const metricValue = (report: Report | undefined, branch: string, metric: MetricKey) =>
  selectRow(report, branch)?.values[metric] ?? null;
export function networkBranches(batch: ReportBatch) {
  return [...new Map(batch.reports.flatMap(r => r.branches.map(b => [b.key, b.name] as const)))]
    .map(([key, name]) => ({ key, name }));
}
export function salesPlan(batch: ReportBatch, branch = '') {
  const report = batch.reports.find(r => r.kind === 'sales');
  const p = batch.period;
  const known = validDate(p.planStart) && validDate(p.planEnd) && p.planStart <= p.planEnd;
  const fact = metricValue(report, branch, 'sales');
  const plan = known ? metricValue(report, branch, 'plan') : null;
  let reason = '';
  if (!report) reason = 'Нужен отчёт продаж с планом (колонки B и C).';
  else if (!known) reason = 'Период плана не подтверждён при импорте.';
  else if (p.start !== p.planStart || p.end !== p.planEnd) reason = 'Периоды факта и плана различаются. Нужен сопоставимый период; RunRate не настроен.';
  else if (fact == null || plan == null) reason = 'В строке отсутствует факт или план.';
  else if (plan <= 0) reason = 'План равен нулю: деление не выполняется.';
  return { report, fact, plan, reason, ratio: reason ? null : fact! / plan! * 100,
    gap: reason ? null : Math.max(0, plan! - fact!) };
}
export function stockShare(batch: ReportBatch, branch = '') {
  const report = batch.reports.find(r => r.kind === 'summary');
  const stock = metricValue(report, branch, 'stock'), aged = metricValue(report, branch, 'aged');
  let reason = '';
  if (!report?.stockDate || !validDate(report.stockDate)) reason = 'Нет сводки с подтверждённой единой датой склада и 45+.';
  else if (stock == null || aged == null) reason = 'Отсутствует склад или количество 45+.';
  else if (stock <= 0) reason = 'Склад равен нулю: доля не определена.';
  else if (aged < 0 || aged > stock) reason = 'Количество 45+ не согласуется со складом.';
  return { report, stock, aged, reason, value: reason ? null : aged! / stock! * 100 };
}
export function validateStockTarget(month: string, raw: string, batch: ReportBatch): number {
  const date = batch.reports.find(r => r.kind === 'summary')?.stockDate;
  if (!date || month !== date.slice(0, 7)) throw new Error('Месяц цели должен совпадать с месяцем складского среза.');
  if (!raw.trim()) throw new Error('Введите целевую долю явно. Пустое значение не равно нулю.');
  if (!/^\d+(?:[.,]\d+)?$/.test(raw.trim())) throw new Error('Введите долю обычным числом от 0 до 100%.');
  const value = Number(raw.trim().replace(',', '.'));
  if (!Number.isFinite(value) || value < 0 || value > 100) throw new Error('Доля должна быть числом от 0 до 100%.');
  return value;
}
export function stockDeviation(batch: ReportBatch, branch: string, target: StockTarget | null) {
  const fact = stockShare(batch, branch);
  if (!target || target.month !== fact.report?.stockDate?.slice(0, 7) || fact.value == null) return null;
  return fact.value - target.value; // percentage points, never rubles or a synthetic score
}
export function rankedBranches(batch: ReportBatch, metric: NetworkMetric, direction: 'asc' | 'desc',
  query = '', filter: FocusFilter = 'all', target: StockTarget | null = null) {
  const rows = networkBranches(batch).map(b => ({ ...b, value: metricValue(networkSource(batch, metric), b.key, metric) }));
  rows.sort((a, b) => {
    if (a.value == null || b.value == null) return a.value == null && b.value == null
      ? a.name.localeCompare(b.name, 'ru') : a.value == null ? 1 : -1;
    return (direction === 'desc' ? b.value - a.value : a.value - b.value) || a.name.localeCompare(b.name, 'ru');
  });
  let lastRank = 0;
  // Rank the whole file scope before search/filter; ties use competition ranking.
  return rows.map((row, i) => {
    if (row.value != null && (i === 0 || row.value !== rows[i - 1].value)) lastRank = i + 1;
    return { ...row, rank: row.value == null ? null : lastRank };
  }).filter(row => normalize(row.name).includes(normalize(query)))
    .filter(row => filter === 'all' || (filter === 'sales-gap'
      ? (salesPlan(batch, row.key).gap ?? 0) > 0
      : (stockDeviation(batch, row.key, target) ?? 0) > 0));
}
