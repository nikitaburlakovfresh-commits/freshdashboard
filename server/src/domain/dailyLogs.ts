import type { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import type { ActorContext } from './workItemService';
import { getEffectiveGrants } from './grants';
import { getTemplateByCode } from './workItemRepo';
import { writeAuditAndOutbox } from './auditOutbox';

const ROLES = ['RF','ROP','ROO'];
export function dailyDate(raw: unknown): string {
  if(typeof raw!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(raw)||raw<'2000-01-01'||raw>'2100-12-31'||
    !Number.isFinite(Date.parse(raw))||new Date(raw).toISOString().slice(0,10)!==raw)
    throw new ApiError('VALIDATION_ERROR','Требуется существующая дата YYYY-MM-DD (2000–2100).');
  return raw;
}
export function dailyRole(raw: unknown): string {
  // Ежедневник существует для РФ, РОП и РОО. У линейных должностей его нет по
  // решению владельца: у них личная запись дня, и итог задачи в неё
  // автоматически не переносится — связка задача↔ежедневник к ней не относится.
  if(typeof raw!=='string'||!ROLES.includes(raw)) throw new ApiError('VALIDATION_ERROR',
    'Ежедневник ведут РФ, РОП и РОО. Для линейной должности снимите перенос итога в ежедневник: у неё личная запись дня.');
  return raw;
}
export async function liveFence(c:PoolClient,ctx:ActorContext) {
  await c.query('LOCK TABLE app_users, sessions, role_grants, roles, role_permissions IN SHARE MODE');
  const live=await c.query(`SELECT 1 FROM sessions s JOIN app_users u ON u.id=s.user_id
    WHERE s.id=$1 AND u.id=$2 AND u.is_active AND u.user_kind='INDIVIDUAL'
    AND NOT u.password_last_shared_indicator AND s.revoked_at IS NULL
    AND s.captured_auth_epoch=u.auth_epoch AND u.password_hash_updated_at<=s.created_at
    AND s.expires_at>now() AND s.created_at>now()-interval '8 hours'
    AND s.last_seen_at>now()-interval '30 minutes'`,[ctx.authUser.sessionId,ctx.authUser.userId]);
  if(!live.rowCount) throw new ApiError('SESSION_REVOKED','Сессия отозвана.');
}
async function authorize(c:PoolClient,ctx:ActorContext,org:string,role:string,manager=false) {
  const grants=await getEffectiveGrants(c,ctx.authUser.userId);
  if(!grants.some(g=>g.orgUnitId===org&&g.role===(manager?'REGIONAL_MANAGER':role)))
    throw new ApiError('NOT_FOUND','Ежедневник или филиал недоступен.');
}
export async function dailyMetadata(c:PoolClient,id:string) {
  const result=await c.query(`SELECT work_item_id,to_char(business_date,'YYYY-MM-DD') business_date,
    role_code,policy_id,base_open,base_close,window_open,window_close,
    now() BETWEEN window_open AND window_close AS can_fill
    FROM daily_log_records WHERE work_item_id=$1`,[id]);
  return result.rows[0]??null;
}
export async function assertDailyWindow(c:PoolClient,id:string) {
  const meta=await dailyMetadata(c,id);
  if(meta&&!meta.can_fill) throw new ApiError('VALIDATION_ERROR',
    `Окно заполнения ${meta.business_date} закрыто или ещё не открыто. Доступно: ${new Date(meta.window_open).toISOString()} — ${new Date(meta.window_close).toISOString()}.`,
    {issues:[{path:'business_date',issue:'outside_fill_window'}]});
  return meta;
}
async function policyFor(c:PoolClient,org:string,role:string,date:string) {
  const r=await c.query(`SELECT *,to_char(effective_from,'YYYY-MM-DD') effective_from FROM daily_log_policies
    WHERE org_unit_id=$1 AND role_code=$2 AND effective_from<=$3::date ORDER BY version DESC LIMIT 1`,[org,role,date]);
  return r.rows[0]??null;
}
export async function setDailyPolicy(ctx:ActorContext,org:string,body:any) {
  const role=dailyRole(body.role),date=dailyDate(body.effective_from);
  for(const key of ['base_open_time','base_close_time']) {
    if(typeof body[key]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body[key])) throw new ApiError('VALIDATION_ERROR','Время должно иметь формат ЧЧ:ММ.');
  }
  if(body.base_close_time<=body.base_open_time) throw new ApiError('VALIDATION_ERROR','Закрытие должно быть позже открытия в тот же день.');
  if(!Number.isInteger(body.early_open_hours)||body.early_open_hours<0||body.early_open_hours>24||
    !Number.isInteger(body.late_close_hours)||body.late_close_hours<0||body.late_close_hours>48||
    !Number.isInteger(body.expected_version)||body.expected_version<0||
    typeof body.reason!=='string'||body.reason.trim().length<5||body.reason.length>500)
    throw new ApiError('VALIDATION_ERROR','Проверьте часы окна, версию и обоснование (5–500 символов).');
  return withTransaction(async c=>{
    await liveFence(c,ctx); await authorize(c,ctx,org,role,true);
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`daily-policy:${org}:${role}`]);
    const previous=(await c.query(`SELECT * FROM daily_log_policies WHERE org_unit_id=$1 AND role_code=$2 ORDER BY version DESC LIMIT 1`,[org,role])).rows[0];
    const version=previous?.version??0;
    if(version!==body.expected_version) throw new ApiError('ENTITY_VERSION_CONFLICT','Политика уже изменена. Обновите карточку.');
    const today=(await c.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
    if(date<today) throw new ApiError('VALIDATION_ERROR','Новая политика не может вступать в силу задним числом.');
    const result=await c.query(`INSERT INTO daily_log_policies(org_unit_id,role_code,version,effective_from,base_open_time,base_close_time,early_open_hours,late_close_hours,reason,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,version`,
      [org,role,version+1,date,body.base_open_time,body.base_close_time,body.early_open_hours,body.late_close_hours,body.reason,ctx.authUser.userId]);
    await writeAuditAndOutbox(c,{actorUserId:ctx.authUser.userId,actorRole:'REGIONAL_MANAGER',orgUnitId:org,workItemId:null,
      action:'DAILY_POLICY_SET',aggregateType:'org_change',aggregateId:result.rows[0].id,aggregateVersion:version+1,
      requestId:ctx.requestId,beforeState:previous??null,afterState:{...body,version:version+1},reason:body.reason,
      resolution:'APPLIED',retentionClass:'WORK_ITEM_STANDARD'});
    return result.rows[0];
  });
}
/**
 * Одно и то же окно на все филиалы и роли сразу.
 *
 * Настраивать окна по одному — 39 филиалов на три роли, 117 форм: до пилота так
 * не дойти. Владелец решил, что окно одинаковое: открытие в начале суток,
 * закрытие в конце. Допуски «раньше» и «позже» при таком окне не нужны — сутки и
 * так целиком внутри, — поэтому здесь они нулевые.
 *
 * ВАЖНО: время пока московское. Часовые пояса филиалов не реализованы, и для
 * Владивостока «конец суток по МСК» наступает в 07:00 следующего местного дня.
 * Это осознанный временный компромисс до внедрения часовых поясов, а не
 * достигнутое требование.
 *
 * Уже настроенное окно с такими же временами не переписывается новой версией:
 * повторное нажатие кнопки не должно плодить версии политики без изменений.
 */
