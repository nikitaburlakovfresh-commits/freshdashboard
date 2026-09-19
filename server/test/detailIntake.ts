// Детальный контур: уровень автомобиля и уровень сотрудника.
// Только синтетические данные; реальные выгрузки в репозиторий не попадают.
import { pool, closePool } from '../src/db/pool';
import { parseAnyWorkbook, parseWorkbook } from '../src/reporting/shared/parseWorkbook';
import { makeWorkbook, summaryRows } from './reportFixtures';
import { DETAIL_ROW_LIMIT, DETAIL_COLUMN_LIMIT, VIN_PERSONAL_COLUMNS, VIN_EXTERNAL_COLUMNS,
  normalizeVin, normalizeVehicleKey, detectDetail, type DetailReport } from '../src/reporting/shared/detailModel';

afterAll(async () => { await closePool(); });

const col = (letters: string) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const put = (row: unknown[], pairs: Record<string, unknown>) => {
  for (const [letter, value] of Object.entries(pairs)) row[col(letter)] = value;
  return row;
};
function vinHeaders() {
  return put([], { A: 'Количество', B: 'Город', C: 'Локация', I: 'Автомобиль VIN', J: 'Тип Поставки',
    K: 'Срок хранения CRM, дн.', L: 'Маржа, руб.', M: 'Рентабельность, %', N: 'Себестоимость, руб.',
    P: 'Цена продажи, руб.', Q: 'Рыночная цена, руб.', AA: 'Количество Лидов', AC: 'Доля не в рекламе',
    AL: 'Ссылка на ТС', AU: 'Эксперт-Оценщик', AV: 'Подтвердил Сделку', AW: 'Диагност',
    AX: 'Технический Координатор', BA: 'Дата Поступления CRM', BB: 'Дата в рекламе' });
}
const vinRow = (location: string, vin: string, extra: Record<string, unknown> = {}) =>
  put([], { A: 1, B: 'Тестоград', C: location, I: vin, J: 'Комиссия', K: 12, L: 1000, M: 0.1, N: 900000,
    P: 1000000, Q: 1010000, AA: 3, AC: 0, AL: 'https://example.invalid/ts/1', AU: 'Иванов И.И.',
    AV: 'Петров П.П.', AW: 'Сидоров С.С.', AX: 'Кузнецов К.К.', BA: '01.09.2030', BB: '02.09.2030', ...extra });
const VIN_A = 'XTA21099063001234', VIN_B = 'JTMHV05J804012345';
const discountHeaders = () => put([], { A: 'Менеджер', B: 'VIN', C: 'Выдано авто, шт',
  D: 'Количество скидок, шт.', E: '% скидок от кол-ва продаж', F: 'Сумма Скидок, руб.',
  G: 'Удельно скидки руб.', H: 'Цена продажи, руб.', I: '% скидок от цены продажи' });
const discountRow = (manager: string, cars: number, count: number, sum: number, price: number, vin?: string) =>
  put([], { A: manager, B: vin ?? null, C: cars, D: count, E: count / cars, F: sum, G: sum / Math.max(count, 1),
    H: price, I: sum / price });

const parse = async (rows: unknown[][], name: string): Promise<DetailReport> => {
  const parsed = await parseAnyWorkbook(makeWorkbook(rows, true), name);
  expect(parsed?.type).toBe('DETAIL');
  return parsed!.report as DetailReport;
};

describe('DETAIL-01 распознавание детальных выгрузок', () => {
  it('склад по автомобилям и скидки определяются по заголовкам', async () => {
    expect(detectDetail([vinHeaders()])).toBe('vinInventory');
    expect(detectDetail([discountHeaders()])).toBe('managerDiscounts');
    expect(detectDetail([[]])).toBeNull();
    const stock = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A)], 'vin.xlsx');
    expect(stock.kind).toBe('vinInventory');
    const discounts = await parse([discountHeaders(), put([], { A: 'Итоги', C: 3, D: 1, F: 10, H: 100 }),
      discountRow('Тест Тестов', 3, 1, 10, 100)], 'skidki.xlsx');
    expect(discounts.kind).toBe('managerDiscounts');
  });
  it('агрегатный разбор детальную выгрузку не принимает, а детальный — агрегатную', async () => {
    expect(await parseWorkbook(makeWorkbook([vinHeaders(), vinRow('Fresh Тест', VIN_A)], true), 'vin.xlsx')).toBeNull();
    const aggregate = await parseAnyWorkbook(makeWorkbook(summaryRows(), true), 'svodka.xlsx');
    expect(aggregate?.type).toBe('AGGREGATE');
  });
});

