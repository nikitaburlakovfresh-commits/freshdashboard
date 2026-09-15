import { Pool, PoolClient, types } from 'pg';
import { config } from '../config';

// pg returns BIGINT (OID 20) as strings by default to avoid precision loss
// above Number.MAX_SAFE_INTEGER. All bigint columns in this schema are
// small monotonically-increasing counters (entity_version, field_version,
// submission_revision, rework_count) that never approach that bound, and
// the domain/service layer compares them as JS numbers (CAS checks use
// strict !==). Parse them as numbers here, once, globally, rather than
// patching every call site — the alternative (leaving them as strings)
// silently breaks every optimistic-concurrency check in the app.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

// All connections pin search_path to pilot_r1 and force UTC per contract
// (schema.sql header, ENGINEERING_PILOT.md §3 due_at semantics).
export const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  max: 10,
});

pool.on('connect', (client) => {
  client.query('SET search_path = pilot_r1, pg_catalog').catch(() => {});
  client.query("SET TIME ZONE 'UTC'").catch(() => {});
});

export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignore rollback error */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
