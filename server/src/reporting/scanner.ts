import { spawn } from 'child_process';
import { ApiError } from '../util/errors';

// Fixed executable, stdin only, no shell, no caller-supplied flags or paths.
// No environment switch that can fabricate a CLEAN receipt in production.
function run(args:string[],input?:Buffer):Promise<{code:number|null;output:string}> {
  return new Promise((resolve,reject)=>{
    const child=spawn('/usr/bin/clamscan',args,{stdio:['pipe','pipe','pipe']});
    let output='',length=0,settled=false;
    const fail=()=>{if(!settled){settled=true;clearTimeout(timer);child.kill('SIGKILL');reject(new ApiError('TEMPORARILY_UNAVAILABLE','Антивирус недоступен или проверка не завершена. Новый результат проверки не получен.'));}};
    const timer=setTimeout(fail,30000);
    child.on('error',fail);child.stdin.on('error',()=>{});
    for(const stream of [child.stdout,child.stderr])stream.on('data',(b:Buffer)=>{
      length+=b.length;if(length>8192)fail();else output+=b.toString();
    });
    child.on('close',code=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,output});}});
    child.stdin.end(input);
  });
}
export async function scanBytes(bytes:Buffer):Promise<{scanner:string;result:'CLEAN'|'INFECTED'}> {
  const before=await run(['--version']);
  const version=before.output.trim();
  const date=Date.parse(version.split('/').slice(2).join('/'));
  if(before.code!==0||!/^ClamAV [\w.+-]+\/\d+\//.test(version)||!Number.isFinite(date)||
    Date.now()-date>48*3600000||date>Date.now()+3600000)
    throw new ApiError('TEMPORARILY_UNAVAILABLE','Нужны проверяемые сигнатуры ClamAV не старше 48 часов.');
  const scan=await run(['--stdout','--no-summary','--alert-exceeds-max=yes','--alert-encrypted=yes','-'],bytes);
  const after=await run(['--version']);
  if(after.code!==0||after.output.trim()!==version||![0,1].includes(scan.code??-1))
    throw new ApiError('TEMPORARILY_UNAVAILABLE','Антивирусная проверка не завершена. Оригинал остаётся в карантине.');
  return {scanner:version,result:scan.code===0?'CLEAN':'INFECTED'};
}
