/* Runs once before the whole test run (Jest globalSetup — separate process,
 * so it can't share module state with test files; reads env directly). Wipes
 * and re-seeds the dedicated fresh_pilot_test database so the suite starts
 * from a known state every run. Never touches fresh_pilot (dev DB) — the
 * database name is hardcoded here for that reason, not read from the
 * developer's own .env. */
import { Client } from 'pg';
import argon2 from 'argon2';

const TEST_DB = 'fresh_pilot_test';
const TEST_PASSWORD = process.env.SEED_FIXTURE_PASSWORD ?? 'Test#Fixture2026Pilot';

const FIXTURES = [
  { login: 'rm_a', full_name: 'Тестовый постановщик A', role: 'REGIONAL_MANAGER', org: 'A' },
  { login: 'rf_a', full_name: 'Тестовый исполнитель A', role: 'RF', org: 'A' },
  { login: 'rm_b', full_name: 'Тестовый постановщик B', role: 'REGIONAL_MANAGER', org: 'B' },
  { login: 'rf_b', full_name: 'Тестовый исполнитель B', role: 'RF', org: 'B' },
  { login: 'rm_rf_a_dual', full_name: 'Двойная роль A (тест)', role: 'REGIONAL_MANAGER', org: 'A' },
  { login: 'rm_rf_a_dual', full_name: 'Двойная роль A (тест)', role: 'RF', org: 'A' },
];

module.exports = async function globalSetup() {
  const host = process.env.PGHOST ?? 'localhost';
  const port = parseInt(process.env.PGPORT ?? '5432', 10);
  const user = process.env.PGUSER ?? 'fresh_app';
  const password = process.env.PGPASSWORD ?? '';

  const client = new Client({ host, port, database: TEST_DB, user, password });
  await client.connect();
  try {
    await client.query('SET search_path = pilot_r1, pg_catalog');

    // Reset mutable tables between full test runs (opt-in, this-process-only
    // truncate of the dedicated test DB — never the dev/deployed DB, and
    // never triggered by db:seed, which stays non-destructive per contract).
    await client.query(
      `TRUNCATE TABLE notifications, consumer_receipts, outbox_events, audit_log,
              idempotency_records, submissions, work_item_fields, work_items,
              sessions RESTART IDENTITY CASCADE`,
    );
    await client.query(`DELETE FROM role_grants`);
    await client.query(`DELETE FROM app_users`);

    const passwordHash = await argon2.hash(TEST_PASSWORD);
    const orgRows = await client.query('SELECT id, code FROM org_units');
    const orgByCode: Record<string, string> = {};
    for (const row of orgRows.rows) orgByCode[row.code] = row.id;

    const userIds: Record<string, string> = {};
    for (const f of FIXTURES) {
      let userId = userIds[f.login];
      if (!userId) {
        const inserted = await client.query(
          `INSERT INTO app_users (login, full_name, password_hash, password_hash_updated_at)
           VALUES ($1,$2,$3, now()) RETURNING id`,
          [f.login, f.full_name, passwordHash],
        );
        userId = inserted.rows[0].id;
        userIds[f.login] = userId;
      }
      await client.query(
        `INSERT INTO role_grants (user_id, role_code, org_unit_id, valid_from) VALUES ($1,$2,$3, now())`,
        [userId, f.role, orgByCode[f.org]],
      );
    }
    // eslint-disable-next-line no-console
    console.log('[globalSetup] fresh_pilot_test seeded:', Object.keys(userIds).join(', '));
  } finally {
    await client.end();
  }
};
