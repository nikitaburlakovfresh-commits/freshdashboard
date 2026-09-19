import { Router,Request,Response,NextFunction } from 'express';
import { requireSession,requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { branchOverview } from '../metrics/overview';
import { listThresholds,setThreshold } from '../metrics/thresholds';
import { listScoringModels,setScoringModel } from '../metrics/scoring';
import { listFocusCatalog,setFocusConfiguration } from '../metrics/focus';
import { divisionDeviationSummary } from '../metrics/divisionSummary';
import { createDeviationTask,listDeviationTasks,myDeviationTasks } from '../metrics/deviationTasks';
import { branchCard } from '../metrics/branchCard';
import { listNotificationPolicies,setNotificationPolicy } from '../settings/notificationPolicies';
import { listPortalSettings,setPortalSetting } from '../settings/portalSettings';
import { listSourceNaming,setSourceAlias,excludeSourceName,revokeSourceExclusion } from '../domain/sourceNaming';
import { ApiError } from '../util/errors';
export const metricsRouter=Router();
const wrap=(f:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{f(req,res).catch(next);};
metricsRouter.use(requireSession);
metricsRouter.use((req,res,next)=>{
  res.set({'Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});
  try{enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();}catch(e){next(e);}
});
metricsRouter.get('/overview',wrap(async(req,res)=>{res.json(await branchOverview(req.authUser!,req.query));}));
metricsRouter.get('/branches/:id',wrap(async(req,res)=>{res.json(await branchCard(req.authUser!,req.params.id,req.query));}));
metricsRouter.get('/portal-settings',wrap(async(req,res)=>{
  res.json(await listPortalSettings(req.authUser!,req.query));}));
metricsRouter.post('/portal-settings',requireOrigin,requireCsrf,wrap(async(req,res)=>{
  const r=await setPortalSetting(req.authUser!,actorCtx(req),req.body,req.header('Idempotency-Key')??'');
  res.status(r.status).json(r.body);}));
metricsRouter.get('/notification-policies',wrap(async(req,res)=>{
  res.json(await listNotificationPolicies(req.authUser!,req.query));}));
metricsRouter.post('/notification-policies',requireOrigin,requireCsrf,wrap(async(req,res)=>{
  const r=await setNotificationPolicy(req.authUser!,actorCtx(req),req.body,req.header('Idempotency-Key')??'');
  res.status(r.status).json(r.body);}));
metricsRouter.get('/scoring',wrap(async(req,res)=>{res.json(await listScoringModels(req.authUser!,req.query));}));
metricsRouter.post('/scoring',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.status(201).json(await setScoringModel(req.authUser!,req.body,req.ctx.requestId));}));
metricsRouter.get('/focus',wrap(async(req,res)=>{res.json(await listFocusCatalog(req.authUser!,req.query));}));
metricsRouter.post('/focus',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.status(201).json(await setFocusConfiguration(req.authUser!,req.body,req.ctx.requestId));}));
metricsRouter.get('/thresholds',wrap(async(req,res)=>{res.json(await listThresholds(req.authUser!,req.query));}));
metricsRouter.post('/thresholds',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.status(201).json(await setThreshold(req.authUser!,req.body,req.ctx.requestId));}));

metricsRouter.get('/source-naming',wrap(async(req,res)=>{res.json(await listSourceNaming(req.authUser!,req.query));}));
metricsRouter.post('/source-naming/aliases',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.status(201).json(await setSourceAlias(req.authUser!,req.body,req.ctx.requestId));}));
metricsRouter.post('/source-naming/exclusions',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.status(201).json(await excludeSourceName(req.authUser!,req.body,req.ctx.requestId));}));
metricsRouter.post('/source-naming/exclusions/:id/revoke',requireOrigin,requireCsrf,
  wrap(async(req,res)=>{res.json(await revokeSourceExclusion(req.authUser!,req.params.id,req.body,req.ctx.requestId));}));

const actorCtx=(req:Request)=>({authUser:req.authUser!,requestId:req.ctx.requestId,
  ip:req.ip??null,userAgent:req.header('user-agent')??null});
metricsRouter.get('/divisions/deviations',wrap(async(req,res)=>{
  res.json(await divisionDeviationSummary(req.authUser!,req.query));
}));
metricsRouter.get('/deviation-tasks/mine',wrap(async(req,res)=>{res.json(await myDeviationTasks(req.authUser!,req.query));}));
metricsRouter.get('/deviation-tasks',wrap(async(req,res)=>{res.json(await listDeviationTasks(req.authUser!,req.query));}));
metricsRouter.post('/deviation-tasks',requireOrigin,requireCsrf,wrap(async(req,res)=>{
  const idem=req.header('Idempotency-Key')??'';
  if(!idem)throw new ApiError('VALIDATION_ERROR','Требуется заголовок Idempotency-Key.');
  const r=await createDeviationTask(req.authUser!,actorCtx(req),req.body,idem);
  res.status(r.status).json(r.body);
}));
