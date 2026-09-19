import { Router,Request,Response,NextFunction } from 'express';
import { requireSession,requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { detailState,previewDetail,commitDetail,readDetailStock } from '../reporting/detailPublication';
import { ApiError } from '../util/errors';
import { requireReportIntake } from '../middleware/featureGate';
export const reportDetailRouter=Router();
const wrap=(f:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{f(req,res).catch(next);};
reportDetailRouter.use(requireSession);
reportDetailRouter.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  try{enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();}catch(e){next(e);}
});
reportDetailRouter.get('/stock',wrap(async(req,res)=>{res.json(await readDetailStock(req.authUser!,req.query));}));
reportDetailRouter.use((req,_res,next)=>Object.keys(req.query).length?next(new ApiError('VALIDATION_ERROR','Фильтры команды не принимаются.')):next());
reportDetailRouter.get('/:id/state',wrap(async(req,res)=>{res.json(await detailState(req.authUser!,req.params.id));}));
reportDetailRouter.post('/:id/preview',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{res.json(await previewDetail(req.authUser!,req.params.id,req.body));}));
reportDetailRouter.post('/:id/publish',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{res.json(await commitDetail(req.authUser!,req.params.id,req.body,req.get('Idempotency-Key'),req.ctx.requestId));}));
