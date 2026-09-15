import { Request, Response, NextFunction } from 'express';
import { PoolClient } from 'pg';
import { pool } from '../db/pool';
import { config } from '../config';
import { ApiError } from '../util/errors';
import { sha256, constantTimeEqual, deriveCsrfToken, randomToken } from '../util/crypto';

export const SESSION_COOKIE_NAME = '__Host-fresh_session';
// Contract §7 proposal: idle 30min, absolute 8h.
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;

export interface AuthedUser {
  sessionId: string;
  userId: string;
  login: string;
  fullName: string;
  csrfToken: string;
  rawToken: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUser?: AuthedUser;
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    out[key] = decodeURIComponent(val);
  }
  return out;
}

// MUST be called with a `client` that is already inside the caller's
// transaction (see routes/auth.ts `login`), so the session row commits
// atomically together with the audit_log/outbox_events rows written in the
// same transaction (contract §4/§7: login must be a single atomic unit —
// no session may be observable/usable without its audit trail, and no
// audit-only "phantom login" may exist without a usable session).
export async function createSession(client: PoolClient, userId: string): Promise<{ rawToken: string; csrfToken: string; expiresAt: Date; sessionId: string }> {
  const rawToken = randomToken(32);
  const csrfToken = deriveCsrfToken(rawToken, config.csrfHmacSecret);
  const tokenDigest = sha256(rawToken);
  const csrfDigest = sha256(csrfToken);
  const expiresAt = new Date(Date.now() + ABSOLUTE_TIMEOUT_MS);

  // Row lock + re-check is_active/user_kind/shared-password INSIDE the same
  // transaction as the credential check that already happened in the route,
  // closing the TOCTOU window between "verify password" and "create session"
  // (a concurrent admin deactivation/rotation between those two steps must
  // not still mint a usable session).
  const userRes = await client.query(
    'SELECT auth_epoch, is_active, user_kind, password_last_shared_indicator FROM app_users WHERE id = $1 FOR UPDATE',
    [userId],
  );
  if (userRes.rowCount === 0) {
    throw new ApiError('INVALID_CREDENTIALS', 'Неверный логин или пароль.');
  }
  const row = userRes.rows[0];
  if (!row.is_active || row.user_kind !== 'INDIVIDUAL' || row.password_last_shared_indicator) {
    throw new ApiError('INVALID_CREDENTIALS', 'Неверный логин или пароль.');
  }
  const authEpoch = row.auth_epoch;

  const inserted = await client.query(
    `INSERT INTO sessions (user_id, token_digest, csrf_digest, captured_auth_epoch, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, tokenDigest, csrfDigest, authEpoch, expiresAt],
  );
  return { rawToken, csrfToken, expiresAt, sessionId: inserted.rows[0].id };
}

// Loads and validates the current session against every live fence: active
// user, matching auth_epoch, password rotation after session creation,
// idle+absolute expiry, and non-revoked (contract §7 threat table).
export async function loadSession(rawToken: string): Promise<AuthedUser | null> {
  const tokenDigest = sha256(rawToken);
  const res = await pool.query(
    `SELECT s.id as session_id, s.user_id, s.csrf_digest, s.captured_auth_epoch,
            s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
            u.login, u.full_name, u.is_active, u.auth_epoch, u.password_hash_updated_at,
            u.password_last_shared_indicator
     FROM sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_digest = $1`,
    [tokenDigest],
  );
  if (res.rowCount === 0) return null;
  const row = res.rows[0];

  if (row.revoked_at) return null;
  if (!row.is_active) return null;
  if (row.password_last_shared_indicator) return null;
  if (row.auth_epoch !== row.captured_auth_epoch) return null;
  if (new Date(row.password_hash_updated_at).getTime() > new Date(row.created_at).getTime()) {
    return null;
  }
  const now = Date.now();
  if (now > new Date(row.expires_at).getTime()) return null;
  if (now - new Date(row.last_seen_at).getTime() > IDLE_TIMEOUT_MS) return null;
  if (now - new Date(row.created_at).getTime() > ABSOLUTE_TIMEOUT_MS) return null;

  // Sliding idle window; last_seen_at touch is not a business mutation.
  await pool.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [row.session_id]);

  const csrfToken = deriveCsrfToken(rawToken, config.csrfHmacSecret);
  if (!constantTimeEqual(sha256(csrfToken), row.csrf_digest)) return null;

  return {
    sessionId: row.session_id,
    userId: row.user_id,
    login: row.login,
    fullName: row.full_name,
    csrfToken,
    rawToken,
  };
}

export function setSessionCookie(res: Response, rawToken: string, expiresAt: Date) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
  );
}

export function clearSessionCookie(res: Response) {
  res.append(
    'Set-Cookie',
    `${SESSION_COOKIE_NAME}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
}

// Required for every protected route. Populates req.authUser or fails 401.
export async function requireSession(req: Request, _res: Response, next: NextFunction) {
  try {
    const cookies = parseCookies(req.header('cookie'));
    const rawToken = cookies[SESSION_COOKIE_NAME];
    if (!rawToken) {
      return next(new ApiError('UNAUTHENTICATED', 'Требуется персональный вход.'));
    }
    const authed = await loadSession(rawToken);
    if (!authed) {
      return next(new ApiError('SESSION_REVOKED', 'Сессия недействительна или отозвана.'));
    }
    req.authUser = authed;
    next();
  } catch (err) {
    next(err);
  }
}

// Required for all unsafe (non-GET) operations besides login. Verifies the
// X-CSRF-Token header matches the session-bound token (contract §7).
export function requireCsrf(req: Request, _res: Response, next: NextFunction) {
  const header = req.header('X-CSRF-Token');
  if (!req.authUser || !header || header !== req.authUser.csrfToken) {
    return next(new ApiError('CSRF_INVALID', 'Недействительный CSRF-токен.'));
  }
  next();
}
