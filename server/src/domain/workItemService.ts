import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import { AuthedUser } from '../auth/session';
import { getEffectiveGrants, isActiveRfWithGrant } from './grants';
import { lockWorkItem, getWorkItemRow, lockField, getField, getCurrentSubmission, WorkItemRow } from './workItemRepo';
import { serializeWorkItem } from './serialize';
import { writeAuditAndOutbox } from './auditOutbox';
import { beginIdempotent, completeIdempotent, IdempotentOperation } from './idempotency';

const TEMPLATE_ID = '00000000-0000-4000-8000-000000000101';

export interface ActorContext {
  authUser: AuthedUser;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

async function currentRmOrgIds(client: PoolClient, userId: string): Promise<Set<string>> {
  const grants = await getEffectiveGrants(client, userId);
  return new Set(grants.filter((g) => g.role === 'REGIONAL_MANAGER').map((g) => g.orgUnitId).filter((id):id is string=>id!==null));
}

async function currentRfOrgIds(client: PoolClient, userId: string): Promise<Set<string>> {
  const grants = await getEffectiveGrants(client, userId);
  return new Set(grants.filter((g) => g.role === 'RF').map((g) => g.orgUnitId).filter((id):id is string=>id!==null));
}

async function loadCard(client: PoolClient, workItem: WorkItemRow) {
  const field = await getField(client, workItem.id);
  const submission = await getCurrentSubmission(client, workItem);
  return serializeWorkItem(workItem, field, submission);
}

/** Shared idempotency wrapper for all business mutations except auth. */
async function withIdempotency<T>(
  client: PoolClient,
  actorId: string,
  operation: IdempotentOperation,
  key: string,
  targetId: string | null,
  body: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  const result = await beginIdempotent(client, actorId, operation, key, targetId, body);
  if ('replay' in result) {
    return result.replay as { status: number; body: T };
  }
  const outcome = await fn();
  await completeIdempotent(client, actorId, operation, key, outcome.status, outcome.body);
  return outcome;
}

function requireIdempotencyKey(key: string | undefined): string {
  if (!key || key.length < 16 || key.length > 128 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new ApiError('VALIDATION_ERROR', 'Заголовок Idempotency-Key обязателен и должен соответствовать формату.', {
      issues: [{ path: 'Idempotency-Key', issue: 'required, 16-128 chars, [A-Za-z0-9._:-]' }],
    });
  }
  return key;
}

// ---------- listWorkItems ----------
export async function listWorkItems(
  ctx: ActorContext,
  params: { orgFilter?: string; status?: string; limit: number; cursor?: string },
) {
  return withTransaction(async (client) => {
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
    const allGrantedOrgs = new Set([...rmOrgs, ...rfOrgs]);

    if (params.orgFilter && !allGrantedOrgs.has(params.orgFilter)) {
      throw new ApiError('FORBIDDEN', 'Нет доступа к запрошенному филиалу.');
    }

    // Cursor filterKey binds the FULL filter set (org_unit_id AND status,
    // not just status) plus a permission-epoch surrogate: the sorted list
    // of currently-granted org IDs. If either the caller's requested
    // filters differ from what the cursor was minted under, OR the
    // caller's grant set has changed since the cursor was issued (grant
    // added/revoked), decodeCursor rejects it with INVALID_CURSOR instead
    // of silently paginating over a stale/inconsistent grant snapshot.
    const cursorFilterKey = buildCursorFilterKey(params.orgFilter, params.status, allGrantedOrgs);
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (params.cursor) {
      const decoded = decodeCursor(params.cursor, ctx.authUser.userId, cursorFilterKey);
      cursorCreatedAt = decoded.createdAt;
      cursorId = decoded.id;
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (params.orgFilter) {
      conditions.push(`wi.org_unit_id = $${idx++}`);
      values.push(params.orgFilter);
    } else {
      conditions.push(`wi.org_unit_id = ANY($${idx++}::uuid[])`);
      values.push(Array.from(allGrantedOrgs));
    }

    // RF-own restriction unless also RM in that org.
    conditions.push(
      `(wi.org_unit_id = ANY($${idx}::uuid[]) OR wi.assignee_user_id = $${idx + 1})`,
    );
    values.push(Array.from(rmOrgs));
    values.push(ctx.authUser.userId);
    idx += 2;

    if (params.status) {
      conditions.push(`wi.status = $${idx++}`);
      values.push(params.status);
    }
    if (cursorCreatedAt && cursorId) {
      conditions.push(`(wi.created_at, wi.id) > ($${idx++}, $${idx++})`);
      values.push(cursorCreatedAt, cursorId);
    }

    values.push(params.limit);
    const sql = `
      SELECT wi.* FROM work_items wi
      WHERE ${conditions.join(' AND ')}
      ORDER BY wi.created_at ASC, wi.id ASC
      LIMIT $${idx}
    `;
    const res = await client.query(sql, values);
    const items = [];
    for (const row of res.rows) {
      const field = await getField(client, row.id);
      const submission = await getCurrentSubmission(client, row);
      items.push(serializeWorkItem(row, field, submission));
    }
    const nextCursor =
      res.rows.length === params.limit
        ? encodeCursor(res.rows[res.rows.length - 1].created_at, res.rows[res.rows.length - 1].id, ctx.authUser.userId, cursorFilterKey)
        : null;
    return { items, next_cursor: nextCursor };
  });
}

// Binds org_unit_id filter + status filter + the actor's current granted-org
// set (sorted, joined) into one opaque key. Any change to the filters OR a
// grant change between cursor issuance and use invalidates the cursor.
function buildCursorFilterKey(orgFilter: string | undefined, status: string | undefined, grantedOrgs: Set<string>): string {
  const grantsSignature = Array.from(grantedOrgs).sort().join(',');
  return JSON.stringify({ orgFilter: orgFilter ?? null, status: status ?? null, grantsSignature });
}

function encodeCursor(createdAt: Date, id: string, actorId: string, filterKey: string): string {
  const payload = JSON.stringify({ createdAt: createdAt.toISOString(), id, actorId, filterKey, exp: Date.now() + 15 * 60 * 1000 });
  return Buffer.from(payload).toString('base64url');
}

function decodeCursor(cursor: string, actorId: string, filterKey: string): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded.actorId !== actorId || decoded.filterKey !== filterKey) {
      throw new Error('mismatch');
    }
    if (Date.now() > decoded.exp) throw new Error('expired');
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new ApiError('INVALID_CURSOR', 'Курсор недействителен или устарел.');
  }
}

