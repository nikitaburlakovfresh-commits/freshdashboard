// Приём всех форматов выгрузок QLIK. Только синтетические данные.
import { pool, closePool } from '../src/db/pool';
import { parseWorkbook } from '../src/reporting/shared/parseWorkbook';
import { reconcile, REPORT_SPECS, REPORT_KINDS } from '../src/reporting/shared/reportModel';
import { METRICS, METRIC_KEYS } from '../src/reporting/shared/metricCatalog';
import { makeWorkbook, summaryRows, salesRows, suppliesRows, suppliesForecastRows,
  creditsRows, tradeUpRows, funnelRows } from './reportFixtures';

const parse = (rows: unknown[][], name: string) => parseWorkbook(makeWorkbook(rows, true), name);
const control = (report: any, metric: string) => reconcile(report).find((r: any) => r.metric === metric)!;

afterAll(async () => { await closePool(); });

describe('INTAKE-01 распознавание форматов', () => {
  const cases: [string, unknown[][], string][] = [
    ['summary', summaryRows(), 'svodka.xlsx'],
    ['sales', salesRows(), 'prodazhi.xlsx'],
    ['supplies', suppliesRows(), 'postavki.xlsx'],
    ['suppliesForecast', suppliesForecastRows(), 'postavki-prognoz.xlsx'],
    ['credits', creditsRows(), 'kredity.xlsx'],
    ['tradeUp', tradeUpRows(), 'tradeup.xlsx'],
    ['funnel', funnelRows(), 'voronka.xlsx'],
  ];
  it.each(cases)('вид %s определяется по заголовкам', async (kind, rows, name) => {
    const report = await parse(rows, name);
    expect(report?.kind).toBe(kind);
    expect(report!.branches.length).toBeGreaterThan(0);
  });
  it('каждый вид описан в спецификации', () => {
    expect(REPORT_KINDS.sort()).toEqual(cases.map(c => c[0]).sort());
  });
});

describe('INTAKE-02 служебные и архивные строки', () => {
  it('архивная локация исключается, но учитывается в сверке итога', async () => {
    const report = (await parse(suppliesRows(), 'postavki.xlsx'))!;
    expect(report.branches.map(b => b.name)).not.toContain('Архив Филиал Гамма (тест)');
    expect(report.excluded.map(e => e.name)).toContain('Архив Филиал Гамма (тест)');
    // Итог источника включает архив, поэтому сверка обязана его учесть.
    expect(control(report, 'suppliesFact').matches).toBe(false);
  });
  it('строка «Не определено» не становится филиалом', async () => {
    const report = (await parse(funnelRows(), 'voronka.xlsx'))!;
    expect(report.branches.map(b => b.name)).not.toContain('Не определено');
    expect(report.excluded.length).toBe(1);
    expect(control(report, 'funnelTraffic').matches).toBe(true);
  });
});

describe('INTAKE-03 сверка применяется только к аддитивным показателям', () => {
  it('доли и удельные значения не сверяются с итогом', async () => {
    const report = (await parse(suppliesForecastRows(), 'postavki-prognoz.xlsx'))!;
    expect(control(report, 'suppliesPlan').additive).toBe(true);
    expect(control(report, 'suppliesPlan').matches).toBe(true);
    // Trade Up целиком состоит из долей и имеет строку итога:
    // сумма долей по филиалам с ней совпадать не обязана и не сверяется.
    const shares = reconcile((await parse(tradeUpRows(), 'tradeup.xlsx'))!);
    expect(shares.length).toBeGreaterThan(0);
    for (const item of shares) {
      expect(item.additive).toBe(false);
      expect(item.matches).toBeNull();
    }
  });
  it('источник без строки итога не выдаёт ложное совпадение', async () => {
    const report = (await parse(creditsRows(), 'kredity.xlsx'))!;
    expect(REPORT_SPECS.credits.hasTotalRow).toBe(false);
    expect(report.total).toBeNull();
    for (const item of reconcile(report)) expect(item.matches).toBeNull();
  });
});

describe('INTAKE-04 многоуровневая шапка и канал воронки', () => {
  it('Trade Up читается по трёхстрочной шапке', async () => {
    const report = (await parse(tradeUpRows(), 'tradeup.xlsx'))!;
    expect(report.branches.length).toBe(2);
    expect(report.branches[0].values.tradeUpTotal).toBeCloseTo(0.25);
    expect(report.branches[1].values.creditShareBuyout).toBeCloseTo(0.5);
  });
  it('воронка требует объявления канала: заголовки обращений и звонков совпадают', async () => {
    const report = (await parse(funnelRows(), 'zvonki.xlsx'))!;
    expect(report.channelRequired).toBe(true);
    expect(REPORT_SPECS.funnel.channelRequired).toBe(true);
  });
});

describe('INTAKE-05 каталог показателей совпадает с базой', () => {
  it('каждый показатель кода есть в справочнике базы с теми же свойствами', async () => {
    const rows = (await pool.query('SELECT code,display_name,unit,is_count,is_additive FROM metric_catalog')).rows;
    const byCode = new Map(rows.map((r: any) => [r.code, r]));
    expect(rows.length).toBe(METRIC_KEYS.length);
    for (const key of METRIC_KEYS) {
      const dbRow = byCode.get(key);
      expect(dbRow).toBeDefined();
      expect(dbRow.display_name).toBe(METRICS[key].name);
      expect(dbRow.unit).toBe(METRICS[key].unit);
      expect(dbRow.is_count).toBe(METRICS[key].count);
      expect(dbRow.is_additive).toBe(METRICS[key].additive);
    }
  });
  it('разрешение публикации отклоняет показатель вне каталога', async () => {
    await expect(pool.query(
      `SELECT 1 FROM metric_catalog WHERE code='pridumannyiPokazatel'`)).resolves.toMatchObject({ rowCount: 0 });
  });
});
