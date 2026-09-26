import { PoolClient } from 'pg';
import { withTransaction as databaseTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import { AuthedUser } from '../auth/session';
import { getEffectiveGrants, isActiveRoleWithGrant } from './grants';
import {
  lockWorkItem, getWorkItemRow, lockFieldByPath, lockAllFields, getFields, getCurrentSubmission,
  getTemplateByCode, getTemplateById, TemplateRow, WorkItemRow,
} from './workItemRepo';
import { serializeWorkItem } from './serialize';
import { writeAuditAndOutbox } from './auditOutbox';
import { beginIdempotent, completeIdempotent, IdempotentOperation } from './idempotency';
import { assertDailyWindow, dailyMetadata, dailyLinks, assignedTasksForDay, dailyDate, ensureDailyLog, liveFence, assertSectionNotTooEarly} from './dailyLogs';

export interface ActorContext {
  authUser: AuthedUser;
  requestId: string;
  ip: string | null;
  userAgent: string | null;
}

// Assignment administration (011) can revoke a grant while a business command
// is in flight. Fence authorization BEFORE any task/idempotency row lock and
// retain it through commit. A re-read alone leaves a check-to-INSERT race.
// Same table order as access administration; SHARE allows concurrent readers
// and task writers, but serializes them with grant/catalog/user mutations.
function withTransaction<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T> {
  return databaseTransaction(async client=>{
    await client.query('LOCK TABLE app_users, sessions, role_grants, roles, role_permissions IN SHARE MODE');
    return fn(client);
  });
}

// Чтение ежедневников подчинённых без проверки (решение владельца 26.09.2026):
// РФ видит ежедневники РОП и РОО своего филиала, дивизиональный — своих
// филиалов. Принимает и возвращает по-прежнему региональный менеджер.
const DIARY_READER_ROLES = ['RF', 'DIVISION_MANAGER'];
async function diaryReadOrgIds(client: PoolClient, userId: string): Promise<Set<string>> {
  const grants = await getEffectiveGrants(client, userId);
  return new Set(grants.filter((g) => DIARY_READER_ROLES.includes(g.role)).map((g) => g.orgUnitId).filter((id):id is string=>id!==null));
}
async function currentRmOrgIds(client: PoolClient, userId: string): Promise<Set<string>> {
  const grants = await getEffectiveGrants(client, userId);
  return new Set(grants.filter((g) => g.role === 'REGIONAL_MANAGER').map((g) => g.orgUnitId).filter((id):id is string=>id!==null));
}

// Generalized replacement for the old RF-only currentRfOrgIds (ТЗ
// "Авторизация по всем ролям индивидуальная", 2026-09-18): returns every
// org unit where the actor currently holds ANY non-REGIONAL_MANAGER,
// non-revoked, in-window grant, together with WHICH role(s) they hold
// there. Two call-site styles read this map:
//  - loose "still an active branch employee" freshness check (get/list/
//    history/notifications): Set(map.keys()) -- matches the ORIGINAL
//    intent of the re-read-after-lock comments below ("so a concurrently
//    revoked grant is still caught"), not a role-identity check, so it is
//    intentionally left permissive across whatever operational role the
//    actor happens to hold in that org.
//  - strict "does the actor hold THIS SPECIFIC role here" check (start/
//    patch/submit/reopen/assign/eligible-assignees), via
//    map.get(orgUnitId)?.has(requiredRole) -- required wherever an action
//    is gated to the exact role a template names as its field owner.
/** Роли, в которых актор может исполнять задачу филиала: операционные и РМ
 * (РМ отвечает на «Запрос в УК», 26.09.2026). */
async function executorRoles(client: PoolClient, userId: string, orgUnitId: string,
  workItem?: { source_ref?: any; assignee_user_id?: string | null }): Promise<Set<string>> {
  const set = new Set((await currentOperationalRolesByOrg(client, userId)).get(orgUnitId) ?? []);
  if ((await currentRmOrgIds(client, userId)).has(orgUnitId)) set.add('REGIONAL_MANAGER');
  // Задача УК (26.09.2026): исполняет назначенный сотрудник УК, пока у него
  // действует любая роль УК. Филиал задачи здесь не важен — это может быть сеть.
  if (workItem?.source_ref?.kind === 'UK_TASK' && workItem.assignee_user_id === userId
    && await holdsUkRole(client, userId)) set.add('UK_STAFF');
  return set;
}
export async function holdsUkRole(client: PoolClient, userId: string): Promise<boolean> {
  return !!(await client.query(`SELECT 1 FROM role_grants g JOIN task_assign_rules r
      ON r.setter_role=g.role_code AND r.target='UK_ANY' AND r.revoked_at IS NULL
     WHERE g.user_id=$1 AND g.revoked_at IS NULL AND g.valid_from<=now()
       AND (g.valid_until IS NULL OR g.valid_until>now()) LIMIT 1`, [userId])).rowCount;
}
/** Задачи УК видят постановщик и исполнитель, где бы ни стоял узел задачи. */
const UK_TASK_MINE = (p: string) => `(wi.source_ref->>'kind'='UK_TASK' AND (wi.assignee_user_id=${p} OR wi.created_by=${p}))`;

async function currentOperationalRolesByOrg(client: PoolClient, userId: string): Promise<Map<string, Set<string>>> {
  const grants = await getEffectiveGrants(client, userId);
  const map = new Map<string, Set<string>>();
  for (const g of grants) {
    if (g.role === 'REGIONAL_MANAGER' || g.orgUnitId === null) continue;
    if (!map.has(g.orgUnitId)) map.set(g.orgUnitId, new Set());
    map.get(g.orgUnitId)!.add(g.role);
  }
  return map;
}

// A template's executor role is derived from field_ownership_rules rather
// than a hardcoded 'RF' literal or a new templates.owner_role_code column:
// every field's declared owner already names the role, and today every
// template (pilot_task_v1, migration 007 test fixtures, migration 008's 5
// RF daily-log templates) has exactly one distinct owner across all of its
// fields. A template mixing owner roles across fields (a future shared
// aggregator, e.g. TZ §13.14 daily_log_branch/add_to_daily_log) is
// explicitly out of scope for this phase -- fail closed with a clear
// VALIDATION_ERROR instead of silently picking one role, so that scenario
// surfaces as a deliberate design decision later, not a silent bug now.
export function deriveTemplateOwnerRole(template: TemplateRow): string {
  const roles = new Set(Object.values(template.field_ownership_rules));
  if (roles.size === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Шаблон не определяет роль-владельца полей.');
  }
  if (roles.size > 1) {
    throw new ApiError(
      'VALIDATION_ERROR',
      'Шаблоны с несколькими ролями-владельцами полей пока не поддерживаются.',
    );
  }
  return [...roles][0];
}

async function loadCard(client: PoolClient, workItem: WorkItemRow) {
  const template = await getTemplateById(client, workItem.template_version_id);
  if (!template) throw new ApiError('NOT_FOUND', 'Объект не найден.');
  const fields = await getFields(client, workItem.id);
  const submission = await getCurrentSubmission(client, workItem);
  const daily = await dailyMetadata(client,workItem.id);
  return {...serializeWorkItem(workItem, template, fields, submission),daily_log:daily,
    // Задачи от руководителя — внутри самого ежедневника (решение владельца 26.09.2026).
    assigned_tasks:daily&&workItem.assignee_user_id?await assignedTasksForDay(client,workItem.org_unit_id,
      workItem.assignee_user_id,daily.business_date):[],
    daily_links:daily?await dailyLinks(client,workItem.id,
      ['SUBMITTED','COMPLETED'].includes(workItem.status)?workItem.current_submission_id??undefined:undefined):[],
    current_business_date:(await client.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day};
}

// Field def lookup + shared validation, driven by templates.field_schema
// (§13.13.1) instead of a hardcoded 'completion_summary'/1-4000 pair.
function findFieldDef(template: TemplateRow, fieldPath: string) {
  return template.field_schema.find((f) => f.field_path === fieldPath);
}
type FieldDef = TemplateRow['field_schema'][number];

// Every branch below returns the exact string to persist in
// work_item_fields.value (still a plain text column -- type-specific
// storage is a later migration, not needed while values round-trip as
// text). Validation is dispatched by fieldDef.type so a role-specific
// hard task (§13.14: link/KPI value/metric) gets real format checking
// instead of the old one-size-fits-all 'text, 1-4000 chars' rule.
function validateFieldValue(fieldDef: FieldDef, value: unknown, path: string): string {
  switch (fieldDef.type) {
    case 'number':
      return validateNumberField(fieldDef, value, path);
    case 'url':
      return validateUrlField(fieldDef, value, path);
    case 'date':
      return validateDateField(value, path);
    case 'text':
      return validateTextField(fieldDef, value, path);
    case 'select':
      return validateSelectField(fieldDef, value, path);
    case 'repeatable_group':
      return validateRepeatableGroupField(fieldDef, value, path);
    default:
      // Fail closed: an unrecognized type is a template authoring bug, not
      // something to silently accept as free text.
      throw new ApiError('VALIDATION_ERROR', 'Неподдерживаемый тип поля шаблона.', {
        issues: [{ path, issue: `unknown field type: ${fieldDef.type}` }],
      });
  }
}

function validateTextField(fieldDef: FieldDef, value: unknown, path: string): string {
  const minChars = fieldDef.min_chars ?? 1;
  const maxChars = fieldDef.max_chars ?? 4000;
  if (
    typeof value !== 'string' ||
    value.length < minChars ||
    value.length > maxChars ||
    !/\S/.test(value)
  ) {
    throw new ApiError('VALIDATION_ERROR', `Значение обязательно, ${minChars}-${maxChars} символов, не только пробелы.`, {
      issues: [{ path, issue: `${minChars}-${maxChars} non-whitespace` }],
    });
  }
  return value;
}

// Accepts a plain decimal string (optionally signed/fractional) -- not
// exponent notation or Infinity/NaN spellings, which Number() would
// otherwise accept. Stored as the original string so no precision is
// lost round-tripping through work_item_fields.value.
const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
function validateNumberField(fieldDef: FieldDef, value: unknown, path: string): string {
  if (typeof value !== 'string' || !NUMBER_PATTERN.test(value)) {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается числовое значение.', { issues: [{ path, issue: 'must be a plain decimal number' }] });
  }
  const n = Number(value);
  if (fieldDef.min_value !== undefined && n < fieldDef.min_value) {
    throw new ApiError('VALIDATION_ERROR', `Значение должно быть не меньше ${fieldDef.min_value}.`, { issues: [{ path, issue: `must be >= ${fieldDef.min_value}` }] });
  }
  if (fieldDef.max_value !== undefined && n > fieldDef.max_value) {
    throw new ApiError('VALIDATION_ERROR', `Значение должно быть не больше ${fieldDef.max_value}.`, { issues: [{ path, issue: `must be <= ${fieldDef.max_value}` }] });
  }
  return value;
}

function validateSelectField(fieldDef: FieldDef, value: unknown, path: string): string {
  const options = fieldDef.options ?? [];
  if (options.length === 0) {
    // A 'select' field with no options is a template authoring bug, not
    // something a submitter can ever satisfy -- fail closed rather than
    // accepting arbitrary text.
    throw new ApiError('VALIDATION_ERROR', 'Шаблон поля не содержит вариантов выбора.', { issues: [{ path, issue: 'select field has no options' }] });
  }
  if (typeof value !== 'string' || !options.includes(value)) {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается один из предусмотренных вариантов.', { issues: [{ path, issue: `must be one of: ${options.join(', ')}` }] });
  }
  return value;
}

// A repeatable_group field's value is a JSON-stringified array of item
// objects (e.g. one "ТС"/"звонок"/"клиент" card per item), still stored in the
// same work_item_fields.value text column every scalar field type
// already uses. Each item is validated against child_fields and the
// canonical JSON is re-serialized (dropping unknown keys) rather than
// trusting the caller's exact bytes -- the same "never persist unvalidated
// input verbatim" rule the scalar validators already follow.
function validateRepeatableGroupField(fieldDef: FieldDef, value: unknown, path: string): string {
  const childFields = fieldDef.child_fields ?? [];
  if (childFields.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'Шаблон группы не содержит полей.', { issues: [{ path, issue: 'repeatable_group has no child_fields' }] });
  }
  if (typeof value !== 'string') {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается список записей.', { issues: [{ path, issue: 'must be a JSON array string' }] });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Недействительный список записей.', { issues: [{ path, issue: 'must be valid JSON' }] });
  }
  if (!Array.isArray(parsed)) {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается список записей.', { issues: [{ path, issue: 'must be a JSON array' }] });
  }
  const minItems = fieldDef.min_items ?? 0;
  const maxItems = fieldDef.max_items ?? 100;
  if (parsed.length < minItems) {
    throw new ApiError('VALIDATION_ERROR', `Нужно не меньше ${minItems} записей.`, { issues: [{ path, issue: `must have >= ${minItems} items` }] });
  }
  if (parsed.length > maxItems) {
    throw new ApiError('VALIDATION_ERROR', `Допустимо не больше ${maxItems} записей.`, { issues: [{ path, issue: `must have <= ${maxItems} items` }] });
  }
  const normalized = parsed.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ApiError('VALIDATION_ERROR', 'Каждая запись должна быть объектом.', { issues: [{ path: `${path}[${index}]`, issue: 'must be an object' }] });
    }
    const record = item as Record<string, unknown>;
    const normalizedItem: Record<string, string> = {};
    for (const child of childFields) {
      const raw = record[child.field_path];
      const childPath = `${path}[${index}].${child.field_path}`;
      if (raw === undefined || raw === null || raw === '') {
        if (child.required) {
          throw new ApiError('VALIDATION_ERROR', 'Обязательное поле записи не заполнено.', { issues: [{ path: childPath, issue: 'required' }] });
        }
        continue;
      }
      normalizedItem[child.field_path] = validateFieldValue(child as FieldDef, raw, childPath);
    }
    return normalizedItem;
  });
  return JSON.stringify(normalized);
}

