import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { commandOrgChange, OperatorActor } from './orgChanges';

type ProposalView = Record<string, any>;
const command = (...args: Parameters<typeof commandOrgChange>) => commandOrgChange(...args) as Promise<ProposalView>;

/** Declarative transfer set. Parents are referenced by code, never by UUID, so
 * the same file can be replayed without carrying environment-specific ids. */
export interface ImportUnit {
  code: string;
  kind: 'DIVISION' | 'CLUSTER' | 'ORG_UNIT';
  display_name: string;
  parent_code: string;
  type_code?: string | null;
  business_model?: string | null;
}
export interface ImportRename { code: string; display_name: string }
export interface ImportActivation { code: string; reason: string }
export interface ImportPlan {
  network_code: string;
  reason: string;
  units: ImportUnit[];
  renames?: ImportRename[];
  activations?: ImportActivation[];
}
export interface ImportOutcome {
  code: string;
  kind: string;
  status: 'CREATED' | 'ALREADY_PRESENT' | 'REJECTED' | 'RENAMED' | 'ACTIVATED' | 'ALREADY_ACTIVE' | 'UNCHANGED';
  target_id?: string;
  effective_from?: string;
  issues?: unknown;
}

const key = (stage: string, code: string) => `orgimport:${stage}:${code}`.slice(0, 128);

async function resolveActor(approval: string): Promise<OperatorActor> {
  const row = await withTransaction(async client => {
    const r = await client.query(`SELECT b.user_id FROM administrator_bootstrap b
      JOIN organization_editor_provisioning e ON e.user_id=b.user_id AND e.grant_id=b.grant_id`);
    return r.rows[0] ?? null;
  });
  if (!row) throw new Error('Bounded organization editor stage is not provisioned for a bootstrapped administrator');
  return { userId: row.user_id, operatorApproval: approval };
}

async function runChange(actor: OperatorActor, change: Record<string, any>, stage: string, code: string, dryRun: boolean) {
  const draft = await command(actor, 'create', null, { change }, key(`${stage}d`, code), randomUUID());
  const previewed = await command(actor, 'preview', draft.id, { expected_version: draft.version }, key(`${stage}p`, code), randomUUID());
  if (previewed.status !== 'PREVIEW' || (previewed.preview_summary?.issues ?? []).length) {
    return { ok: false as const, issues: previewed.preview_summary?.issues };
  }
  if (dryRun) return { ok: true as const, applied: null };
  const applied = await command(actor, 'apply', draft.id,
    { expected_version: previewed.version, preview_token: previewed.preview_token }, key(`${stage}a`, code), randomUUID());
  return { ok: true as const, applied };
}

/** Transfers a confirmed directory set through the ordinary draft / preview /
 * apply stages. It never backdates, never activates a branch, never creates a
 * user, grant, task, metric or mailing, and never rewrites an existing unit:
 * a code that already exists is reported and left untouched. */