/**
 * Разумное время заполнения раздела ежедневника.
 *
 * not_before — жёсткий запрет: по часам портал точно знает, что день ещё не
 * кончился, и «закрыть день» в 11 утра запрещает без всяких допущений.
 *
 * not_after — НЕ запрет. Позднее заполнение разрешено и только помечается: портал
 * знает время заполнения поля, а не время события, и руководитель, реально
 * проведший планёрку в 9:00 и севший за форму в 14:00, не должен получать отказ.
 * Отметка считается в sectionFillLateness по updated_at, отдельно не хранится.
 */
export async function assertSectionNotTooEarly(c:PoolClient,sectionNum:number|null,businessDate:string) {
  if(!sectionNum) return;
  const rule=(await c.query(
    `SELECT not_before,mode FROM daily_section_time_rules
      WHERE section_num=$1 AND effective_from<=$2::date
      ORDER BY effective_from DESC,version DESC LIMIT 1`,[sectionNum,businessDate])).rows[0];
  // Режим MARK: раннее заполнение разрешено и только отмечается (решение
  // владельца 26.09.2026 — запрет закрытия дня до 16:00 не давал сдать день).
  if(!rule?.not_before||rule.mode!=='BLOCK') return;
  const now=(await c.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','HH24:MI') t, "+
    "to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') d")).rows[0];
  // Правило действует только в свои сутки: вчерашний ежедневник дозаполняют
  // сегодня, и запрещать это по времени суток было бы уже бессмысленно.
  if(now.d!==businessDate) return;
  const limit=String(rule.not_before).slice(0,5);
  if(now.t<limit)
    throw new ApiError('VALIDATION_ERROR',
      `Раздел ${sectionNum} нельзя заполнять раньше ${limit}: день ещё не закончился.`);
}