function validateUrlField(fieldDef: FieldDef, value: unknown, path: string): string {
  const maxChars = fieldDef.max_chars ?? 2048;
  if (typeof value !== 'string' || value.length === 0 || value.length > maxChars) {
    throw new ApiError('VALIDATION_ERROR', `Ссылка обязательна, до ${maxChars} символов.`, { issues: [{ path, issue: `1-${maxChars} chars` }] });
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ApiError('VALIDATION_ERROR', 'Недействительная ссылка.', { issues: [{ path, issue: 'must be an absolute http(s) URL' }] });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError('VALIDATION_ERROR', 'Ссылка должна быть http/https.', { issues: [{ path, issue: 'must be http or https' }] });
  }
  return value;
}

// Calendar date only (YYYY-MM-DD), matching the §13.14 "next event date"
// use case -- not a full timestamp, so this deliberately does not reuse
// validateUtcTimestamp's RFC3339-with-Z shape.
function validateDateField(value: unknown, path: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ApiError('VALIDATION_ERROR', 'Ожидается дата в формате YYYY-MM-DD.', { issues: [{ path, issue: 'must be YYYY-MM-DD' }] });
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) {
    throw new ApiError('VALIDATION_ERROR', 'Недействительная календарная дата.', { issues: [{ path, issue: 'invalid calendar date' }] });
  }
  return value;
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

