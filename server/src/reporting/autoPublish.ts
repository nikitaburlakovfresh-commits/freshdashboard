// Приём пакета QLIK «одной кнопкой»: загрузка → структурная проверка →
// автоматическая привязка филиалов по справочнику портала → антивирусная
// проверка → публикация показателей. Портал ничего не выдумывает: период
// объявляет загружающий, строки без однозначного филиала не публикуются и
// перечисляются отдельно, нераспознанные файлы не публикуются.
import { randomUUID } from 'crypto';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { normalizeBranchName } from '../domain/branchNameMatch';
import { resolveSourceAliases, resolveSourceExclusions } from '../domain/sourceNaming';
import { uploadBatch, probeBatch } from './service';
import { getReview, saveReview } from './review';
import { scanBatch, previewPublication, commitPublication, publicationState } from './factPublication';
import { REPORT_SPECS, type ReportKind } from './shared/reportModel';
import { METRIC_NAMES } from './shared/metricCatalog';
import type { UploadFile } from './storage';

/** При пересечении показателей в нескольких отчётах источник фиксирован. */
const SOURCE_PRIORITY: ReportKind[] = ['sales', 'summary', 'supplies', 'suppliesForecast',
  'credits', 'tradeUp', 'discounts', 'revenuePlan', 'funnel'] as ReportKind[];

export interface AutoPublishResult {
  batch_id: string | null;
  stage: 'UPLOAD' | 'PROBE' | 'REVIEW' | 'PUBLISH' | 'DONE';
  published: number;
  publication_id: string | null;
  period: { start: string; end: string };
  mapped_rows: number;
  recognized: { kind: string; rows: number }[];
  skipped_files: { name: string; reason: string }[];
  excluded_rows: { row: number; kind: string; name: string; reason: string }[];
  unresolved_rows: { row: number; kind: string; name: string; why: string }[];
  published_metrics: string[];
  withheld_metrics: string[];
  message: string;
}

const empty = (period: { start: string; end: string }): AutoPublishResult => ({
  batch_id: null, stage: 'UPLOAD', published: 0, publication_id: null, period,
  mapped_rows: 0, recognized: [], skipped_files: [], excluded_rows: [],
  unresolved_rows: [], published_metrics: [], withheld_metrics: [], message: '',
});

