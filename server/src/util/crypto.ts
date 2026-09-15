import crypto from 'crypto';

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

// Contract §7 PROPOSED token bootstrap: CSRF token derived deterministically
// from the raw session token via HMAC-SHA256, so verifying a presented CSRF
// header only requires recomputing the HMAC from the raw cookie token —
// nothing extra needs to be stored beyond the CSRF digest already in the DB.
export function deriveCsrfToken(rawSessionToken: string, csrfSecret: string): string {
  return crypto
    .createHmac('sha256', csrfSecret)
    .update(`R1-CSRF-v1:${rawSessionToken}`)
    .digest('base64url');
}

export function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function canonicalJsonHash(value: unknown): Buffer {
  return sha256(canonicalize(value));
}

// Deterministic key ordering so payload hashing (idempotency fingerprint,
// contract §4 sequence step 3) does not depend on client key order.
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}
