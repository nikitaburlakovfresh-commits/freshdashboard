import { ApiError } from '../util/errors';

// In-memory rate limiting for the R1 pilot only. Contract §7 proposes
// 5 failed attempts/(login,15min), 30/(IP,15min) with progressive delay.
// A real deployment would need a shared store across processes; documented
// as an R1 pilot limitation in IMPLEMENTATION.md (single-process assumption).

interface Bucket {
  count: number;
  windowStart: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT = 5;
const IP_LIMIT = 30;
// Было 30 изменений в минуту. Ежедневник РФ — 95 полей с автосохранением каждого,
// и при быстром заполнении лимит срабатывал: владелец получил «Повторите позже» на
// 72-й версии и не смог сдать день (26.09.2026). Лимит защищает от перебора и
// сбойного клиента, а не от человека, быстро заполняющего форму.
const MUTATION_LIMIT = 300; // per session per minute
const GENERAL_LIMIT = 600; // per session per minute
const MINUTE_MS = 60 * 1000;

const byLogin = new Map<string, Bucket>();
const byIp = new Map<string, Bucket>();
const bySessionGeneral = new Map<string, Bucket>();
const bySessionMutation = new Map<string, Bucket>();

function hit(map: Map<string, Bucket>, key: string, windowMs: number, limit: number): { blocked: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const existing = map.get(key);
  if (!existing || now - existing.windowStart > windowMs) {
    map.set(key, { count: 1, windowStart: now });
    return { blocked: false, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  if (existing.count > limit) {
    const retryAfterSeconds = Math.ceil((existing.windowStart + windowMs - now) / 1000);
    return { blocked: true, retryAfterSeconds: Math.max(1, retryAfterSeconds) };
  }
  return { blocked: false, retryAfterSeconds: 0 };
}

export function checkLoginRateLimit(login: string, ip: string) {
  const loginResult = hit(byLogin, login, WINDOW_MS, LOGIN_LIMIT);
  if (loginResult.blocked) return loginResult;
  return hit(byIp, ip, WINDOW_MS, IP_LIMIT);
}

export function checkSessionRateLimit(sessionId: string, isMutation: boolean) {
  const general = hit(bySessionGeneral, sessionId, MINUTE_MS, GENERAL_LIMIT);
  if (general.blocked) return general;
  if (isMutation) return hit(bySessionMutation, sessionId, MINUTE_MS, MUTATION_LIMIT);
  return { blocked: false, retryAfterSeconds: 0 };
}

export function _resetForTests() {
  byLogin.clear();
  byIp.clear();
  bySessionGeneral.clear();
  bySessionMutation.clear();
}

export function enforceLoginRateLimit(login: string, ip: string | null): void {
  const result = checkLoginRateLimit(login, ip ?? 'unknown');
  if (result.blocked) {
    throw new ApiError('RATE_LIMITED', 'Повторите позже.', { retry_after_seconds: result.retryAfterSeconds });
  }
}

export function enforceSessionRateLimit(sessionId: string, isMutation: boolean): void {
  const result = checkSessionRateLimit(sessionId, isMutation);
  if (result.blocked) {
    throw new ApiError('RATE_LIMITED', 'Повторите позже.', { retry_after_seconds: result.retryAfterSeconds });
  }
}