/**
 * Разделы, заполненные позже разумного времени. Считается из updated_at поля —
 * единственного факта о времени, который есть. Нужно сводке и руководителю:
 * ежедневник, заполненный целиком в 21:40 одним заходом, виден по этой отметке.
 */
export async function sectionFillLateness(c:PoolClient,workItemId:string) {
  return (await c.query(
    `WITH fields AS (
       SELECT (e.value->>'section_num')::int section_num,e.value->>'field_path' field_path,
              e.value->>'section_title' section_title
         FROM work_items w JOIN templates t ON t.id=w.template_version_id,
              jsonb_array_elements(t.field_schema) e
        WHERE w.id=$1 AND e.value->>'section_num' IS NOT NULL
     ), rules AS (
       SELECT DISTINCT ON (section_num) section_num,not_after
         FROM daily_section_time_rules
        WHERE not_after IS NOT NULL
          AND effective_from<=(SELECT business_date FROM daily_log_records WHERE work_item_id=$1)
        ORDER BY section_num,effective_from DESC,version DESC
     )
     SELECT fl.section_num,max(fl.section_title) section_title,
            to_char(max(f.updated_at) AT TIME ZONE 'Europe/Moscow','HH24:MI') filled_at,
            to_char(r.not_after,'HH24:MI') not_after
       FROM fields fl
       JOIN rules r ON r.section_num=fl.section_num
       JOIN work_item_fields f ON f.work_item_id=$1 AND f.field_path=fl.field_path
        AND f.value IS NOT NULL AND btrim(f.value)<>''
      GROUP BY fl.section_num,r.not_after
     HAVING (max(f.updated_at) AT TIME ZONE 'Europe/Moscow')::time > r.not_after
      ORDER BY fl.section_num`,[workItemId])).rows as
    {section_num:number;section_title:string|null;filled_at:string;not_after:string}[];
}