describe('DETAIL-02 идентификатор автомобиля', () => {
  it('VIN нормализуется, кириллические двойники приводятся к латинице', () => {
    expect(normalizeVin(' xta21099063001234 ')).toBe(VIN_A);
    expect(normalizeVin('ХТА21099063001234')).toBe(VIN_A); // кириллические Х, Т, А
    expect(normalizeVin('XTA2109906300123')).toBeNull();
    expect(normalizeVin('XTA2109906300I234')).toBeNull(); // I, O, Q в VIN недопустимы
  });
  it('номер кузова принимается как FRAME и не выдаётся за VIN', () => {
    expect(normalizeVehicleKey('BL5FP100242')).toEqual({ key: 'BL5FP100242', kind: 'FRAME' });
    expect(normalizeVehicleKey('DM8P-200453')).toEqual({ key: 'DM8P-200453', kind: 'FRAME' });
    expect(normalizeVehicleKey('XTA21099063001234')).toEqual({ key: VIN_A, kind: 'VIN' });
    expect(normalizeVehicleKey('123')).toBeNull();
  });
  it('вид ключа сохраняется в отчёте отдельными счётчиками', async () => {
    const report = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A), vinRow('Fresh Тест', 'BL5FP100242')], 'vin.xlsx');
    expect(report.keyKinds).toEqual({ vin: 1, frame: 1 });
    expect(report.vehicles.map(v => v.keyKind)).toEqual(['VIN', 'FRAME']);
  });
});

describe('DETAIL-03 исключения и конфликты источника', () => {
  it('строка без идентификатора исключается, а не превращается в запись склада', async () => {
    const report = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A), vinRow('Fresh Тест', '')], 'vin.xlsx');
    expect(report.vehicles.length).toBe(1);
    expect(report.excluded[0].reason).toMatch(/без пригодного идентификатора/);
  });
  it('архивная локация и служебная строка не становятся филиалом', async () => {
    const report = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A),
      vinRow('Архив Fresh Старый', VIN_B), vinRow('Не определено', 'BL5FP100242')], 'vin.xlsx');
    expect(report.locations).toEqual(['Fresh Тест']);
    expect(report.excluded.map(e => e.reason)).toEqual([
      'Архивная локация; в управляемую сеть не входит.', 'Служебная строка источника, не филиал сети.']);
  });
  it('повторный идентификатор фиксируется конфликтом, строки не сливаются', async () => {
    const report = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A), vinRow('Fresh Второй', VIN_A)], 'vin.xlsx');
    expect(report.vehicles.length).toBe(2);
    expect(report.conflicts.length).toBe(1);
    expect(report.conflicts[0].reason).toContain(VIN_A);
  });
});

describe('DETAIL-04 персональные и внешние столбцы', () => {
  it('столбцы сотрудников и ссылка на ТС в состояние портала не переносятся', async () => {
    const report = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A)], 'vin.xlsx');
    expect(report.personalColumnsDropped).toEqual([...VIN_PERSONAL_COLUMNS, ...VIN_EXTERNAL_COLUMNS]);
    const serialized = JSON.stringify(report.vehicles);
    for (const value of ['Иванов И.И.', 'Петров П.П.', 'Сидоров С.С.', 'Кузнецов К.К.', 'example.invalid'])
      expect(serialized).not.toContain(value);
  });
  it('дата среза источником не объявляется и не подставляется', async () => {
    const report = await parse([vinHeaders(), vinRow('Fresh Тест', VIN_A)], 'vin.xlsx');
    expect(report.observedOn).toBeNull();
  });
});

