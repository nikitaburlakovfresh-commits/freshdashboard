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
  if(typeof raw!=='string'||!ROLES.includes(raw)) throw new ApiError('VALIDATION_ERROR','Beta ежедневника поддерживает РФ, РОП и РОО.');
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
  const template=await getTemplateByCode(c,`personal_daily_${role.toLowerCase()}_v1`);
  if(!template) throw new ApiError('TEMPORARILY_UNAVAILABLE','Шаблон ежедневника не установлен.');
  const created=await c.query(`INSERT INTO work_items(org_unit_id,template_version_id,title,due_at,status,assignee_user_id,created_by)
    VALUES($1,$2,$3,$4,'ASSIGNED',$5,$5) RETURNING id`,[org,template.id,`Ежедневник ${role} · ${date}`,window.base_close,ctx.authUser.userId]);
  const id=created.rows[0].id;
  for(const field of template.field_schema) await c.query(`INSERT INTO work_item_fields(work_item_id,org_unit_id,field_path,updated_by)
    VALUES($1,$2,$3,$4)`,[id,org,field.field_path,ctx.authUser.userId]);
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
      links:rec?await dailyLinks(c,rec.work_item_id,['SUBMITTED','COMPLETED'].includes(rec.status)?rec.current_submission_id:undefined):[],primary_storage:'POSTGRESQL',external_sync_status:'NOT_APPLICABLE'};
  });
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
