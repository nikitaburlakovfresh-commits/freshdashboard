import { Router, Request, Response, NextFunction } from 'express';
import { requireSession, requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { readRoleMatrix, updateRolePermissions } from '../domain/rolePermissionEditor';
import {
  registrationDirectory, submitRegistration, listRegistrationRequests,
  decideRegistration, pendingRegistrationCount,
} from '../domain/registration';

const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

/** Открытый контур регистрации: человек ещё не имеет входа в портал. */
export const publicRegistrationRouter = Router();
publicRegistrationRouter.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
publicRegistrationRouter.get('/directory', wrap(async (_req, res) => {
  res.json(await registrationDirectory());
}));
publicRegistrationRouter.post('/', requireOrigin, wrap(async (req, res) => {
  res.status(201).json(await submitRegistration(req.body));
}));

/** Закрытый контур: настройка прав и решения по заявкам. */
export const adminSettingsRouter = Router();
adminSettingsRouter.use(requireSession);
adminSettingsRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try { enforceSessionRateLimit(req.authUser!.sessionId, req.method !== 'GET'); next(); } catch (err) { next(err); }
});

adminSettingsRouter.get('/roles', wrap(async (req, res) => {
  res.json(await readRoleMatrix(req.authUser!));
}));
adminSettingsRouter.post('/roles/:code/permissions', requireOrigin, requireCsrf, wrap(async (req, res) => {
  res.json(await updateRolePermissions(req.authUser!, req.params.code, req.body));
}));

adminSettingsRouter.get('/registrations/pending-count', wrap(async (req, res) => {
  res.json(await pendingRegistrationCount(req.authUser!));
}));
adminSettingsRouter.get('/registrations', wrap(async (req, res) => {
  res.json(await listRegistrationRequests(req.authUser!, String(req.query.status ?? 'PENDING')));
}));
for (const action of ['approve', 'reject'] as const) {
  adminSettingsRouter.post(`/registrations/:id/${action}`, requireOrigin, requireCsrf, wrap(async (req, res) => {
    res.json(await decideRegistration(req.authUser!, req.params.id, action, req.body));
  }));
}
