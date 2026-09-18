import { Router,Request,Response,NextFunction } from 'express';
import { requireSession,requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { accessDirectory,listAccessChanges,getAccessChange,commandAccessChange } from '../domain/accessChanges';
export const accessRouter=Router();
accessRouter.use(requireSession);
accessRouter.use((req,res,next)=>{
  res.setHeader('Cache-Control','no-store');
  try {enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();} catch(err){next(err);}
});
const wrap=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{fn(req,res).catch(next);};
accessRouter.get('/directory',wrap(async(req,res)=>{res.json(await accessDirectory(req.authUser!));}));
accessRouter.get('/proposals',wrap(async(req,res)=>{res.json(await listAccessChanges(req.authUser!));}));
accessRouter.get('/proposals/:id',wrap(async(req,res)=>{res.json(await getAccessChange(req.authUser!,req.params.id));}));
accessRouter.post('/proposals',requireOrigin,requireCsrf,wrap(async(req,res)=>{
  res.json(await commandAccessChange(req.authUser!,'create',null,req.body,req.header('Idempotency-Key'),req.ctx.requestId));
}));
for(const action of ['preview','apply'] as const) accessRouter.post(`/proposals/:id/${action}`,requireOrigin,requireCsrf,wrap(async(req,res)=>{
  res.json(await commandAccessChange(req.authUser!,action,req.params.id,req.body,req.header('Idempotency-Key'),req.ctx.requestId));
}));
