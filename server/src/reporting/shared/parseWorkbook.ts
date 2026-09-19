import { unzipSync, strFromU8 } from 'fflate';
import { readSheet } from 'read-excel-file/universal';
import { detectReport, parseReport, type Report } from './reportModel';

// Closed, single-sheet aggregate format. Classification uses only header cells,
// never a UUID/file name. Unsupported detail rows are not parsed into records.
const MAX_EXPANDED = 50 * 1024 * 1024;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeXml = (text: string) => text.replace(/&#x([0-9a-f]+);|&#(\d+);|&(amp|lt|gt|quot|apos);/gi,
  (_, hex, decimal, named) => hex || decimal
    ? String.fromCodePoint(Math.min(0x10ffff, parseInt(hex || decimal, hex ? 16 : 10)))
    : (ENTITIES[named.toLowerCase()] ?? ''));
const textNodes = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => decodeXml(m[1])).join('');
const attr = (xml: string, name: string) => xml.match(new RegExp(`\\b${name}=["']([^"']*)["']`))?.[1];

export async function parseWorkbook(buffer: ArrayBuffer, file: string): Promise<Report | null> {
  const bytes = new Uint8Array(buffer);
  let expanded = 0, count = 0;
  const entries = new Set<string>();
  // Inspect the central directory before allocating decompressed entries.
  unzipSync(bytes, { filter: entry => {
    expanded += entry.originalSize; count++;
    if (count > 250 || expanded > MAX_EXPANDED || entry.originalSize > 30 * 1024 * 1024 ||
        entries.has(entry.name) || entry.name.includes('..') || /vbaProject/i.test(entry.name))
      throw new Error('Архив Excel превышает безопасные лимиты или содержит неподдерживаемую структуру.');
    entries.add(entry.name);
    return false;
  } });
  const sheets = [...entries].filter(n => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  if (sheets.length !== 1 || sheets[0] !== 'xl/worksheets/sheet1.xml') return null;
  const parts = unzipSync(bytes, { filter: e => ['xl/worksheets/sheet1.xml', 'xl/sharedStrings.xml', 'xl/workbook.xml'].includes(e.name) });
  const sheetXml = strFromU8(parts['xl/worksheets/sheet1.xml']);
  const workbookXml = parts['xl/workbook.xml'] ? strFromU8(parts['xl/workbook.xml']) : '';
  // Многоуровневая шапка занимает до трёх строк; читаем ровно их и не больше.
  const headerXml = [1, 2, 3]
    .map(r => sheetXml.match(new RegExp(`<row\\b[^>]*\\br=["']${r}["'][^>]*>([\\s\\S]*?)</row>`))?.[1] ?? '')
    .join('');
  if (!headerXml || headerXml.length > 300000) return null;
  const cells = [...headerXml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)];
  const neededStrings = new Set<number>();
  for (const cell of cells) if (attr(cell[1], 't') === 's') neededStrings.add(Number(cell[2]?.match(/<v>(.*?)<\/v>/)?.[1]));
  const strings = new Map<number, string>();
  if (parts['xl/sharedStrings.xml']) {
    const shared = strFromU8(parts['xl/sharedStrings.xml']);
    let i = 0;
    for (const m of shared.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) {
      if (neededStrings.has(i)) strings.set(i, textNodes(m[1]));
      i++;
    }
  }
  // Часть источников объявляет формат многоуровневой шапкой (до трёх строк),
  // поэтому классификация читает первые три строки, но только их.
  const headerRows: unknown[][] = [[], [], []];
  for (const cell of cells) {
    const address = attr(cell[1], 'r')?.match(/^([A-Z]{1,2})([1-3])$/);
    if (!address) continue;
    const index = [...address[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
    const xml = cell[2] ?? '';
    headerRows[Number(address[2]) - 1][index] = attr(cell[1], 't') === 's'
      ? strings.get(Number(xml.match(/<v>(.*?)<\/v>/)?.[1])) : textNodes(xml);
  }
  const kind = detectReport(headerRows);
  if (!kind) return null;
  if (/<!DOCTYPE|<!ENTITY|<[A-Za-z][\w.-]*:/i.test(sheetXml))
    throw new Error('Некорректная или неподдерживаемая структура XML отчёта.');
  // Bounds apply before the library allocates sparse arrays from row/cell refs.
  let rowCount = 0;
  const rowRefs = new Set<number>();
  for (const m of sheetXml.matchAll(/<row\b([^>]*)>/g)) {
    const row = Number(attr(m[1], 'r'));
    if (++rowCount > 502 || !Number.isInteger(row) || row < 1 || row > 502)
      throw new Error('Превышен лимит строк агрегатного отчёта (500 филиалов).');
    if (rowRefs.has(row)) throw new Error('Некорректная структура: повторный адрес строки.');
    rowRefs.add(row);
  }
  const cellRefs = new Set<string>();
  for (const m of sheetXml.matchAll(/<c\b([^>]*)>/g)) {
    const address = attr(m[1], 'r')?.match(/^([A-Z]{1,2})(\d+)$/);
    if (!address) throw new Error('Некорректный адрес ячейки.');
    const column = [...address[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
    if (column > 64 || Number(address[2]) < 1 || Number(address[2]) > 502) throw new Error('Ячейки вне допустимого диапазона отчёта.');
    if (cellRefs.has(address[0])) throw new Error('Некорректная структура: повторный адрес ячейки.');
    cellRefs.add(address[0]);
  }
  const sheetTag = workbookXml.match(/<sheet\b[^>]*>/)?.[0] ?? '';
  const sheetName = decodeXml(attr(sheetTag, 'name') ?? 'Sheet1');
  if (sheetName.length > 100) throw new Error('Некорректное имя листа.');
  const rows = await readSheet(buffer, 1, { trim: false });
  return parseReport(rows, kind, file, sheetName);
}
