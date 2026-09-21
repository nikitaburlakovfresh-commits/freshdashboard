import { parentPort, workerData } from 'worker_threads';
import { validateXlsx } from './zipSafety';
import { parseAnyWorkbook } from './shared/parseWorkbook';
import { comparisonIssues, reconcile, Report } from './shared/reportModel';

/**
 * Проверка пакета не отклоняет весь пакет из-за одного файла. Каждый файл
 * проверяется отдельно: распознанные агрегаты попадают в предпросмотр,
 * нераспознанные перечисляются с причиной и не публикуются. Содержимое
 * книги, пути и внутренние ошибки парсера наружу не выводятся.
 *
 * Детальные выгрузки (реестр по VIN, скидки по менеджерам) распознаются здесь
 * же и перечисляются отдельным списком. Раньше пакет без агрегатов отклонялся
 * целиком, и реестр склада нельзя было принять вообще: его публикация есть в
 * портале, но пакет до неё не доходил. Сам разбор детальных строк остаётся в
 * детальном контуре — здесь только распознавание формата.
 */
async function run() {
  const reports:Report[]=[];
  const details:{name:string;kind:string;rows:number;locations:number}[]=[];
  const skipped:{name:string;reason:string}[]=[];
  for(const file of workerData.files) {
    const bytes=Buffer.from(file.bytes);
    try {
      validateXlsx(bytes);
    } catch {
      skipped.push({name:String(file.name),reason:'файл не прошёл проверку XLSX: формулы, макросы, внешние ссылки или нестандартная структура'});
      continue;
    }
    let parsed:Awaited<ReturnType<typeof parseAnyWorkbook>>=null;
    try {
      parsed=await parseAnyWorkbook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,file.name);
    } catch {
      skipped.push({name:String(file.name),reason:'структура отчёта не соответствует поддерживаемому формату'});
      continue;
    }
    if(!parsed) {
      skipped.push({name:String(file.name),reason:'формат не поддержан'});
      continue;
    }
    if(parsed.type==='DETAIL') {
      if(details.some(d=>d.kind===parsed!.report.kind)) {
        skipped.push({name:String(file.name),reason:'в пакете уже есть детальная выгрузка того же вида; принят первый файл'});
        continue;
      }
      details.push({name:String(file.name),kind:parsed.report.kind,
        rows:parsed.report.vehicles.length+parsed.report.managers.length,
        locations:parsed.report.locations.length});
      continue;
    }
    const report:Report=parsed.report;
    if(reports.some(r=>r.kind===report!.kind)) {
      skipped.push({name:String(file.name),reason:'в пакете уже есть отчёт того же формата; принят первый файл'});
      continue;
    }
    reports.push(report);
  }
  if(!reports.length&&!details.length) throw new Error('none');
  return {reports,details,controls:reports.map(r=>({kind:r.kind,items:reconcile(r)})),
    comparison:comparisonIssues(reports),skipped};
}
run().then(preview=>parentPort!.postMessage({ok:true,preview})).catch(()=>{
  parentPort!.postMessage({ok:false,error:'Ни один файл пакета не распознан как агрегатный отчёт портала: допустимы агрегаты без формул, макросов и внешних ссылок.'});
});