// Catalog exposes immutable schemas, never another person's task values.
// Creating tasks remains RM-only; SUPER_ADMIN is not an implicit executor.
export async function listTaskTemplates(ctx: ActorContext) {
  return withTransaction(async client => {
    if (!(await currentRmOrgIds(client, ctx.authUser.userId)).size) {
      throw new ApiError('FORBIDDEN', 'Нет права постановки задач.');
    }
    const result = await client.query<TemplateRow>("SELECT * FROM templates WHERE code NOT LIKE 'personal_daily_%' ORDER BY display_name, code");
    return { items: result.rows.filter(t => {
      const roles = new Set(Object.values(t.field_ownership_rules));
      return roles.size === 1 && t.field_schema.length > 0 &&
        t.field_schema.every(f => t.field_ownership_rules[f.field_path]);
    }).map(t => ({
      code: t.code, display_name: t.display_name, version: t.version,
      owner_role: deriveTemplateOwnerRole(t), field_schema: t.field_schema,
      requires_acceptance: t.requires_acceptance,
    })) };
  });
}

// ---------- listWorkItems ----------
export async function listWorkItems(
  ctx: ActorContext,
  params: { orgFilter?: string; status?: string; limit: number; cursor?: string; mine?: boolean; role?: string },
) {
  return withTransaction(async (client) => {
    const rmOrgs = await currentRmOrgIds(client, ctx.authUser.userId);
    const operationalRoles = await currentOperationalRolesByOrg(client, ctx.authUser.userId);
    const allGrantedOrgs = new Set([...rmOrgs, ...operationalRoles.keys()]);

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
    if (params.role && !params.mine) throw new ApiError('VALIDATION_ERROR', 'Фильтр роли доступен только в личном списке.');
    const cursorFilterKey = JSON.stringify({
      base: buildCursorFilterKey(params.orgFilter, params.status, allGrantedOrgs),
      mine: params.mine ?? false, role: params.role ?? null,
      roles: [...operationalRoles].sort(([a],[b]) => a.localeCompare(b)).map(([org, roles]) => [org, [...roles].sort()]),
    });
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
      conditions.push(`(wi.org_unit_id = ANY($${idx++}::uuid[]) OR ${UK_TASK_MINE(`$${idx++}`)})`);
      values.push(Array.from(allGrantedOrgs), ctx.authUser.userId);
    }

    // RF-own restriction unless also RM in that org.
    conditions.push(
      `(wi.org_unit_id = ANY($${idx}::uuid[]) OR wi.assignee_user_id = $${idx + 1} OR wi.created_by = $${idx + 1}
        OR (wi.org_unit_id = ANY($${idx + 2}::uuid[]) AND EXISTS (SELECT 1 FROM daily_log_records d WHERE d.work_item_id=wi.id))
        OR ${UK_TASK_MINE(`$${idx + 1}`)})`,
    );
    const diaryOrgs = Array.from(await diaryReadOrgIds(client, ctx.authUser.userId));
    values.push(Array.from(rmOrgs));
    values.push(ctx.authUser.userId);
    values.push(diaryOrgs);
    idx += 3;
    // A revoked diary role must not be readable via another surviving role.
    conditions.push(`(NOT EXISTS (SELECT 1 FROM daily_log_records d WHERE d.work_item_id=wi.id)
      OR wi.org_unit_id=ANY($${idx++}::uuid[]) OR wi.org_unit_id=ANY($${idx++}::uuid[]) OR EXISTS (
        SELECT 1 FROM daily_log_records d JOIN role_grants g ON g.user_id=d.user_id
          AND g.org_unit_id=d.org_unit_id AND g.role_code=d.role_code
        WHERE d.work_item_id=wi.id AND g.user_id=$${idx++} AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())))`);
    values.push(Array.from(rmOrgs),diaryOrgs,ctx.authUser.userId);

    if (params.mine) {
      conditions.push(`wi.assignee_user_id = $${idx++}`);
      values.push(ctx.authUser.userId);
      conditions.push(`wi.status IN ('ASSIGNED', 'IN_PROGRESS', 'SUBMITTED')`);
      // Exact single owner role AND exact branch. A remaining ROP grant
      // must not expose a formerly assigned RF task in the personal view.
      const scopes: string[] = [];
      for (const [org, roles] of operationalRoles) {
        for (const role of roles) {
          if (params.role && params.role !== role) continue;
          scopes.push(`(wi.org_unit_id = $${idx++} AND
            EXISTS (SELECT 1 FROM jsonb_each_text(t.field_ownership_rules)) AND
            NOT EXISTS (SELECT 1 FROM jsonb_each_text(t.field_ownership_rules) o WHERE o.value <> $${idx++}))`);
          values.push(org, role);
        }
      }
      conditions.push(scopes.length ? `(${scopes.join(' OR ')})` : 'FALSE');
    }
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
      SELECT wi.* FROM work_items wi JOIN templates t ON t.id = wi.template_version_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY wi.created_at ASC, wi.id ASC
      LIMIT $${idx}
    `;
    const res = await client.query(sql, values);
    const items = [];
    // Templates are immutable once created, so caching by id across this
    // page's rows is safe and avoids one lookup per row for list views
    // that repeat the same (today, only) template many times over.
    const templateCache = new Map<string, TemplateRow>();
    for (const row of res.rows) {
      let template = templateCache.get(row.template_version_id);
      if (!template) {
        const found = await getTemplateById(client, row.template_version_id);
        if (!found) throw new ApiError('NOT_FOUND', 'Объект не найден.');
        template = found;
        templateCache.set(row.template_version_id, template);
      }
      const fields = await getFields(client, row.id);
      const submission = await getCurrentSubmission(client, row);
      items.push(serializeWorkItem(row, template, fields, submission));
    }
    // Ярлыки у задачи в списке (решение владельца 26.09.2026): отклонение по
    // показателю, МБО, запрос в УК, поручение — как ярлык «MBO» старого портала.
    const ids = res.rows.map((r: any) => r.id);
    if (ids.length) {
      const dev = new Map((await client.query(`SELECT work_item_id, metric, rag FROM metric_deviation_tasks WHERE work_item_id = ANY($1::uuid[])`, [ids])).rows.map((r: any) => [r.work_item_id, r]));
      const mbo = new Set((await client.query(`SELECT work_item_id FROM mbo_card_task_links WHERE work_item_id = ANY($1::uuid[])`, [ids])).rows.map((r: any) => r.work_item_id));
      for (let i = 0; i < items.length; i++) {
        const row: any = res.rows[i];
        const d: any = dev.get(row.id);
        (items[i] as any).labels = {
          deviation: d ? { metric: d.metric, rag: d.rag } : null,
          mbo: mbo.has(row.id),
          uk_request: row.source_ref?.kind === 'UK_REQUEST',
          uk_task: row.source_ref?.kind === 'UK_TASK' ? { scope: row.source_ref?.scope_name ?? null } : null,
          delegated: !!row.source_ref && !['UK_REQUEST', 'UK_TASK'].includes(row.source_ref?.kind),
          created_by_me: row.created_by === ctx.authUser.userId && row.assignee_user_id !== ctx.authUser.userId,
        };
      }
    }
    const nextCursor =
      res.rows.length === params.limit
        ? encodeCursor(res.rows[res.rows.length - 1].created_at, res.rows[res.rows.length - 1].id, ctx.authUser.userId, cursorFilterKey)
        : null;
    const clock = await client.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') AS day");
    return { items, next_cursor: nextCursor, current_business_date: clock.rows[0].day };
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

    // Candidate pool is scoped to the template's declared owner role
    // (§ generalization 2026-09-18), not a hardcoded 'RF' literal, so the
    // picker offers the right people once a template targets ROP/ROO/etc.
    const template = await getTemplateById(client, row.template_version_id);
    if (!template) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    const ownerRole = deriveTemplateOwnerRole(template);

    const res = await client.query(
      `SELECT u.id, u.full_name, u.login
       FROM app_users u
       JOIN role_grants rg ON rg.user_id = u.id
       WHERE u.is_active
         AND NOT u.password_last_shared_indicator
         AND rg.role_code = $2
         AND rg.org_unit_id = $1
         AND rg.revoked_at IS NULL
         AND rg.valid_from <= now()
         AND (rg.valid_until IS NULL OR rg.valid_until > now())
       ORDER BY u.full_name`,
      [row.org_unit_id, ownerRole],
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
    const operationalRoles = await currentOperationalRolesByOrg(client, ctx.authUser.userId);
    // Автор поручения обязан видеть поставленную задачу: иначе он не может её
    // принять, а приёмка автором введена 21.09.2026.
    const diaryOrgs = await diaryReadOrgIds(client, ctx.authUser.userId);
    const isDiary = !!(await dailyMetadata(client,row.id));
    const ukMine = row.source_ref?.kind === 'UK_TASK' &&
      (row.assignee_user_id === ctx.authUser.userId || row.created_by === ctx.authUser.userId);
    const visible = ukMine ||
      rmOrgs.has(row.org_unit_id) ||
      (isDiary && diaryOrgs.has(row.org_unit_id)) ||
      (operationalRoles.has(row.org_unit_id) && row.assignee_user_id === ctx.authUser.userId) ||
      (operationalRoles.has(row.org_unit_id) && row.created_by === ctx.authUser.userId);
    if (!visible) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    const daily=await dailyMetadata(client,row.id);
    if(daily&&!rmOrgs.has(row.org_unit_id)&&!diaryOrgs.has(row.org_unit_id)&&!operationalRoles.get(row.org_unit_id)?.has(daily.role_code))
      throw new ApiError('NOT_FOUND','Объект не найден.');
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
  validateTitle(body.title);
  const dueAt = validateUtcTimestamp(body.due_at, 'due_at');

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'createWorkItem', idemKey, null, body, async () => {
      // Template lookup is now data-driven (§13.13.1) instead of a hardcoded
      // string compare, but templates are append-only/immutable so, like the
      // grants re-read below, doing it here right before the mutating INSERT
      // carries no staleness risk -- it can never have changed mid-request.
      if (typeof body.template_code !== 'string') {
        throw new ApiError('VALIDATION_ERROR', 'Неизвестный шаблон.', { issues: [{ path: 'template_code', issue: 'required' }] });
      }
      if(body.template_code.startsWith('personal_daily_')) throw new ApiError('VALIDATION_ERROR','Откройте ежедневник через выбор роли и даты.');
      const template = await getTemplateByCode(client, body.template_code);
      if (!template) {
        throw new ApiError('VALIDATION_ERROR', 'Неизвестный шаблон.', { issues: [{ path: 'template_code', issue: 'unknown template_code' }] });
      }
      // Multi-field templates are supported: submitWorkItem already locks
      // and validates every field row together (not just one hardcoded
      // field), and field_values is the per-field snapshot migration 007
      // added for exactly this. The only remaining single-field assumption
      // is submissions.completion_summary itself, which falls back to the
      // first field in field_schema order when no field is literally named
      // 'completion_summary' -- a legacy display column, not a correctness
      // gate, since every field is still independently required at submit.
      if (template.field_schema.length === 0) {
        throw new ApiError('VALIDATION_ERROR', 'Шаблон не содержит полей.', {
          issues: [{ path: 'template_code', issue: 'template has no fields' }],
        });
      }

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

      // Use the same admission predicate as migration 010's DB trigger.
      // Authorization comes first, so this does not disclose hidden branches.
      // PRE_LAUNCH editor records never become operational just by existing.
      const admission = await client.query('SELECT org_accepts_new_work($1) AS allowed', [body.org_unit_id]);
      if (!admission.rows[0].allowed) {
        throw new ApiError('VALIDATION_ERROR', 'Филиал пока не принимает новые задачи.', {
          issues: [{ path: 'org_unit_id', issue: 'ORG_UNIT_NOT_OPERATIONAL' }],
        });
      }

      const inserted = await client.query(
        `INSERT INTO work_items (org_unit_id, template_version_id, title, due_at, created_by)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [body.org_unit_id, template.id, body.title, dueAt, ctx.authUser.userId],
      );
      const workItem = inserted.rows[0];
      // Одной вставкой: у шаблонов ежедневника десятки полей, и цикл давал по
      // обращению к базе на каждое поле при создании задачи.
      await client.query(
        `INSERT INTO work_item_fields (work_item_id, org_unit_id, field_path, updated_by)
         SELECT $1, $2, path, $3 FROM unnest($4::text[]) path`,
        [workItem.id, workItem.org_unit_id, ctx.authUser.userId,
          template.field_schema.map((f) => f.field_path)],
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
      // Candidate must hold the role the TEMPLATE names as field owner
      // (generalization 2026-09-18), not a hardcoded RF check -- so
      // assigning a ROP/ROO/etc.-owned template only accepts an active
      // grantee of that same role.
      const templateForAssign = await getTemplateById(client, workItem.template_version_id);
      if (!templateForAssign) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      const assignOwnerRole = deriveTemplateOwnerRole(templateForAssign);
      const eligible = await isActiveRoleWithGrant(client, assigneeId, workItem.org_unit_id, assignOwnerRole);
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
      // Re-read grants AFTER the row lock so a concurrently revoked grant is
      // still caught. Generalized 2026-09-18: the actor must hold the exact
      // role the TEMPLATE names as field owner (not a hardcoded RF check),
      // so a ROP/ROO/etc.-owned template's own assignee can start it too.
      const startTemplate = await getTemplateById(client, workItem.template_version_id);
      if (!startTemplate) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      const startOwnerRole = deriveTemplateOwnerRole(startTemplate);
      const startRolesHeld = await executorRoles(client, ctx.authUser.userId, workItem.org_unit_id, workItem);
      const isOwnExecutor = startRolesHeld.has(startOwnerRole) && workItem.assignee_user_id === ctx.authUser.userId;
      if (!isOwnExecutor) throw new ApiError('FORBIDDEN', 'Действие не разрешено.');
      await assertDailyWindow(client,workItemId);
      await liveFence(client,ctx);

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
        actorRole: startOwnerRole,
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
  // Batching >1 change per call is deferred until createWorkItem accepts
  // multi-field templates (migration 007 header) -- keeping this at
  // exactly one change avoids a half-applied multi-field patch contract.
  const change = body.changes[0];
  if (typeof change.field_path !== 'string') {
    throw new ApiError('VALIDATION_ERROR', 'Неизвестное поле.', { issues: [{ path: 'changes[0].field_path', issue: 'required' }] });
  }
  const fieldPath = change.field_path;
  const expectedFieldVersion = requireVersion(change.expected_version);
  const rawNewValue = change.new_value;

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'patchWorkItemFields', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked grant is
      // still caught. Loose gate first (any operational role in this org +
      // is the assignee) -- same "still an active branch employee" freshness
      // check the RF-only code used to do; the field-specific role match
      // happens below once the field's declared owner role is known.
      const rolesHeld = await executorRoles(client, ctx.authUser.userId, workItem.org_unit_id, workItem);
      const isOwnExecutor = rolesHeld.size > 0 && workItem.assignee_user_id === ctx.authUser.userId;
      if (!isOwnExecutor) throw new ApiError('FORBIDDEN_FIELD', 'Действие с полем не разрешено.');

      if (!['ASSIGNED', 'IN_PROGRESS'].includes(workItem.status)) {
        throw new ApiError('INVALID_TRANSITION', 'Переход из текущего состояния запрещён.', { current_status: workItem.status as any });
      }

      // Field def + ownership are read from the template (§13.13.1) instead
      // of a hardcoded 'completion_summary' compare, so an unknown field_path
      // or one this template does not grant the actor's held role write
      // access to is rejected the same way regardless of which template the
      // work item uses or which role owns its fields (generalized 2026-09-18:
      // was a hardcoded !== 'RF' compare).
      const template = await getTemplateById(client, workItem.template_version_id);
      if (!template) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      const fieldDef = findFieldDef(template, fieldPath);
      if (!fieldDef) {
        throw new ApiError('VALIDATION_ERROR', 'Неизвестное поле.', { issues: [{ path: 'changes[0].field_path', issue: 'unknown field_path for this template' }] });
      }
      const fieldOwnerRole = template.field_ownership_rules[fieldPath];
      if (!fieldOwnerRole || !rolesHeld.has(fieldOwnerRole)) {
        throw new ApiError('FORBIDDEN_FIELD', 'Действие с полем не разрешено.');
      }
      await assertDailyWindow(client,workItemId);
      // «Закрыть день» в 11 утра портал запрещает: по часам он точно знает, что
      // день не кончился. Позднее заполнение, наоборот, не запрещается — оно
      // помечается, потому что время заполнения поля не равно времени события.
      const dailyRecord=(await client.query(
        'SELECT business_date::text FROM daily_log_records WHERE work_item_id=$1',[workItemId])).rows[0];
      if(dailyRecord)
        await assertSectionNotTooEarly(client,(fieldDef as any).section_num??null,dailyRecord.business_date);
      await liveFence(client,ctx);
      const newValue = validateFieldValue(fieldDef, rawNewValue, 'changes[0].new_value');

      const field = await lockFieldByPath(client, workItemId, fieldPath);
      if (!field) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      if (field.field_version !== expectedFieldVersion) {
        // Field CAS reject -> FIELD_PATCH_REJECTED security/audit event (§4).
        await writeAuditAndOutbox(client, {
          actorUserId: ctx.authUser.userId,
          actorRole: fieldOwnerRole,
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
              field_path: fieldPath,
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
         WHERE work_item_id = $3 AND field_path = $4`,
        [newValue, ctx.authUser.userId, workItemId, fieldPath],
      );
      const updatedWi = await client.query(
        `UPDATE work_items SET entity_version = entity_version + 1, updated_at = now() WHERE id = $1 RETURNING *`,
        [workItemId],
      );
      const newRow = updatedWi.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: fieldOwnerRole,
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'FIELDS_PATCH',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { field_path: fieldPath, field_version: field.field_version, value: previousValue },
        afterState: { field_path: fieldPath, field_version: field.field_version + 1, value: newValue },
        resolution: 'APPLIED',
        retentionClass: 'WORK_ITEM_STANDARD',
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        eventType: 'work_item.fields_patched',
        payload: { work_item_id: workItemId, field_path: fieldPath },
      });

      const card = await loadCard(client, newRow);
      return { status: 200, body: card };
    });
  });
}

// ---------- submitWorkItem ----------
export async function submitWorkItem(ctx: ActorContext, workItemId: string, idemKey: string, body: { expected_entity_version: unknown; add_to_daily_log?:unknown; business_date?:unknown }) {
  requireIdempotencyKey(idemKey);
  const expectedVersion = requireVersion(body.expected_entity_version);
  if(body.add_to_daily_log!==undefined&&typeof body.add_to_daily_log!=='boolean')
    throw new ApiError('VALIDATION_ERROR','add_to_daily_log должен быть логическим значением.');
  const linkedDate=body.add_to_daily_log?dailyDate(body.business_date):null;

  return withTransaction(async (client) => {
    return withIdempotency(client, ctx.authUser.userId, 'submitWorkItem', idemKey, workItemId, body, async () => {
      const workItem = await lockWorkItem(client, workItemId);
      if (!workItem) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      // Re-read grants AFTER the row lock so a concurrently revoked grant is
      // still caught. Generalized 2026-09-18: the actor must hold the exact
      // role the TEMPLATE names as field owner (not a hardcoded RF check).
      const submitTemplate = await getTemplateById(client, workItem.template_version_id);
      if (!submitTemplate) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      const submitOwnerRole = deriveTemplateOwnerRole(submitTemplate);
      const submitRolesHeld = await executorRoles(client, ctx.authUser.userId, workItem.org_unit_id, workItem);
      const isOwnExecutorSubmit = submitRolesHeld.has(submitOwnerRole) && workItem.assignee_user_id === ctx.authUser.userId;
      if (!isOwnExecutorSubmit) throw new ApiError('FORBIDDEN', 'Действие не разрешено.');
      await liveFence(client,ctx);
      const daily=await assertDailyWindow(client,workItemId);
      if(daily&&linkedDate) throw new ApiError('VALIDATION_ERROR','Ежедневник нельзя вложить в другой ежедневник.');

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
      // Жёсткий запрет (решение владельца 26.09.2026): день не сдаётся, пока не
      // сданы обязательные задачи от руководителя — со сроком на этот день и
      // просроченные. Касается ежедневников и личных записей дня.
      const dayOf:string|undefined=daily?.business_date??(await client.query(
        `SELECT business_date::text d FROM personal_day_notes WHERE work_item_id=$1`,[workItemId])).rows[0]?.d;
      if(dayOf&&workItem.assignee_user_id){
        const open=(await assignedTasksForDay(client,workItem.org_unit_id,workItem.assignee_user_id,dayOf))
          .filter((t:any)=>t.mandatory&&['ASSIGNED','IN_PROGRESS'].includes(t.status));
        if(open.length) throw new ApiError('VALIDATION_ERROR',
          `Нельзя сдать день: не сданы обязательные задачи от руководителя (${open.length}): `
          +open.slice(0,5).map((t:any)=>`«${t.title}»`).join(', ')+(open.length>5?' и другие':'')
          +'. Сдайте по ним результат — если выполнить не удалось, опишите причину.',
          {issues:open.map((t:any)=>({path:'assigned_tasks',issue:'mandatory_open',work_item_id:t.id}))});
      }
      // Every field on this work item is locked and validated together at
      // submit time (not just one hardcoded field) so a future multi-field
      // template cannot be submitted with some fields silently unfilled.
      // Today templates only ever define one field, so this is exactly one
      // row -- but the loop, not the field count, is what makes the check
      // real for later phases.
      const fields = await lockAllFields(client, workItemId);
      // Обязательность берётся из шаблона (исправление 26.09.2026). Раньше
      // требовалось заполнить ВСЕ поля, и ежедневник РФ из 95 полей нельзя было
      // сдать, пока пусты необязательные задачи, скрытые поля или разделы с
      // отметкой «Не выполнено». Теперь: поля с required=true, а у ежедневника —
      // ещё отметка выполнения каждой обязательной задачи дня. Шаблон без явных
      // признаков required проверяется по-старому — все поля.
      const schema: any[] = (await client.query(`SELECT field_schema FROM templates WHERE id=$1`,
        [workItem.template_version_id])).rows[0]?.field_schema ?? [];
      const explicit = schema.some(d => typeof d.required === 'boolean');
      const mustFill = explicit
        ? new Set(schema.filter(d => d.required === true
            || (daily && /_done$/.test(d.field_path) && !d.optional)).map(d => d.field_path as string))
        : null;
      const empty = fields.filter((f: any) => (!mustFill || mustFill.has(f.field_path)) && (!f.value || !/\S/.test(f.value)));
      if (empty.length) {
        const label = (p: string) => {
          const d = schema.find(x => x.field_path === p);
          if (!d) return p;
          return /_done$/.test(p) && d.section_num != null ? `задача ${d.section_num} — отметка выполнения` : d.label ?? p;
        };
        throw new ApiError('COMPLETION_REQUIRED', 'Нельзя сдать: не заполнено — '
          + empty.slice(0, 6).map((f: any) => `«${label(f.field_path)}»`).join(', ')
          + (empty.length > 6 ? ` и ещё ${empty.length - 6}` : '') + '.',
          { issues: empty.map((f: any) => ({ path: f.field_path, issue: 'required' })) } as any);
      }
      const fieldValues: Record<string, string> = {};
      for (const f of fields) fieldValues[f.field_path] = f.value;
      // completion_summary stays the source of truth for this release's
      // single-field templates (contract column, read by every existing
      // reviewer/report query); field_values is the forward-compatible
      // snapshot migration 007 added alongside it, not a replacement yet.
      const primaryField = fields.find((f) => f.field_path === 'completion_summary') ?? fields[0];

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
             field_values, entity_version, template_version_id, due_at, submitted_by, submission_marker)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [
          workItemId,
          workItem.org_unit_id,
          nextRevision,
          primaryField.value,
          primaryField.field_version,
          JSON.stringify(fieldValues),
          nextEntityVersion,
          workItem.template_version_id,
          workItem.due_at,
          ctx.authUser.userId,
          marker,
        ],
      );
      const submission = submissionRes.rows[0];
      if(daily) {
        await client.query(`INSERT INTO daily_submission_markers(submission_id,marker)
          SELECT $1,CASE WHEN submitted_at<$2 THEN 'EARLY' WHEN submitted_at>$3 THEN 'LATE' ELSE 'ON_TIME' END
          FROM submissions WHERE id=$1`,[submission.id,daily.base_open,daily.base_close]);
        await client.query(`INSERT INTO daily_submission_links(daily_submission_id,task_submission_id)
          SELECT $1,submission_id FROM daily_log_links WHERE daily_log_id=$2`,[submission.id,workItemId]);
      }
      if(linkedDate) {
        const dailyId=await ensureDailyLog(client,ctx,workItem.org_unit_id,submitOwnerRole,linkedDate);
        await assertDailyWindow(client,dailyId);
        const dailyState=await client.query('SELECT status FROM work_items WHERE id=$1 FOR UPDATE',[dailyId]);
        if(!['ASSIGNED','IN_PROGRESS'].includes(dailyState.rows[0].status))
          throw new ApiError('INVALID_TRANSITION','Ежедневник уже отправлен или закрыт. Верните его на доработку либо снимите добавление в ежедневник.');
        await client.query('INSERT INTO daily_log_links(daily_log_id,submission_id) VALUES($1,$2)',[dailyId,submission.id]);
        const journal=await client.query('UPDATE work_items SET entity_version=entity_version+1,updated_at=now() WHERE id=$1 RETURNING entity_version',[dailyId]);
        await writeAuditAndOutbox(client,{actorUserId:ctx.authUser.userId,actorRole:submitOwnerRole,orgUnitId:workItem.org_unit_id,
          workItemId:dailyId,action:'DAILY_RESULT_LINKED',aggregateType:'work_item',aggregateId:dailyId,
          aggregateVersion:journal.rows[0].entity_version,requestId:ctx.requestId,beforeState:null,
          afterState:{task_id:workItemId,submission_id:submission.id,business_date:linkedDate},
          resolution:'APPLIED',retentionClass:'WORK_ITEM_STANDARD'});
      }

      const updatedWi = await client.query(
        `UPDATE work_items SET status = 'SUBMITTED', entity_version = entity_version + 1,
                submission_revision = $1, current_submission_id = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [nextRevision, submission.id, workItemId],
      );
      const newRow = updatedWi.rows[0];

      await writeAuditAndOutbox(client, {
        actorUserId: ctx.authUser.userId,
        actorRole: submitOwnerRole,
        orgUnitId: workItem.org_unit_id,
        workItemId,
        action: 'SUBMIT',
        aggregateType: 'work_item',
        aggregateId: workItemId,
        aggregateVersion: newRow.entity_version,
        requestId: ctx.requestId,
        beforeState: { status: workItem.status },
        afterState: { status: 'SUBMITTED', submission_id: submission.id, revision: nextRevision, daily_business_date:linkedDate },
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
  // Принимает либо региональный менеджер филиала, либо тот, кто задачу поставил
  // (решение владельца 21.09.2026): выполненная задача обязана вернуться на
  // проверку автору поручения, иначе поручение остаётся без приёмки.
  if (!rmOrgs.has(workItem.org_unit_id) && workItem.created_by !== actorUserId)
    throw new ApiError('NOT_FOUND', 'Объект не найден.');
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
        // Кем принято: региональным менеджером филиала или автором поручения.
        // Столбец actor_role оставляем прежним, различие фиксируем в состоянии,
        // чтобы в истории было видно основание приёмки.
        afterState: { status: 'COMPLETED',
          accepted_as: rmOrgs.has(workItem.org_unit_id) ? 'REGIONAL_MANAGER' : 'TASK_AUTHOR' },
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
      // Generalized 2026-09-18: the previous assignee must still hold the
      // role the TEMPLATE names as field owner (not a hardcoded RF check).
      const reopenTemplate = await getTemplateById(client, workItem.template_version_id);
      if (!reopenTemplate) throw new ApiError('NOT_FOUND', 'Объект не найден.');
      const reopenOwnerRole = deriveTemplateOwnerRole(reopenTemplate);
      if (
        !workItem.assignee_user_id ||
        !(await isActiveRoleWithGrant(client, workItem.assignee_user_id, workItem.org_unit_id, reopenOwnerRole))
      ) {
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
    const operationalRoles = await currentOperationalRolesByOrg(client, ctx.authUser.userId);
    const daily=await dailyMetadata(client,row.id);
    const diaryOrgs = await diaryReadOrgIds(client, ctx.authUser.userId);
    const visible =
      (row.source_ref?.kind === 'UK_TASK' &&
        (row.assignee_user_id === ctx.authUser.userId || row.created_by === ctx.authUser.userId)) ||
      rmOrgs.has(row.org_unit_id) ||
      (!!daily && diaryOrgs.has(row.org_unit_id)) ||
      (operationalRoles.has(row.org_unit_id) && row.assignee_user_id === ctx.authUser.userId);
    if (!visible) throw new ApiError('NOT_FOUND', 'Объект не найден.');
    if(daily&&!rmOrgs.has(row.org_unit_id)&&!diaryOrgs.has(row.org_unit_id)&&!operationalRoles.get(row.org_unit_id)?.has(daily.role_code))
      throw new ApiError('NOT_FOUND','Объект не найден.');

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
      // patchWorkItemFields now stores field_path in the audit before/after
      // state itself, so this reads back whichever field actually changed
      // instead of assuming completion_summary.
      field_path: after?.field_path ?? before?.field_path ?? 'completion_summary',
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
    const operationalRoles = await currentOperationalRolesByOrg(client, ctx.authUser.userId);
    const grantedOrgs = new Set([...rmOrgs, ...operationalRoles.keys()]);

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
    const operationalRoles = await currentOperationalRolesByOrg(client, ctx.authUser.userId);
    const grantedOrgs = new Set([...rmOrgs, ...operationalRoles.keys()]);

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
