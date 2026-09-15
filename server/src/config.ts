import 'dotenv/config';

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name}`);
  }
  return v;
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '4000', 10),
  db: {
    host: process.env.PGHOST ?? 'localhost',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'fresh_pilot',
    user: process.env.PGUSER ?? 'fresh_app',
    password: process.env.PGPASSWORD ?? '',
  },
  // R1-01 session auth. Secrets must come from env; no baked-in defaults in
  // any environment other than test, where a fixed fixture is documented.
  sessionHmacSecret:
    process.env.SESSION_HMAC_SECRET ??
    (process.env.NODE_ENV === 'test' ? 'test-only-session-hmac-secret-fixture-not-for-prod' : ''),
  csrfHmacSecret:
    process.env.CSRF_HMAC_SECRET ??
    (process.env.NODE_ENV === 'test' ? 'test-only-csrf-hmac-secret-fixture-not-for-prod' : ''),
  allowedOrigin:
    process.env.ALLOWED_ORIGIN ??
    (process.env.NODE_ENV === 'test' ? 'http://localhost:5173' : ''),
  seedFixturePassword: process.env.SEED_FIXTURE_PASSWORD ?? '',
};

if (!config.sessionHmacSecret || !config.csrfHmacSecret || !config.allowedOrigin) {
  // Fail fast rather than silently weakening auth (contract §7).
  // eslint-disable-next-line no-console
  console.error(
    'FATAL: SESSION_HMAC_SECRET, CSRF_HMAC_SECRET and ALLOWED_ORIGIN must be set via environment.',
  );
  if (config.nodeEnv !== 'test') {
    process.exit(1);
  }
}
