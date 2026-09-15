import { Router, Request, Response, NextFunction } from 'express';
import { ApiError } from '../util/errors';
import { requireOrigin } from '../middleware/origin';
import { requireSession, requireCsrf } from '../auth/session';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import * as svc from '../domain/workItemService';

export const notificationsRouter = Router();

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

function buildCtx(req: Request) {
  return {
    authUser: req.authUser!,
    requestId: req.ctx.requestId,
    ip: req.ip ?? null,
    userAgent: req.header('user-agent') ?? null,
  };
}

function parseLimit(raw: unknown): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) {
    throw new ApiError('VALIDATION_ERROR', 'limit должен быть целым от 1 до 100.', {
      issues: [{ path: 'limit', issue: 'integer 1-100' }],
    });
  }
  return n;
}

// GET /notifications
notificationsRouter.get(
  '/',
  requireSession,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, false);
    const unreadOnly = req.query.unread_only === 'true';
    const limit = parseLimit(req.query.limit);
    const cursor = req.query.cursor as string | undefined;
    const result = await svc.listNotifications(buildCtx(req), { unreadOnly, limit, cursor });
    res.status(200).json(result);
  }),
);

// POST /notifications/:id/read
notificationsRouter.post(
  '/:id/read',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = (req.header('Idempotency-Key') ?? '') as string;
    const result = await svc.readNotification(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);
