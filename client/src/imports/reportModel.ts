// Only aggregate business values cross the worker boundary. No workbook, VIN,
// employee records, hyperlinks or unused columns are kept in application state.
export type ReportKind = 'summary' | 'sales';
export type MetricKey = 'sales' | 'margin' | 'stock' | 'aged' | 'plan' | 'revenue' | 'baseMargin' | 'kso';
export type Values = Partial<Record<MetricKey, number | null>>;
export interface ReportRow { name: string; key: string; row: number; values: Values }
export interface Report {
  kind: ReportKind;
  file: string;
  sheet: string;
  stockDate?: string;
  columns: Partial<Record<MetricKey, string>>;
  total: ReportRow;
  branches: ReportRow[];
}
export interface ImportPeriod { start: string; end: string; planStart: string; planEnd: string }
export interface ReportBatch {
  reports: Report[];
  skipped: { file: string; reason: string }[];
  period: ImportPeriod;
}
export const REPORT_NAMES: Record<ReportKind, string> = {
  summary: 'Сводка продаж и склада', sales: 'Продажи · КСО и маржа',
};
export const METRIC_NAMES: Record<MetricKey, string> = {
  sales: 'Продажи автомобилей', margin: 'Маржа + КСО', stock: 'Автомобили на складе',
  aged: 'Склад 45+', plan: 'План продаж', revenue: 'Выручка',
  baseMargin: 'Маржа без КСО', kso: 'КСО',
};
export const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '2199-12-31') return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function validatePeriod(period: ImportPeriod): void {
  if (!validDate(period.start) || !validDate(period.end) || period.start > period.end)
    throw new Error('Укажите корректные даты начала и окончания периода продаж.');
  if ((period.planStart || period.planEnd) &&
      (!validDate(period.planStart) || !validDate(period.planEnd) || period.planStart > period.planEnd))
    throw new Error('Укажите обе корректные даты периода плана или оставьте обе пустыми.');
}
export function numeric(value: unknown, count: boolean, address: string): number | null {
  if (value == null || (typeof value === 'string' && ['', '-', '—', '–'].includes(value.trim()))) return null;
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') {
    const text = value.trim();
    if (!/^[+-]?(?:\d+|\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,]\d+)?$/.test(text))
      throw new Error(`${address}: ожидается число или пустая ячейка.`);
    n = Number(text.replace(/[ \u00a0\u202f]/g, '').replace(',', '.'));
  } else throw new Error(`${address}: неверный тип значения.`);
  if (!Number.isFinite(n) || Math.abs(n) > 1e15 || (count && (!Number.isSafeInteger(n) || n < 0)))
    throw new Error(`${address}: недопустимое ${count ? 'количество' : 'число'}.`);
  return n;
}
const columnIndex = (column: string) => [...column].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
export function detectReport(headers: unknown[]): ReportKind | null {
  const at = (c: string, s: string) => normalize(String(headers[columnIndex(c)] ?? '')) === normalize(s);
  if (!at('A', 'Франчайзи')) return null;
  if (at('H', 'Продажи Факт, шт.') && at('N', 'Факт Маржа, руб.') &&
      at('U', 'Факт КСО, руб.') && at('W', 'Факт Маржа+КСО, руб.') &&
      /^Склад на \d{2}\.\d{2}\.\d{4}, шт\.$/i.test(String(headers[4] ?? '').trim()) &&
      /^Склад 45\+ на \d{2}\.\d{2}\.\d{4}, шт\.$/i.test(String(headers[27] ?? '').trim()))
    return 'summary';
  if (at('B', 'План Кол-во, шт.') && at('C', 'Факт Кол-во, шт.') &&
      at('H', 'Выручка, руб.') && at('J', 'Факт КСО, руб.') &&
      at('M', 'Факт Железо, руб.') && at('P', 'Факт Маржа, руб.')) return 'sales';
  return null;
}
export function parseReport(rows: unknown[][], kind: ReportKind, file: string, sheet: string): Report {
  if (rows.length < 2 || rows.length > 502 || rows.some(r => r.length > 64))
    throw new Error('Допустимо до 500 филиалов и 64 столбцов в агрегатном отчёте.');
  if (detectReport(rows[0]) !== kind) throw new Error('Заголовки отчёта не соответствуют поддерживаемому формату.');
  const columns: Report['columns'] = kind === 'summary'
    ? { sales: 'H', margin: 'W', stock: 'E', aged: 'AB', revenue: 'L', baseMargin: 'N', kso: 'U' }
    : { sales: 'C', margin: 'P', plan: 'B', revenue: 'H', baseMargin: 'M', kso: 'J' };
  let stockDate: string | undefined;
  if (kind === 'summary') {
    const dates = [4, 27].map(i => String(rows[0][i]).match(/\d{2}\.\d{2}\.\d{4}/)![0].split('.').reverse().join('-'));
    if (!validDate(dates[0]) || dates[0] !== dates[1]) throw new Error('Даты склада и склада 45+ отсутствуют, некорректны или различаются.');
    stockDate = dates[0];
  }
  const readRow = (raw: unknown[], row: number, name: string): ReportRow => {
    const values: Values = {};
    for (const [key, column] of Object.entries(columns)) {
      values[key as MetricKey] = numeric(raw[columnIndex(column!)], ['sales', 'stock', 'aged', 'plan'].includes(key), `${sheet}!${column}${row}`);
    }
    if (values.stock != null && values.aged != null && values.aged > values.stock)
      throw new Error(`${sheet}, строка ${row}: склад 45+ превышает весь склад.`);
    return { name, key: normalize(name), row, values };
  };
  // This source contract puts the official all-network total at row 2.
  // Blank A2 is deliberate, not a missing branch name. Never sum it with branches.
  const totalLabel = normalize(String(rows[1][0] ?? ''));
  if (totalLabel && !['итого', 'всего', 'итого по сети', 'total'].includes(totalLabel))
    throw new Error('Не найдена отдельная итоговая строка 2. Импорт остановлен.');
  const total = readRow(rows[1], 2, 'Вся сеть · итог отчёта');
  if (Object.values(total.values).every(v => v == null)) throw new Error('Итоговая строка отчёта пуста.');
  const branches: ReportRow[] = [];
  const seen = new Set<string>();
  for (let i = 2; i < rows.length; i++) {
    const raw = rows[i];
    if (raw.every(v => v == null || v === '')) continue;
    if (typeof raw[0] !== 'string' || !raw[0].trim() || raw[0].length > 160)
      throw new Error(`${sheet}!A${i + 1}: отсутствует или некорректно название филиала.`);
    const name = raw[0].replace(/\s+/g, ' ').trim();
    const key = normalize(name);
    if (seen.has(key)) throw new Error(`${sheet}!A${i + 1}: повторное название филиала.`);
    if (['итого', 'всего', 'total'].includes(key)) throw new Error(`${sheet}!A${i + 1}: дополнительная итоговая строка не поддерживается.`);
    seen.add(key);
    branches.push(readRow(raw, i + 1, name));
  }
  if (!branches.length) throw new Error('В отчёте не найдены филиалы для сверки.');
  return { kind, file, sheet, columns, stockDate, total, branches };
}
export function selectRow(report: Report | undefined, key: string): ReportRow | undefined {
  return key === '' ? report?.total : report?.branches.find(r => r.key === key);
}
export function sourceAddress(report: Report | undefined, row: ReportRow | undefined, metric: MetricKey): string {
  const column = report?.columns[metric];
  return report && row && column ? `${report.sheet}!${column}${row.row}` : 'Нет ячейки в источнике';
}
export function reconcile(report: Report) {
  return (Object.keys(report.columns) as MetricKey[]).map(metric => {
    const official = report.total.values[metric] ?? null;
    const values = report.branches.map(r => r.values[metric]);
    const complete = values.every(v => v != null);
    const sum = complete ? values.reduce<number>((a, v) => a + v!, 0) : null;
    const delta = official != null && sum != null ? sum - official : null;
    return { metric, official, sum, delta, matches: delta != null && Math.abs(delta) < 0.01 };
  });
}
export function comparisonIssues(reports: Report[]): string[] {
  const summary = reports.find(r => r.kind === 'summary');
  const sales = reports.find(r => r.kind === 'sales');
  if (!summary || !sales) return [];
  const issues: string[] = [];
  const keys = new Set([...summary.branches, ...sales.branches].map(r => r.key));
  let missing = 0, mismatch = 0, incomplete = 0;
  for (const key of ['', ...keys]) {
    const a = selectRow(summary, key), b = selectRow(sales, key);
    if (!a || !b) { missing++; continue; }
    for (const metric of ['sales', 'margin'] as const) {
      const x = a.values[metric], y = b.values[metric];
      if (x == null || y == null) { incomplete++; continue; }
      if (Math.abs(x - y) >= 0.01) mismatch++;
    }
  }
  if (missing) issues.push(`Различается состав филиалов: ${missing} есть только в одном отчёте. Все сохранены; пропуски не заменены нулями.`);
  if (mismatch) issues.push(`Продажи / маржа + КСО: ${mismatch} расхождений между отчётами. Карточки используют сводку, значения не складываются.`);
  if (incomplete) issues.push(`Межотчётная сверка неполна: ${incomplete} пар значений содержат пропуски.`);
  if (!mismatch && !incomplete) issues.push('Продажи и маржа + КСО совпадают в итогах и во всех общих филиалах двух отчётов.');
  return issues;
}