export async function autoPublishPackage(auth: AuthedUser, metadata: any,
  files: UploadFile[], requestId: string): Promise<AutoPublishResult> {
  const period = { start: metadata?.period?.start, end: metadata?.period?.end };
  const out = empty(period);

  const uploaded: any = await uploadBatch(auth, metadata, files, requestId);
  out.batch_id = uploaded.id;
  const probed: any = await probeBatch(auth, uploaded.id, { expected_version: Number(uploaded.version) }, randomUUID());
  out.skipped_files = probed.preview?.skipped ?? [];
  if (probed.status !== 'NEEDS_MAPPING' || !probed.preview?.valid_structure) {
    out.stage = 'PROBE';
    out.message = probed.preview?.error ?? 'Структурная проверка пакета не пройдена.';
    return out;
  }
  out.recognized = (probed.preview.reports ?? []).map((r: any) => ({ kind: r.kind, rows: r.branches.length }));

  // Привязка строк к действующим филиалам: точное совпадение названия либо
  // объявленный в портале алиас. Неоднозначные строки не публикуются.
  let review: any = await getReview(auth, uploaded.id);
  const byName = new Map<string, string[]>();
  for (const candidate of review.candidates) {
    const key = normalizeBranchName(candidate.display_name);
    byName.set(key, [...(byName.get(key) ?? []), candidate.id]);
  }
  const eligible = new Set<string>(review.candidates.map((c: any) => c.id as string));
  const networkId: string = probed.preview.network_id ?? probed.network_id;
  const { aliases, exclusions } = await withTransaction(async c => ({
    aliases: await resolveSourceAliases(c, period.end),
    exclusions: await resolveSourceExclusions(c, networkId, period.end),
  }));
  const edits: { item_id: string; org_unit_id: string }[] = [];
  for (const row of review.rows) {
    if (row.org_unit_id && row.status === 'PROPOSED') continue;
    const norm = normalizeBranchName(row.source_name);
    const exclusion = exclusions.get(norm);
    if (exclusion !== undefined) {
      out.excluded_rows.push({ row: row.source_row, kind: row.report_kind, name: row.source_name, reason: exclusion });
      continue;
    }
    const alias = aliases.get(norm);
    if (alias !== undefined) {
      if (eligible.has(alias)) { edits.push({ item_id: row.item_id, org_unit_id: alias }); continue; }
      out.unresolved_rows.push({ row: row.source_row, kind: row.report_kind, name: row.source_name,
        why: 'алиас указывает на недействующий филиал' });
      continue;
    }
    const hit = byName.get(norm) ?? [];
    if (hit.length === 1) edits.push({ item_id: row.item_id, org_unit_id: hit[0] });
    else out.unresolved_rows.push({ row: row.source_row, kind: row.report_kind, name: row.source_name,
      why: hit.length ? 'несколько филиалов с таким названием' : 'нет действующего филиала с таким названием' });
  }
  const basis = `Пакет QLIK за ${period.start} — ${period.end}, загружен администратором через портал.`;
  for (let i = 0; i < edits.length; i += 100) {
    await saveReview(auth, uploaded.id, {
      expected_version: review.current.version, preview_hash: review.preview_hash,
      period: { start: period.start, end: period.end,
        planStart: metadata.period.planStart, planEnd: metadata.period.planEnd, basis },
      edits: edits.slice(i, i + 100),
      reason: 'Автоматическая привязка строк к филиалам по справочнику портала.',
    }, `auto-map-${uploaded.id.slice(0, 8)}-${i}-${Date.now()}`.slice(0, 120), randomUUID());
    review = await getReview(auth, uploaded.id);
  }
  out.mapped_rows = edits.length;
  if (!review.current.version) {
    out.stage = 'REVIEW';
    out.message = 'Ни одна строка пакета не привязалась к действующему филиалу: публикация не выполнена.';
    return out;
  }

  await scanBatch(auth, uploaded.id, {}, randomUUID());

  // Состав публикации: показатели распознанных отчётов, на которые есть
  // действующее разрешение публикации. Остальные честно объявляются отложенными.
  const state: any = await publicationState(auth, uploaded.id);
  const allowed = new Set<string>(state.allowed_metrics ?? []);
  const kinds = new Set<string>(out.recognized.map(r => r.kind));
  const chosen = new Map<string, ReportKind>();
  for (const kind of SOURCE_PRIORITY) {
    if (!kinds.has(kind) || REPORT_SPECS[kind]?.channelRequired) continue;
    for (const metric of Object.keys(REPORT_SPECS[kind].columns)) {
      if (!chosen.has(metric)) chosen.set(metric, kind);
    }
  }
  const choices = [...chosen.entries()].filter(([metric]) => allowed.has(metric))
    .map(([metric, source]) => ({ metric, source,
      methodology: `Агрегат отчёта «${source}» QLIK за объявленный период без пересчёта на стороне портала.` }));
  out.withheld_metrics = [...chosen.keys()].filter(m => !allowed.has(m))
    .map(m => METRIC_NAMES[m as keyof typeof METRIC_NAMES] ?? m);
  if (!choices.length) {
    out.stage = 'PUBLISH';
    out.message = 'Нет действующего разрешения на публикацию ни одного показателя распознанных отчётов.';
    return out;
  }

  // Показатель, по которому сверка с итогом источника невозможна, не
  // публикуется, но и не блокирует остальной пакет: он объявляется отложенным
  // с причиной из проверки. Подмена значений и отключение сверки недопустимы.
  const codeByName = new Map<string, string>(Object.entries(METRIC_NAMES).map(([code, name]) => [name, code]));
  let active = choices;
  let preview: any = null;
  for (let attempt = 0; attempt < 4 && active.length; attempt++) {
    preview = await previewPublication(auth, uploaded.id, {
      review_version: review.current.version, choices: active,
      reason: `Публикация пакета QLIK за ${period.start} — ${period.end} одной операцией из портала.`,
      confirm_source_aggregates: true,
    });
    if (preview.can_commit) break;
    const blockers: string[] = preview.blockers ?? [];
    const blocked = new Set<string>();
    for (const blocker of blockers) {
      const name = blocker.slice(0, blocker.indexOf(':'));
      const code = codeByName.get(name.trim());
      if (code) blocked.add(code);
    }
    if (!blocked.size) {
      out.stage = 'PUBLISH';
      out.message = blockers.join('; ') || 'Публикация заблокирована проверками портала.';
      return out;
    }
    for (const code of blocked)
      out.withheld_metrics.push(`${METRIC_NAMES[code as keyof typeof METRIC_NAMES] ?? code} — сверка с итогом источника не подтверждена`);
    active = active.filter(choice => !blocked.has(choice.metric));
    preview = null;
  }
  if (!preview?.can_commit) {
    out.stage = 'PUBLISH';
    out.message = 'Ни один показатель пакета не прошёл сверку с итогами источников: публикация не выполнена.';
    return out;
  }
  const committed: any = await commitPublication(auth, uploaded.id, {
    preview_id: preview.preview_id, proposal_hash: preview.proposal_hash, confirm: true,
  }, `auto-publish-${uploaded.id.slice(0, 8)}-${Date.now()}`.slice(0, 120), randomUUID());
  out.stage = 'DONE';
  out.publication_id = committed.publication_id ?? null;
  out.published = Number(committed.count ?? preview.rows.length);
  out.published_metrics = active.map(c => METRIC_NAMES[c.metric as keyof typeof METRIC_NAMES] ?? c.metric);
  out.message = `Опубликовано ${out.published} значений; метрики обзора пересчитаны по опубликованным показателям.`;
  return out;
}
