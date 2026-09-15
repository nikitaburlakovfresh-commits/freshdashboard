import { Router, Request, Response, NextFunction } from 'express';
import { ApiError } from '../util/errors';
import { requireOrigin } from '../middleware/origin';
import { requireSession, requireCsrf } from '../auth/session';
import { enforceSessionRateLimit } from '../auth/rateLimit';
import * as svc from '../domain/workItemService';

export const workItemsRouter = Router();

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

function readIdemKey(req: Request): string {
  return (req.header('Idempotency-Key') ?? '') as string;
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

// GET /work-items
workItemsRouter.get(
  '/',
  requireSession,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, false);
    const orgFilter = req.query.org_unit_id as string | undefined;
    const status = req.query.status as string | undefined;
    const limit = parseLimit(req.query.limit);
    const cursor = req.query.cursor as string | undefined;
    const result = await svc.listWorkItems(buildCtx(req), { orgFilter, status, limit, cursor });
    res.status(200).json(result);
  }),
);

// POST /work-items
workItemsRouter.post(
  '/',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.createWorkItem(buildCtx(req), idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// GET /work-items/:id
workItemsRouter.get(
  '/:id',
  requireSession,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, false);
    const result = await svc.getWorkItem(buildCtx(req), req.params.id);
    res.status(200).json(result);
  }),
);

// GET /work-items/:id/eligible-assignees
// Additive R1 pilot endpoint (18th operation, beyond the 17 contract
// operationIds) -- read-only, RM-only, branch-scoped. Feeds the assignment
// picker in the client so an operator never has to paste a raw UUID.
workItemsRouter.get(
  '/:id/eligible-assignees',
  requireSession,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, false);
    const result = await svc.getEligibleAssignees(buildCtx(req), req.params.id);
    res.status(200).json(result);
  }),
);

// POST /work-items/:id/assign
workItemsRouter.post(
  '/:id/assign',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.assignWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// POST /work-items/:id/start
workItemsRouter.post(
  '/:id/start',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.startWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// PATCH /work-items/:id/fields
workItemsRouter.patch(
  '/:id/fields',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.patchWorkItemFields(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// POST /work-items/:id/submit
workItemsRouter.post(
  '/:id/submit',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.submitWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// POST /work-items/:id/accept
workItemsRouter.post(
  '/:id/accept',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.acceptWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// POST /work-items/:id/rework
workItemsRouter.post(
  '/:id/rework',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.reworkWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// POST /work-items/:id/cancel
workItemsRouter.post(
  '/:id/cancel',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.cancelWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// POST /work-items/:id/reopen
workItemsRouter.post(
  '/:id/reopen',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const idemKey = readIdemKey(req);
    const result = await svc.reopenWorkItem(buildCtx(req), req.params.id, idemKey, req.body ?? {});
    res.status(result.status).json(result.body);
  }),
);

// GET /work-items/:id/history
workItemsRouter.get(
  '/:id/history',
  requireSession,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, false);
    const limit = parseLimit(req.query.limit);
    const cursor = req.query.cursor as string | undefined;
    const result = await svc.getWorkItemHistory(buildCtx(req), req.params.id, { limit, cursor });
    res.status(200).json(result);
  }),
);
