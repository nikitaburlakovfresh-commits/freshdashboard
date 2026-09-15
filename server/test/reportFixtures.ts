// Synthetic only. Never use real workbooks in the public repository.
import {zipSync,strToU8} from 'fflate';
export function headers(kind = 'summary') {
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
export function summaryRows() {
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

export function salesRows() { const row=(name:string|null,count:number)=>{const r:unknown[]=[];r[0]=name;r[1]=count;r[2]=count;r[7]=count*100;r[9]=0;r[12]=count;r[15]=count;return r;};return [headers('sales'),row(null,8),row('Филиал Альфа (тест)',3),row('Филиал Бета (тест)',5)];}
