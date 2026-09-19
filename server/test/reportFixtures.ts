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

// Синтетические выгрузки остальных форматов QLIK. Структура шапок повторяет
// реальные выгрузки, значения выдуманы и к бизнесу отношения не имеют.
const row = (cells: Record<number, unknown>) => { const r: unknown[] = []; for (const [k, v] of Object.entries(cells)) r[Number(k)] = v; return r; };

export function suppliesRows() {
  return [
    row({0:'Франчайзи',1:'План на 01.04.2030, шт.',2:'Факт, шт.',3:'План Себестоимость, руб.',4:'Факт Себестоимость, руб.'}),
    row({1:9,2:7,3:900,4:700}),
    row({0:'Филиал Альфа (тест)',1:4,2:3,3:400,4:300}),
    row({0:'Филиал Бета (тест)',1:5,2:4,3:500,4:400}),
    row({0:'Архив Филиал Гамма (тест)',1:11,2:11,3:1,4:1}),
  ];
}
export function suppliesForecastRows() {
  return [
    row({0:'Франчайзи',1:'План, шт.',2:'Факт, шт.',3:'%',4:'Прогноз, шт.',5:'Цена в Закупке, руб.',6:'Прогноз, руб.'}),
    row({1:9,2:7,3:0.77,4:8,5:100,6:800}),
    row({0:'Филиал Альфа (тест)',1:4,2:3,3:0.75,4:3.5,5:100,6:350}),
    row({0:'Филиал Бета (тест)',1:5,2:4,3:0.8,4:4.5,5:100,6:450}),
  ];
}
export function creditsRows() {
  const h = row({0:'Франчайзи',1:'План Количество кредитов',2:'Факт Кол-во кредитов (Google)',3:'Факт Кол-во кредитов (CRM)',4:'Δ',5:'%',
    6:'План Брокерских, шт.',7:'Факт Брокерских, шт.',9:'План Доля кредита',10:'Факт Доля кредита',
    12:'План КСО',13:'Факт КСО',15:'План Доход на 1 кредит, руб.',16:'Факт Доход на 1 кредит, руб.',
    18:'План Средняя сумма кредита, руб.',19:'Факт Средняя сумма кредита, руб.',21:'План % дохода от суммы кредита',22:'Факт % дохода от суммы кредита'});
  const data = (name: string, plan: number) => row({0:name,1:plan,2:plan,3:plan,6:1,7:1,9:0.5,10:0.5,
    12:plan*10,13:plan*10,15:10,16:10,18:1000,19:1000,21:0.1,22:0.1});
  // Источник кредитов строки итога не содержит — это часть его формата.
  return [h, data('Филиал Альфа (тест)',4), data('Филиал Бета (тест)',5)];
}
export function tradeUpRows() {
  return [
    row({1:'Trade Up',2:'Trade Up',3:'Trade Up',4:'Кредиты (crm)',5:'Кредиты (crm)',6:'Кредиты (crm)'}),
    row({0:'Тип Поставки',1:'Итоги',2:'Комиссия',3:'Выкуп',4:'Итоги',5:'Комиссия',6:'Выкуп'}),
    row({0:'Франчайзи',1:'Итоги',2:'Комиссия',3:'Выкуп',4:'Итоги',5:'Комиссия',6:'Выкуп'}),
    row({1:0.3,2:0.2,3:0.4,4:0.5,5:0.45,6:0.55}),
    row({0:'Филиал Альфа (тест)',1:0.25,2:0.2,3:0.3,4:0.5,5:0.4,6:0.6}),
    row({0:'Филиал Бета (тест)',1:0.35,2:0.2,3:0.5,4:0.5,5:0.5,6:0.5}),
  ];
}
export function funnelRows() {
  return [
    row({0:'Дилер Первого Касания',1:'Трафик',2:'Визит',3:'Конверсия (Трафик → Визит)',4:'Сделки',
      5:'Конверсия (Визит → Сделка)',6:'Конверсия (Трафик → Сделка)'}),
    row({0:'Итоги',1:300,2:90,3:0.3,4:9,5:0.1,6:0.03}),
    row({0:'Филиал Альфа (тест)',1:100,2:30,3:0.3,4:3,5:0.1,6:0.03}),
    row({0:'Филиал Бета (тест)',1:200,2:60,3:0.3,4:6,5:0.1,6:0.03}),
    row({0:'Не определено',1:0,2:0,3:0,4:0,5:0,6:0}),
  ];
}
