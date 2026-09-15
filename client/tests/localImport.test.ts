// Deliberately synthetic. Never add uploaded workbooks, real branch names or
// source totals to fixtures or repository history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { detectReport, parseReport, numeric, validatePeriod, reconcile, comparisonIssues, selectRow } from '../src/imports/reportModel';
import { parseWorkbook } from '../src/imports/parseWorkbook';

function headers(kind = 'summary') {
  const h: unknown[] = [];
  h[0] = 'Франчайзи';
  if (kind === 'summary') {
    h[4] = 'Склад на 10.04.2030, шт.'; h[7] = 'Продажи Факт, шт.';
    h[11] = 'Выручка, руб.'; h[13] = 'Факт Маржа, руб.'; h[20] = 'Факт КСО, руб.';
    h[22] = 'Факт Маржа+КСО, руб.'; h[27] = 'Склад 45+ на 10.04.2030, шт.';
  } else {
    h[1] = 'План Кол-во, шт.'; h[2] = 'Факт Кол-во, шт.'; h[7] = 'Выручка, руб.';
    h[9] = 'Факт КСО, руб.'; h[12] = 'Факт Железо, руб.'; h[15] = 'Факт Маржа, руб.';
  }
  return h;
}
function summaryRows() {
  const make = (name: string | null, sales: number, margin: number, stock: number, aged: number) => {
    const r: unknown[] = []; r[0] = name; r[4] = stock; r[7] = sales;
    r[11] = 100; r[13] = margin - 5; r[20] = 5; r[22] = margin; r[27] = aged;
    return r;
  };
  const total = make(null, 8, 10, 12, 3);
  total[11] = 200; total[13] = 0; total[20] = 10;
  return [headers(), total, make('Филиал Альфа (тест)', 3, -20, 7, 1), make('Филиал Бета (тест)', 5, 30, 5, 2)];
}
const letter = (index: number): string => index < 26 ? String.fromCharCode(65 + index) : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + index % 26)}`;
const escape = (v: unknown) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
export function makeWorkbook(rows: unknown[][], shared = false): ArrayBuffer {
  const strings: string[] = [];
  const xmlRows = rows.map((row, i) => `<row r="${i + 1}">${row.map((value, j) => {
    if (value == null) return '';
    const address = `${letter(j)}${i + 1}`;
    if (typeof value === 'number') return `<c r="${address}"><v>${value}</v></c>`;
    if (shared) { const index = strings.push(String(value)) - 1; return `<c r="${address}" t="s"><v>${index}</v></c>`; }
    return `<c r="${address}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`;
  }).join('')}</row>`).join('');
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const parts: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    '_rels/.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8(`<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Synthetic" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet xmlns="${ns}"><sheetData>${xmlRows}</sheetData></worksheet>`),
  };
  if (shared) parts['xl/sharedStrings.xml'] = strToU8(`<sst xmlns="${ns}" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t>${escape(s)}</t></si>`).join('')}</sst>`);
  const result = zipSync(parts);
  return result.buffer.slice(result.byteOffset, result.byteOffset + result.byteLength) as ArrayBuffer;
}
test('null is not zero; money can be negative; strict finite numeric values', () => {
  for (const v of [null, undefined, '', '-', '—', '–']) assert.equal(numeric(v, true, 'S!A1'), null);
  assert.equal(numeric(0, true, 'S!A1'), 0);
  assert.equal(numeric('-1 234,56', false, 'S!A1'), -1234.56);
  assert.equal(numeric('1\u00a0234', true, 'S!A1'), 1234);
  for (const v of [NaN, Infinity, -Infinity, {}, true, 'oops', '12 34', '1e2', '1,234.56', 1e16])
    assert.throws(() => numeric(v, false, 'S!A1'));
  for (const v of [-1, 1.5, '-2']) assert.throws(() => numeric(v, true, 'S!A1'));
});
test('dates are explicit, valid and independent of stock', () => {
  const period = { start: '2030-04-01', end: '2030-04-08', planStart: '', planEnd: '' };
  validatePeriod(period);
  for (const patch of [{ start: '' }, { end: '2030-02-30' }, { start: '2030-05-01' }, { planStart: '2030-04-01' }])
    assert.throws(() => validatePeriod({ ...period, ...patch }));
  validatePeriod({ ...period, planStart: '2030-04-01', planEnd: '2030-04-30' });
});
test('header detection, official totals, KSO semantics, source rows and reconciliation', () => {
  const report = parseReport(summaryRows(), 'summary', 'arbitrary-name.xlsx', 'Synthetic');
  assert.equal(detectReport(headers()), 'summary');
  assert.equal(detectReport(headers('sales')), 'sales');
  assert.equal(detectReport(['VIN', 'private detail']), null);
  assert.equal(report.total.values.sales, 8);
  assert.equal(report.total.values.margin, 10);
  assert.equal(report.total.values.baseMargin, 0);
  assert.equal(report.branches[0].values.margin, -20);
  assert.equal(report.stockDate, '2030-04-10');
  assert.equal(report.branches[1].row, 4);
  assert(reconcile(report).every(c => c.matches));
});
test('invalid totals, duplicate names, count and row guards reject', () => {
  for (const mutate of [
    (r: unknown[][]) => { r[1][0] = 'Not a total'; },
    (r: unknown[][]) => { r[3][0] = '  Филиал Альфа (тест)  '; },
    (r: unknown[][]) => { r[2][7] = -1; },
    (r: unknown[][]) => { r[2][7] = 1.2; },
    (r: unknown[][]) => { r[2][27] = 20; },
    (r: unknown[][]) => { r[0][27] = 'Склад 45+ на 11.04.2030, шт.'; },
    (r: unknown[][]) => { r[2][0] = ''; },
  ]) { const rows = summaryRows(); mutate(rows); assert.throws(() => parseReport(rows, 'summary', 'test.xlsx', 'Synthetic')); }
  assert.throws(() => parseReport(Array(503).fill([]), 'summary', 'test.xlsx', 'Synthetic'));
});
test('reconciliation flags differences and incomplete values, no silent sum', () => {
  const rows = summaryRows(); rows[2][7] = '-'; rows[1][22] = 9;
  const report = parseReport(rows, 'summary', 'test.xlsx', 'Synthetic');
  const sales = reconcile(report).find(c => c.metric === 'sales')!;
  assert.equal(sales.sum, null); assert.equal(sales.matches, false);
  assert.equal(reconcile(report).find(c => c.metric === 'margin')!.delta, 1);
});
test('different branch sets never inner-join or fill a missing source', () => {
  const summary = parseReport(summaryRows(), 'summary', 'summary.xlsx', 'Synthetic');
  const rows = [headers('sales'), [null, 10, 8], ['Филиал Гамма (тест)', 10, 8]];
  rows[1][9] = 0; rows[1][12] = 10; rows[1][15] = 10;
  rows[2][9] = 0; rows[2][12] = 10; rows[2][15] = 10;
  const sales = parseReport(rows, 'sales', 'sales.xlsx', 'Synthetic');
  assert.equal(selectRow(sales, summary.branches[0].key), undefined);
  assert(comparisonIssues([summary, sales]).some(s => s.includes('3 есть только')));
});
test('real XLSX decoding with inline and shared strings; filename does not classify', async () => {
  for (const shared of [false, true]) {
    const report = await parseWorkbook(makeWorkbook(summaryRows(), shared), 'uuid-or-any-name.xlsx');
    assert.equal(report?.total.values.sales, 8); assert.equal(report?.total.values.margin, 10);
    assert.equal(report?.sheet, 'Synthetic'); assert.equal(report?.branches[0].values.margin, -20);
  }
});
test('unsupported data, invalid archive and oversized sparse row are guarded', async () => {
  assert.equal(await parseWorkbook(makeWorkbook([['VIN', 'Staff'], ['PRIVATE_SENTINEL', 'NOT_FOR_DOM']]), 'summary.xlsx'), null);
  await assert.rejects(parseWorkbook(new ArrayBuffer(20), 'test.xlsx'));
  const sparse: unknown[][] = summaryRows(); sparse[600] = ['late row'];
  await assert.rejects(parseWorkbook(makeWorkbook(sparse), 'test.xlsx'));
});
test('cached formulas are read, uncached formulas are missing; no evaluation', async () => {
  for (const cached of [true, false]) {
    const parts = unzipSync(new Uint8Array(makeWorkbook(summaryRows())));
    parts['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(parts['xl/worksheets/sheet1.xml'])
      .replace('<c r="H3"><v>3</v></c>', `<c r="H3"><f>1+2</f>${cached ? '<v>3</v>' : ''}</c>`));
    const zip = zipSync(parts);
    const report = await parseWorkbook(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), 'formula.xlsx');
    assert.equal(report?.branches[0].values.sales, cached ? 3 : null);
  }
});
test('duplicate cell addresses cannot override a fact silently', async () => {
  const parts = unzipSync(new Uint8Array(makeWorkbook(summaryRows())));
  parts['xl/worksheets/sheet1.xml'] = strToU8(strFromU8(parts['xl/worksheets/sheet1.xml'])
    .replace('<c r="H3"><v>3</v></c>', '<c r="H3"><v>3</v></c><c r="H3"><v>6</v></c>'));
  const zip = zipSync(parts);
  await assert.rejects(parseWorkbook(zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength), 'duplicate.xlsx'));
});
