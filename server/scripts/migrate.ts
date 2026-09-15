/* Baseline creation on an empty DB, followed by additive checksum-locked
 * migrations. Existing pilot_r1 is never dropped or baseline-rewritten. */
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import 'dotenv/config';
import { applyVersionedMigrations } from '../src/db/migrations';

async function main() {
  const client = new Client({
    host: process.env.PGHOST ?? 'localhost',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'fresh_pilot',
    user: process.env.PGUSER ?? 'fresh_app',
    password: process.env.PGPASSWORD ?? '',
  });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('fresh:versioned-migrations'))");
    const existing = await client.query(
      "select 1 from information_schema.schemata where schema_name = 'pilot_r1'",
    );
    if (existing.rowCount && existing.rowCount > 0) {
      console.log('Existing pilot_r1 preserved; checking additive migrations.');
    } else {
      const sqlPath = process.env.SCHEMA_FILE ?? [
        path.resolve(__dirname, '../../contracts/schema.sql'),
        path.resolve(__dirname, '../../../contracts/schema.sql'),
      ].find(p => fs.existsSync(p));
      if (!sqlPath) throw new Error('Baseline schema file missing');
      await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
      await client.query(fs.readFileSync(sqlPath, 'utf8'));
      console.log('Baseline pilot_r1 created.');
    }
    const applied = await applyVersionedMigrations(client);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'All versioned migrations already applied.');
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('fresh:versioned-migrations'))").catch(() => {});
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
