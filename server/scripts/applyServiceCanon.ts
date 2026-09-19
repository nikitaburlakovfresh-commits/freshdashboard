// Настройка канона показателей сервисным субъектом: пороги светофора, модель
// балла и фокусы месяца. Значения берутся только из переданного файла канона —
// скрипт ничего не выдумывает и не подставляет значения по умолчанию.
import { readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { withTransaction, closePool } from '../src/db/pool';
import { serviceAuthedUser } from '../src/domain/serviceActor';
import { setThreshold } from '../src/metrics/thresholds';
import { setScoringModel } from '../src/metrics/scoring';
import { setFocusConfiguration } from '../src/metrics/focus';

interface Canon {
  actor_code: string;
  thresholds?: any[];
  scoring?: any;
  focus?: any;
}

const [canonPath, ...extra] = process.argv.slice(2);

async function actor(code: string) {
  return withTransaction(async c => {
    const row = (await c.query(
      `SELECT a.user_id FROM service_intake_actors a JOIN app_users u ON u.id=a.user_id
        WHERE a.code=$1 AND a.revoked_at IS NULL AND u.is_active AND u.user_kind='SERVICE'`, [code])).rows[0];
    if (!row) throw new Error(`Active service actor '${code}' not found`);
    return row.user_id as string;
  });
}

async function run() {
  if (extra.length || !canonPath) throw new Error('Usage: applyServiceCanon <canon.json>');
  const canon = JSON.parse(readFileSync(path.resolve(canonPath), 'utf8')) as Canon;
  const auth = serviceAuthedUser(await actor(canon.actor_code), canon.actor_code);
  const applied: Record<string, unknown> = {};
  if (canon.thresholds?.length) {
    const results = [];
    for (const threshold of canon.thresholds) results.push(await setThreshold(auth, threshold, randomUUID()));
    applied.thresholds = results.length;
  }
  if (canon.scoring) applied.scoring = await setScoringModel(auth, canon.scoring, randomUUID());
  if (canon.focus) applied.focus = await setFocusConfiguration(auth, canon.focus, randomUUID());
  return applied;
}

run().then(r => console.log(JSON.stringify(r, null, 2)))
  .catch(e => { console.error(String(e instanceof Error ? e.message : e)); process.exitCode = 1; })
  .finally(closePool);