export async function setDailyPolicyForAll(ctx:ActorContext,body:any) {
  const date=dailyDate(body?.effective_from);
  const roles:string[]=Array.isArray(body?.roles)&&body.roles.length?body.roles.map(dailyRole):['RF','ROP','ROO'];
  for(const key of ['base_open_time','base_close_time']) {
    if(typeof body?.[key]!=='string'||!/^([01]\d|2[0-3]):[0-5]\d$/.test(body[key]))
      throw new ApiError('VALIDATION_ERROR','Время должно иметь формат ЧЧ:ММ.');
  }
  if(body.base_close_time<=body.base_open_time)
    throw new ApiError('VALIDATION_ERROR','Закрытие должно быть позже открытия в тот же день.');
  if(typeof body?.reason!=='string'||body.reason.trim().length<5||body.reason.length>500)
    throw new ApiError('VALIDATION_ERROR','Укажите основание изменения, 5–500 символов.');
  return withTransaction(async c=>{
    await liveFence(c,ctx);
    const today=(await c.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
    if(date<today) throw new ApiError('VALIDATION_ERROR','Новая политика не может вступать в силу задним числом.');
    // Только филиалы, на которых у пользователя есть право регионального
    // менеджера: массовое действие не расширяет область видимости.
    const branches=(await c.query(
      `SELECT DISTINCT g.org_unit_id id,n.display_name
         FROM role_grants g
         JOIN org_directory_units u ON u.id=g.org_unit_id AND u.kind='ORG_UNIT'
         LEFT JOIN org_directory_name_history n ON n.org_unit_id=u.id AND n.effective_to IS NULL
        WHERE g.user_id=$1 AND g.role_code='REGIONAL_MANAGER' AND g.revoked_at IS NULL
          AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
          AND org_lifecycle_at(u.id,$2::date)='ACTIVE'
        ORDER BY n.display_name`,[ctx.authUser.userId,date])).rows as {id:string;display_name:string|null}[];
    if(!branches.length)
      throw new ApiError('FORBIDDEN','Нет филиалов, на которых вы региональный менеджер: массовая настройка недоступна.');
    const applied:{org_unit_id:string;display_name:string|null;role:string;version:number}[]=[];
    const unchanged:{org_unit_id:string;display_name:string|null;role:string}[]=[];
    for(const b of branches) {
      for(const role of roles) {
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`daily-policy:${b.id}:${role}`]);
        const previous=(await c.query(
          `SELECT * FROM daily_log_policies WHERE org_unit_id=$1 AND role_code=$2 ORDER BY version DESC LIMIT 1`,
          [b.id,role])).rows[0];
        if(previous&&previous.base_open_time.slice(0,5)===body.base_open_time
          &&previous.base_close_time.slice(0,5)===body.base_close_time
          &&Number(previous.early_open_hours)===0&&Number(previous.late_close_hours)===0) {
          unchanged.push({org_unit_id:b.id,display_name:b.display_name,role});continue;
        }
        const version=(previous?.version??0)+1;
        const result=await c.query(
          `INSERT INTO daily_log_policies(org_unit_id,role_code,version,effective_from,base_open_time,
             base_close_time,early_open_hours,late_close_hours,reason,created_by)
           VALUES($1,$2,$3,$4,$5,$6,0,0,$7,$8) RETURNING version`,
          [b.id,role,version,date,body.base_open_time,body.base_close_time,body.reason,ctx.authUser.userId]);
        await writeAuditAndOutbox(c,{actorUserId:ctx.authUser.userId,actorRole:'REGIONAL_MANAGER',orgUnitId:b.id,
          workItemId:null,action:'DAILY_POLICY_SET',aggregateType:'org_change',aggregateId:b.id,
          aggregateVersion:version,requestId:ctx.requestId,beforeState:previous??null,
          afterState:{role,effective_from:date,base_open_time:body.base_open_time,
            base_close_time:body.base_close_time,early_open_hours:0,late_close_hours:0,version,bulk:true},
          reason:body.reason,resolution:'APPLIED',retentionClass:'WORK_ITEM_STANDARD'});
        applied.push({org_unit_id:b.id,display_name:b.display_name,role,version:result.rows[0].version});
      }
    }
    return {effective_from:date,roles,base_open_time:body.base_open_time,base_close_time:body.base_close_time,
      branches:branches.length,applied,unchanged,timezone:'Europe/Moscow',
      timezone_note:'Время московское: часовые пояса филиалов ещё не реализованы.'};
  });
}

