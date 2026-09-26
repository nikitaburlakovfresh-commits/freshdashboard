// Детальный контур: построчные выгрузки уровня автомобиля (VIN) и уровня
// сотрудника. Контур отделён от агрегатного: свои лимиты, своя политика
// персональных данных и своё хранилище. Значения не досчитываются и не
// агрегируются здесь — отсутствие данных остаётся отсутствием.
import { normalize, numeric, validDate } from './reportModel';

export type DetailKind = 'vinInventory' | 'managerDiscounts';
export const DETAIL_ROW_LIMIT = 8000;
export const DETAIL_COLUMN_LIMIT = 64;
export const DETAIL_NAMES: Record<DetailKind, string> = {
  vinInventory: 'Склад по автомобилям (VIN)',
  managerDiscounts: 'Скидки по менеджерам',
};
// Столбцы источника с персональными данными и внешними ссылками. Они
// намеренно НЕ переносятся в состояние портала на этом этапе: основания
// обработки и срок хранения по 152-ФЗ отдельно не утверждены.
export const VIN_PERSONAL_COLUMNS = ['Эксперт-Оценщик', 'Подтвердил Сделку', 'Диагност', 'Технический Координатор'];
// «Ссылка на ТС» с 26.09.2026 переносится: руководитель переходит из портала
// сразу в карточку автомобиля в CRM. Принимается только адрес CRM FreshAuto.
export const VIN_EXTERNAL_COLUMNS: string[] = [];
const CRM_URL = /^https:\/\/crm\.freshauto\.ru\/[A-Za-z0-9/_.\-]{1,300}$/;

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const FRAME_RE = /^[A-Z0-9-]{8,20}$/;
const upper = (raw: unknown) => String(raw ?? '').normalize('NFKC').replace(/\s/g, '').toUpperCase()
  .replace(/[АВЕКМНОРСТУХ]/g, c => 'ABEKMHOPCTYX'['АВЕКМНОРСТУХ'.indexOf(c)]);
export const normalizeVin = (raw: unknown): string | null => {
  const value = upper(raw);
  return VIN_RE.test(value) ? value : null;
};
// Часть склада (праворульные автомобили) физически не имеет VIN — у них номер
// кузова. Такие строки не выбрасываются и не выдаются за VIN: сохраняется вид ключа.
export const normalizeVehicleKey = (raw: unknown): { key: string; kind: 'VIN' | 'FRAME' } | null => {
  const value = upper(raw);
  if (VIN_RE.test(value)) return { key: value, kind: 'VIN' };
  return FRAME_RE.test(value) ? { key: value, kind: 'FRAME' } : null;
};

const columnIndex = (column: string) => [...column].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
const cell = (row: unknown[] | undefined, column: string) => String(row?.[columnIndex(column)] ?? '');
const at = (row: unknown[] | undefined, column: string, expected: string) => normalize(cell(row, column)) === normalize(expected);

export interface VehicleRow {
  row: number; vin: string; keyKind: 'VIN' | 'FRAME'; location: string; locationKey: string; city: string | null;
  supplyType: string | null; daysOnStock: number | null; marginRub: number | null; profitability: number | null;
  costRub: number | null; salePriceRub: number | null; marketPriceRub: number | null; leads: number | null;
  notAdvertisedShare: number | null; arrivalDate: string | null; advertisedDate: string | null;
  // Описание автомобиля и счётчики изменений цены из того же отчёта «Анализ
  // склада». Нужны реестру в том объёме, в каком он работает на старом портале.
  make: string | null; model: string | null; productionYear: number | null;
  color: string | null; mileage: number | null; advertisingStatus: string | null;
  pppSumRub: number | null; marketDiffRub: number | null;
  priceChangesCount: number | null; priceChangesSumRub: number | null; priceChangesDays: number | null;
  erkCount: number | null; erkDays: number | null; avitoCostRub: number | null;
  crmUrl: string | null;
}
export interface ManagerDiscountRow {
  row: number; manager: string; managerKey: string; carsIssued: number | null; discountCount: number | null;
  discountShare: number | null; discountSumRub: number | null; unitDiscountRub: number | null;
  salePriceRub: number | null; discountOfPrice: number | null;
}
export interface ManagerVehicleDiscount extends ManagerDiscountRow { vin: string; keyKind: 'VIN' | 'FRAME' }
export interface DetailExcluded { row: number; label: string; reason: string }
export interface DetailReport {
  kind: DetailKind; file: string; sheet: string;
  vehicles: VehicleRow[]; managers: ManagerDiscountRow[]; vehicleDiscounts: ManagerVehicleDiscount[];
  total: ManagerDiscountRow | null; excluded: DetailExcluded[];
  locations: string[]; personalColumnsDropped: string[]; conflicts: DetailExcluded[];
  keyKinds: { vin: number; frame: number };
  reconciliation: { metric: string; rows: number; total: number; matches: boolean }[];
  observedOn: null; // источник не объявляет дату среза; она приходит подтверждённым периодом
}

