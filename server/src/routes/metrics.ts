import { Router,Request,Response,NextFunction } from 'express';
import { requireSession,requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { branchOverview } from '../metrics/overview';
import { listThresholds,setThreshold } from '../metrics/thresholds';
export const metricsRouter=Router();
const wrap=(f:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{f(req,res).catch(next);};
metricsRouter.use(requireSession);
metricsRouter.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  try{enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();}catch(e){next(e);}
});
metricsRouter.get('/overview',wrap(async(req,res)=>{res.json(await branchOverview(req.authUser!,req.query));}));
metricsRouter.get('/thresholds',wrap(async(req,res)=>{res.json(await listThresholds(req.authUser!,req.query));}));
metricsRouter.post('/thresholds',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.status(201).json(await setThreshold(req.authUser!,req.body,req.ctx.requestId));}));
