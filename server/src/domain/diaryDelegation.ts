import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import type { ActorContext } from './workItemService';
import { liveFence } from './dailyLogs';
import { writeAuditAndOutbox } from './auditOutbox';

/**
 * Поручения из строки ежедневника.
 *
 * Решения владельца 26.09.2026. По конкретному автомобилю действие можно
 * поставить на будущий день — и в этот день у исполнителя возникает задача; или
 * передать машину РОП, РОО, стоку, кому-то ещё; каждую машину — разному человеку
 * или никому. По звонку руководитель филиала направляет свой вывод вместе с этим
 * звонком в задачи РОП. Всё это один механизм: строка ежедневника → поручение
 * конкретному человеку на конкретный день.
 *
 * Как задача «возникает в нужный день». Её срок — конец выбранного дня, а блок
 * «Задачи от руководителя» в ежедневнике исполнителя показывает задачи со сроком
 * на этот день или раньше. До наступления дня задача существует, но в
 * ежедневнике не мешает. Поручение себе на будущее работает так же.
 *
 * Кто ставит. Руководитель филиала, РОП и РОО — только из своего ежедневника и
 * только людям своего филиала. Региональный менеджер — из любого ежедневника своего
 * филиала. Шире область видимости это не делает: исполнитель выбирается из
 * действующих грантов филиала на дату постановки.
 *
 * Кто принимает. Автор поручения — это уже реализовано приёмкой 21.09. Своё
 * собственное исполнение принять нельзя, поэтому поручение себе принимает
 * региональный менеджер.
 */

const SETTER_ROLES = ['RF', 'ROP', 'ROO'];
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalid = (text: string) => new ApiError('VALIDATION_ERROR', text);

interface DiaryContext { id: string; org_unit_id: string; assignee_user_id: string | null; role_code: string; business_date: string }

export async function diaryFor(c: PoolClient, ctx: ActorContext, diaryId: string, forWrite: boolean): Promise<DiaryContext> {
  if (!uuid.test(diaryId)) throw new ApiError('NOT_FOUND', 'Ежедневник не найден.');
  const d = (await c.query(
    `SELECT w.id, w.org_unit_id, w.assignee_user_id, r.role_code, r.business_date::text business_date
       FROM work_items w JOIN daily_log_records r ON r.work_item_id = w.id
      WHERE w.id = $1`, [diaryId])).rows[0] as DiaryContext | undefined;
  if (!d) throw new ApiError('NOT_FOUND', 'Ежедневник не найден.');
  const roles = (await c.query(
    `SELECT role_code FROM role_grants
      WHERE user_id = $1 AND org_unit_id = $2 AND revoked_at IS NULL
        AND valid_from <= now() AND (valid_until IS NULL OR valid_until > now())`,
    [ctx.authUser.userId, d.org_unit_id])).rows.map(r => r.role_code as string);
  const isRm = roles.includes('REGIONAL_MANAGER');
  const isOwner = d.assignee_user_id === ctx.authUser.userId && roles.includes(d.role_code)
    && SETTER_ROLES.includes(d.role_code);
  // Не раскрываем существование чужого ежедневника: тот же ответ, что на
  // несуществующий.
  if (!isRm && !isOwner) throw new ApiError('NOT_FOUND', 'Ежедневник не найден.');
  if (forWrite && !isRm && !isOwner) throw new ApiError('FORBIDDEN', 'Ставить поручения из этого ежедневника нельзя.');
  return d;
}

/** Кому можно поручить: люди с действующими грантами ролей филиала. */
export async function delegationTargets(ctx: ActorContext, diaryId: string) {
  return withTransaction(async c => {
    const d = await diaryFor(c, ctx, diaryId, false);
    const rows = (await c.query(
      `SELECT u.id user_id, u.full_name, u.login, g.role_code, r.display_name role_name
         FROM role_grants g
         JOIN app_users u ON u.id = g.user_id AND u.is_active AND u.user_kind = 'INDIVIDUAL'
         JOIN roles r ON r.code = g.role_code
         JOIN templates t ON t.code = 'delegated_task_' || lower(g.role_code) || '_v1'
        WHERE g.org_unit_id = $1 AND g.revoked_at IS NULL
          AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
        ORDER BY r.display_name, u.full_name`, [d.org_unit_id])).rows;
    // Каталог ролей для выбора участников встречи: роли филиала и УК FRESH
    // берутся из справочника ролей, а не из кода.
    const roles = (await c.query(
      `SELECT code, display_name FROM roles
        WHERE code NOT IN ('SUPER_ADMIN','SHARED_LOGIN','ACTING_BH','ACTING_RF','LAUNCH_TEAM','TECHNICAL_COORDINATOR')
        ORDER BY display_name`)).rows;
    return { org_unit_id: d.org_unit_id, business_date: d.business_date, self_user_id: ctx.authUser.userId, targets: rows, roles };
  });
}

/** Поручения, поставленные из этого ежедневника, — для отметки у строк. */
export async function listDiaryDelegations(ctx: ActorContext, diaryId: string) {
  return withTransaction(async c => {
    await diaryFor(c, ctx, diaryId, false);
    return (await c.query(
      `SELECT w.id, w.title, w.status, w.brief, w.source_ref,
              to_char(w.due_at AT TIME ZONE 'Europe/Moscow', 'YYYY-MM-DD') due_date,
              u.full_name assignee_name, t.display_name template_name
         FROM work_items w
         JOIN templates t ON t.id = w.template_version_id
         LEFT JOIN app_users u ON u.id = w.assignee_user_id
        WHERE w.source_ref->>'diary_work_item_id' = $1
        ORDER BY w.created_at`, [diaryId])).rows;
  });
}

