import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import type { ActorContext } from './workItemService';
import { getEffectiveGrants } from './grants';
import { getTemplateByCode } from './workItemRepo';
import { writeAuditAndOutbox } from './auditOutbox';
import { dailyDate, liveFence } from './dailyLogs';

/**
 * Личная запись дня линейного сотрудника (миграция 048).
 *
 * Это не ежедневник. Ежедневник РФ, РОП и РОО — жёсткий контур: 28 обязательных
 * задач, окно заполнения по филиалу и роли, отметки «вовремя / с опозданием».
 * Здесь всего три свободных поля, окна нет, опоздать нельзя, на балл филиала
 * запись не влияет и источником показателей не является.
 *
 * Сотрудник заводит её себе сам: никто её не назначает и не принимает по
 * умолчанию. Видит её он сам и региональный менеджер филиала — то же правило
 * видимости, что у любой задачи.
 */
const LINE_ROLES = ['MOP', 'EO', 'KSO_STAFF', 'SMOP', 'SMOO'];

export function lineRole(raw: unknown): string {
  if (typeof raw !== 'string' || !LINE_ROLES.includes(raw)) {
    throw new ApiError('VALIDATION_ERROR',
      'Личная запись дня доступна линейным должностям: МОП, ЭО, сотрудник КСО, СМОП, СЭО.');
  }
  return raw;
}

/** Право на личную запись — действующее право этой роли на этом филиале. */
async function authorize(c: PoolClient, ctx: ActorContext, org: string, role: string) {
  const grants = await getEffectiveGrants(c, ctx.authUser.userId);
  if (!grants.some(g => g.orgUnitId === org && g.role === role)) {
    throw new ApiError('NOT_FOUND', 'Запись или филиал недоступны.');
  }
}

/**
 * Открыть запись за день, создав её при первом обращении. Уникальный
 * естественный ключ и advisory-lock делают повторный вызов безопасным при
 * повторной отправке формы и при работе с двух устройств.
 */
export async function ensurePersonalNote(
  c: PoolClient, ctx: ActorContext, org: string, role: string, date: string,
) {
  lineRole(role); dailyDate(date); await authorize(c, ctx, org, role);
  await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [`note:${org}:${ctx.authUser.userId}:${role}:${date}`]);
  const existing = (await c.query(
    `SELECT work_item_id FROM personal_day_notes
      WHERE org_unit_id=$1 AND user_id=$2 AND role_code=$3 AND business_date=$4`,
    [org, ctx.authUser.userId, role, date])).rows[0];
  if (existing) return existing.work_item_id as string;

  if (!(await c.query('SELECT org_accepts_new_work($1) allowed', [org])).rows[0].allowed) {
    throw new ApiError('VALIDATION_ERROR', 'Филиал пока не принимает новые записи.');
  }
  // Дата записи не может быть будущей: запись о работе дня, которого не было,
  // смысла не имеет. Прошлые дни открыты — окна заполнения здесь нет намеренно.
  const today = (await c.query(
    "SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
  if (date > today) throw new ApiError('VALIDATION_ERROR', 'Дата записи не может быть будущей.');

  const template = await getTemplateByCode(c, `personal_note_${role.toLowerCase()}_v1`);
  if (!template) throw new ApiError('TEMPORARILY_UNAVAILABLE', 'Шаблон личной записи не установлен.');
  const due = (await c.query(
    `SELECT ($1::date + time '23:59') AT TIME ZONE 'Europe/Moscow' AS due`, [date])).rows[0].due;
  const created = await c.query(
    `INSERT INTO work_items(org_unit_id,template_version_id,title,due_at,status,assignee_user_id,created_by)
     VALUES($1,$2,$3,$4,'ASSIGNED',$5,$5) RETURNING id`,
    [org, template.id, `Личная запись дня · ${date}`, due, ctx.authUser.userId]);
  const id = created.rows[0].id as string;
  await c.query(
    `INSERT INTO work_item_fields(work_item_id,org_unit_id,field_path,updated_by)
     SELECT $1,$2,path,$3 FROM unnest($4::text[]) path`,
    [id, org, ctx.authUser.userId, template.field_schema.map(f => f.field_path)]);
  await c.query(
    `INSERT INTO personal_day_notes(work_item_id,org_unit_id,user_id,role_code,business_date)
     VALUES($1,$2,$3,$4,$5)`, [id, org, ctx.authUser.userId, role, date]);
  await writeAuditAndOutbox(c, {
    actorUserId: ctx.authUser.userId, actorRole: role, orgUnitId: org, workItemId: id,
    action: 'CREATE', aggregateType: 'work_item', aggregateId: id, aggregateVersion: 1,
    requestId: ctx.requestId, beforeState: null,
    afterState: { status: 'ASSIGNED', business_date: date, role, kind: 'PERSONAL_DAY_NOTE' },
    resolution: 'APPLIED', retentionClass: 'WORK_ITEM_STANDARD',
    eventType: 'work_item.created', payload: { work_item_id: id },
  });
  return id;
}

export async function openPersonalNote(ctx: ActorContext, body: any) {
  const role = lineRole(body?.role), date = dailyDate(body?.business_date);
  return withTransaction(async c => {
    await liveFence(c, ctx);
    return { id: await ensurePersonalNote(c, ctx, body.org_unit_id, role, date) };
  });
}

/**
 * Личный день сотрудника: его запись за дату и поручения, которые ему выдали.
 * Показатели филиала сюда не попадают — линейная должность их не видит.
 */
export async function getPersonalNoteDay(ctx: ActorContext, org: string, roleRaw: unknown, dateRaw: unknown) {
  const role = lineRole(roleRaw), date = dailyDate(dateRaw);
  return withTransaction(async c => {
    await liveFence(c, ctx); await authorize(c, ctx, org, role);
    const record = (await c.query(
      `SELECT n.work_item_id,w.status,w.entity_version,w.current_submission_id
         FROM personal_day_notes n JOIN work_items w ON w.id=n.work_item_id
        WHERE n.org_unit_id=$1 AND n.user_id=$2 AND n.role_code=$3 AND n.business_date=$4`,
      [org, ctx.authUser.userId, role, date])).rows[0] ?? null;
    const tasks = (await c.query(
      `SELECT w.id,w.title,w.status,w.entity_version,
              to_char(w.due_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD HH24:MI') due_at_local,
              (w.due_at IS NOT NULL AND (w.due_at AT TIME ZONE 'Europe/Moscow')::date<=$3::date) AS mandatory,
              author.full_name AS created_by_name
         FROM work_items w
         JOIN templates t ON t.id=w.template_version_id
         LEFT JOIN app_users author ON author.id=w.created_by
        WHERE w.org_unit_id=$1 AND w.assignee_user_id=$2
          AND t.code NOT LIKE 'personal_note_%' AND t.code NOT LIKE 'personal_daily_%'
          AND w.status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED')
        ORDER BY mandatory DESC,w.due_at NULLS LAST,w.created_at`,
      [org, ctx.authUser.userId, date])).rows;
    const current = (await c.query(
      "SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
    return {
      business_date: date, current_business_date: current, role,
      record, assigned_tasks: tasks,
      // Явно: окна заполнения нет, отметок опоздания нет, на балл не влияет.
      fill_window: null, affects_branch_score: false,
    };
  });
}
