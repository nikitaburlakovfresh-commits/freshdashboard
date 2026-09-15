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

export async function lockField(client: PoolClient, workItemId: string) {
  const res = await client.query(
    'SELECT * FROM work_item_fields WHERE work_item_id = $1 FOR UPDATE',
    [workItemId],
  );
  return res.rows[0];
}

export async function getField(client: PoolClient, workItemId: string) {
  const res = await client.query('SELECT * FROM work_item_fields WHERE work_item_id = $1', [workItemId]);
  return res.rows[0];
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
