import { Router, Request, Response, NextFunction } from 'express';
import { requireSession, requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { getPersonalDay, openDailyLog, setDailyPolicy, setDailyPolicyForAll } from '../domain/dailyLogs';
import { operationalOverview } from '../domain/operationalOverview';
import { getPersonalNoteDay, openPersonalNote } from '../domain/personalNotes';
export const dailyRouter=Router();
dailyRouter.use(requireSession);
dailyRouter.use((req,_res,next)=>{try{enforceSessionRateLimit(req.authUser!.sessionId,req.method!=='GET');next();}catch(e){next(e);}});
const wrap=(fn:(req:Request,res:Response)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>{fn(req,res).catch(next);};
const ctx=(req:Request)=>({authUser:req.authUser!,requestId:req.ctx.requestId,ip:req.ip??null,userAgent:req.header('user-agent')??null});
dailyRouter.get('/day',wrap(async(req,res)=>{res.json(await getPersonalDay(ctx(req),req.query.org_unit_id as string,req.query.role,req.query.business_date));}));
dailyRouter.post('/open',requireOrigin,requireCsrf,wrap(async(req,res)=>{res.json(await openDailyLog(ctx(req),req.body??{}));}));
// Личная запись дня линейного сотрудника: отдельные маршруты, потому что это
// не ежедневник — окна заполнения и политики здесь нет.
dailyRouter.get('/note',wrap(async(req,res)=>{res.json(await getPersonalNoteDay(ctx(req),req.query.org_unit_id as string,req.query.role,req.query.business_date));}));
dailyRouter.post('/note/open',requireOrigin,requireCsrf,wrap(async(req,res)=>{res.json(await openPersonalNote(ctx(req),req.body??{}));}));
dailyRouter.get('/overview',wrap(async(req,res)=>{res.json(await operationalOverview(ctx(req),req.query.business_date,req.query.org_unit_id as string|undefined));}));
// Одинаковое окно на все филиалы и роли: настраивать 117 форм по одной нельзя.
dailyRouter.post('/policies-bulk',requireOrigin,requireCsrf,wrap(async(req,res)=>{res.json(await setDailyPolicyForAll(ctx(req),req.body??{}));}));
dailyRouter.post('/policies/:org',requireOrigin,requireCsrf,wrap(async(req,res)=>{res.json(await setDailyPolicy(ctx(req),req.params.org,req.body??{}));}));
