import { zipSync, strToU8 } from 'fflate';

/**
 * Типовая форма плана выручки. QLIK плановую выручку не выгружает, поэтому она
 * загружается отдельной ручной формой функционального руководителя. Файл
 * собирается в браузере: сервер не хранит шаблонов с названиями филиалов, а
 * список филиалов берётся из действующего справочника оргструктуры на дату.
 */
const escape = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function sheet(rows: { name: string; plan: string }[]): string {
  const head = '<row r="1"><c r="A1" t="inlineStr"><is><t>Франчайзи</t></is></c>'
    + '<c r="B1" t="inlineStr"><is><t>План Выручка, руб.</t></is></c></row>';
  const body = rows.map((r, i) => {
    const n = i + 2;
    const plan = r.plan ? `<c r="B${n}"><v>${r.plan}</v></c>` : `<c r="B${n}"/>`;
    return `<row r="${n}"><c r="A${n}" t="inlineStr"><is><t>${escape(r.name)}</t></is></c>${plan}</row>`;
  }).join('');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<cols><col min="1" max="1" width="34" customWidth="1"/>'
    + '<col min="2" max="2" width="22" customWidth="1"/></cols>'
    + `<sheetData>${head}${body}</sheetData></worksheet>`;
}

/** Собирает XLSX с одним листом «Sheet1» и двумя столбцами формы. */
export function buildRevenuePlanTemplate(branches: string[]): Blob {
  const rows = branches.map(name => ({ name, plan: '' }));
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
      + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheet(rows)),
  };
  const zipped = zipSync(files, { level: 6 });
  // Копия в отдельный ArrayBuffer: Blob не должен держать ссылку на пул fflate.
  const bytes = new Uint8Array(zipped.length);
  bytes.set(zipped);
  return new Blob([bytes], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}
