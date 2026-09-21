// Публикация пакета QLIK без браузера: тем же кодом, что кнопка портала.
// Период объявляется аргументами, состав показателей ограничен действующим
// разрешением на публикацию. Ничего не домысливается.
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { autoPublishPackage } from '../src/reporting/autoPublish';
import { serviceAuthedUser } from '../src/domain/serviceActor';
import { withTransaction, closePool } from '../src/db/pool';
const argv = process.argv.slice(2);
// Канал воронки объявляется явно: --funnel-channel APPEALS|CALLS
const channelAt = argv.indexOf('--funnel-channel');
const funnelChannel = channelAt >= 0 ? argv[channelAt + 1] : undefined;
if (channelAt >= 0) argv.splice(channelAt, 2);
const [actorCode, networkCode, start, end, dir, ...extra] = argv;
async function main() {
  if (extra.length || !actorCode || !networkCode || !start || !end || !dir)
    throw new Error('Usage: autoPublishPackage <actor-code> <network-code> <start> <end> <dir>');
  const actor = await withTransaction(async c => {
    const row = (await c.query(`SELECT a.user_id, a.code FROM service_intake_actors a
      JOIN app_users u ON u.id=a.user_id
      WHERE a.code=$1 AND a.revoked_at IS NULL AND u.is_active AND u.user_kind='SERVICE'`, [actorCode])).rows[0];
    if (!row) throw new Error(`Сервисный субъект '${actorCode}' не найден или отозван`);
    return { userId: row.user_id as string, code: row.code as string };
  });
  const networkId = await withTransaction(async c => {
    const row = (await c.query(`SELECT d.id FROM org_directory_units d
      WHERE d.code=$1 AND d.kind='NETWORK' AND d.effective_to IS NULL`, [networkCode])).rows[0];
    if (!row) throw new Error(`Сеть '${networkCode}' не найдена`);
    return row.id as string;
  });
  const files = readdirSync(path.resolve(dir)).filter(n => /\.xlsx$/i.test(n)).sort()
    .map(n => ({ name: n, bytes: readFileSync(path.resolve(dir, n)) }));
  const auth = serviceAuthedUser(actor.userId, actor.code);
  const result = await autoPublishPackage(auth, {
    network_id: networkId,
    period: { state: 'CONFIRMED', start, end, planStart: start, planEnd: end,
      confirmation: `Период объявлен администратором сети при публикации пакета ${start} — ${end}.` },
  }, files, randomUUID(),
  funnelChannel ? { funnel: funnelChannel as any } : {});
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(String(e?.message ?? e)); process.exitCode = 1; }).finally(closePool);