export function detectDetail(rows: unknown[][]): DetailKind | null {
  const h = rows[0];
  if (at(h, 'A', 'Количество') && at(h, 'C', 'Локация') && at(h, 'I', 'Автомобиль VIN') &&
      at(h, 'K', 'Срок хранения CRM, дн.') && at(h, 'P', 'Цена продажи, руб.')) return 'vinInventory';
  if (at(h, 'A', 'Менеджер') && at(h, 'B', 'VIN') && at(h, 'C', 'Выдано авто, шт') &&
      at(h, 'D', 'Количество скидок, шт.') && at(h, 'F', 'Сумма Скидок, руб.') &&
      at(h, 'H', 'Цена продажи, руб.')) return 'managerDiscounts';
  return null;
}

const excel = (value: unknown): string | null => {
  if (value instanceof Date) {
    const iso = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate())).toISOString().slice(0, 10);
    return validDate(iso) ? iso : null;
  }
  const text = String(value ?? '').trim();
  const dotted = text.match(/^(\d{2})\.(\d{2})\.(\d{4})/);
  if (dotted) { const iso = `${dotted[3]}-${dotted[2]}-${dotted[1]}`; return validDate(iso) ? iso : null; }
  const isoLike = text.match(/^\d{4}-\d{2}-\d{2}/);
  return isoLike && validDate(isoLike[0]) ? isoLike[0] : null;
};
const SERVICE_LOCATIONS = ['не определено', 'тип поставки'];
const EXCLUDE = (key: string): string | null => {
  if (SERVICE_LOCATIONS.includes(key)) return 'Служебная строка источника, не филиал сети.';
  if (/^архив(?:\s|$)/.test(key)) return 'Архивная локация; в управляемую сеть не входит.';
  return null;
};

