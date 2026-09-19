import { spawn } from 'child_process';
import { ApiError } from '../util/errors';
import { config } from '../config';
import { MAX_FILE_BYTES } from './storage';

// clamscan загружает полный набор сигнатур в память на каждый запуск: на
// боевом сервере это ~35 секунд на один файл. Таймаут держит запас, но не
// бесконечен — незавершённая проверка по-прежнему не даёт вердикта CLEAN.
const SCAN_TIMEOUT_MS=180000;

export type SourceScanResult='CLEAN'|'INFECTED'|'NOT_SCANNED';

// Fixed executable, stdin only, no shell, no caller-supplied flags or paths.
// No environment switch that can fabricate a CLEAN receipt in production.
function run(args:string[],input?:Buffer):Promise<{code:number|null;output:string}> {
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/clamscan',args,{stdio:['pipe','pipe','pipe'],env:{...process.env,LC_ALL:'C',TZ:'UTC'}});
    let output='',length=0,settled=false;
    const fail=()=>{if(!settled){settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(new ApiError('TEMPORARILY_UNAVAILABLE','Антивирус недоступен или проверка не завершена. Новый результат проверки не получен.'));}};
    const timer=setTimeout(fail,SCAN_TIMEOUT_MS);
    child.on('error',fail);child.stdin.on('error',()=>{});
    for(const stream of [child.stdout,child.stderr])stream.on('data',(b:Buffer)=>{
      length+=b.length;if(length>8192)fail();else output+=b.toString();
    });
    child.on('close',code=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,output});}});
    child.stdin.end(input);
  });
}
/** BETA-02. Антивирусный контур сохранён целиком и включается режимом
 * REPORT_SCAN_MODE=clamav. В режиме 'off' проверка НЕ выполняется и НЕ
 * подделывается: возвращается честный статус NOT_SCANNED, который в публикации
 * трактуется отдельно от CLEAN. Размер и тип файла проверяются в любом режиме. */
export async function scanSource(bytes:Buffer):Promise<{scanner:string;result:SourceScanResult}> {
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX_FILE_BYTES)
    throw new ApiError('VALIDATION_ERROR','Недопустимый размер файла для проверки оригинала.');
  if(config.reportScanMode==='off')return {scanner:'NOT_SCANNED/REPORT_SCAN_MODE=off',result:'NOT_SCANNED'};
  return scanBytes(bytes);
}
let scanning=false;
export async function scanBytes(bytes:Buffer):Promise<{scanner:string;result:'CLEAN'|'INFECTED'}> {
  if(!Buffer.isBuffer(bytes)||bytes.length===0||bytes.length>MAX_FILE_BYTES)
    throw new ApiError('VALIDATION_ERROR','Недопустимый размер файла для антивирусной проверки.');
  if(scanning)throw new ApiError('TEMPORARILY_UNAVAILABLE','Антивирус занят. Повторите проверку позднее.');
  scanning=true;
  try {return await scan(bytes);} finally {scanning=false;}
}
async function scan(bytes:Buffer):Promise<{scanner:string;result:'CLEAN'|'INFECTED'}> {
  const before=await run(['--version']);
  const version=before.output.trim();
  const date=Date.parse(version.split('/').slice(2).join('/'));
  if(before.code!==0||!/^ClamAV [\w.+-]+\/\d+\//.test(version)||!Number.isFinite(date)||
    Date.now()-date>48*3600000||date>Date.now()+3600000)
    throw new ApiError('TEMPORARILY_UNAVAILABLE','Нужны проверяемые сигнатуры ClamAV не старше 48 часов.');
  const scan=await run(['--stdout','--no-summary','--alert-exceeds-max=yes','--alert-encrypted=yes',
    '--max-filesize=8M','--max-scansize=64M','--max-files=2048','--max-recursion=16','-'],bytes);
  const after=await run(['--version']);
  if(after.code!==0||after.output.trim()!==version||![0,1].includes(scan.code??-1))
    throw new ApiError('TEMPORARILY_UNAVAILABLE','Антивирусная проверка не завершена. Оригинал остаётся в карантине.');
  return {scanner:version,result:scan.code===0?'CLEAN':'INFECTED'};
}
