import { Request } from 'express';
import Busboy from 'busboy';
import { ApiError } from '../util/errors';
import { UploadFile, MAX_FILE_BYTES } from './storage';

export async function readUpload(req:Request):Promise<{metadata:unknown;files:UploadFile[]}> {
  const max=17*1024*1024;
  const length=req.header('content-length');
  if((length && (!/^\d+$/.test(length) || Number(length)>max)) ||
    (req.header('content-encoding') && req.header('content-encoding')!=='identity') ||
    !/^multipart\/form-data;\s*boundary=/i.test(req.header('content-type') ?? ''))
    throw new ApiError('VALIDATION_ERROR','Ожидается ограниченный multipart: до 2 XLSX, 8 МиБ каждый.');
  return new Promise((resolve,reject)=>{
    let parser:ReturnType<typeof Busboy>;
    // Busboy emits partsLimit on reaching the count, not on the next part.
    // files/fields retain the exact 2+1 contract; fourth part is forbidden.
    try {parser=Busboy({headers:req.headers,limits:{fileSize:MAX_FILE_BYTES,files:2,fields:1,fieldSize:4096,parts:4,headerPairs:30}});}
    catch {reject(new ApiError('VALIDATION_ERROR','Некорректный multipart.'));return;}
    let settled=false,total=0,metadata:unknown,fieldSeen=false;
    const files:UploadFile[]=[];
    const timer=setTimeout(()=>fail('Загрузка превысила 20 секунд.'),20000);
    const cleanup=()=>{clearTimeout(timer);req.off('data',count);req.off('aborted',aborted);req.off('error',aborted);};
    const fail=(message:string)=>{
      if(settled)return;settled=true;cleanup();req.unpipe(parser);
      // Avoid destroying Busboy inside its synchronous part callback.
      setImmediate(()=>parser.destroy());req.resume();
      reject(new ApiError('VALIDATION_ERROR',message));
    };
    const count=(b:Buffer)=>{total+=b.length;if(total>max)fail('Превышен размер запроса.');};
    const aborted=()=>fail('Загрузка прервана.');
    req.on('data',count);req.once('aborted',aborted);req.once('error',aborted);
    parser.on('field',(name,value,info)=>{
      if(name!=='metadata' || fieldSeen || info.valueTruncated || info.nameTruncated) {fail('Недопустимые метаданные.');return;}
      fieldSeen=true;
      try {metadata=JSON.parse(value);} catch {fail('Некорректные метаданные JSON.');}
    });
    parser.on('file',(name,stream,info)=>{
      stream.on('error',()=>fail('Ошибка загрузки файла.'));
      if(name!=='files' || !/\.xlsx$/i.test(info.filename) ||
        !['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream'].includes(info.mimeType)) {
        stream.resume();fail('Допустимы только оригиналы XLSX в поле files.');return;
      }
      const chunks:Buffer[]=[];
      stream.on('data',b=>{if(!settled)chunks.push(b);});
      stream.once('limit',()=>fail('XLSX превышает лимит 8 МиБ.'));
      stream.once('end',()=>{if(!settled)files.push({name:info.filename,bytes:Buffer.concat(chunks)});});
    });
    for(const event of ['filesLimit','fieldsLimit','partsLimit']) parser.on(event,()=>fail('Допустимы 1 поле метаданных и до 2 файлов.'));
    parser.once('error',()=>fail('Незавершённый или некорректный multipart.'));
    parser.once('close',()=>{
      if(settled)return;
      if(!fieldSeen || !files.length) {fail('Добавьте метаданные и XLSX.');return;}
      settled=true;cleanup();resolve({metadata,files});
    });
    req.pipe(parser);
  });
}
