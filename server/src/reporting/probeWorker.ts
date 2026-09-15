import { parentPort, workerData } from 'worker_threads';
import { validateXlsx } from './zipSafety';
import { parseWorkbook } from './shared/parseWorkbook';
import { comparisonIssues, reconcile, Report } from './shared/reportModel';

async function run() {
  const reports:Report[]=[];
  for(const file of workerData.files) {
    const bytes=Buffer.from(file.bytes);
    validateXlsx(bytes);
    const report=await parseWorkbook(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,file.name);
    if(!report) throw new Error('Поддерживаются только два агрегатных формата; детализация сотрудников и VIN не принимается.');
    if(reports.some(r=>r.kind===report.kind)) throw new Error('В пакете допустим только один отчёт каждого формата.');
    reports.push(report);
  }
  return {reports,controls:reports.map(r=>({kind:r.kind,items:reconcile(r)})),comparison:comparisonIssues(reports)};
}
run().then(preview=>parentPort!.postMessage({ok:true,preview})).catch(()=>{
  // Do not emit arbitrary workbook content, ZIP names, paths or parser internals.
  parentPort!.postMessage({ok:false,error:'Файл не прошёл закрытую проверку XLSX: допустимы только агрегаты, без формул, макросов, внешних ссылок и детализации.'});
});