export async function createDiaryDelegation(ctx: ActorContext, diaryId: string, raw: any) {
  const b = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const allowed = ['assignee_user_id', 'role_code', 'due_date', 'title', 'brief', 'section_num', 'field_path', 'row_index', 'link', 'vin'];
  if (Object.keys(b).some(k => !allowed.includes(k))) throw invalid('Неизвестные поля поручения.');
  if (typeof b.assignee_user_id !== 'string' || !uuid.test(b.assignee_user_id)) throw invalid('Выберите исполнителя.');
  if (typeof b.role_code !== 'string' || !/^[A-Z_]{2,40}$/.test(b.role_code)) throw invalid('Выберите роль исполнителя.');
  if (typeof b.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(b.due_date)) throw invalid('Укажите день, на который ставится задача.');
  const title = typeof b.title === 'string' ? b.title.trim() : '';
  if (title.length < 3 || title.length > 200) throw invalid('Название задачи: от 3 до 200 символов.');
  const brief = typeof b.brief === 'string' && b.brief.trim() ? b.brief.trim() : null;
  if (brief && brief.length > 4000) throw invalid('Суть поручения: не длиннее 4000 символов.');
  const link = typeof b.link === 'string' && b.link.trim() ? b.link.trim() : null;
  if (link && (link.length > 2000 || !/^https?:\/\//i.test(link))) throw invalid('Ссылка должна начинаться с http:// или https://.');
  const vin = typeof b.vin === 'string' && /^[A-Z0-9-]{8,20}$/.test(b.vin) ? b.vin : null;
  const sectionNum = Number.isInteger(b.section_num) ? b.section_num : null;
  const rowIndex = Number.isInteger(b.row_index) && b.row_index >= 0 ? b.row_index : null;
  const fieldPath = typeof b.field_path === 'string' && /^[a-z0-9_]{1,80}$/.test(b.field_path) ? b.field_path : null;

  return withTransaction(async c => {
    await liveFence(c, ctx);
    const d = await diaryFor(c, ctx, diaryId, true);
    const today = (await c.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') d")).rows[0].d;
    if (b.due_date < today) throw invalid('Поручение нельзя поставить на прошедший день.');
    if (!(await c.query('SELECT org_accepts_new_work($1) ok', [d.org_unit_id])).rows[0].ok)
      throw invalid('Филиал пока не принимает новые задачи.');
    // Исполнитель проверяется по действующему гранту роли на этом филиале, а
    // не по списку, который видел браузер: грант мог быть отозван.
    const grant = (await c.query(
      `SELECT 1 FROM role_grants g JOIN app_users u ON u.id = g.user_id AND u.is_active
        WHERE g.user_id = $1 AND g.role_code = $2 AND g.org_unit_id = $3 AND g.revoked_at IS NULL
          AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())`,
      [b.assignee_user_id, b.role_code, d.org_unit_id])).rowCount;
    if (!grant) throw new ApiError('ASSIGNEE_INELIGIBLE', 'Этот сотрудник не работает в филиале в выбранной роли.');
    const template = (await c.query(
      `SELECT id, field_schema FROM templates WHERE code = $1 ORDER BY version DESC LIMIT 1`,
      ['delegated_task_' + b.role_code.toLowerCase() + '_v1'])).rows[0];
    if (!template) throw invalid('Для этой роли поручения пока не предусмотрены.');

    const sourceRef = { diary_work_item_id: diaryId, diary_role: d.role_code, diary_date: d.business_date,
      section_num: sectionNum, field_path: fieldPath, row_index: rowIndex, link, vin };
    const item = (await c.query(
      `INSERT INTO work_items (org_unit_id, template_version_id, title, due_at, created_by,
           status, assignee_user_id, parent_work_item_id, brief, source_ref)
       VALUES ($1, $2, $3, ($4::date + time '23:59') AT TIME ZONE 'Europe/Moscow', $5,
           'ASSIGNED', $6, $7, $8, $9) RETURNING id, entity_version`,
      [d.org_unit_id, template.id, title, b.due_date, ctx.authUser.userId,
        b.assignee_user_id, diaryId, brief, JSON.stringify(sourceRef)])).rows[0];
    await c.query(
      `INSERT INTO work_item_fields (work_item_id, org_unit_id, field_path, updated_by)
       SELECT $1, $2, f->>'field_path', $3 FROM jsonb_array_elements($4::jsonb) f`,
      [item.id, d.org_unit_id, ctx.authUser.userId, JSON.stringify(template.field_schema)]);
    await writeAuditAndOutbox(c, {
      actorUserId: ctx.authUser.userId, actorRole: d.role_code, orgUnitId: d.org_unit_id, workItemId: item.id,
      action: 'CREATE', aggregateType: 'work_item', aggregateId: item.id, aggregateVersion: item.entity_version,
      requestId: ctx.requestId, beforeState: null,
      afterState: { status: 'ASSIGNED', assignee_user_id: b.assignee_user_id, due_date: b.due_date, source: sourceRef },
      resolution: 'APPLIED', retentionClass: 'WORK_ITEM_STANDARD', ip: ctx.ip, userAgent: ctx.userAgent,
      eventType: 'work_item.assigned', payload: { work_item_id: item.id },
    });
    return { id: item.id, due_date: b.due_date };
  });
}
