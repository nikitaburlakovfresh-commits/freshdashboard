/* Runs once before the whole test run (Jest globalSetup — separate process,
 * so it can't share module state with test files; reads env directly). Wipes
 * and re-seeds the dedicated fresh_pilot_test database so the suite starts
 * from a known state every run. Never touches fresh_pilot (dev DB) — the
 * database name is hardcoded here for that reason, not read from the
 * developer's own .env. */
import { Client } from 'pg';
import argon2 from 'argon2';
import { assertLocalTestDatabase } from './testDatabaseGuard';
import { applyVersionedMigrations } from '../src/db/migrations';

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
  assertLocalTestDatabase();
  const host = process.env.PGHOST ?? 'localhost';
  const port = parseInt(process.env.PGPORT ?? '5432', 10);
  const user = process.env.PGUSER ?? 'fresh_app';
  const password = process.env.PGPASSWORD ?? '';

  const client = new Client({ host, port, database: TEST_DB, user, password });
  await client.connect();
  try {
    const target = await client.query('SELECT current_database() AS db, current_setting(\'server_version_num\')::int AS version');
    if (target.rows[0].db !== TEST_DB || target.rows[0].version < 160000 || target.rows[0].version >= 170000) {
      throw new Error('Expected the isolated fresh_pilot_test database on PostgreSQL 16');
    }
    await client.query("SELECT pg_advisory_lock(hashtext('fresh:versioned-migrations'))");
    try { await applyVersionedMigrations(client); }
    finally { await client.query("SELECT pg_advisory_unlock(hashtext('fresh:versioned-migrations'))"); }
    await client.query('SET search_path = pilot_r1, pg_catalog');

    // Reset mutable tables between full test runs (opt-in, this-process-only
    // truncate of the dedicated test DB — never the dev/deployed DB, and
    // never triggered by db:seed, which stays non-destructive per contract).
    await client.query(
      `TRUNCATE TABLE notifications, consumer_receipts, outbox_events, audit_log,
              idempotency_records, submissions, work_item_fields, work_items,
              sessions RESTART IDENTITY CASCADE`,
    );
    await client.query('TRUNCATE report_staging_access,report_staging_files,report_staging_batches');
    await client.query('TRUNCATE administrator_bootstrap');
    await client.query('TRUNCATE org_change_proposals, organization_editor_provisioning');
    await client.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code<>'organization.directory.review'");
    await client.query(`DELETE FROM role_grants`);
    await client.query(`DELETE FROM app_users`);
    // Synthetic metadata only. No deployed database is reachable through the
    // local/name/version guard above. Immutable history is never disabled.
    await client.query('TRUNCATE report_staging_files,report_staging_batches,org_directory_name_history, org_directory_affiliation_history, org_directory_units');
    await client.query(`INSERT INTO org_directory_units
      (id,code,kind,lifecycle_state,is_demo,demo_locked,effective_from,pilot_org_unit_id)
      SELECT id,code,'ORG_UNIT','ACTIVE',true,true,'2020-01-01',id FROM org_units`);
    await client.query(`INSERT INTO org_directory_units
      (id,code,kind,lifecycle_state,is_demo,effective_from) VALUES
      ('10000000-0000-4000-8000-000000000001','TEST_NETWORK','NETWORK','ACTIVE',true,'2020-01-01'),
      ('10000000-0000-4000-8000-000000000002','TEST_DIVISION','DIVISION','ACTIVE',true,'2020-01-01'),
      ('10000000-0000-4000-8000-000000000003','TEST_CLUSTER','CLUSTER','ACTIVE',true,'2020-01-01'),
      ('10000000-0000-4000-8000-000000000004','TEST_NONDEMO','NETWORK','ACTIVE',false,'2020-01-01')`);
    await client.query(`INSERT INTO org_directory_name_history
      (org_unit_id,display_name,effective_from,effective_to,change_reason)
      SELECT id,'Прежнее имя '||code||' (тест)','2020-01-01','2026-01-01','Synthetic test history' FROM org_units`);
    await client.query(`INSERT INTO org_directory_name_history
      (org_unit_id,display_name,effective_from,change_reason)
      SELECT id,display_name,'2026-01-01','Synthetic current name' FROM org_units`);
    await client.query(`INSERT INTO org_directory_name_history
      (org_unit_id,display_name,effective_from,change_reason)
      SELECT id,'Синтетическая скрытая единица '||code,'2020-01-01','Synthetic metadata, no grants'
      FROM org_directory_units WHERE pilot_org_unit_id IS NULL`);
    await client.query(`INSERT INTO org_directory_affiliation_history
      (org_unit_id,parent_id,business_model,effective_from,effective_to,change_reason)
      SELECT id,'10000000-0000-4000-8000-000000000001','FRANCHISE','2020-01-01','2026-01-01','Synthetic past affiliation' FROM org_units`);
    await client.query(`INSERT INTO org_directory_affiliation_history
      (org_unit_id,parent_id,business_model,effective_from,change_reason)
      SELECT id,'10000000-0000-4000-8000-000000000002','OWN_OPERATION','2026-01-01','Synthetic current affiliation' FROM org_units`);
    await client.query(`INSERT INTO org_directory_affiliation_history
      (org_unit_id,parent_id,business_model,effective_from,change_reason) VALUES
      ('10000000-0000-4000-8000-000000000001',NULL,'UC','2020-01-01','Synthetic root'),
      ('10000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','UC','2020-01-01','Synthetic division'),
      ('10000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002','UC','2020-01-01','Synthetic cluster'),
      ('10000000-0000-4000-8000-000000000004',NULL,'UC','2020-01-01','Synthetic isolation fixture')`);

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
