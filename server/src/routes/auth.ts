import { Router, Request, Response, NextFunction } from 'express';
import { pool, withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import { requireOrigin } from '../middleware/origin';
import { requireSession, requireCsrf, createSession, setSessionCookie, clearSessionCookie } from '../auth/session';
import { verifyPassword } from '../auth/password';
import { enforceLoginRateLimit, enforceSessionRateLimit } from '../auth/rateLimit';
import { getEffectiveGrants } from '../domain/grants';
import { writeAuditAndOutbox } from '../domain/auditOutbox';

export const authRouter = Router();
export const meRouter = Router();

function wrap(fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}

// POST /auth/login — contract §Auth. Uniform INVALID_CREDENTIALS for
// wrong/unknown/disabled login; exact-Origin required; no CSRF header at
// this bootstrap step since no session exists yet.
authRouter.post(
  '/login',
  requireOrigin,
  wrap(async (req, res) => {
    const ip = req.ip ?? null;
    const { login, password } = req.body ?? {};
    if (typeof login !== 'string' || typeof password !== 'string' || login.length === 0 || password.length === 0) {
      throw new ApiError('VALIDATION_ERROR', 'Логин и пароль обязательны.', {
        issues: [{ path: 'login/password', issue: 'required strings' }],
      });
    }

    enforceLoginRateLimit(login, ip);

    // The whole login — credential check, session insert, and audit/outbox
    // — commits as ONE transaction per contract §4/§7, so a session row is
    // never durable without its audit trail and vice versa (previously these
    // were three separate auto-committing pool.query calls plus a fourth
    // transaction for the audit write — a crash between them could leave a
    // usable session with no audit trail).
    const { rawToken, csrfToken, expiresAt, sessionId, user } = await withTransaction(async (client) => {
      const userRes = await client.query(
        `SELECT id, password_hash, is_active, user_kind, password_last_shared_indicator, full_name
         FROM app_users WHERE login = $1`,
        [login],
      );
      const row = userRes.rows[0];
      const passwordHash = row ? row.password_hash : null;
      const ok = await verifyPassword(passwordHash, password);

      if (!row || !row.is_active || row.user_kind !== 'INDIVIDUAL' || row.password_last_shared_indicator || !ok) {
        throw new ApiError('INVALID_CREDENTIALS', 'Неверный логин или пароль.');
      }

      const session = await createSession(client, row.id);

      await writeAuditAndOutbox(client, {
        actorUserId: row.id,
        actorRole: null,
        orgUnitId: null,
        workItemId: null,
        action: 'LOGIN',
        aggregateType: 'session',
        aggregateId: session.sessionId,
        aggregateVersion: 1,
        requestId: req.ctx.requestId,
        beforeState: null,
        afterState: { session_id: session.sessionId },
        resolution: 'APPLIED',
        retentionClass: 'SECURITY_5Y',
        ip,
        userAgent: req.header('user-agent') ?? null,
        eventType: 'auth.logged_in',
        payload: { session_id: session.sessionId },
      });

      return { ...session, user: { id: row.id, login, full_name: row.full_name, user_kind: row.user_kind } };
    });

    setSessionCookie(res, rawToken, expiresAt);
    res.status(200).json({
      user,
      csrf_token: csrfToken,
      expires_at: expiresAt.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    });
  }),
);

// POST /auth/logout
authRouter.post(
  '/logout',
  requireOrigin,
  requireSession,
  requireCsrf,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, true);
    const revokedAt = new Date();
    await withTransaction(async (client) => {
      await client.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.authUser!.sessionId]);
      await writeAuditAndOutbox(client, {
        actorUserId: req.authUser!.userId,
        actorRole: null,
        orgUnitId: null,
        workItemId: null,
        action: 'LOGOUT',
        aggregateType: 'session',
        aggregateId: req.authUser!.sessionId,
        aggregateVersion: 2,
        requestId: req.ctx.requestId,
        beforeState: { revoked: false },
        afterState: { revoked: true },
        resolution: 'APPLIED',
        retentionClass: 'SECURITY_5Y',
        ip: req.ip ?? null,
        userAgent: req.header('user-agent') ?? null,
        eventType: 'auth.logged_out',
        payload: { session_id: req.authUser!.sessionId },
      });
    });
    clearSessionCookie(res);
    res.status(200).json({ revoked: true, revoked_at: revokedAt.toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }),
);

// GET /me
meRouter.get(
  '/',
  requireSession,
  wrap(async (req, res) => {
    enforceSessionRateLimit(req.authUser!.sessionId, false);
    const client = await pool.connect();
    try {
      const grants = await getEffectiveGrants(client, req.authUser!.userId);
      const userRes = await client.query(
        `SELECT id, login, full_name, user_kind FROM app_users WHERE id = $1`,
        [req.authUser!.userId],
      );
      const sessRes = await client.query('SELECT expires_at FROM sessions WHERE id = $1', [req.authUser!.sessionId]);
      res.status(200).json({
        user: userRes.rows[0],
        csrf_token: req.authUser!.csrfToken,
        expires_at: new Date(sessRes.rows[0].expires_at).toISOString().replace(/\.\d{3}Z$/, 'Z'),
        grants: grants.map((g) => ({
          id: g.id,
          role: g.role,
          org_unit_id: g.orgUnitId,
          valid_from: new Date(g.validFrom).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          valid_until: g.validUntil ? new Date(g.validUntil).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
          permissions: g.permissions,
        })),
      });
    } finally {
      client.release();
    }
  }),
);
