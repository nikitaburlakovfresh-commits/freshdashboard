import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { Client } from 'pg';

export function migrationDirectory(): string {
  const candidates = [path.resolve(__dirname, '../../migrations'), path.resolve(__dirname, '../../../migrations')];
  const found = candidates.find(p => fs.existsSync(path.join(p, '001_org_directory.sql')));
  if (!found) throw new Error('Versioned SQL migrations are missing from the release');
  return found;
}

/** Additive migrations only. Baseline is never reapplied to an existing schema.
 * Caller holds the session-level migration lock, also used for baseline creation.
 */
export async function applyVersionedMigrations(client: Client, directory = migrationDirectory()): Promise<string[]> {
  const applied: string[] = [];
  const files = fs.readdirSync(directory).filter(f => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  if (new Set(files.map(f => f.slice(0, 3))).size !== files.length) throw new Error('Duplicate migration version');
  await client.query(`CREATE TABLE IF NOT EXISTS pilot_r1.schema_migrations (
    version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  for (const file of files) {
    const sql = fs.readFileSync(path.join(directory, file), 'utf8');
    const checksum = createHash('sha256').update(sql).digest('hex');
    const previous = await client.query('SELECT checksum FROM pilot_r1.schema_migrations WHERE version=$1', [file]);
    if (previous.rowCount) {
      if (previous.rows[0].checksum !== checksum) throw new Error(`Migration checksum mismatch: ${file}`);
      continue;
    }
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO pilot_r1.schema_migrations(version,checksum) VALUES ($1,$2)', [file, checksum]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }
  return applied;
}
