import { Router, Request, Response, NextFunction } from 'express';
import { requireSession, requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { withTransaction } from '../db/pool';
import { stagingAccess } from '../reporting/access';
import { readUpload } from '../reporting/multipart';
import { capabilities, listBatches, detail, uploadBatch, probeBatch, downloadSource } from '../reporting/service';
import { ApiError } from '../util/errors';
import { getReview,saveReview,savedOverview,savedBranch } from '../reporting/review';
import { requireReportIntake } from '../middleware/featureGate';
import { autoPublishPackage } from '../reporting/autoPublish';

export const reportBatchesRouter=Router();
const wrap=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{
  fn(req,res).catch(error=>{
    if(req.method==='POST' && !req.complete) {
      res.setHeader('Connection','close');
      res.once('finish',()=>req.destroy());
    }
    next(error);
  });
};
reportBatchesRouter.use(requireSession);
reportBatchesRouter.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  try {enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();} catch(e){next(e);}
});
reportBatchesRouter.use((req,_res,next)=>{
  if(Object.keys(req.query).length) return next(new ApiError('VALIDATION_ERROR','Scope и фильтры клиента не принимаются.'));
  withTransaction(c=>stagingAccess(c,req.authUser!)).then(()=>next(),next);
});
reportBatchesRouter.get('/capabilities',wrap(async(req,res)=>{res.json(await capabilities(req.authUser!));}));
reportBatchesRouter.get('/',wrap(async(req,res)=>{res.json(await listBatches(req.authUser!));}));
reportBatchesRouter.get('/:id',wrap(async(req,res)=>{res.json(await detail(req.authUser!,req.params.id));}));
reportBatchesRouter.get('/:id/review',wrap(async(req,res)=>{res.json(await getReview(req.authUser!,req.params.id));}));
reportBatchesRouter.post('/:id/review',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{
  res.json(await saveReview(req.authUser!,req.params.id,req.body,req.get('Idempotency-Key'),req.ctx.requestId));
}));
reportBatchesRouter.get('/:id/overview',wrap(async(req,res)=>{res.json(await savedOverview(req.authUser!,req.params.id));}));
reportBatchesRouter.get('/:id/branches/:itemId',wrap(async(req,res)=>{
  res.json(await savedBranch(req.authUser!,req.params.id,req.params.itemId));
}));
let receiving=false;
reportBatchesRouter.post('/',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{
  if(receiving) throw new ApiError('TEMPORARILY_UNAVAILABLE','Другая загрузка выполняется. Повторите позже.',{retry_after_seconds:5});
  receiving=true;
  try {
    const upload=await readUpload(req);
    res.status(200).json(await uploadBatch(req.authUser!,upload.metadata,upload.files,req.ctx.requestId));
  } finally {receiving=false;}
}));
// Приём «одной кнопкой»: загрузка, привязка и публикация без ручных этапов.
reportBatchesRouter.post('/auto-publish',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{
  if(receiving) throw new ApiError('TEMPORARILY_UNAVAILABLE','Другая загрузка выполняется. Повторите позже.',{retry_after_seconds:5});
  receiving=true;
  try {
    const upload=await readUpload(req);
    res.status(200).json(await autoPublishPackage(req.authUser!,upload.metadata,upload.files,req.ctx.requestId));
  } finally {receiving=false;}
}));
reportBatchesRouter.post('/:id/probe',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{
  res.json(await probeBatch(req.authUser!,req.params.id,req.body,req.ctx.requestId));
}));
reportBatchesRouter.get('/:id/files/:fileId/download',wrap(async(req,res)=>{
  const r=await downloadSource(req.authUser!,req.params.id,req.params.fileId,req.ctx.requestId);
  throw new ApiError('FORBIDDEN',r.message);
}));
reportBatchesRouter.use((_req,_res,next)=>next(new ApiError('FORBIDDEN','Этот этап не поддерживает commit, применение привязок, удаление или публикацию отчётов.')));
