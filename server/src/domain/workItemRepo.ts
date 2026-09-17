import { PoolClient } from 'pg';
import { ApiError } from '../util/errors';

export interface WorkItemRow {
  id: string;
  org_unit_id: string;
  template_version_id: string;
  requires_acceptance: boolean;
  title: string;
  due_at: Date;
  status: string;
  assignee_user_id: string | null;
  created_by: string;
  entity_version: number;
  is_blocked: boolean;
  blocked_reason: string | null;
  current_submission_id: string | null;
  submission_revision: number;
  rework_count: number;
  created_at: Date;
  updated_at: Date;
}

// Locks the work_item row (contract §4 step 4: "SELECT ... FOR UPDATE") so
// concurrent mutations serialize correctly. Returns null if absent (caller
// maps to 404, never revealing existence beyond scope).
export async function lockWorkItem(client: PoolClient, id: string): Promise<WorkItemRow | null> {
  const res = await client.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [id]);
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

export async function getWorkItemRow(client: PoolClient, id: string): Promise<WorkItemRow | null> {
  const res = await client.query('SELECT * FROM work_items WHERE id = $1', [id]);
  if (res.rowCount === 0) return null;
  return res.rows[0];
}

// Locks a single named field row for CAS (patchWorkItemFields writes one
// field per call). Returns undefined if the template has no such field
// (caller maps that to VALIDATION_ERROR, never guessing a default path).
export async function lockFieldByPath(client: PoolClient, workItemId: string, fieldPath: string) {
  const res = await client.query(
    'SELECT * FROM work_item_fields WHERE work_item_id = $1 AND field_path = $2 FOR UPDATE',
    [workItemId, fieldPath],
  );
  return res.rows[0];
}

// Locks every field row belonging to a work item, in a stable order.
// submitWorkItem uses this: with templates.field_schema now able to
// describe more than one field, a snapshot at submit time must validate
// and capture ALL of them together, not just one hardcoded field.
export async function lockAllFields(client: PoolClient, workItemId: string) {
  const res = await client.query(
    'SELECT * FROM work_item_fields WHERE work_item_id = $1 ORDER BY field_path FOR UPDATE',
    [workItemId],
  );
  return res.rows;
}

export async function getFields(client: PoolClient, workItemId: string) {
  const res = await client.query('SELECT * FROM work_item_fields WHERE work_item_id = $1 ORDER BY field_path', [workItemId]);
  return res.rows;
}

export interface TemplateRow {
  id: string;
  code: string;
  version: number;
  requires_acceptance: boolean;
  field_schema_version: number;
  display_name: string;
  is_system: boolean;
  // `type` currently in use: 'text' (existing pilot field, validated by
  // min_chars/max_chars), plus 'number' (min_value/max_value), 'url', and
  // 'date' (calendar date, no extra bounds) for the role-specific hard
  // tasks described in §13.14 (link/KPI-value/metric fields). Unknown
  // future types fail closed in validateFieldValue rather than silently
  // falling back to text rules.
  field_schema: {
    field_path: string;
    label: string;
    type: string;
    required: boolean;
    min_chars?: number;
    max_chars?: number;
    min_value?: number;
    max_value?: number;
  }[];
  field_ownership_rules: Record<string, string>;
  field_visibility_rules: Record<string, string[]>;
}

// Templates are append-only (templates_immutable trigger blocks UPDATE/
// DELETE outright), so a plain un-locked read is always consistent --
// there is no concurrent-mutation case to guard against.
export async function getTemplateByCode(client: PoolClient, code: string): Promise<TemplateRow | null> {
  const res = await client.query('SELECT * FROM templates WHERE code = $1', [code]);
  return res.rows[0] ?? null;
}

export async function getTemplateById(client: PoolClient, id: string): Promise<TemplateRow | null> {
  const res = await client.query('SELECT * FROM templates WHERE id = $1', [id]);
  return res.rows[0] ?? null;
}

export async function getCurrentSubmission(client: PoolClient, workItem: WorkItemRow) {
  if (!workItem.current_submission_id) return null;
  const res = await client.query('SELECT * FROM submissions WHERE id = $1', [workItem.current_submission_id]);
  return res.rows[0] ?? null;
}

/** Scope check: RM sees org grant; RF sees only own assigned items. 404 if hidden. */
export function assertVisible(
  workItem: WorkItemRow,
  actorUserId: string,
  grantedOrgIds: Set<string>,
  isRfInOrg: (orgId: string) => boolean,
): void {
  const visibleAsRm = grantedOrgIds.has(workItem.org_unit_id);
  const visibleAsRf = isRfInOrg(workItem.org_unit_id) && workItem.assignee_user_id === actorUserId;
  if (!visibleAsRm && !visibleAsRf) {
    throw new ApiError('NOT_FOUND', 'Объект не найден.');
  }
}

export function checkEntityVersion(workItem: WorkItemRow, expected: number): void {
  if (workItem.entity_version !== expected) {
    throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
      current_entity_version: workItem.entity_version,
      current_status: workItem.status as any,
    });
  }
}
