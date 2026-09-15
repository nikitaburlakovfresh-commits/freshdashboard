// Loaded once per test file via setupFilesAfterEnv. Points every test at the
// dedicated fresh_pilot_test database (never fresh_pilot, the dev DB) and
// supplies the documented test-only fixture secrets. Never used outside
// NODE_ENV=test (see server/src/config.ts guard).
process.env.NODE_ENV = 'test';
process.env.PGDATABASE = process.env.PGDATABASE ?? 'fresh_pilot_test';
process.env.PGHOST = process.env.PGHOST ?? 'localhost';
process.env.PGPORT = process.env.PGPORT ?? '5432';
process.env.PGUSER = process.env.PGUSER ?? 'fresh_app';
// Documented synthetic-only fixture; never used for the dev/deployed DB.
process.env.PGPASSWORD = process.env.PGPASSWORD ?? '';
process.env.SESSION_HMAC_SECRET = process.env.SESSION_HMAC_SECRET ?? 'test-only-session-hmac-secret-fixture-not-for-prod';
process.env.CSRF_HMAC_SECRET = process.env.CSRF_HMAC_SECRET ?? 'test-only-csrf-hmac-secret-fixture-not-for-prod';
process.env.ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? 'http://localhost:5173';
process.env.SEED_FIXTURE_PASSWORD = process.env.SEED_FIXTURE_PASSWORD ?? 'Test#Fixture2026Pilot';
