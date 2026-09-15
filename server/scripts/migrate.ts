/*
 * One-time schema creation for the R1 pilot database. Mirrors
 * contracts/schema.sql verbatim (the canonical contract DDL), executed
 * against the configured PostgreSQL 16 instance. Not an idempotent
 * migration runner — matches the contract's own stated intent
 * ("intentionally not an idempotent migration runner").
 *
 * Usage: npm run db:migrate --workspace=server
 */
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import 'dotenv/config';

async function main() {
  const sqlPath = process.env.SCHEMA_FILE ?? path.resolve(__dirname, '../../contracts/schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  const client = new Client({
    host: process.env.PGHOST ?? 'localhost',
    port: parseInt(process.env.PGPORT ?? '5432', 10),
    database: process.env.PGDATABASE ?? 'fresh_pilot',
    user: process.env.PGUSER ?? 'fresh_app',
    password: process.env.PGPASSWORD ?? '',
  });
  await client.connect();
  try {
    const existing = await client.query(
      "select 1 from information_schema.schemata where schema_name = 'pilot_r1'",
    );
    if (existing.rowCount && existing.rowCount > 0) {
      console.log('Schema pilot_r1 already exists; skipping (not a destructive re-run).');
      return;
    }
    await client.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await client.query(sql);
    console.log('Migration applied: pilot_r1 schema created from contracts/schema.sql');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
