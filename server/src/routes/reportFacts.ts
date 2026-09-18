import { Router,Request,Response,NextFunction } from 'express';
import { requireSession,requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { publicationState,scanBatch,previewPublication,commitPublication,readPublished } from '../reporting/factPublication';
import { ApiError } from '../util/errors';
import { requireReportIntake } from '../middleware/featureGate';
export const reportFactsRouter=Router();
const wrap=(f:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{f(req,res).catch(next);};
reportFactsRouter.use(requireSession);
reportFactsRouter.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  try{enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();}catch(e){next(e);}
});
reportFactsRouter.get('/',wrap(async(req,res)=>{res.json(await readPublished(req.authUser!,req.query));}));
reportFactsRouter.use((req,_res,next)=>Object.keys(req.query).length?next(new ApiError('VALIDATION_ERROR','Фильтры команды не принимаются.')):next());
reportFactsRouter.get('/:id/publication',wrap(async(req,res)=>{res.json(await publicationState(req.authUser!,req.params.id));}));
reportFactsRouter.post('/:id/scan',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{res.json(await scanBatch(req.authUser!,req.params.id,req.body,req.ctx.requestId));}));
reportFactsRouter.post('/:id/preview',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{res.json(await previewPublication(req.authUser!,req.params.id,req.body));}));
reportFactsRouter.post('/:id/publish',requireOrigin,requireCsrf,requireReportIntake,wrap(async(req,res)=>{res.json(await commitPublication(req.authUser!,req.params.id,req.body,req.get('Idempotency-Key'),req.ctx.requestId));}));
