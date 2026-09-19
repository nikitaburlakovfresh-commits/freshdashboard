// Only aggregate business values cross the worker boundary. No workbook, VIN,
// employee records, hyperlinks or unused columns are kept in application state.
import {
  METRICS, METRIC_KEYS, METRIC_NAMES, isAdditiveMetric, isCountMetric, isMetricKey,
  type MetricKey,
} from './metricCatalog';

export { METRICS, METRIC_KEYS, METRIC_NAMES, isAdditiveMetric, isCountMetric, isMetricKey };
export type { MetricKey };

export type ReportKind =
  | 'summary' | 'sales' | 'supplies' | 'suppliesForecast' | 'credits' | 'tradeUp' | 'funnel';
export type Values = Partial<Record<MetricKey, number | null>>;
export interface ReportRow { name: string; key: string; row: number; values: Values }
/** Служебные и архивные строки источника. Сохраняются отдельно: они не филиалы
 * сети, но входят в официальный итог отчёта, поэтому нужны для сверки. */
export interface ExcludedRow extends ReportRow { reason: string }
export interface Report {
  kind: ReportKind;
  file: string;
  sheet: string;
  stockDate?: string;
  /** Дата плана из заголовка, если источник её объявляет. */
  planDate?: string;
  columns: Partial<Record<MetricKey, string>>;
  total: ReportRow | null;
  branches: ReportRow[];
  excluded: ExcludedRow[];
  /** true, если формат источника не отличим по заголовкам от другого канала
   * и требует явного объявления загружающим (воронка обращений / звонков). */
  channelRequired?: boolean;
}
export interface ImportPeriod { start: string; end: string; planStart: string; planEnd: string }
export interface ReportBatch {
  reports: Report[];
  skipped: { file: string; reason: string }[];
  period: ImportPeriod;
}
export const REPORT_NAMES: Record<ReportKind, string> = {
  summary: 'Сводка продаж и склада',
  sales: 'Продажи · КСО и маржа',
  supplies: 'Поставки · план, факт, себестоимость',
  suppliesForecast: 'Поставки · прогноз и цена в закупке',
  credits: 'Финансовые услуги и кредиты',
  tradeUp: 'Trade Up и кредиты по типу поставки',
  funnel: 'Воронка обращений или звонков',
};
export const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('ru');
const TOTAL_LABELS = ['итого', 'всего', 'итого по сети', 'итоги', 'total'];
const SERVICE_LABELS = ['не определено', 'тип поставки'];

