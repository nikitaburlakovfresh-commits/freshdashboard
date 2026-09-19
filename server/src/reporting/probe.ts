import path from 'path';
import { Worker } from 'worker_threads';
import { UploadFile } from './storage';
import { ApiError } from '../util/errors';

export const PARSER_VERSION='aggregate-shared-2+catalog-1+safezip-1';
let active=0;
export async function probeFiles(files:UploadFile[]):Promise<any> {
  if(active>=1) throw new ApiError('TEMPORARILY_UNAVAILABLE','Другая проверка выполняется. Повторите позже.',{retry_after_seconds:5});
  active++;
  try {
    return await new Promise((resolve,reject)=>{
      // Runtime uses packaged JS. ts-jest/dev source execution also uses the
      // independently compiled worker, never ts-node/eval on uploaded content.
      const workerPath=__filename.endsWith('.ts')
        ? path.resolve(__dirname,'../../dist/src/reporting/probeWorker.js')
        : path.join(__dirname,'probeWorker.js');
      const worker=new Worker(workerPath,{
        workerData:{files:files.map(f=>({name:f.name,bytes:f.bytes}))},
        resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16,stackSizeMb:4},
      });
      let settled=false;
      const done=(error:Error|null,value?:unknown)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        void worker.terminate().then(()=>error?reject(error):resolve(value));
      };
      const timer=setTimeout(()=>done(null,{ok:false,error:'Проверка превысила лимит времени; пакет остаётся неподтверждённым.'}),10000);
      worker.once('message',m=>done(null,m));
      worker.once('error',()=>done(null,{ok:false,error:'Проверка остановлена ограничением ресурсов.'}));
      worker.once('exit',()=>{if(!settled) done(null,{ok:false,error:'Проверка завершилась без результата.'});});
    });
  } finally {active--;}
}
