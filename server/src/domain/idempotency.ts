import { PoolClient } from 'pg';
import { createHash } from 'crypto';
import { ApiError } from '../util/errors';
import { canonicalJsonHash } from '../util/crypto';

// `FOR UPDATE` only locks rows that already exist — on the FIRST request
// with a given (actor, operation, key) there is no row yet, so it locks
// nothing. Two concurrent first-requests then both see rowCount===0, both
// proceed to INSERT, and the loser hits the unique constraint as a raw
// Postgres error (uncaught -> 503) instead of the intended 409. A
// transaction-scoped advisory lock keyed by the same tuple, acquired BEFORE
// the SELECT, serializes concurrent callers regardless of whether the row
// exists yet, so the loser always observes the winner's committed/pending
// row and gets a correct outcome (a same-payload replay, or
// IDEMPOTENCY_IN_PROGRESS/IDEMPOTENCY_KEY_REUSED) instead of a raw
// constraint violation surfacing as 503.
function advisoryLockKey(actorId: string, operation: string, key: string): [number, number] {
  const digest = createHash('sha256').update(`${actorId}:${operation}:${key}`).digest();
  // Two signed 32-bit ints, as required by pg_advisory_xact_lock(int,int).
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export type IdempotentOperation =
  | 'userCreate'
  | 'accessChangeCreate' | 'accessChangePreview' | 'accessChangeApply'
  | 'reportReviewDraft'
  | 'reportFactPublish'
  | 'orgChangeCreate' | 'orgChangeEdit' | 'orgChangePreview' | 'orgChangeApply'
  | 'createWorkItem'
  | 'assignWorkItem'
  | 'startWorkItem'
  | 'patchWorkItemFields'
  | 'submitWorkItem'
  | 'acceptWorkItem'
  | 'reworkWorkItem'
  | 'cancelWorkItem'
  | 'reopenWorkItem'
  | 'readNotification';

/**
 * Implements contract §4 sequence step 3 (fingerprint) and step 7 (atomic
 * commit including the saved success response). Fingerprint = operation +
 * normalized target (path param, or null for create) + canonical JSON body.
 * Must run inside the same transaction as the business mutation so that the
 * IN_PROGRESS row and the eventual SUCCEEDED row are part of one commit.
 */
export async function beginIdempotent(
  client: PoolClient,
  actorId: string,
  operation: IdempotentOperation,
  key: string,
  targetId: string | null,
  body: unknown,
): Promise<{ replay: { status: number; body: unknown } } | { fresh: true }> {
  const payloadHash = canonicalJsonHash({ targetId, body });

  const [lockA, lockB] = advisoryLockKey(actorId, operation, key);
  // Held for the rest of this DB transaction (pg_advisory_xact_lock auto-
  // releases on COMMIT/ROLLBACK) — serializes any concurrent request with
  // the exact same (actor, operation, key) before either one reads/writes
  // the idempotency_records row.
  await client.query('SELECT pg_advisory_xact_lock($1, $2)', [lockA, lockB]);

  const existing = await client.query(
    `SELECT target_id, payload_hash, status, response_status, response_body
     FROM idempotency_records
     WHERE actor_id = $1 AND operation = $2 AND key = $3
     FOR UPDATE`,
    [actorId, operation, key],
  );

  if (existing.rowCount && existing.rowCount > 0) {
    const row = existing.rows[0];
    const sameTarget = (row.target_id ?? null) === (targetId ?? null);
    const sameHash = Buffer.compare(row.payload_hash, payloadHash) === 0;
    if (!sameTarget || !sameHash) {
      throw new ApiError(
        'IDEMPOTENCY_KEY_REUSED',
        'Ключ идемпотентности уже использован с другим запросом.',
      );
    }
    if (row.status === 'IN_PROGRESS') {
      throw new ApiError(
        'IDEMPOTENCY_IN_PROGRESS',
        'Предыдущий запрос с этим ключом ещё выполняется.',
      );
    }
    // status === 'SUCCEEDED': caller must re-check current authorization
    // before returning this replay (contract §4 step 3), which callers do
    // prior to invoking this function via the standard permission checks.
    return { replay: { status: row.response_status, body: row.response_body } };
  }

  // expires_at is computed by Postgres itself, relative to the SAME now()
  // used for created_at, via `now() + interval '30 days'` in one SQL
  // expression -- not `new Date(Date.now() + 30d)` computed in Node and
  // passed as a parameter. The two clocks (Node's Date.now() at query-build
  // time vs Postgres's now() at execution time) are never perfectly equal,
  // so the Node-computed value could land a few milliseconds BEFORE
  // created_at + 30 days once the DB actually executes the INSERT,
  // violating the table's own CHECK (expires_at >= created_at + 30 days)
  // and turning every idempotent create into an uncaught 503. Binding both
  // timestamps to the same DB-side now() removes the race entirely.
  await client.query(
    `INSERT INTO idempotency_records (actor_id, operation, key, target_id, payload_hash, status, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'IN_PROGRESS', now(), now() + interval '30 days')`,
    [actorId, operation, key, targetId, payloadHash],
  );
  return { fresh: true };
}

export async function completeIdempotent(
  client: PoolClient,
  actorId: string,
  operation: IdempotentOperation,
  key: string,
  status: number,
  body: unknown,
): Promise<void> {
  await client.query(
    `UPDATE idempotency_records
     SET status = 'SUCCEEDED', response_status = $4, response_body = $5
     WHERE actor_id = $1 AND operation = $2 AND key = $3`,
    [actorId, operation, key, status, body],
  );
}
