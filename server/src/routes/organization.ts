import { Router, Request, Response, NextFunction } from 'express';
import { requireSession, requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { ApiError } from '../util/errors';
import { getAdministrationReview, getDirectoryHistory, getDirectoryTree, parseDirectoryDate } from '../domain/orgDirectory';
import { commandOrgChange, getOrgChange, listOrgChanges } from '../domain/orgChanges';

export const organizationRouter = Router();
organizationRouter.use(requireSession);
organizationRouter.use((req, _res, next) => {
  try { enforceSessionRateLimit(req.authUser!.sessionId, req.method !== 'GET'); next(); } catch (err) { next(err); }
});
const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

organizationRouter.get('/tree', wrap(async (req, res) => {
  if (Object.keys(req.query).some(key => key !== 'as_of')) {
    throw new ApiError('VALIDATION_ERROR', 'Допустим только параметр as_of; scope определяется сервером.');
  }
  res.json(await getDirectoryTree(req.authUser!, parseDirectoryDate(req.query.as_of)));
}));
organizationRouter.get('/units/:id/history', wrap(async (req, res) => {
  res.json(await getDirectoryHistory(req.authUser!, req.params.id));
}));

function denyAdministration(_req: Request, _res: Response, next: NextFunction) {
  next(new ApiError('FORBIDDEN', 'Изменения оргструктуры, назначений и импорта не реализованы в этом выпуске; административное чтение не разрешает запись.', {
    issues: [{ path: 'administration', issue: 'ADMIN_WRITES_NOT_IMPLEMENTED' }],
  }));
}
organizationRouter.get('/admin-review', wrap(async (req,res) => {
  if (Object.keys(req.query).some(key => key !== 'as_of')) {
    throw new ApiError('VALIDATION_ERROR','Допустим только параметр as_of; scope определяется сервером.');
  }
  res.json(await getAdministrationReview(req.authUser!,parseDirectoryDate(req.query.as_of)));
}));
organizationRouter.get('/proposals',wrap(async(req,res)=>{
  res.json(await listOrgChanges(req.authUser!));
}));
organizationRouter.get('/proposals/:id',wrap(async(req,res)=>{
  res.json(await getOrgChange(req.authUser!,req.params.id));
}));
organizationRouter.post('/proposals',requireOrigin,requireCsrf,wrap(async(req,res)=>{
  res.json(await commandOrgChange(req.authUser!,'create',null,req.body,req.header('Idempotency-Key'),req.ctx.requestId));
}));
organizationRouter.patch('/proposals/:id',requireOrigin,requireCsrf,wrap(async(req,res)=>{
  res.json(await commandOrgChange(req.authUser!,'edit',req.params.id,req.body,req.header('Idempotency-Key'),req.ctx.requestId));
}));
for(const action of ['preview','apply'] as const) organizationRouter.post(`/proposals/:id/${action}`,requireOrigin,requireCsrf,wrap(async(req,res)=>{
  res.json(await commandOrgChange(req.authUser!,action,req.params.id,req.body,req.header('Idempotency-Key'),req.ctx.requestId));
}));
// Fail closed for every attempted write, including guessed import/apply/grant
// routes. No request body or client-side role flag can confer administration.
organizationRouter.use((req, res, next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  requireOrigin(req, res, err => {
    if (err) return next(err);
    requireCsrf(req, res, csrfErr => csrfErr ? next(csrfErr) : denyAdministration(req, res, next));
  });
});