// ---------- getEligibleAssignees ----------
// Additive R1 pilot endpoint (18th, beyond the original 17 operationIds).
// RM-only, branch-scoped: lists active RF users who currently hold an
// effective (not expired/revoked) grant in the SAME org unit as the work
// item, so the client can offer a picker instead of requiring a raw UUID
// paste for `assignWorkItem`'s `assignee_user_id`. Read-only -- no lock,
// no idempotency key, same visibility fence as getWorkItem (RM must hold
// a current RM grant on the item's org unit; anyone else, including an
// RF actor, sees 404 NOT_FOUND, matching the no-cross-branch-leak pattern
// used everywhere else in this service instead of a distinguishing 403).
export async function getEligibleAssignees(ctx: ActorContext, workItemId: string) {
  return withTransaction(async (client) => {
    const row = await getWorkItemRow(client, workItemId);
    if (!row) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    if (!rmOrgs.has(row.org_unit_id)) throw new ApiError('NOT_FOUND', 'Объект не найден.');

    const res = await client.query(
      `SELECT u.id, u.full_name, u.login
       FROM app_users u
       JOIN role_grants rg ON rg.user_id = u.id
       WHERE u.is_active
         AND NOT u.password_last_shared_indicator
         AND rg.role_code = 'RF'
         AND rg.org_unit_id = $1
         AND rg.revoked_at IS NULL
         AND rg.valid_from <= now()
         AND (rg.valid_until IS NULL OR rg.valid_until > now())
       ORDER BY u.full_name`,
      [row.org_unit_id],
    );
    return {
      items: res.rows.map((r) => ({ id: r.id, full_name: r.full_name, login: r.login })),
    };
  });
}

// ---------- getWorkItem ----------
export async function getWorkItem(ctx: ActorContext, workItemId: string) {
  return withTransaction(async (client) => {
    const row = await getWorkItemRow(client, workItemId);
    if (!row) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
    const visible =
      rmOrgs.has(row.org_unit_id) || (rfOrgs.has(row.org_unit_id) && row.assignee_user_id === ctx.authUser.userId);
    if (!visible) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    return loadCard(client, row);
  });
}