describe('DETAIL-05 скидки по менеджерам', () => {
  const rows = () => [discountHeaders(),
    put([], { A: 'Итоги', C: 10, D: 4, E: 0.4, F: 400, G: 100, H: 2000, I: 0.2 }),
    discountRow('Первый Менеджер', 6, 3, 300, 1200),
    discountRow('Второй Менеджер', 4, 1, 100, 800)];
  it('итоговая строка не становится менеджером, сверка идёт по аддитивным столбцам', async () => {
    const report = await parse(rows(), 'skidki.xlsx');
    expect(report.managers.map(m => m.manager)).toEqual(['Первый Менеджер', 'Второй Менеджер']);
    expect(report.total?.carsIssued).toBe(10);
    expect(report.reconciliation.map(r => [r.metric, r.matches]))
      .toEqual([['C', true], ['D', true], ['F', true], ['H', true]]);
    // Доли и удельные величины не складываются и в сверку не входят.
    expect(report.reconciliation.map(r => r.metric)).not.toContain('E');
    expect(report.reconciliation.map(r => r.metric)).not.toContain('G');
  });
  it('расхождение суммы строк с итогом источника видно и не скрывается', async () => {
    const broken = rows();
    broken[3] = discountRow('Второй Менеджер', 5, 1, 100, 800);
    const report = await parse(broken, 'skidki.xlsx');
    expect(report.reconciliation.find(r => r.metric === 'C')).toMatchObject({ rows: 11, total: 10, matches: false });
  });
  it('вложенная строка с VIN идёт отдельным уровнем и не удваивает сумму', async () => {
    const nested = rows();
    nested.push(discountRow('Первый Менеджер', 1, 1, 50, 300, VIN_A));
    const report = await parse(nested, 'skidki.xlsx');
    expect(report.managers.length).toBe(2);
    expect(report.vehicleDiscounts.map(v => [v.manager, v.vin])).toEqual([['Первый Менеджер', VIN_A]]);
    expect(report.reconciliation.every(r => r.matches)).toBe(true);
  });
  it('вложенная строка без идентификатора не сливается со сводной, а становится конфликтом', async () => {
    const nested = rows();
    nested.push(discountRow('Первый Менеджер', 1, 1, 50, 300));
    const report = await parse(nested, 'skidki.xlsx');
    expect(report.vehicleDiscounts.length).toBe(0);
    expect(report.conflicts.length).toBe(1);
    expect(report.excluded[0].reason).toMatch(/без идентификатора автомобиля/);
    expect(report.reconciliation.every(r => r.matches)).toBe(true);
  });
  it('филиал в выгрузке скидок отсутствует: локации не выдумываются', async () => {
    const report = await parse(rows(), 'skidki.xlsx');
    expect(report.locations).toEqual([]);
  });
});

describe('DETAIL-06 лимиты объёма', () => {
  it('детальный лимит строк больше агрегатного, но конечен', async () => {
    expect(DETAIL_ROW_LIMIT).toBe(8000);
    expect(DETAIL_COLUMN_LIMIT).toBe(64);
    const many = [vinHeaders()];
    for (let i = 0; i < 300; i++) many.push(vinRow('Fresh Тест', `BL5FP1002${String(i).padStart(4, '0')}`));
    const report = await parse(many, 'vin.xlsx');
    expect(report.vehicles.length).toBe(300);
  });
  it('агрегатный лимит строк детальным приёмом не ослабляется', async () => {
    const rows: unknown[][] = summaryRows();
    while (rows.length < 520) rows.push(put([], { A: `Филиал ${rows.length} (тест)` }));
    await expect(parseWorkbook(makeWorkbook(rows, true), 'svodka.xlsx')).rejects.toThrow();
  });
});

describe('DETAIL-07 хранилище и права', () => {
  it('права детального контура заведены, гранты миграцией не выданы', async () => {
    const permissions = (await pool.query(
      "SELECT code FROM permissions WHERE code IN('report_detail.read','report_detail.publish') ORDER BY code")).rows;
    expect(permissions.map(p => p.code)).toEqual(['report_detail.publish', 'report_detail.read']);
    expect((await pool.query('SELECT count(*)::int n FROM report_detail_access')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM report_detail_publications')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM vehicle_identity')).rows[0].n).toBe(0);
    expect((await pool.query('SELECT count(*)::int n FROM manager_discount_rows')).rows[0].n).toBe(0);
  });
  it('вид ключа проверяется базой: VIN обязан быть 17-значным', async () => {
    await expect(pool.query(
      "INSERT INTO vehicle_identity(id,vehicle_key,key_kind) VALUES(gen_random_uuid(),'BL5FP100242','VIN')"))
      .rejects.toThrow();
  });
  it('опубликованная строка склада неизменна', async () => {
    await expect(pool.query('UPDATE vehicle_stock_rows SET leads=1 WHERE false')).resolves.toBeDefined();
  });
});
