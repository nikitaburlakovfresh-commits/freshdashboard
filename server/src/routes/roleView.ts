import { Router, Request, Response, NextFunction } from 'express';
import { requireSession, requireCsrf } from '../auth/session';
import { requireOrigin } from '../middleware/origin';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import { listViewCandidates, enterRoleView, exitRoleView, roleViewStatus } from '../domain/roleView';

export const roleViewRouter = Router();
roleViewRouter.use(requireSession);
roleViewRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  try { enforceSessionRateLimit(req.authUser!.sessionId, req.method !== 'GET'); next(); } catch (err) { next(err); }
});
const wrap = (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => { fn(req, res).catch(next); };

const ip = (req: Request) => req.ip ?? null;
const ua = (req: Request) => req.header('user-agent') ?? null;

roleViewRouter.get('/status', (req, res) => { res.json(roleViewStatus(req.authUser!)); });

roleViewRouter.get('/candidates', wrap(async (req, res) => {
  res.json(await listViewCandidates(req.authUser!));
}));

roleViewRouter.post('/', requireOrigin, requireCsrf, wrap(async (req, res) => {
  res.json(await enterRoleView(req.authUser!, req.body, ip(req), ua(req)));
}));

// Выход намеренно не требует CSRF-заголовка: он должен срабатывать всегда,
// включая случай, когда экран роли отдал клиенту другой набор данных. Это
// единственное изменяющее действие, разрешённое в режиме просмотра, и оно
// только возвращает администратора к самому себе.
roleViewRouter.post('/exit', requireOrigin, wrap(async (req, res) => {
  res.json(await exitRoleView(req.authUser!, ip(req), ua(req)));
}));
