/*
 * Opt-in seed script for the R1 pilot. NOT run automatically by build/start.
 * Creates the four synthetic personal users (rm_a, rf_a, rm_b, rf_b) plus one
 * dual-role fixture user (rm_rf_a_dual) needed for the self-review negative
 * test (ENGINEERING_PILOT.md §7: "дополнительная dual-role fixture нужна
 * для self-review теста"). Never destructive: skips creation if a login
 * already exists. Password comes from SEED_FIXTURE_PASSWORD env var only —
 * this script refuses to run if that variable is unset, and refuses to run
 * outside development/test NODE_ENV to avoid ever seeding a shared/prod DB.
 *
 * Usage: SEED_FIXTURE_PASSWORD=... npm run db:seed --workspace=server
 */
import 'dotenv/config';
import { Client } from 'pg';
import argon2 from 'argon2';

const FIXTURE_LOGINS = [
  { login: 'rm_a', full_name: 'Тестовый постановщик A', role: 'REGIONAL_MANAGER', org: 'A' },
  { login: 'rf_a', full_name: 'Тестовый исполнитель A', role: 'RF', org: 'A' },
  { login: 'rm_b', full_name: 'Тестовый постановщик B', role: 'REGIONAL_MANAGER', org: 'B' },
  { login: 'rf_b', full_name: 'Тестовый исполнитель B', role: 'RF', org: 'B' },
  // Dual-role fixture: same person holds both roles in branch A, needed to
  // exercise SELF_REVIEW_FORBIDDEN even across roles (contract §4, §7).
  { login: 'rm_rf_a_dual', full_name: 'Двойная роль A (тест)', role: 'REGIONAL_MANAGER', org: 'A' },
  { login: 'rm_rf_a_dual', full_name: 'Двойная роль A (тест)', role: 'RF', org: 'A' },
];

async function main() {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const hostedPilot = process.env.ALLOW_SYNTHETIC_PILOT_SEED === 'true';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && !hostedPilot) {
    console.error(`Refusing to seed: NODE_ENV=${nodeEnv} is not development or test.`);
    process.exit(1);
  }
  const password = process.env.SEED_FIXTURE_PASSWORD;
  if (!password && !hostedPilot) {
    console.error('Refusing to seed: SEED_FIXTURE_PASSWORD is not set. This is a synthetic-only fixture; no baked-in password exists.');
    process.exit(1);
  }

  const client = new Client({
    host: process.env.PGHOST ?? 'localhost',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'fresh_pilot',
    user: process.env.PGUSER ?? 'fresh_app',
    password: process.env.PGPASSWORD ?? '',
  });
  await client.connect();
  try {
    await client.query('SET search_path = pilot_r1, pg_catalog');
    const orgRows = await client.query('SELECT id, code FROM org_units');
    const orgByCode: Record<string, string> = {};
    for (const row of orgRows.rows) orgByCode[row.code] = row.id;

    const seenLogins = new Set<string>();
    for (const fixture of FIXTURE_LOGINS) {
      if (hostedPilot && fixture.login === 'rm_rf_a_dual') continue;
      const userPassword = hostedPilot
        ? process.env[`PILOT_PASSWORD_${fixture.login.toUpperCase()}`]
        : password;
      if (!userPassword || (hostedPilot && userPassword.length < 20)) {
        throw new Error(`Missing strong individual password for ${fixture.login}`);
      }
      const passwordHash = await argon2.hash(userPassword);
      let userId: string;
      const existing = await client.query('SELECT id FROM app_users WHERE login = $1', [fixture.login]);
      if (existing.rowCount && existing.rowCount > 0) {
        userId = existing.rows[0].id;
        console.log(`User ${fixture.login} already exists; not modifying credentials.`);
      } else {
        const inserted = await client.query(
          `INSERT INTO app_users (login, full_name, password_hash, password_hash_updated_at)
           VALUES ($1, $2, $3, now()) RETURNING id`,
          [fixture.login, fixture.full_name, passwordHash],
        );
        userId = inserted.rows[0].id;
        console.log(`Created user ${fixture.login} (${fixture.role} / org ${fixture.org}).`);
      }
      seenLogins.add(fixture.login);

      const orgId = orgByCode[fixture.org];
      const grantExisting = await client.query(
        `SELECT id FROM role_grants
         WHERE user_id = $1 AND role_code = $2 AND org_unit_id = $3 AND revoked_at IS NULL`,
        [userId, fixture.role, orgId],
      );
      if (grantExisting.rowCount && grantExisting.rowCount > 0) {
        console.log(`Grant for ${fixture.login}/${fixture.role}/${fixture.org} already active.`);
        continue;
      }
      await client.query(
        `INSERT INTO role_grants (user_id, role_code, org_unit_id, valid_from)
         VALUES ($1, $2, $3, now())`,
        [userId, fixture.role, orgId],
      );
      console.log(`Granted ${fixture.role} in org ${fixture.org} to ${fixture.login}.`);
    }

    console.log('Seed complete. Synthetic PILOT users:', Array.from(seenLogins).join(', '));
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
