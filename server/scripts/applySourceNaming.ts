// Наполнение справочника названий филиалов в отчётах сервисным субъектом.
// Скрипт не придумывает соответствий: филиал задаётся кодом, название —
// строкой из файла. Любое расхождение прерывает выполнение без частичной
// записи по конкретной записи (каждая запись — своя транзакция домена).
import { readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { withTransaction, closePool } from '../src/db/pool';
import { serviceAuthedUser } from '../src/domain/serviceActor';
import { setSourceAlias, excludeSourceName } from '../src/domain/sourceNaming';

interface Plan {
  actor_code: string;
  aliases?: { branch_code: string; source_name: string; effective_from: string; reason: string }[];
  exclusions?: { source_name: string; effective_from: string; reason: string }[];
}

const [planPath, ...extra] = process.argv.slice(2);

async function actorUserId(code: string) {
  return withTransaction(async c => {
    const row = (await c.query(
      `SELECT a.user_id FROM service_intake_actors a JOIN app_users u ON u.id=a.user_id
        WHERE a.code=$1 AND a.revoked_at IS NULL AND u.is_active AND u.user_kind='SERVICE'`, [code])).rows[0];
    if (!row) throw new Error(`Active service actor '${code}' not found`);
    return row.user_id as string;
  });
}

async function resolve(codes: string[]) {
  return withTransaction(async c => {
    const rows = (await c.query(
      `SELECT id, code FROM org_directory_units
        WHERE kind='ORG_UNIT' AND effective_to IS NULL AND code = ANY($1)`, [codes])).rows;
    const map = new Map<string, string>(rows.map((r: any) => [r.code as string, r.id as string]));
    const missing = codes.filter(c2 => !map.has(c2));
    if (missing.length) throw new Error(`Branch codes not found: ${missing.join(', ')}`);
    return map;
  });
}

async function networkId() {
  return withTransaction(async c => {
    const rows = (await c.query(
      "SELECT id FROM org_directory_units WHERE kind='NETWORK' AND effective_to IS NULL")).rows;
    if (rows.length !== 1) throw new Error(`Expected exactly one active network, found ${rows.length}`);
    return rows[0].id as string;
  });
}

async function run() {
  if (extra.length || !planPath) throw new Error('Usage: applySourceNaming <plan.json>');
  const plan = JSON.parse(readFileSync(path.resolve(planPath), 'utf8')) as Plan;
  const auth = serviceAuthedUser(await actorUserId(plan.actor_code), plan.actor_code);
  const aliases = plan.aliases ?? [];
  const exclusions = plan.exclusions ?? [];
  const branches = aliases.length ? await resolve([...new Set(aliases.map(a => a.branch_code))]) : new Map();
  const appliedAliases: unknown[] = [];
  for (const a of aliases) {
    appliedAliases.push(await setSourceAlias(auth, {
      org_unit_id: branches.get(a.branch_code), source_name: a.source_name,
      effective_from: a.effective_from, reason: a.reason,
    }, randomUUID()));
  }
  const appliedExclusions: unknown[] = [];
  if (exclusions.length) {
    const network = await networkId();
    for (const e of exclusions) {
      appliedExclusions.push(await excludeSourceName(auth, {
        network_id: network, source_name: e.source_name,
        effective_from: e.effective_from, reason: e.reason,
      }, randomUUID()));
    }
  }
  console.log(JSON.stringify({ aliases: appliedAliases, exclusions: appliedExclusions }));
}

run().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; })
  .finally(closePool);
