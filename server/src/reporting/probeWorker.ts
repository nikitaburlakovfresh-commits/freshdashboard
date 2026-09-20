import { parentPort, workerData } from 'worker_threads';
import { validateXlsx } from './zipSafety';
import { parseWorkbook } from './shared/parseWorkbook';
import { comparisonIssues, reconcile, Report } from './shared/reportModel';

/**
 * Проверка пакета не отклоняет весь пакет из-за одного файла. Каждый файл
 * проверяется отдельно: распознанные агрегаты попадают в предпросмотр,
 * нераспознанные перечисляются с причиной и не публикуются. Содержимое
 * книги, пути и внутренние ошибки парсера наружу не выводятся.
 */
async function run() {
  const reports:Report[]=[];
  const skipped:{name:string;reason:string}[]=[];
  for(const file of workerData.files) {
    const bytes=Buffer.from(file.bytes);
    try {
      validateXlsx(bytes);
    } catch {
      skipped.push({name:String(file.name),reason:'файл не прошёл проверку XLSX: формулы, макросы, внешние ссылки или нестандартная структура'});
      continue;
    }
    let report:Report|null=null;
    try {
      report=await parseWorkbook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,file.name);
    } catch {
      skipped.push({name:String(file.name),reason:'структура отчёта не соответствует поддерживаемому агрегатному формату'});
      continue;
    }
    if(!report) {
      skipped.push({name:String(file.name),reason:'формат не поддержан: детализация по сотрудникам и по VIN этим пакетом не принимается'});
      continue;
    }
    if(reports.some(r=>r.kind===report!.kind)) {
      skipped.push({name:String(file.name),reason:'в пакете уже есть отчёт того же формата; принят первый файл'});
      continue;
    }
    reports.push(report);
  }
  if(!reports.length) throw new Error('none');
  return {reports,controls:reports.map(r=>({kind:r.kind,items:reconcile(r)})),
    comparison:comparisonIssues(reports),skipped};
}
run().then(preview=>parentPort!.postMessage({ok:true,preview})).catch(()=>{
  parentPort!.postMessage({ok:false,error:'Ни один файл пакета не распознан как агрегатный отчёт портала: допустимы агрегаты без формул, макросов и внешних ссылок.'});
});
