// Synthetic only. No uploaded data or production identities.
import test from 'node:test';
import assert from 'node:assert/strict';
import { type Report, type ReportBatch, normalize } from '../src/imports/reportModel';
import { metricValue, networkSource, networkBranches, rankedBranches, salesPlan, stockShare, validateStockTarget, stockDeviation } from '../src/imports/networkModel';
const row = (name: string, values: Record<string, number | null>, i = 3) => ({ name, key: normalize(name), row: i, values });
function batch(): ReportBatch {
  const summary: Report = { kind: 'summary', file: 'synthetic-summary.xlsx', sheet: 'Test', stockDate: '2030-04-10',
    columns: { sales: 'H', margin: 'W', stock: 'E', aged: 'AB' },
    total: row('Итог', { sales: 20, margin: 10, stock: 100, aged: 10 }, 2),
    branches: [row('Тест Альфа', { sales: 8, margin: -10, stock: 10, aged: 5 }),
      row('Тест Бета', { sales: 12, margin: 20, stock: 90, aged: 5 }, 4),
      row('Тест Гамма', { sales: null, margin: null, stock: 0, aged: 0 }, 5),
      row('Тест Дельта', { sales: 12, margin: 0, stock: null, aged: null }, 6)] };
  const sales: Report = { kind: 'sales', file: 'synthetic-sales.xlsx', sheet: 'Test', columns: { sales: 'C', plan: 'B', margin: 'P' },
    total: row('Итог', { sales: 30, plan: 40, margin: 20 }, 2),
    branches: [row('Тест Альфа', { sales: 6, plan: 10 }), row('Тест Бета', { sales: 24, plan: 20 }, 4),
      row('Тест Гамма', { sales: 0, plan: 0 }, 5), row('Тест Эпсилон', { sales: 1, plan: null }, 6)] };
  return { reports: [summary, sales], skipped: [], period: { start: '2030-04-01', end: '2030-04-10', planStart: '2030-04-01', planEnd: '2030-04-10' } };
}
test('network is official row, union retains missing branches; no source addition or per-cell fallback', () => {
  const b = batch();
  assert.equal(networkBranches(b).length, 5);
  assert.equal(metricValue(networkSource(b, 'sales'), '', 'sales'), 20);
  assert.equal(metricValue(networkSource(b, 'sales'), normalize('Тест Гамма'), 'sales'), null);
  assert.equal(metricValue(networkSource(b, 'sales'), normalize('Тест Эпсилон'), 'sales'), null);
});
test('both rank directions put selected-metric missing last, retain zero and negative margin', () => {
  const b = batch();
  assert.deepEqual(rankedBranches(b, 'margin', 'asc').map(r => r.value), [-10, 0, 20, null, null]);
  assert.deepEqual(rankedBranches(b, 'margin', 'desc').map(r => r.value), [20, 0, -10, null, null]);
});
test('ties share rank; search preserves global position and normalizes input', () => {
  assert.deepEqual(rankedBranches(batch(), 'sales', 'desc').map(r => r.rank), [1, 1, 3, null, null]);
  assert.equal(rankedBranches(batch(), 'sales', 'desc', '  аЛьФА  ')[0].rank, 3);
});
test('sales focus uses fact and plan from the same second report, not summary', () => {
  assert.equal(salesPlan(batch()).ratio, 75);
  assert.equal(salesPlan(batch(), normalize('Тест Альфа')).ratio, 60);
  assert.equal(salesPlan(batch(), normalize('Тест Альфа')).gap, 4);
});
test('mismatched, unknown and zero plan blocks ratio; missing fact is not zero', () => {
  const b = batch(); b.period.planEnd = '2030-04-30';
  assert.equal(salesPlan(b).ratio, null);
  assert.match(salesPlan(b).reason, /Периоды/);
  b.period.planEnd = ''; b.period.planStart = '';
  assert.equal(salesPlan(b).plan, null);
  assert.equal(salesPlan(batch(), normalize('Тест Гамма')).ratio, null);
  assert.equal(salesPlan(batch(), normalize('Не существует')).ratio, null);
});
test('network 45+ is ratio of official components, never sum or average of branch ratios', () => {
  assert.equal(stockShare(batch()).value, 10);
  assert.equal(stockShare(batch(), normalize('Тест Альфа')).value, 50);
});
test('stock share rejects missing date, zero denominator and invalid count', () => {
  const b = batch(); b.reports[0].stockDate = undefined;
  assert.equal(stockShare(b).value, null);
  assert.equal(stockShare(batch(), normalize('Тест Гамма')).value, null);
  assert.equal(stockShare(batch(), normalize('Тест Дельта')).value, null);
  b.reports[0].stockDate = '2030-04-10'; b.reports[0].total.values.aged = 101;
  assert.equal(stockShare(b).value, null);
});
test('explicit draft target only, no seeded norm; zero is a valid intentional target', () => {
  const b = batch();
  assert.throws(() => validateStockTarget('2030-04', '', b));
  assert.throws(() => validateStockTarget('2030-05', '20', b));
  assert.throws(() => validateStockTarget('2030-04', '-1', b));
  assert.throws(() => validateStockTarget('2030-04', '101', b));
  assert.equal(validateStockTarget('2030-04', '0', b), 0);
  assert.equal(validateStockTarget('2030-04', '12,5', b), 12.5);
});
test('focus filters only assessed rows and comparison is percentage points, not scores or money', () => {
  const b = batch(), target = { month: '2030-04', value: 20, revision: 1 };
  assert.equal(stockDeviation(b, normalize('Тест Альфа'), target), 30);
  assert.equal(stockDeviation(b, normalize('Тест Альфа'), null), null);
  assert.equal(stockDeviation(b, normalize('Тест Альфа'), { ...target, month: '2030-05' }), null);
  assert.deepEqual(rankedBranches(b, 'sales', 'desc', '', 'sales-gap').map(r => r.name), ['Тест Альфа']);
  assert.deepEqual(rankedBranches(b, 'sales', 'desc', '', 'aged-gap', target).map(r => r.name), ['Тест Альфа']);
});
test('replacement with sales-only does not carry stock or target comparability forward', () => {
  const b = batch(); b.reports = b.reports.filter(r => r.kind === 'sales');
  assert.equal(stockShare(b).value, null);
  assert.equal(metricValue(networkSource(b, 'stock'), '', 'stock'), null);
  assert.equal(salesPlan(b).ratio, 75);
});
