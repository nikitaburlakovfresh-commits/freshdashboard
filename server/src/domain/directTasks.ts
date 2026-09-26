import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import type { ActorContext } from './workItemService';
import { liveFence } from './dailyLogs';
import { writeAuditAndOutbox } from './auditOutbox';

/**
 * Постановка задач сверху вниз и «Запрос в УК» (решение владельца 26.09.2026).
 *
 * Кто кому ставит — таблица task_assign_rules: РФ и собственник — всем ролям
 * филиала, РОП — СМОП и МОП, РОО — СЭО и ЭО, руководитель КСО — сотрудникам КСО.
 * Запрос в УК уходит региональному менеджеру филиала; отвечает он, принимает
 * автор. Задача одна — work_items, с обычным жизненным циклом и приёмкой.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (t: string) => new ApiError('VALIDATION_ERROR', t);

export async function assignOptions(ctx: ActorContext) {
  return withTransaction(async c => {
    const setters = (await c.query(
      `SELECT DISTINCT g.org_unit_id, g.role_code, n.display_name org_name
         FROM role_grants g
         JOIN task_assign_rules r ON r.setter_role=g.role_code AND r.revoked_at IS NULL
         JOIN org_directory_name_history n ON n.org_unit_id=g.org_unit_id AND n.effective_to IS NULL
        WHERE g.user_id=$1 AND g.org_unit_id IS NOT NULL AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
        ORDER BY n.display_name`, [ctx.authUser.userId])).rows;
    const scopes: any[] = [];
    for (const s of setters) {
      const rules = (await c.query(`SELECT target FROM task_assign_rules WHERE setter_role=$1 AND revoked_at IS NULL`,
        [s.role_code])).rows.map((r: any) => r.target as string);
      const people = (await c.query(
        `SELECT u.id user_id, u.full_name, g.role_code, ro.display_name role_name
           FROM role_grants g JOIN app_users u ON u.id=g.user_id AND u.is_active AND u.user_kind='INDIVIDUAL'
           JOIN roles ro ON ro.code=g.role_code
           JOIN templates t ON t.code='delegated_task_'||lower(g.role_code)||'_v1'
          WHERE g.org_unit_id=$1 AND g.role_code=ANY($2::text[]) AND g.user_id<>$3 AND g.revoked_at IS NULL
            AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
          ORDER BY ro.display_name, u.full_name`, [s.org_unit_id, rules, ctx.authUser.userId])).rows;
      const uk = rules.includes('UK_REQUEST') ? (await c.query(
        `SELECT u.id user_id, u.full_name FROM role_grants g
           JOIN app_users u ON u.id=g.user_id AND u.is_active
          WHERE g.org_unit_id=$1 AND g.role_code='REGIONAL_MANAGER' AND g.revoked_at IS NULL
            AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
          ORDER BY u.full_name`, [s.org_unit_id])).rows : [];
      const prev = scopes.find(x => x.org_unit_id === s.org_unit_id);
      if (prev) {
        for (const p of people) if (!prev.people.some((q: any) => q.user_id === p.user_id && q.role_code === p.role_code)) prev.people.push(p);
        if (!prev.uk_managers.length) prev.uk_managers = uk;
        prev.uk_request = prev.uk_request || rules.includes('UK_REQUEST');
      } else scopes.push({ org_unit_id: s.org_unit_id, org_name: s.org_name, setter_role: s.role_code,
        people, uk_request: rules.includes('UK_REQUEST'), uk_managers: uk });
    }
    return { scopes };
  });
}

export async function createDirectTask(ctx: ActorContext, raw: any) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowed = ['kind', 'org_unit_id', 'assignee_user_id', 'role_code', 'due_date', 'title', 'brief'];
  if (Object.keys(b).some(k => !allowed.includes(k))) throw invalid('Неизвестные поля задачи.');
  if (b.kind !== 'TASK' && b.kind !== 'UK_REQUEST') throw invalid('Выберите тип: задача сотруднику или запрос в УК.');
  if (typeof b.org_unit_id !== 'string' || !uuid.test(b.org_unit_id)) throw invalid('Выберите филиал.');
  if (typeof b.assignee_user_id !== 'string' || !uuid.test(b.assignee_user_id)) throw invalid('Выберите исполнителя.');
  if (typeof b.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) throw invalid('Укажите срок.');
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length < 3 || title.length > 200) throw invalid('Название: от 3 до 200 символов.');
  const brief = typeof b.brief === 'string' && b.brief.trim() ? b.brief.trim() : null;
  if (brief && brief.length > 4000) throw invalid('Суть: не длиннее 4000 символов.');
  return withTransaction(async c => {
    await liveFence(c, ctx);
    const today = (await c.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') d")).rows[0].d;
    if (b.due_date < today) throw invalid('Срок не может быть в прошлом.');
    const target = b.kind === 'UK_REQUEST' ? 'UK_REQUEST' : b.role_code;
    if (typeof target !== 'string' || !/^[A-Z_]{2,40}$/.test(target)) throw invalid('Выберите роль исполнителя.');
    // Право ставить — по действующему гранту постановщика и правилу, а не по
    // тому, что показал браузер.
    const setter = (await c.query(
      `SELECT g.role_code FROM role_grants g JOIN task_assign_rules r ON r.setter_role=g.role_code
         AND r.target=$3 AND r.revoked_at IS NULL
        WHERE g.user_id=$1 AND g.org_unit_id=$2 AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now()) LIMIT 1`,
      [ctx.authUser.userId, b.org_unit_id, target])).rows[0];
    if (!setter) throw new ApiError('FORBIDDEN', b.kind === 'UK_REQUEST'
      ? 'Запрос в УК из этой роли не предусмотрен.' : 'Ставить задачи этой роли вам не разрешено.');
    if (!(await c.query('SELECT org_accepts_new_work($1) ok', [b.org_unit_id])).rows[0].ok)
      throw invalid('Филиал пока не принимает новые задачи.');
    const assigneeRole = b.kind === 'UK_REQUEST' ? 'REGIONAL_MANAGER' : target;
    const ok = (await c.query(
      `SELECT 1 FROM role_grants g JOIN app_users u ON u.id=g.user_id AND u.is_active
        WHERE g.user_id=$1 AND g.role_code=$2 AND g.org_unit_id=$3 AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())`,
      [b.assignee_user_id, assigneeRole, b.org_unit_id])).rowCount;
    if (!ok) throw new ApiError('ASSIGNEE_INELIGIBLE', b.kind === 'UK_REQUEST'
      ? 'Этот сотрудник не является региональным менеджером филиала.' : 'Этот сотрудник не работает в филиале в выбранной роли.');
    const code = b.kind === 'UK_REQUEST' ? 'uk_request_v1' : 'delegated_task_' + target.toLowerCase() + '_v1';
    const template = (await c.query(`SELECT id, field_schema FROM templates WHERE code=$1 ORDER BY version DESC LIMIT 1`, [code])).rows[0];
    if (!template) throw invalid('Для этой роли задачи пока не предусмотрены.');
    const sourceRef = { kind: b.kind, setter_role: setter.role_code };
    const item = (await c.query(
      `INSERT INTO work_items (org_unit_id, template_version_id, title, due_at, created_by, status, assignee_user_id, brief, source_ref)
       VALUES ($1,$2,$3,($4::date + time '23:59') AT TIME ZONE 'Europe/Moscow',$5,'ASSIGNED',$6,$7,$8)
       RETURNING id, entity_version`,
      [b.org_unit_id, template.id, title, b.due_date, ctx.authUser.userId, b.assignee_user_id, brief, JSON.stringify(sourceRef)])).rows[0];
    await c.query(
      `INSERT INTO work_item_fields (work_item_id, org_unit_id, field_path, updated_by)
       SELECT $1,$2,f->>'field_path',$3 FROM jsonb_array_elements($4::jsonb) f`,
      [item.id, b.org_unit_id, ctx.authUser.userId, JSON.stringify(template.field_schema)]);
    await writeAuditAndOutbox(c, {
      actorUserId: ctx.authUser.userId, actorRole: setter.role_code, orgUnitId: b.org_unit_id, workItemId: item.id,
      action: 'CREATE', aggregateType: 'work_item', aggregateId: item.id, aggregateVersion: item.entity_version,
      requestId: ctx.requestId, beforeState: null,
      afterState: { status: 'ASSIGNED', assignee_user_id: b.assignee_user_id, due_date: b.due_date, source: sourceRef },
      resolution: 'APPLIED', retentionClass: 'WORK_ITEM_STANDARD', ip: ctx.ip, userAgent: ctx.userAgent,
      eventType: 'work_item.assigned', payload: { work_item_id: item.id },
    });
    return { id: item.id, due_date: b.due_date };
  });
}
