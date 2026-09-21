// Приём реестра автомобилей (VIN) из файлов «Анализ склада» без участия
// человека: этим же путём портал сможет принимать реестр ежедневно.
//
// Скрипт не обходит правила портала. Он выполняет ту же цепочку, что и форма:
// загрузка оригинала → структурная проверка → предложение → публикация.
// Действует сервисный субъект приёма QLIK: у него нет и не может быть сессии,
// зато есть явная возможность PUBLISH и разрешение на детальный контур.
// Дата среза объявляется явно, потому что источник её не содержит.
//
// Запуск внутри контейнера приложения:
//   node server/dist/scripts/loadDetailStock.js <каталог|файл> [--kind vinInventory]
// Имя файла задаёт дату среза: 2026-09-20.xlsx
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import type { AuthedUser } from '../auth/session';
import { uploadBatch, probeBatch } from '../reporting/service';
import { previewDetail, commitDetail } from '../reporting/detailPublication';
import { scanBatch } from '../reporting/factPublication';
import type { DetailKind } from '../reporting/shared/detailModel';

const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

async function serviceActor(): Promise<AuthedUser> {
  return withTransaction(async c => {
    const row = (await c.query(
      `SELECT u.id, u.login, u.full_name FROM app_users u
       JOIN service_intake_actors a ON a.user_id = u.id AND a.revoked_at IS NULL
       WHERE a.code = 'qlik_daily_v2' AND u.is_active AND u.user_kind = 'SERVICE'`)).rows[0];
    if (!row) throw new Error('Сервисный субъект приёма qlik_daily_v2 не найден или отозван.');
    // Сессии у сервисного субъекта нет: проверки для него идут по возможности
    // INTAKE/PUBLISH, а не по сессии. Подставлять чужую сессию нельзя.
    return { sessionId: randomUUID(), userId: row.id, login: row.login,
      fullName: row.full_name, csrfToken: '', rawToken: '' } as AuthedUser;
  });
}

async function rootNetwork(): Promise<string> {
  return withTransaction(async c => {
    const row = (await c.query(
      `SELECT d.id FROM org_directory_units d
       JOIN org_directory_affiliation_history a ON a.org_unit_id = d.id
       WHERE d.kind = 'NETWORK' AND NOT d.is_demo AND NOT d.demo_locked
         AND d.effective_to IS NULL AND a.parent_id IS NULL AND a.effective_to IS NULL`)).rows[0];
    if (!row) throw new Error('Корневая сеть в справочнике не найдена.');
    return row.id as string;
  });
}

async function loadOne(auth: AuthedUser, networkId: string, path: string, kind: DetailKind) {
  const name = basename(path);
  const matched = DATE_RE.exec(name);
  if (!matched) throw new Error(`Имя файла ${name} не содержит дату среза в виде ГГГГ-ММ-ДД.`);
  const observedOn = matched[1];
  const bytes = readFileSync(path);
  const confirmation = `Срез склада на ${observedOn}, принят сервисным субъектом приёма QLIK.`;
  const metadata = { network_id: networkId, period: { state: 'CONFIRMED',
    start: observedOn, end: observedOn, planStart: observedOn, planEnd: observedOn,
    confirmation } };

  const uploaded: any = await uploadBatch(auth, metadata, [{ name, bytes }], randomUUID());
  const probed: any = await probeBatch(auth, uploaded.id,
    { expected_version: Number(uploaded.version) }, randomUUID());
  if (process.env.DETAIL_LOAD_DEBUG) console.log('ПРОВЕРКА:', JSON.stringify({
    status: probed.status, valid: probed.preview?.valid_structure, error: probed.preview?.error,
    skipped: probed.preview?.skipped, details: probed.preview?.details,
    reports: (probed.preview?.reports ?? []).map((r: any) => r.kind),
    files: (probed.files ?? []).map((f: any) => f.display_name) }, null, 1));
  const file = (probed.files ?? []).find((f: any) => f.display_name === name)
    ?? (probed.preview?.files ?? []).find((f: any) => f.display_name === name);
  if (!file) throw new Error(`Оригинал ${name} не найден в пакете после проверки: ${probed.preview?.error ?? probed.status}`);

  // Отметка проверки источника обязательна и не старше суток — тот же этап,
  // что и в форме портала.
  await scanBatch(auth, uploaded.id, {}, randomUUID());

  const preview: any = await previewDetail(auth, uploaded.id, { kind, file_id: file.id,
    observed_on: observedOn, confirm_detail_rows: true,
    declaration: `Реестр автомобилей на ${observedOn} из отчёта «Анализ склада» QLIK.` });
  if (!preview.can_commit) {
    return { observedOn, published: 0, blockers: preview.blockers ?? [],
      excluded: (preview.excluded ?? []).length };
  }
  const committed: any = await commitDetail(auth, uploaded.id,
    { preview_id: preview.preview_id, proposal_hash: preview.proposal_hash, confirm: true },
    `detail-${kind}-${observedOn}`, randomUUID());
  return { observedOn, published: committed.accepted_rows ?? preview.accepted_rows ?? 0,
    blockers: [], excluded: (preview.excluded ?? []).length };
}

async function main() {
  const target = process.argv[2];
  const kindArg = process.argv.includes('--kind')
    ? process.argv[process.argv.indexOf('--kind') + 1] : 'vinInventory';
  if (!target) throw new Error('Укажите каталог или файл.');
  const kind = kindArg as DetailKind;
  const files = statSync(target).isDirectory()
    ? readdirSync(target).filter(f => /\.xlsx$/i.test(f)).sort().map(f => join(target, f))
    : [target];
  const auth = await serviceActor();
  const networkId = await rootNetwork();
  console.log(`Файлов к приёму: ${files.length}, вид: ${kind}`);
  let total = 0;
  for (const path of files) {
    try {
      const r = await loadOne(auth, networkId, path, kind);
      total += r.published;
      console.log(`${r.observedOn}: строк принято ${r.published}` +
        (r.excluded ? `, не сопоставлено локаций ${r.excluded}` : '') +
        (r.blockers.length ? ` | ПРЕПЯТСТВИЯ: ${r.blockers.slice(0, 3).join('; ')}` : ''));
    } catch (e: any) {
      console.log(`${basename(path)}: ОШИБКА ${e?.message ?? e}`);
    }
  }
  console.log(`Итого принято строк: ${total}`);
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