interface ReportSpec {
  /** Строка заголовка (1-based). */
  headerRow: number;
  /** Есть ли отдельная официальная итоговая строка сразу после заголовка. */
  hasTotalRow: boolean;
  columns: Partial<Record<MetricKey, string>>;
  channelRequired?: boolean;
}
export const REPORT_SPECS: Record<ReportKind, ReportSpec> = {
  summary: {
    headerRow: 1, hasTotalRow: true,
    columns: {
      suppliesFact: 'B', stockStart: 'C', stockStartCost: 'D', stock: 'E', stockCost: 'F', stockUnitCost: 'G',
      sales: 'H', outflow: 'I', turnoverBuyout: 'J', turnoverCommission: 'K', revenue: 'L',
      purchasePrice: 'M', baseMargin: 'N', unitMargin: 'O', ptzCost: 'P', ptzCount: 'Q',
      creditsCrm: 'R', creditsGoogle: 'S', royaltyKso: 'T', kso: 'U', unitKso: 'V',
      margin: 'W', unitMarginKso: 'X', mdProfitability: 'Y', saleDays: 'Z', stockDays: 'AA',
      aged: 'AB', agedCost: 'AC', agedShare: 'AD',
    },
  },
  sales: {
    headerRow: 1, hasTotalRow: true,
    columns: {
      plan: 'B', sales: 'C', forecast: 'E', purchasePrice: 'G', revenue: 'H',
      planKso: 'I', kso: 'J', planIron: 'L', factIron: 'M', planMargin: 'O', margin: 'P',
      forecastMargin: 'R', planUnitKso: 'T', planUnitMargin: 'U', unitMargin: 'V',
    },
  },
  supplies: {
    headerRow: 1, hasTotalRow: true,
    columns: { suppliesPlan: 'B', suppliesFact: 'C', suppliesPlanCost: 'D', suppliesFactCost: 'E' },
  },
  suppliesForecast: {
    headerRow: 1, hasTotalRow: true,
    columns: {
      suppliesPlan: 'B', suppliesFact: 'C', suppliesForecast: 'E',
      purchasePrice: 'F', suppliesForecastCost: 'G',
    },
  },
  credits: {
    headerRow: 1, hasTotalRow: false,
    columns: {
      creditsPlan: 'B', creditsGoogle: 'C', creditsCrm: 'D', brokerPlan: 'G', brokerFact: 'H',
      creditSharePlan: 'J', creditShareFact: 'K', creditKsoPlan: 'M', creditKsoFact: 'N',
      incomePerCreditPlan: 'P', incomePerCreditFact: 'Q', avgCreditPlan: 'S', avgCreditFact: 'T',
      incomeSharePlan: 'V', incomeShareFact: 'W',
    },
  },
  tradeUp: {
    headerRow: 3, hasTotalRow: true,
    columns: {
      tradeUpTotal: 'B', tradeUpCommission: 'C', tradeUpBuyout: 'D',
      creditShareTotal: 'E', creditShareCommission: 'F', creditShareBuyout: 'G',
    },
  },
  funnel: {
    headerRow: 1, hasTotalRow: true, channelRequired: true,
    columns: {
      funnelTraffic: 'B', funnelVisits: 'C', funnelTrafficToVisit: 'D', funnelDeals: 'E',
      funnelVisitToDeal: 'F', funnelTrafficToDeal: 'G',
    },
  },
};
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
const cell = (row: unknown[] | undefined, column: string) => String(row?.[columnIndex(column)] ?? '');
const at = (row: unknown[] | undefined, column: string, expected: string) =>
  normalize(cell(row, column)) === normalize(expected);
const DATE_HEADER = (text: string, prefix: RegExp) => prefix.test(text.trim());

