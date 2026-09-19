// Автономный прогон сервисного контура: загрузка → проверка структуры →
// сверка привязок → проверка оригиналов → предложение публикации → публикация.
// Контур ничего не выдумывает: период, перечень показателей, методику и
// основание задаёт план прогона; строки, которые не сопоставились с филиалом
// однозначно по названию, остаются непривязанными и прогон блокируется.
import { randomUUID } from 'crypto';
import { readFile } from 'fs/promises';
import path from 'path';
import { withTransaction } from '../db/pool';
import { serviceAuthedUser } from './serviceActor';
import { uploadBatch, probeBatch } from '../reporting/service';
import { getReview, saveReview } from '../reporting/review';
import { scanBatch, previewPublication, commitPublication } from '../reporting/factPublication';
import type { UploadFile } from '../reporting/storage';

export interface RunPeriod {
  start: string; end: string; planStart: string; planEnd: string;
  confirmation: string; basis: string;
}
export interface RunChoice { metric: string; source: string; methodology: string }
export interface RunBatch { files: string[]; choices: RunChoice[]; reason: string }
export interface RunPlan {
  actor_code: string;
  network_code: string;
  period: RunPeriod;
  mapping_reason: string;
  batches: RunBatch[];
}

type Stage = 'UPLOAD' | 'PROBE' | 'REVIEW' | 'SCAN' | 'PREVIEW' | 'COMMIT';
type Outcome = 'OK' | 'BLOCKED' | 'FAILED';

/** Нормализация названия строки отчёта и филиала для однозначного сравнения.
 * Сопоставление только точное после нормализации: похожие названия не
 * склеиваются, неоднозначность считается блокировкой, а не догадкой. */