// ---------- createWorkItem ----------
export async function createWorkItem(
  ctx: ActorContext,
  idemKey: string,
  body: { org_unit_id: string; template_code: string; title: string; due_at: string },
) {
  requireIdempotencyKey(idemKey);
  if (body.template_code !== 'pilot_task_v1') {
    throw new ApiError('VALIDATION_ERROR', 'Неизвестный шаблон.', { issues: [{ path: 'template_code', issue: 'must be pilot_task_v1' }] });
  }
  validateTitle(body.title);
  const dueAt = validateUtcTimestamp(body.due_at, 'due_at');

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'createWorkItem', idemKey, null, body, async () => {
      // Grants are re-read HERE, inside the idempotency advisory lock and
      // as the very last check before the mutating INSERT — not once at
      // the top of the transaction — so a grant revoked concurrently right
      // up until this statement is still caught (contract §4/§7: every
      // mutation re-validates authorization immediately before acting, not
      // from a snapshot taken earlier in the request).
      const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
      if (!rmOrgs.has(body.org_unit_id)) {
        throw new ApiError('FORBIDDEN', 'Нет grant REGIONAL_MANAGER в указанном филиале.');
      }

      const inserted = await client.query(
        `INSERT INTO work_items (org_unit_id, template_version_id, title, due_at, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [body.org_unit_id, TEMPLATE_ID, body.title, dueAt, ctx.authUser.userId],
      );
      const workItem = inserted.rows[0];
      await client.query(
        `INSERT INTO work_item_fields (work_item_id, org_unit_id, updated_by) VALUES ($1, $2, $3)`,
        [workItem.id, workItem.org_unit_id, ctx.authUser.userId],
      );

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'REGIONAL_MANAGER',
        orgUnitId: workItem.org_unit_id,
        workItemId: workItem.id,
        action: 'CREATE',
        aggregateType: 'work_item',
        aggregateId: workItem.id,
        aggregateVersion: 1,
        requestId: ctx.requestId,
        beforeState: null,
        afterState: { status: 'DRAFT' },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.created',
        payload: { work_item_id: workItem.id },
      });

      const card = await loadCard(client, workItem);
      return { status: 201, body: card };
    });
  });
}

function validateTitle(title: unknown): void {
  if (typeof title !== 'string' || title.length < 1 || title.length > 200 || !/\S/.test(title)) {
    throw new ApiError('VALIDATION_ERROR', 'Название обязательно, 1-200 символов, не только пробелы.', {
      issues: [{ path: 'title', issue: 'required, 1-200 non-whitespace' }],
    });
  }
}

function validateUtcTimestamp(value: unknown, path: string): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(value)) {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается UTC RFC3339 с Z.', { issues: [{ path, issue: 'must be UTC RFC3339 with Z' }] });
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new ApiError('VALIDATION_ERROR', 'Недействительная календарная дата.', { issues: [{ path, issue: 'invalid calendar date' }] });
  }
  return d;
}

function validateReason(reason: unknown, required = true): string | null {
  if (reason === undefined || reason === null) {
    if (required) throw new ApiError('VALIDATION_ERROR', 'Причина обязательна.', { issues: [{ path: 'reason', issue: 'required' }] });
    return null;
  }
  if (typeof reason !== 'string' || reason.length < 1 || reason.length > 500 || !/\S/.test(reason)) {
    throw new ApiError('VALIDATION_ERROR', 'Причина: 1-500 символов, не только пробелы.', { issues: [{ path: 'reason', issue: '1-500 non-whitespace' }] });
  }
  return reason;
}

function requireVersion(v: unknown): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw new ApiError('VALIDATION_ERROR', 'expected_entity_version обязателен и должен быть целым >=1.', {
      issues: [{ path: 'expected_entity_version', issue: 'required integer >=1' }],
    });
  }
  return v;
}

// ---------- assignWorkItem ----------
export async function assignWorkItem(
  ctx: ActorContext,
  workItemId: string,
  idemKey: string,
  body: { expected_entity_version: unknown; assignee_user_id: unknown },
) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);
  if (typeof body.assignee_user_id !== 'string') {
    throw new ApiError('VALIDATION_ERROR', 'assignee_user_id обязателен.', { issues: [{ path: 'assignee_user_id', issue: 'required uuid' }] });
  }
  const assigneeId = body.assignee_user_id;

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'assignWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock (not once at transaction start) so
      // a concurrently revoked RM grant is still caught.
      const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
      if (!rmOrgs.has(workItem.org_unit_id)) throw new ApiError('NOT_FOUND', 'Объект не найден.');

      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      if (workItem.status !== 'DRAFT') {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }
      const eligible = await isActiveRfWithGrant(client, assigneeId, workItem.org_unit_id);
      if (!eligible) {
        throw new ApiError('ASSIGNEE_INELIGIBLE', 'Указанный исполнитель недоступен для назначения.');
      }

      const before = { status: workItem.status, assignee_user_id: workItem.assignee_user_id };
      const updated = await client.query(
        `UPDATE work_items SET status = 'ASSIGNED', assignee_user_id = $1, entity_version = entity_version + 1, updated_at = now()
         WHERE id = $2 RETURNING *`,
        [assigneeId, workItemId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'REGIONAL_MANAGER',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'ASSIGN',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: before,
        afterState: { status: 'ASSIGNED', assignee_user_id: assigneeId },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.assigned',
        payload: { work_item_id: workItemId },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- startWorkItem ----------
export async function startWorkItem(ctx: ActorContext, workItemId: string, idemKey: string, body: { expected_entity_version: unknown }) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'startWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RF grant
      // is still caught.
      const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
      const isOwnRf = rfOrgs.has(workItem.org_unit_id) && workItem.assignee_user_id === ctx.authUser.userId;
      if (!isOwnRf) throw new ApiError('FORBIDDEN', 'Действие не разрешено.');

      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      if (workItem.status !== 'ASSIGNED') {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }

      const updated = await client.query(
        `UPDATE work_items SET status = 'IN_PROGRESS', entity_version = entity_version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'RF',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'START',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { status: workItem.status },
        afterState: { status: 'IN_PROGRESS' },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.started',
        payload: { work_item_id: workItemId },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- patchWorkItemFields ----------
export async function patchWorkItemFields(
  ctx: ActorContext,
  workItemId: string,
  idemKey: string,
  body: { changes: { field_path: unknown; expected_version: unknown; new_value: unknown }[] },
) {
  requireIdempotencyKey(idemKey);
  if (!Array.isArray(body.changes) || body.changes.length !== 1) {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается ровно одно изменение поля.', { issues: [{ path: 'changes', issue: 'exactly one item' }] });
  }
  const change = body.changes[0];
  if (change.field_path !== 'completion_summary') {
    throw new ApiError('VALIDATION_ERROR', 'Неизвестное поле.', { issues: [{ path: 'changes[0].field_path', issue: 'must be completion_summary' }] });
  }
  const expectedFieldVersion = requireVersion(change.expected_version);
  if (
    typeof change.new_value !== 'string' ||
    change.new_value.length < 1 ||
    change.new_value.length > 4000 ||
    !/\S/.test(change.new_value)
  ) {
    throw new ApiError('VALIDATION_ERROR', 'Значение обязательно, 1-4000 символов, не только пробелы.', {
      issues: [{ path: 'changes[0].new_value', issue: '1-4000 non-whitespace' }],
    });
  }
  const newValue = change.new_value;

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'patchWorkItemFields', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RF grant
      // is still caught.
      const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
      const isOwnRf = rfOrgs.has(workItem.org_unit_id) && workItem.assignee_user_id === ctx.authUser.userId;
      if (!isOwnRf) throw new ApiError('FORBIDDEN_FIELD', 'Действие с полем не разрешено.');

      if (!['ASSIGNED', 'IN_PROGRESS'].includes(workItem.status)) {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }

      const field = await lockField(client, workItemId);
      if (field.field_version !== expectedFieldVersion) {
        // Field CAS reject -> FIELD_PATCH_REJECTED security/audit event (§4).
        await writeAuditAndOutbox(client, {
          actorUserId: ctx.authUser.userId,
          actorRole: 'RF',
          orgUnitId: workItem.org_unit_id,
          workItemId,
          action: 'FIELD_PATCH_REJECTED',
          aggregateType: 'work_item',
          aggregateId: workItemId,
          aggregateVersion: workItem.entity_version,
          requestId: ctx.requestId,
          beforeState: null,
          afterState: null,
          resolution: 'REJECTED',
          retentionClass: 'SECURITY_5Y',
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        throw new ApiError('FIELD_VERSION_CONFLICT', 'Поле изменилось, требуется явное разрешение конфликта.', {
          current_entity_version: workItem.entity_version,
          conflicts: [
            {
              field_path: 'completion_summary',
              expected_version: expectedFieldVersion,
              current_version: field.field_version,
              current_value: field.value,
            },
          ],
        });
      }

      const previousValue = field.value;
      await client.query(
        `UPDATE work_item_fields SET value = $1, field_version = field_version + 1, updated_by = $2, updated_at = now()
         WHERE work_item_id = $3`,
        [newValue, ctx.authUser.userId, workItemId],
      );
      const updatedWi = await client.query(
        `UPDATE work_items SET entity_version = entity_version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updatedWi.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'RF',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'FIELDS_PATCH',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { field_version: field.field_version, value: previousValue },
        afterState: { field_version: field.field_version + 1, value: newValue },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.fields_patched',
        payload: { work_item_id: workItemId, field_path: 'completion_summary' },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- submitWorkItem ----------
export async function submitWorkItem(ctx: ActorContext, workItemId: string, idemKey: string, body: { expected_entity_version: unknown }) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'submitWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RF grant
      // is still caught.
      const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
      const isOwnRf = rfOrgs.has(workItem.org_unit_id) && workItem.assignee_user_id === ctx.authUser.userId;
      if (!isOwnRf) throw new ApiError('FORBIDDEN', 'Действие не разрешено.');

      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      if (!['ASSIGNED', 'IN_PROGRESS'].includes(workItem.status)) {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }
      if (workItem.is_blocked) {
        throw new ApiError('WORK_ITEM_BLOCKED', 'Нельзя сдать заблокированную задачу.');
      }
      const field = await lockField(client, workItemId);
      if (!field.value || !/\S/.test(field.value)) {
        throw new ApiError('COMPLETION_REQUIRED', 'Результат должен быть заполнен перед сдачей.');
      }

      const nextRevision = workItem.submission_revision + 1;
      const now = new Date();
      const marker = now.getTime() > new Date(workItem.due_at).getTime() ? 'LATE' : 'ON_TIME';
      const nextEntityVersion = workItem.entity_version + 1;

      // work_items_check3 requires current_submission_id IS NOT NULL whenever
      // status IN ('SUBMITTED','COMPLETED'), enforced per-statement (not
      // deferred). Insert the submission row first, then flip status and
      // current_submission_id together in one UPDATE so the row never
      // transiently violates the constraint.
      const submissionRes = await client.query(
        `INSERT INTO submissions (work_item_id, org_unit_id, revision, completion_summary, field_version,
             entity_version, template_version_id, due_at, submitted_by, submission_marker)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          workItemId,
          workItem.org_unit_id,
          nextRevision,
          field.value,
          field.field_version,
          nextEntityVersion,
          workItem.template_version_id,
          workItem.due_at,
          ctx.authUser.userId,
          marker,
        ],
      );
      const submission = submissionRes.rows[0];

      const updatedWi = await client.query(
        `UPDATE work_items SET status = 'SUBMITTED', entity_version = entity_version + 1,
                submission_revision = $1, current_submission_id = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [nextRevision, submission.id, workItemId],
      );
      const newRow = updatedWi.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'RF',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'SUBMIT',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { status: workItem.status },
        afterState: { status: 'SUBMITTED', submission_id: submission.id, revision: nextRevision },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.submitted',
        payload: { work_item_id: workItemId, submission_id: submission.id },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- acceptWorkItem / reworkWorkItem ----------
async function reviewGuard(client: PoolClient, workItem: WorkItemRow, actorUserId: string, rmOrgs: Set<string>) {
  if (!rmOrgs.has(workItem.org_unit_id)) throw new ApiError('NOT_FOUND', 'Объект не найден.');
  if (workItem.status !== 'SUBMITTED') {
    throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
  }
  const submission = await getCurrentSubmission(client, workItem);
  if (workItem.assignee_user_id === actorUserId || (submission && submission.submitted_by === actorUserId)) {
    throw new ApiError('SELF_REVIEW_FORBIDDEN', 'Нельзя принять или вернуть собственное исполнение.');
  }
  return submission;
}

export async function acceptWorkItem(
  ctx: ActorContext,
  workItemId: string,
  idemKey: string,
  body: { expected_entity_version: unknown; submission_id: unknown; submission_revision: unknown },
) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);
  if (typeof body.submission_id !== 'string' || typeof body.submission_revision !== 'number') {
    throw new ApiError('VALIDATION_ERROR', 'submission_id и submission_revision обязательны.', {
      issues: [{ path: 'submission_id', issue: 'required' }],
    });
  }

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'acceptWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RM
      // grant is still caught.
      const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      const submission = await reviewGuard(client, workItem, ctx.authUser.userId, rmOrgs);
      if (!submission || submission.id !== body.submission_id || submission.revision !== body.submission_revision) {
        throw new ApiError('SUBMISSION_CONFLICT', 'Версия сдачи устарела.', {
          current_submission_id: submission ? submission.id : null,
          current_submission_revision: submission ? submission.revision : 0,
        });
      }

      const updated = await client.query(
        `UPDATE work_items SET status = 'COMPLETED', entity_version = entity_version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'REGIONAL_MANAGER',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'ACCEPT',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { status: workItem.status },
        afterState: { status: 'COMPLETED' },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.accepted',
        payload: { work_item_id: workItemId, submission_id: submission.id, submission_revision: submission.revision },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

export async function reworkWorkItem(
  ctx: ActorContext,
  workItemId: string,
  idemKey: string,
  body: { expected_entity_version: unknown; submission_id: unknown; submission_revision: unknown; reason: unknown },
) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);
  const reason = validateReason(body.reason, true);
  if (typeof body.submission_id !== 'string' || typeof body.submission_revision !== 'number') {
    throw new ApiError('VALIDATION_ERROR', 'submission_id и submission_revision обязательны.', {
      issues: [{ path: 'submission_id', issue: 'required' }],
    });
  }

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'reworkWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RM
      // grant is still caught.
      const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      const submission = await reviewGuard(client, workItem, ctx.authUser.userId, rmOrgs);
      if (!submission || submission.id !== body.submission_id || submission.revision !== body.submission_revision) {
        throw new ApiError('SUBMISSION_CONFLICT', 'Версия сдачи устарела.', {
          current_submission_id: submission ? submission.id : null,
          current_submission_revision: submission ? submission.revision : 0,
        });
      }

      const updated = await client.query(
        `UPDATE work_items SET status = 'IN_PROGRESS', entity_version = entity_version + 1,
                rework_count = rework_count + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'REGIONAL_MANAGER',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'REWORK',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { status: workItem.status },
        afterState: { status: 'IN_PROGRESS', rework_count: newRow.rework_count },
        reason,
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.rework_requested',
        payload: { work_item_id: workItemId, submission_id: submission.id },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- cancelWorkItem ----------
export async function cancelWorkItem(ctx: ActorContext, workItemId: string, idemKey: string, body: { expected_entity_version: unknown; reason: unknown }) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);
  const reason = validateReason(body.reason, true);

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'cancelWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RM
      // grant is still caught.
      const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
      if (!rmOrgs.has(workItem.org_unit_id)) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      if (!['DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED'].includes(workItem.status)) {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }

      const before = { status: workItem.status, is_blocked: workItem.is_blocked, blocked_reason: workItem.blocked_reason };
      const updated = await client.query(
        `UPDATE work_items SET status = 'CANCELLED', is_blocked = false, blocked_reason = NULL,
                entity_version = entity_version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'REGIONAL_MANAGER',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'CANCEL',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: before,
        afterState: { status: 'CANCELLED' },
        reason,
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.cancelled',
        payload: { work_item_id: workItemId },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- reopenWorkItem ----------
export async function reopenWorkItem(ctx: ActorContext, workItemId: string, idemKey: string, body: { expected_entity_version: unknown; reason: unknown }) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);
  const reason = validateReason(body.reason, true);

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'reopenWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked RM
      // grant is still caught.
      const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
      if (!rmOrgs.has(workItem.org_unit_id)) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      if (workItem.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: workItem.entity_version,
          current_status: workItem.status as any,
        });
      }
      if (workItem.status !== 'COMPLETED') {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }
      if (!workItem.assignee_user_id || !(await isActiveRfWithGrant(client, workItem.assignee_user_id, workItem.org_unit_id))) {
        throw new ApiError('ASSIGNEE_INELIGIBLE', 'Прежний исполнитель недоступен для возобновления.');
      }

      const updated = await client.query(
        `UPDATE work_items SET status = 'IN_PROGRESS', entity_version = entity_version + 1, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: 'REGIONAL_MANAGER',
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'REOPEN',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { status: workItem.status },
        afterState: { status: 'IN_PROGRESS' },
        reason,
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.reopened',
        payload: { work_item_id: workItemId },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- getWorkItemHistory ----------
export async function getWorkItemHistory(ctx: ActorContext, workItemId: string, params: { limit: number; cursor?: string }) {
  return withTransaction(async (client) => {
    const row = await getWorkItemRow(client, workItemId);
    if (!row) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
    const visible = rmOrgs.has(row.org_unit_id) || (rfOrgs.has(row.org_unit_id) && row.assignee_user_id === ctx.authUser.userId);
    if (!visible) throw new ApiError('NOT_FOUND', 'Объект не найден.');

    let cursorVersion: number | null = null;
    let cursorEventId: string | null = null;
    if (params.cursor) {
      const decoded = decodeHistoryCursor(params.cursor, ctx.authUser.userId, workItemId);
      cursorVersion = decoded.version;
      cursorEventId = decoded.eventId;
    }

    const conditions = [`work_item_id = $1`, `aggregate_type = 'work_item'`, `resolution = 'APPLIED'`];
    const values: unknown[] = [workItemId];
    let idx = 2;
    if (cursorVersion !== null) {
      conditions.push(`(aggregate_version, id) > ($${idx++}, $${idx++})`);
      values.push(cursorVersion, cursorEventId);
    }
    values.push(params.limit);

    const res = await client.query(
      `SELECT * FROM audit_log WHERE ${conditions.join(' AND ')} ORDER BY aggregate_version ASC, id ASC LIMIT $${idx}`,
      values,
    );

    const items = [];
    for (const entry of res.rows) {
      items.push(await mapAuditToHistoryEntry(client, entry));
    }
    const nextCursor =
      res.rows.length === params.limit
        ? encodeHistoryCursor(res.rows[res.rows.length - 1].aggregate_version, res.rows[res.rows.length - 1].id, ctx.authUser.userId, workItemId)
        : null;
    return { items, next_cursor: nextCursor };
  });
}

async function mapAuditToHistoryEntry(client: PoolClient, entry: any) {
  const actionToEvent: Record<string, string> = {
    CREATE: 'work_item.created',
    ASSIGN: 'work_item.assigned',
    START: 'work_item.started',
    FIELDS_PATCH: 'work_item.fields_patched',
    SUBMIT: 'work_item.submitted',
    ACCEPT: 'work_item.accepted',
    REWORK: 'work_item.rework_requested',
    CANCEL: 'work_item.cancelled',
    REOPEN: 'work_item.reopened',
  };
  const before = entry.before_state;
  const after = entry.after_state;
  let submission = null;
  if (entry.action === 'SUBMIT' && after?.submission_id) {
    const res = await client.query('SELECT * FROM submissions WHERE id = $1', [after.submission_id]);
    if (res.rowCount) submission = require('./serialize').serializeSubmission(res.rows[0]);
  }
  let fieldChange = null;
  if (entry.action === 'FIELDS_PATCH') {
    fieldChange = {
      field_path: 'completion_summary',
      previous_value: before?.value ?? null,
      new_value: after?.value,
      field_version: after?.field_version,
    };
  }
  return {
    event_id: entry.id,
    event_type: actionToEvent[entry.action] ?? entry.action,
    aggregate_version: Number(entry.aggregate_version),
    occurred_at: entry.occurred_at.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    actor_id: entry.actor_user_id,
    from_status: before?.status ?? null,
    to_status: after?.status ?? null,
    reason: entry.reason ?? null,
    field_change: fieldChange,
    submission,
    reviewed_submission_id: after?.submission_id ?? null,
    reviewed_submission_revision: after?.revision ?? after?.submission_revision ?? null,
  };
}

// ---------- listNotifications ----------
export async function listNotifications(ctx: ActorContext, params: { unreadOnly: boolean; limit: number; cursor?: string }) {
  return withTransaction(async (client) => {
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
    const grantedOrgs = new Set([...rmOrgs, ...rfOrgs]);

    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (params.cursor) {
      const decoded = decodeNotifCursor(params.cursor, ctx.authUser.userId, params.unreadOnly);
      cursorCreatedAt = decoded.createdAt;
      cursorId = decoded.id;
    }

    const conditions = [`n.recipient_user_id = $1`, `n.org_unit_id = ANY($2::uuid[])`];
    const values: unknown[] = [ctx.authUser.userId, Array.from(grantedOrgs)];
    let idx = 3;
    if (params.unreadOnly) {
      conditions.push('n.read_at IS NULL');
    }
    if (cursorCreatedAt && cursorId) {
      conditions.push(`(n.created_at, n.id) > ($${idx++}, $${idx++})`);
      values.push(cursorCreatedAt, cursorId);
    }
    values.push(params.limit);

    const res = await client.query(
      `SELECT n.* FROM notifications n WHERE ${conditions.join(' AND ')}
       ORDER BY n.created_at ASC, n.id ASC LIMIT $${idx}`,
      values,
    );
    const { serializeNotification } = await import('./serialize');
    const items = res.rows.map(serializeNotification);
    const nextCursor =
      res.rows.length === params.limit
        ? encodeNotifCursor(res.rows[res.rows.length - 1].created_at, res.rows[res.rows.length - 1].id, ctx.authUser.userId, params.unreadOnly)
        : null;
    return { items, next_cursor: nextCursor };
  });
}

function encodeNotifCursor(createdAt: Date, id: string, actorId: string, unreadOnly: boolean): string {
  const payload = JSON.stringify({ createdAt: createdAt.toISOString(), id, actorId, unreadOnly, exp: Date.now() + 15 * 60 * 1000 });
  return Buffer.from(payload).toString('base64url');
}
function decodeNotifCursor(cursor: string, actorId: string, unreadOnly: boolean): { createdAt: string; id: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded.actorId !== actorId || decoded.unreadOnly !== unreadOnly) throw new Error('mismatch');
    if (Date.now() > decoded.exp) throw new Error('expired');
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new ApiError('INVALID_CURSOR', 'Курсор недействителен или устарел.');
  }
}

// ---------- readNotification ----------
export async function readNotification(ctx: ActorContext, notificationId: string, idemKey: string, body: { expected_entity_version: unknown }) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);

  return withTransaction(async (client) => {
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    const rfOrgs = await currentRfOrgIds(client, ctx.authUser.userId);
    const grantedOrgs = new Set([...rmOrgs, ...rfOrgs]);

    return withIdempotency(client, ctx.authUser.userId, 'readNotification', idemKey, notificationId, body, async () => {
      const res = await client.query('SELECT * FROM notifications WHERE id = $1 FOR UPDATE', [notificationId]);
      if (res.rowCount === 0) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      const notif = res.rows[0];
      if (notif.recipient_user_id !== ctx.authUser.userId || !grantedOrgs.has(notif.org_unit_id)) {
        throw new ApiError('NOT_FOUND', 'Объект не найден.');
      }
      if (notif.entity_version !== expectedVersion) {
        throw new ApiError('ENTITY_VERSION_CONFLICT', 'Версия сущности изменилась.', {
          current_entity_version: notif.entity_version,
        });
      }

      const { serializeNotification } = await import('./serialize');
      if (notif.read_at) {
        return { status: 200, body: serializeNotification(notif) };
      }

      const updated = await client.query(
        `UPDATE notifications SET read_at = now(), entity_version = entity_version + 1 WHERE id = $1 RETURNING *`,
        [notificationId],
      );
      const newRow = updated.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: null,
        orgUnitId: notif.org_unit_id,
        workItemId: notif.work_item_id,
        action: 'NOTIFICATION_READ',
        aggregateType: 'notification',
        aggregateId: notificationId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { read_at: null },
        afterState: { read_at: newRow.read_at },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'notification.read',
        payload: { notification_id: notificationId },
      });

      return { status: 200, body: serializeNotification(newRow) };
    });
  });
}

function encodeHistoryCursor(version: number, eventId: string, actorId: string, workItemId: string): string {
  const payload = JSON.stringify({ version, eventId, actorId, workItemId, exp: Date.now() + 15 * 60 * 1000 });
  return Buffer.from(payload).toString('base64url');
}
function decodeHistoryCursor(cursor: string, actorId: string, workItemId: string): { version: number; eventId: string } {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (decoded.actorId !== actorId || decoded.workItemId !== workItemId) throw new Error('mismatch');
    if (Date.now() > decoded.exp) throw new Error('expired');
    return { version: decoded.version, eventId: decoded.eventId };
  } catch {
    throw new ApiError('INVALID_CURSOR', 'Курсор недействителен или устарел.');
  }
}