/** Классификация только по ячейкам заголовка; имя файла не используется. */
export function detectReport(rows: unknown[][]): ReportKind | null {
  const h = rows[0];
  if (at(h, 'A', 'Франчайзи')) {
    if (at(h, 'H', 'Продажи Факт, шт.') && at(h, 'N', 'Факт Маржа, руб.') &&
        at(h, 'U', 'Факт КСО, руб.') && at(h, 'W', 'Факт Маржа+КСО, руб.') &&
        DATE_HEADER(cell(h, 'E'), /^Склад на \d{2}\.\d{2}\.\d{4}, шт\.$/i) &&
        DATE_HEADER(cell(h, 'AB'), /^Склад 45\+ на \d{2}\.\d{2}\.\d{4}, шт\.$/i))
      return 'summary';
    if (at(h, 'B', 'План Кол-во, шт.') && at(h, 'C', 'Факт Кол-во, шт.') &&
        at(h, 'H', 'Выручка, руб.') && at(h, 'J', 'Факт КСО, руб.') &&
        at(h, 'M', 'Факт Железо, руб.') && at(h, 'P', 'Факт Маржа, руб.')) return 'sales';
    if (DATE_HEADER(cell(h, 'B'), /^План на \d{2}\.\d{2}\.\d{4}, шт\.$/i) && at(h, 'C', 'Факт, шт.') &&
        at(h, 'D', 'План Себестоимость, руб.') && at(h, 'E', 'Факт Себестоимость, руб.')) return 'supplies';
    if (at(h, 'B', 'План, шт.') && at(h, 'C', 'Факт, шт.') && at(h, 'E', 'Прогноз, шт.') &&
        at(h, 'F', 'Цена в Закупке, руб.') && at(h, 'G', 'Прогноз, руб.')) return 'suppliesForecast';
    if (at(h, 'B', 'План Количество кредитов') && at(h, 'C', 'Факт Кол-во кредитов (Google)') &&
        at(h, 'D', 'Факт Кол-во кредитов (CRM)') && at(h, 'M', 'План КСО') &&
        at(h, 'V', 'План % дохода от суммы кредита')) return 'credits';
  }
  if (at(h, 'A', 'Дилер Первого Касания') && at(h, 'B', 'Трафик') && at(h, 'C', 'Визит') &&
      at(h, 'E', 'Сделки') && /^Конверсия \(Трафик → Визит\)/i.test(cell(h, 'D').trim()) &&
      /^Конверсия \(Трафик → Сделка\)/i.test(cell(h, 'G').trim())) return 'funnel';
  if (at(h, 'B', 'Trade Up') && at(h, 'E', 'Кредиты (crm)') &&
      at(rows[1], 'A', 'Тип Поставки') && at(rows[2], 'A', 'Франчайзи') &&
      ['B', 'E'].every(c => at(rows[2], c, 'Итоги')) &&
      ['C', 'F'].every(c => at(rows[2], c, 'Комиссия')) &&
      ['D', 'G'].every(c => at(rows[2], c, 'Выкуп'))) return 'tradeUp';
  return null;
}
function excludeReason(key: string, name: string): string | null {
  if (SERVICE_LABELS.includes(key)) return 'Служебная строка источника, не филиал сети.';
  // \b в JS опирается на ASCII и после кириллицы не срабатывает.
  if (/^архив(?:\s|$)/.test(key)) return 'Архивная локация; в управляемую сеть не входит.';
  if (!name.trim()) return null;
  return null;
}
export function parseReport(rows: unknown[][], kind: ReportKind, file: string, sheet: string): Report {
  const spec = REPORT_SPECS[kind];
  if (rows.length < spec.headerRow + 1 || rows.length > 502 || rows.some(r => r.length > 64))
    throw new Error('Допустимо до 500 филиалов и 64 столбцов в агрегатном отчёте.');
  if (detectReport(rows) !== kind) throw new Error('Заголовки отчёта не соответствуют поддерживаемому формату.');
  const { columns } = spec;
  const header = rows[spec.headerRow - 1];
  let stockDate: string | undefined, planDate: string | undefined;
  const headerDate = (column: string) => {
    const match = cell(header, column).match(/\d{2}\.\d{2}\.\d{4}/);
    return match ? match[0].split('.').reverse().join('-') : null;
  };
  if (kind === 'summary') {
    const dates = ['E', 'AB'].map(headerDate);
    if (!dates[0] || !validDate(dates[0]) || dates[0] !== dates[1])
      throw new Error('Даты склада и склада 45+ отсутствуют, некорректны или различаются.');
    stockDate = dates[0];
  }
  if (kind === 'supplies') {
    const date = headerDate('B');
    if (!date || !validDate(date)) throw new Error('Некорректная дата плана в заголовке отчёта поставок.');
    planDate = date;
  }
  const readRow = (raw: unknown[], row: number, name: string): ReportRow => {
    const values: Values = {};
    for (const [key, column] of Object.entries(columns)) {
      const metric = key as MetricKey;
      values[metric] = numeric(raw[columnIndex(column!)], isCountMetric(metric), `${sheet}!${column}${row}`);
    }
    if (values.stock != null && values.aged != null && values.aged > values.stock)
      throw new Error(`${sheet}, строка ${row}: склад 45+ превышает весь склад.`);
    return { name, key: normalize(name), row, values };
  };
  // Официальный итог сети объявляется отдельной строкой сразу после заголовка;
  // пустая ячейка названия здесь намеренна. Итог никогда не суммируется с филиалами.
  let total: ReportRow | null = null;
  let dataStart = spec.headerRow; // индекс первой строки данных (0-based)
  if (spec.hasTotalRow) {
    const totalRaw = rows[spec.headerRow];
    const label = normalize(String(totalRaw?.[0] ?? ''));
    if (label && !TOTAL_LABELS.includes(label))
      throw new Error(`Не найдена отдельная итоговая строка ${spec.headerRow + 1}. Импорт остановлен.`);
    total = readRow(totalRaw, spec.headerRow + 1, 'Вся сеть · итог отчёта');
    if (Object.values(total.values).every(v => v == null)) throw new Error('Итоговая строка отчёта пуста.');
    dataStart = spec.headerRow + 1;
  }
  const branches: ReportRow[] = [];
  const excluded: ExcludedRow[] = [];
  const seen = new Set<string>();
  for (let i = dataStart; i < rows.length; i++) {
    const raw = rows[i];
    if (raw.every(v => v == null || v === '')) continue;
    if (typeof raw[0] !== 'string' || !raw[0].trim() || raw[0].length > 160)
      throw new Error(`${sheet}!A${i + 1}: отсутствует или некорректно название филиала.`);
    const name = raw[0].replace(/\s+/g, ' ').trim();
    const key = normalize(name);
    if (seen.has(key)) throw new Error(`${sheet}!A${i + 1}: повторное название филиала.`);
    seen.add(key);
    if (TOTAL_LABELS.includes(key)) {
      if (spec.hasTotalRow) throw new Error(`${sheet}!A${i + 1}: дополнительная итоговая строка не поддерживается.`);
      throw new Error(`${sheet}!A${i + 1}: итоговая строка в неожидаемом месте. Импорт остановлен.`);
    }
    const reason = excludeReason(key, name);
    if (reason) excluded.push({ ...readRow(raw, i + 1, name), reason });
    else branches.push(readRow(raw, i + 1, name));
  }
  if (!branches.length) throw new Error('В отчёте не найдены филиалы для сверки.');
  return { kind, file, sheet, columns, stockDate, planDate, total, branches, excluded,
    channelRequired: spec.channelRequired };
}
export function selectRow(report: Report | undefined, key: string): ReportRow | undefined {
  return key === '' ? report?.total ?? undefined : report?.branches.find(r => r.key === key);
}
export function sourceAddress(report: Report | undefined, row: ReportRow | undefined, metric: MetricKey): string {
  const column = report?.columns[metric];
  return report && row && column ? `${report.sheet}!${column}${row.row}` : 'Нет ячейки в источнике';
}
/** Сверка «сумма строк = официальный итог» применяется только к аддитивным
 * показателям. Доли, удельные значения и сроки не складываются, поэтому для них
 * возвращается matches=null: это не расхождение и не подтверждение. */
export function reconcile(report: Report) {
  return (Object.keys(report.columns) as MetricKey[]).map(metric => {
    const additive = isAdditiveMetric(metric);
    const official = report.total?.values[metric] ?? null;
    if (!additive || !report.total)
      return { metric, additive, official, sum: null, delta: null, matches: null as boolean | null };
    // Служебные и архивные строки входят в официальный итог источника,
    // поэтому участвуют в контроле целостности, но не в сети филиалов.
    const values = [...report.branches, ...report.excluded].map(r => r.values[metric]);
    const complete = values.every(v => v != null);
    const sum = complete ? values.reduce<number>((a, v) => a + v!, 0) : null;
    const delta = official != null && sum != null ? sum - official : null;
    return { metric, additive, official, sum, delta,
      matches: delta != null ? Math.abs(delta) < 0.01 : null as boolean | null };
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

export const REPORT_KINDS = Object.keys(REPORT_SPECS) as ReportKind[];