export function normalizeBranchName(value: string): string {
  return value.toLowerCase().replace(/ё/g, 'е')
    .replace(/fresh|фреш|авто\s*центр|автоцентр|филиал/g, ' ')
    .replace(/[^a-zа-я0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

async function journal(actorUserId: string, batchId: string | null, stage: Stage,
  outcome: Outcome, detail: unknown, startedAt: Date) {
  await withTransaction(c => c.query(
    `INSERT INTO service_intake_runs(id,actor_user_id,batch_id,stage,outcome,detail,started_at)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [randomUUID(), actorUserId, batchId, stage, outcome, JSON.stringify(detail), startedAt]));
}

async function resolveActor(code: string) {
  return withTransaction(async c => {
    const row = (await c.query(
      `SELECT a.user_id, a.code FROM service_intake_actors a JOIN app_users u ON u.id=a.user_id
        WHERE a.code=$1 AND a.revoked_at IS NULL AND u.is_active AND u.user_kind='SERVICE'`, [code])).rows[0];
    if (!row) throw new Error(`Active service actor '${code}' not found`);
    return { userId: row.user_id as string, code: row.code as string };
  });
}

async function resolveNetwork(code: string) {
  return withTransaction(async c => {
    const row = (await c.query(
      `SELECT d.id FROM org_directory_units d
         JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id
        WHERE d.code=$1 AND d.kind='NETWORK' AND NOT d.is_demo AND NOT d.demo_locked
          AND d.effective_to IS NULL AND a.parent_id IS NULL AND a.effective_to IS NULL`, [code])).rows[0];
    if (!row) throw new Error(`Root network '${code}' not found`);
    return row.id as string;
  });
}

/** Один пакет: до двух XLSX, один набор показателей, одно основание. */
async function runBatch(actor: { userId: string; code: string }, networkId: string,
  plan: RunPlan, batch: RunBatch, sourceDir: string) {
  const auth = serviceAuthedUser(actor.userId, actor.code);
  const started = new Date();
  const uploads: UploadFile[] = [];
  for (const name of batch.files)
    uploads.push({ name: path.basename(name), bytes: await readFile(path.resolve(sourceDir, name)) });

  const requestId = randomUUID();
  const uploaded: any = await uploadBatch(auth, {
    network_id: networkId,
    period: {
      state: 'CONFIRMED', start: plan.period.start, end: plan.period.end,
      planStart: plan.period.planStart, planEnd: plan.period.planEnd,
      confirmation: plan.period.confirmation,
    },
  }, uploads, requestId);
  const batchId = uploaded.id as string;
  await journal(actor.userId, batchId, 'UPLOAD', 'OK',
    { files: uploads.map(f => f.name), reused: uploaded.reused === true }, started);

  const probed: any = await probeBatch(auth, batchId, { expected_version: Number(uploaded.version) }, randomUUID());
  if (probed.status !== 'NEEDS_MAPPING' || !probed.preview?.valid_structure) {
    await journal(actor.userId, batchId, 'PROBE', 'BLOCKED',
      { status: probed.status, error: probed.preview?.error ?? null }, started);
    return { batch_id: batchId, outcome: 'BLOCKED' as const, stage: 'PROBE' as const,
      detail: probed.preview?.error ?? `status=${probed.status}` };
  }
  await journal(actor.userId, batchId, 'PROBE', 'OK', { preview_hash: probed.preview_hash }, started);

  // Сверка: точное сопоставление названий строк с действующими филиалами сети.
  let review: any = await getReview(auth, batchId);
  const byName = new Map<string, string[]>();
  for (const candidate of review.candidates) {
    const key = normalizeBranchName(candidate.display_name);
    byName.set(key, [...(byName.get(key) ?? []), candidate.id]);
  }
  const edits: { item_id: string; org_unit_id: string }[] = [];
  const unresolved: { row: number; kind: string; name: string; why: string }[] = [];
  for (const row of review.rows) {
    if (row.org_unit_id && row.status === 'PROPOSED') continue;
    const hit = byName.get(normalizeBranchName(row.source_name)) ?? [];
    if (hit.length === 1) edits.push({ item_id: row.item_id, org_unit_id: hit[0] });
    else unresolved.push({ row: row.source_row, kind: row.report_kind, name: row.source_name,
      why: hit.length ? 'AMBIGUOUS_NAME' : 'NO_ACTIVE_BRANCH_WITH_THIS_NAME' });
  }
  for (let i = 0; i < edits.length; i += 100) {
    const chunk = edits.slice(i, i + 100);
    await saveReview(auth, batchId, {
      expected_version: review.current.version, preview_hash: review.preview_hash,
      period: { start: plan.period.start, end: plan.period.end, planStart: plan.period.planStart,
        planEnd: plan.period.planEnd, basis: plan.period.basis },
      edits: chunk, reason: plan.mapping_reason,
    }, `svc-review-${batchId.slice(0, 8)}-${i}-${Date.now()}`.slice(0, 120), randomUUID());
    review = await getReview(auth, batchId);
  }
  if (unresolved.length) {
    await journal(actor.userId, batchId, 'REVIEW', 'BLOCKED',
      { mapped: edits.length, unresolved }, started);
    return { batch_id: batchId, outcome: 'BLOCKED' as const, stage: 'REVIEW' as const, unresolved };
  }
  await journal(actor.userId, batchId, 'REVIEW', 'OK',
    { mapped: edits.length, version: review.current.version }, started);

  const scan = await scanBatch(auth, batchId, {}, randomUUID());
  await journal(actor.userId, batchId, 'SCAN', 'OK', scan, started);

  const command = {
    review_version: review.current.version,
    choices: batch.choices, reason: batch.reason, confirm_source_aggregates: true as const,
  };
  const preview: any = await previewPublication(auth, batchId, command);
  if (!preview.can_commit) {
    await journal(actor.userId, batchId, 'PREVIEW', 'BLOCKED', { blockers: preview.blockers }, started);
    return { batch_id: batchId, outcome: 'BLOCKED' as const, stage: 'PREVIEW' as const, blockers: preview.blockers };
  }
  await journal(actor.userId, batchId, 'PREVIEW', 'OK',
    { preview_id: preview.preview_id, rows: preview.rows.length }, started);

  const committed: any = await commitPublication(auth, batchId, {
    preview_id: preview.preview_id, proposal_hash: preview.proposal_hash, confirm: true,
  }, `svc-publish-${batchId.slice(0, 8)}-${Date.now()}`.slice(0, 120), randomUUID());
  await journal(actor.userId, batchId, 'COMMIT', 'OK', committed, started);
  return { batch_id: batchId, outcome: 'OK' as const, stage: 'COMMIT' as const, ...committed };
}

export async function runServiceIntake(plan: RunPlan, sourceDir: string) {
  const actor = await resolveActor(plan.actor_code);
  const networkId = await resolveNetwork(plan.network_code);
  const results: unknown[] = [];
  for (const batch of plan.batches) {
    const started = new Date();
    try {
      results.push(await runBatch(actor, networkId, plan, batch, sourceDir));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown';
      await journal(actor.userId, null, 'UPLOAD', 'FAILED', { files: batch.files, message }, started);
      results.push({ outcome: 'FAILED', files: batch.files, message });
    }
  }
  return { actor: plan.actor_code, network: plan.network_code, results };
}
