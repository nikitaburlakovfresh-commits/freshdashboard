/** A name alone is not a safety boundary: forbid remote hosts and mismatched
 * database environments before test setup can truncate or seed anything. */
export function assertLocalTestDatabase() {
  if (process.env.PGDATABASE && process.env.PGDATABASE !== 'fresh_pilot_test') {
    throw new Error('Tests require PGDATABASE=fresh_pilot_test; refusing any other database');
  }
  const host = process.env.PGHOST ?? 'localhost';
  if (!['localhost', '127.0.0.1', '::1', '/var/run/postgresql'].includes(host)) {
    throw new Error('Tests require a local PostgreSQL host; remote connections are forbidden');
  }
  process.env.PGDATABASE = 'fresh_pilot_test';
}