export function parseDetail(rows: unknown[][], kind: DetailKind, file: string, sheet: string): DetailReport {
  if (rows.length < 2 || rows.length > DETAIL_ROW_LIMIT || rows.some(r => r.length > DETAIL_COLUMN_LIMIT))
    throw new Error(`Допустимо до ${DETAIL_ROW_LIMIT} строк и ${DETAIL_COLUMN_LIMIT} столбцов в детальной выгрузке.`);
  if (detectDetail(rows) !== kind) throw new Error('Заголовки детальной выгрузки не соответствуют поддерживаемому формату.');
  const excluded: DetailExcluded[] = [];
  const report: DetailReport = {
    kind, file, sheet, vehicles: [], managers: [], vehicleDiscounts: [], total: null, excluded, locations: [],
    conflicts: [], keyKinds: { vin: 0, frame: 0 },
    personalColumnsDropped: kind === 'vinInventory' ? [...VIN_PERSONAL_COLUMNS, ...VIN_EXTERNAL_COLUMNS] : [],
    reconciliation: [], observedOn: null,
  };
  const num = (raw: unknown[], column: string, row: number, count: boolean) =>
    numeric(raw[columnIndex(column)], count, `${sheet}!${column}${row}`);

  if (kind === 'vinInventory') {
    const seen = new Set<string>();
    const locations = new Set<string>();
    for (let i = 1; i < rows.length; i++) {
      const raw = rows[i], row = i + 1;
      if (raw.every(v => v == null || v === '')) continue;
      const location = cell(raw, 'C').replace(/\s+/g, ' ').trim();
      const label = location || cell(raw, 'B').trim() || `строка ${row}`;
      if (!location || location.length > 160) { excluded.push({ row, label, reason: 'Не указана локация автомобиля.' }); continue; }
      const key = normalize(location);
      const reason = EXCLUDE(key);
      if (reason) { excluded.push({ row, label: location, reason }); continue; }
      const identity = normalizeVehicleKey(raw[columnIndex('I')]);
      // Строка без любого пригодного идентификатора автомобиля не становится
      // записью склада и учитывается как дефект качества данных.
      if (!identity) { excluded.push({ row, label: location, reason: 'Строка без пригодного идентификатора автомобиля.' }); continue; }
      const { key: vin, kind: keyKind } = identity;
      // Повтор ключа не удаляется и не сливается: это конфликт источника,
      // который решает человек до публикации.
      if (seen.has(vin)) report.conflicts.push({ row, label: location, reason: `Повторный идентификатор ${vin} в одной выгрузке.` });
      seen.add(vin);
      locations.add(location);
      if (keyKind === 'VIN') report.keyKinds.vin++; else report.keyKinds.frame++;
      report.vehicles.push({
        row, vin, keyKind, location, locationKey: key,
        city: cell(raw, 'B').trim() || null,
        supplyType: cell(raw, 'J').trim() || null,
        daysOnStock: num(raw, 'K', row, true), marginRub: num(raw, 'L', row, false),
        profitability: num(raw, 'M', row, false), costRub: num(raw, 'N', row, false),
        salePriceRub: num(raw, 'P', row, false), marketPriceRub: num(raw, 'Q', row, false),
        leads: num(raw, 'AA', row, true), notAdvertisedShare: num(raw, 'AC', row, false),
        arrivalDate: excel(raw[columnIndex('BA')]), advertisedDate: excel(raw[columnIndex('BB')]),
        make: cell(raw, 'D').trim() || null, model: cell(raw, 'E').trim() || null,
        productionYear: num(raw, 'F', row, true), color: cell(raw, 'G').trim() || null,
        mileage: num(raw, 'H', row, true),
        pppSumRub: num(raw, 'O', row, false), marketDiffRub: num(raw, 'R', row, false),
        priceChangesCount: num(raw, 'V', row, true), erkCount: num(raw, 'W', row, false),
        priceChangesDays: num(raw, 'X', row, false), erkDays: num(raw, 'Y', row, false),
        priceChangesSumRub: num(raw, 'Z', row, false),
        advertisingStatus: cell(raw, 'AB').trim() || null,
        avitoCostRub: num(raw, 'AD', row, false),
        crmUrl: at(rows[0], 'AL', 'Ссылка на ТС') && CRM_URL.test(cell(raw, 'AL').trim()) ? cell(raw, 'AL').trim() : null,
      });
    }
    report.locations = [...locations].sort((a, b) => a.localeCompare(b, 'ru'));
    if (!report.vehicles.length) throw new Error('В детальной выгрузке склада нет ни одной строки с идентифицируемым автомобилем.');
    return report;
  }

  // Скидки по менеджерам: уровень сотрудника, филиал в источнике не указан.
  const readManager = (raw: unknown[], row: number, manager: string): ManagerDiscountRow => ({
    row, manager, managerKey: normalize(manager),
    carsIssued: num(raw, 'C', row, true), discountCount: num(raw, 'D', row, true),
    discountShare: num(raw, 'E', row, false), discountSumRub: num(raw, 'F', row, false),
    unitDiscountRub: num(raw, 'G', row, false), salePriceRub: num(raw, 'H', row, false),
    discountOfPrice: num(raw, 'I', row, false),
  });
  const totalLabel = normalize(cell(rows[1], 'A'));
  if (!['итоги', 'итого', 'всего'].includes(totalLabel))
    throw new Error('Не найдена отдельная итоговая строка 2 выгрузки скидок. Импорт остановлен.');
  report.total = readManager(rows[1], 2, 'Все менеджеры · итог отчёта');
  const seen = new Set<string>();
  for (let i = 2; i < rows.length; i++) {
    const raw = rows[i], row = i + 1;
    if (raw.every(v => v == null || v === '')) continue;
    const manager = cell(raw, 'A').replace(/\s+/g, ' ').trim();
    if (!manager || manager.length > 160) throw new Error(`${sheet}!A${row}: отсутствует или некорректно имя менеджера.`);
    const key = normalize(manager);
    if (['итоги', 'итого', 'всего'].includes(key)) { excluded.push({ row, label: manager, reason: 'Повторная итоговая строка источника.' }); continue; }
    // Источник выгружает иерархию: сводная строка менеджера и вложенные
    // строки по конкретным автомобилям. При пустой колонке VIN вложенную
    // строку нечем идентифицировать: она не сливается со сводной и не суммируется
    // второй раз, иначе скидки были бы посчитаны дважды.
    if (seen.has(key)) {
      const identity = normalizeVehicleKey(raw[columnIndex('B')]);
      if (!identity) {
        excluded.push({ row, label: manager, reason: 'Вложенная строка менеджера без идентификатора автомобиля; сливать её со сводной нельзя.' });
        report.conflicts.push({ row, label: manager, reason: 'Сводная и вложенная строки менеджера неразличимы.' });
        continue;
      }
      report.vehicleDiscounts.push({ ...readManager(raw, row, manager), vin: identity.key, keyKind: identity.kind });
      continue;
    }
    seen.add(key);
    report.managers.push(readManager(raw, row, manager));
  }
  if (!report.managers.length) throw new Error('В выгрузке скидок нет ни одной строки менеджера.');
  for (const v of report.vehicleDiscounts) if (v.keyKind === 'VIN') report.keyKinds.vin++; else report.keyKinds.frame++;
  // Сверяются только аддитивные величины; доли и удельные значения не складываются.
  for (const [metric, column] of [['carsIssued', 'C'], ['discountCount', 'D'], ['discountSumRub', 'F'], ['salePriceRub', 'H']] as const) {
    const total = report.total[metric];
    if (total == null) continue;
    const sum = report.managers.reduce((acc, m) => acc + (m[metric] ?? 0), 0);
    report.reconciliation.push({ metric: column, rows: sum, total, matches: Math.abs(sum - total) < 0.5 });
  }
  return report;
}