export async function importOrgDirectory(plan: ImportPlan, approval: string, dryRun: boolean) {
  const listed = (x: unknown) => Array.isArray(x) ? x.length : 0;
  if (!plan || typeof plan.network_code !== 'string' ||
      (plan.units !== undefined && !Array.isArray(plan.units)) ||
      listed(plan.units) + listed(plan.renames) + listed(plan.activations) === 0) {
    throw new Error('Transfer set must name the network code and at least one create, rename or activation');
  }
  if (typeof plan.reason !== 'string' || plan.reason.trim().length < 16) throw new Error('Explicit transfer reason required');
  if (!approval || approval.trim().length < 16) throw new Error('Explicit approval reference required');
  const order: Record<string, number> = { DIVISION: 1, CLUSTER: 2, ORG_UNIT: 3 };
  const units = [...(plan.units ?? [])].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
  if (units.some(u => !order[u.kind])) throw new Error('Only DIVISION, CLUSTER and ORG_UNIT may be transferred');

  const actor = await resolveActor(approval);
  const today = await withTransaction(async client =>
    (await client.query("SELECT to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD') d")).rows[0].d as string);
  const known = await withTransaction(async client => {
    const r = await client.query('SELECT lower(code) code, id FROM org_directory_units');
    return new Map<string, string>(r.rows.map(x => [x.code, x.id]));
  });
  if (!known.has(plan.network_code.toLowerCase())) throw new Error('Network root code is absent from the directory');

  const outcomes: ImportOutcome[] = [];
  for (const unit of units) {
    const existing = known.get(unit.code.toLowerCase());
    if (existing) { outcomes.push({ code: unit.code, kind: unit.kind, status: 'ALREADY_PRESENT', target_id: existing }); continue; }
    const parentId = known.get(unit.parent_code.toLowerCase());
    if (!parentId) {
      outcomes.push({ code: unit.code, kind: unit.kind, status: 'REJECTED', issues: [{ path: 'parent_code', issue: 'Родитель отсутствует в справочнике.' }] });
      continue;
    }
    const change = {
      operation: 'ORG_UNIT_CREATE', code: unit.code, kind: unit.kind, display_name: unit.display_name,
      parent_id: parentId, effective_from: today, reason: plan.reason.trim(),
      ...(unit.type_code ? { type_code: unit.type_code } : {}),
      ...(unit.business_model ? { business_model: unit.business_model } : {}),
    };
    const draft = await command(actor, 'create', null, { change }, key('draft', unit.code), randomUUID());
    const previewed = await command(actor, 'preview', draft.id, { expected_version: draft.version }, key('prev', unit.code), randomUUID());
    if (previewed.status !== 'PREVIEW') {
      outcomes.push({ code: unit.code, kind: unit.kind, status: 'REJECTED', issues: previewed.preview_summary?.issues });
      continue;
    }
    if (dryRun) { outcomes.push({ code: unit.code, kind: unit.kind, status: 'CREATED', target_id: previewed.target_id }); continue; }
    const applied = await command(actor, 'apply', draft.id,
      { expected_version: previewed.version, preview_token: previewed.preview_token }, key('apply', unit.code), randomUUID());
    known.set(unit.code.toLowerCase(), applied.target_id);
    outcomes.push({ code: unit.code, kind: unit.kind, status: 'CREATED', target_id: applied.target_id });
  }
  const named = await withTransaction(async client => {
    const r = await client.query(`SELECT lower(u.code) code, u.id,
      org_lifecycle_at(u.id,(now() AT TIME ZONE 'UTC')::date) state,
      (SELECT to_char(max(n.effective_from),'YYYY-MM-DD') FROM org_directory_name_history n WHERE n.org_unit_id=u.id) name_from,
      (SELECT n.display_name FROM org_directory_name_history n WHERE n.org_unit_id=u.id
        ORDER BY n.effective_from DESC LIMIT 1) display_name FROM org_directory_units u`);
    return new Map<string, any>(r.rows.map(x => [x.code, x]));
  });
  for (const rename of plan.renames ?? []) {
    const unit = named.get(rename.code.toLowerCase());
    if (!unit) { outcomes.push({ code: rename.code, kind: 'RENAME', status: 'REJECTED', issues: [{ path: 'code', issue: 'Единица отсутствует в справочнике.' }] }); continue; }
    if (unit.display_name === rename.display_name) { outcomes.push({ code: rename.code, kind: 'RENAME', status: 'UNCHANGED', target_id: unit.id }); continue; }
    // The directory forbids overlapping names, so a rename takes effect no earlier
    // than the day after the current name began. The date is reported, never hidden.
    const effective = unit.name_from >= today
      ? new Date(Date.parse(`${unit.name_from}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
      : today;
    const r = await runChange(actor, { operation: 'ORG_UNIT_RENAME', target_id: unit.id, display_name: rename.display_name,
      effective_from: effective, reason: plan.reason.trim() }, 'ren', rename.code, dryRun);
    outcomes.push(r.ok
      ? { code: rename.code, kind: 'RENAME', status: 'RENAMED', target_id: unit.id, effective_from: effective }
      : { code: rename.code, kind: 'RENAME', status: 'REJECTED', target_id: unit.id, issues: r.issues });
  }
  for (const activation of plan.activations ?? []) {
    const unit = known.get(activation.code.toLowerCase());
    const current = named.get(activation.code.toLowerCase());
    if (!unit) { outcomes.push({ code: activation.code, kind: 'ACTIVATION', status: 'REJECTED', issues: [{ path: 'code', issue: 'Филиал отсутствует в справочнике.' }] }); continue; }
    if (current?.state === 'ACTIVE') { outcomes.push({ code: activation.code, kind: 'ACTIVATION', status: 'ALREADY_ACTIVE', target_id: unit }); continue; }
    if (!activation.reason || activation.reason.trim().length < 10) {
      outcomes.push({ code: activation.code, kind: 'ACTIVATION', status: 'REJECTED', target_id: unit, issues: [{ path: 'reason', issue: 'Для активации требуется основание от 10 символов.' }] });
      continue;
    }
    const r = await runChange(actor, { operation: 'ORG_UNIT_ACTIVATE', target_id: unit,
      effective_from: today, reason: activation.reason.trim() }, 'act', activation.code, dryRun);
    outcomes.push(r.ok
      ? { code: activation.code, kind: 'ACTIVATION', status: 'ACTIVATED', target_id: unit }
      : { code: activation.code, kind: 'ACTIVATION', status: 'REJECTED', target_id: unit, issues: r.issues });
  }
  return {
    mode: dryRun ? 'DRY_RUN' : 'APPLIED', effective_from: today,
    renamed: outcomes.filter(o => o.status === 'RENAMED').length,
    activated: outcomes.filter(o => o.status === 'ACTIVATED').length,
    created: outcomes.filter(o => o.status === 'CREATED').length,
    already_present: outcomes.filter(o => o.status === 'ALREADY_PRESENT').length,
    rejected: outcomes.filter(o => o.status === 'REJECTED').length,
    outcomes,
  };
}