// Called in the SAME transaction as task submit. Unique natural key + advisory
// lock makes open/create safe under retries and concurrent browser tabs.
export async function ensureDailyLog(c:PoolClient,ctx:ActorContext,org:string,role:string,date:string) {
  dailyRole(role);dailyDate(date);await authorize(c,ctx,org,role);
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`daily:${org}:${ctx.authUser.userId}:${role}:${date}`]);
  const existing=(await c.query(`SELECT work_item_id FROM daily_log_records
    WHERE org_unit_id=$1 AND user_id=$2 AND role_code=$3 AND business_date=$4`,
    [org,ctx.authUser.userId,role,date])).rows[0];
  if(existing) return existing.work_item_id as string;
  if(!(await c.query('SELECT org_accepts_new_work($1) allowed',[org])).rows[0].allowed)
    throw new ApiError('VALIDATION_ERROR','Филиал пока не принимает новые записи.');
  const policy=await policyFor(c,org,role,date);
  if(!policy) throw new ApiError('VALIDATION_ERROR','Для роли и даты не настроено окно заполнения. Обратитесь к РМ.');
  const window=(await c.query(`SELECT ($1::date+$2::time) AT TIME ZONE 'Europe/Moscow' AS base_open,
    ($1::date+$3::time) AT TIME ZONE 'Europe/Moscow' AS base_close,
    (($1::date+$2::time) AT TIME ZONE 'Europe/Moscow')-make_interval(hours=>$4) AS window_open,
    (($1::date+$3::time) AT TIME ZONE 'Europe/Moscow')+make_interval(hours=>$5) AS window_close`,
    [date,policy.base_open_time,policy.base_close_time,policy.early_open_hours,policy.late_close_hours])).rows[0];
  const now=(await c.query('SELECT now() AS time')).rows[0].time;
  if(now<window.window_open||now>window.window_close) throw new ApiError('VALIDATION_ERROR','Вне окна заполнения выбранного дня.',{issues:[{path:'business_date',issue:'outside_fill_window'}]});
  // Ежедневник с 28 жёсткими задачами (миграция 045). Записи, созданные по
  // версии _v1, остаются на своей версии шаблона — история не переписывается.
  const template=await getTemplateByCode(c,`personal_daily_${role.toLowerCase()}_v2`);
  if(!template) throw new ApiError('TEMPORARILY_UNAVAILABLE','Шаблон ежедневника не установлен.');
  const created=await c.query(`INSERT INTO work_items(org_unit_id,template_version_id,title,due_at,status,assignee_user_id,created_by)
    VALUES($1,$2,$3,$4,'ASSIGNED',$5,$5) RETURNING id`,[org,template.id,`Ежедневник ${role} · ${date}`,window.base_close,ctx.authUser.userId]);
  const id=created.rows[0].id;
  // Одной вставкой, а не по полю за запрос: у ежедневника РФ 95 полей, и
  // цикл дал бы 95 обращений к базе на каждое открытие дня.
  await c.query(`INSERT INTO work_item_fields(work_item_id,org_unit_id,field_path,updated_by)
    SELECT $1,$2,path,$3 FROM unnest($4::text[]) path`,
    [id,org,ctx.authUser.userId,template.field_schema.map(f=>f.field_path)]);
  await c.query(`INSERT INTO daily_log_records(work_item_id,org_unit_id,user_id,role_code,business_date,policy_id,base_open,base_close,window_open,window_close)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,org,ctx.authUser.userId,role,date,policy.id,window.base_open,window.base_close,window.window_open,window.window_close]);
  await writeAuditAndOutbox(c,{actorUserId:ctx.authUser.userId,actorRole:role,orgUnitId:org,workItemId:id,
    action:'CREATE',aggregateType:'work_item',aggregateId:id,aggregateVersion:1,requestId:ctx.requestId,beforeState:null,
    afterState:{status:'ASSIGNED',business_date:date,role,policy_id:policy.id},resolution:'APPLIED',retentionClass:'WORK_ITEM_STANDARD',
    eventType:'work_item.created',payload:{work_item_id:id}});
  return id as string;
}
export async function openDailyLog(ctx:ActorContext,body:any) {
  const role=dailyRole(body.role),date=dailyDate(body.business_date);
  return withTransaction(async c=>{await liveFence(c,ctx);return {id:await ensureDailyLog(c,ctx,body.org_unit_id,role,date)};});
}
export async function getPersonalDay(ctx:ActorContext,org:string,roleRaw:unknown,dateRaw:unknown) {
  const role=dailyRole(roleRaw),date=dailyDate(dateRaw);
  return withTransaction(async c=>{
    await liveFence(c,ctx);await authorize(c,ctx,org,role);
    const rec=(await c.query(`SELECT d.work_item_id,w.status,w.entity_version,w.current_submission_id FROM daily_log_records d JOIN work_items w ON w.id=d.work_item_id
      WHERE d.org_unit_id=$1 AND d.user_id=$2 AND d.role_code=$3 AND d.business_date=$4`,[org,ctx.authUser.userId,role,date])).rows[0];
    const policy=await policyFor(c,org,role,date);
    const current=(await c.query("SELECT to_char(now() AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD') AS day")).rows[0].day;
    return {business_date:date,current_business_date:current,record:rec?{...rec,...await dailyMetadata(c,rec.work_item_id)}:null,policy,
      assigned_tasks:await assignedTasksForDay(c,org,ctx.authUser.userId,date),
      links:rec?await dailyLinks(c,rec.work_item_id,['SUBMITTED','COMPLETED'].includes(rec.status)?rec.current_submission_id:undefined):[],primary_storage:'POSTGRESQL',external_sync_status:'NOT_APPLICABLE'};
  });
}
/**
 * Задачи, поставленные исполнителю руководителем, — блок «Задачи от
 * руководителя» в ежедневнике дня. Это не жёсткие задачи ежедневника: они
 * приходят извне, поэтому показываются отдельным списком ещё до выполнения.
 * Берём открытые задачи филиала, назначенные этому пользователю, кроме самих
 * ежедневников, со сроком на этот день или раньше (просроченные видны тоже).
 */
export async function assignedTasksForDay(c:PoolClient,org:string,userId:string,date:string) {
  return (await c.query(`SELECT w.id,w.title,w.status,w.entity_version,
      to_char(w.due_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD HH24:MI') due_at_local,
      t.display_name template_name,w.created_by,
      author.full_name AS created_by_name,
      EXISTS(SELECT 1 FROM daily_log_links l JOIN submissions s ON s.id=l.submission_id
        WHERE s.work_item_id=w.id) AS in_daily_log
    FROM work_items w
    JOIN templates t ON t.id=w.template_version_id
    LEFT JOIN app_users author ON author.id=w.created_by
    WHERE w.org_unit_id=$1 AND w.assignee_user_id=$2
      AND t.code NOT LIKE 'personal_daily_%'
      AND w.status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED')
      AND (w.due_at IS NULL OR (w.due_at AT TIME ZONE 'Europe/Moscow')::date<=$3::date)
    ORDER BY w.due_at NULLS LAST,w.created_at`,[org,userId,date])).rows;
}
export async function dailyLinks(c:PoolClient,id:string,submissionId?:string) {
  return (await c.query(`SELECT s.id submission_id,s.work_item_id,s.revision,s.completion_summary,s.submitted_at,
    w.title,w.status current_task_status,dm.marker daily_marker
    FROM daily_log_links l JOIN submissions s ON s.id=l.submission_id JOIN work_items w ON w.id=s.work_item_id
    LEFT JOIN daily_submission_markers dm ON dm.submission_id=s.id
    WHERE l.daily_log_id=$1 AND ($2::uuid IS NULL OR EXISTS(
      SELECT 1 FROM daily_submission_links ds WHERE ds.daily_submission_id=$2 AND ds.task_submission_id=s.id))
    ORDER BY s.submitted_at,s.id`,[id,submissionId??null])).rows;
}
