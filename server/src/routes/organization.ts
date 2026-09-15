import { Router, Request, Response, NextFunction } from 'express';
import { requireSession, requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { ApiError } from '../util/errors';
import { getDirectoryHistory, getDirectoryTree, parseDirectoryDate } from '../domain/orgDirectory';

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
  next(new ApiError('FORBIDDEN', 'Административное назначение не настроено. Пилотные RM/RF не могут изменять оргструктуру или утверждать импорт.', {
    issues: [{ path: 'administration', issue: 'ADMIN_ASSIGNMENT_NOT_CONFIGURED' }],
  }));
}
organizationRouter.get('/admin-review', denyAdministration);
// Fail closed for every attempted write, including guessed import/apply/grant
// routes. No request body or client-side role flag can confer administration.
organizationRouter.use((req, res, next) => {
  if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
  requireOrigin(req, res, err => {
    if (err) return next(err);
    requireCsrf(req, res, csrfErr => csrfErr ? next(csrfErr) : denyAdministration(req, res, next));
  });
});
