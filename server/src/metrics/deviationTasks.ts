import { randomUUID } from 'crypto';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import * as workItems from '../domain/workItemService';
import type { ActorContext } from '../domain/workItemService';
import { factAccess } from '../reporting/factAccess';
import { METRIC_NAMES } from '../reporting/shared/reportModel';
import { uuid } from '../reporting/storage';
import { ApiError } from '../util/errors';
import { evaluateRag, resolveThresholds, thresholdFor } from './thresholds';

const invalid=(s:string,path?:string)=>new ApiError('VALIDATION_ERROR',s,path?{issues:[{path,issue:'invalid'}]}:undefined);
const date=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v))return false;
  const t=Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;
};

interface Command {
  org_unit_id:string; metric:string; period_start:string; period_end:string; snapshot_id:string;
  expected_rag:'RED'|'AMBER'; template_code:string; title:string; due_at:string; reason:string;
  assignee_user_id:string|null;
}
const KEYS=['org_unit_id','metric','period_start','period_end','snapshot_id','expected_rag',
  'template_code','title','due_at','reason','assignee_user_id'];

function parse(raw:any):Command {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!KEYS.includes(k)))
    throw invalid('Передайте только поля постановки задачи по отклонению.');
  const {org_unit_id,metric,period_start,period_end,snapshot_id,expected_rag,template_code,title,due_at,reason}=raw;
  const assignee_user_id=raw.assignee_user_id??null;
  if(typeof org_unit_id!=='string'||!uuid.test(org_unit_id))throw invalid('Филиал указан неверно.','org_unit_id');
  if(typeof metric!=='string'||!Object.hasOwn(METRIC_NAMES,metric))throw invalid('Выберите показатель из справочника.','metric');
  if(!date(period_start)||!date(period_end)||period_start>period_end)
    throw invalid('Укажите точный период опубликованного среза.','period_start');
  if(typeof snapshot_id!=='string'||!uuid.test(snapshot_id))throw invalid('Версия показателя указана неверно.','snapshot_id');
  if(expected_rag!=='RED'&&expected_rag!=='AMBER')
    throw invalid('Задача создаётся только по красному или жёлтому статусу.','expected_rag');
  if(typeof template_code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(template_code))
    throw invalid('Выберите шаблон задачи.','template_code');
  if(typeof title!=='string'||title.trim().length<1||title.length>200)throw invalid('Укажите название задачи.','title');
  if(typeof due_at!=='string')throw invalid('Укажите срок задачи.','due_at');
  if(typeof reason!=='string'||reason.trim().length<16||reason.length>500)
    throw invalid('Укажите основание постановки задачи (16–500 символов).','reason');
  if(assignee_user_id!==null&&(typeof assignee_user_id!=='string'||!uuid.test(assignee_user_id)))
    throw invalid('Ответственный указан неверно.','assignee_user_id');
  return {org_unit_id,metric,period_start,period_end,snapshot_id,expected_rag,template_code,
    title:title.trim(),due_at,reason:reason.trim(),assignee_user_id};
}

/**
 * Повторная проверка отклонения на сервере. Клиентский статус не является
 * основанием: значение, версия снимка и версия порога перечитываются заново.
 */
async function verifyDeviation(c:any,auth:AuthedUser,cmd:Command) {
  const grants=await factAccess(c,auth,'READ');
  const grant=grants.find(g=>g.org_unit_id===cmd.org_unit_id);
  if(!grant)throw new ApiError('FORBIDDEN','Нет доступа к показателям этого филиала.');
  if(!grant.metrics.includes(cmd.metric))throw new ApiError('FORBIDDEN','Нет доступа к этому показателю.');
  const rows=(await c.query(`SELECT s.id,s.metric,s.value::text value,s.unit,s.revision
    FROM report_fact_snapshots s JOIN report_fact_current p ON p.snapshot_id=s.id
    WHERE s.org_unit_id=$1 AND s.period_start=$2 AND s.period_end=$3 AND s.metric IN ($4,'plan')`,
  [cmd.org_unit_id,cmd.period_start,cmd.period_end,cmd.metric])).rows;
  const fact=rows.find((r:any)=>r.metric===cmd.metric);
  if(!fact)throw new ApiError('NOT_FOUND','За этот период нет опубликованного значения показателя.');
  if(fact.id!==cmd.snapshot_id)
    throw new ApiError('DEVIATION_CONFLICT','Показатель переопубликован: откройте сетку заново и проверьте отклонение.');
  const plan=rows.find((r:any)=>r.metric==='plan');
  const t=thresholdFor(await resolveThresholds(c,cmd.period_end),cmd.metric,cmd.org_unit_id);
  if(!t)throw new ApiError('DEVIATION_CONFLICT','Порог показателя не настроен: отклонение не определено.');
  const {rag,basis_value}=evaluateRag(t,Number(fact.value),plan?Number(plan.value):null);
  if(rag!=='RED'&&rag!=='AMBER')
    throw new ApiError('DEVIATION_CONFLICT','По текущим данным и порогам отклонения нет: задача не создаётся.');
  if(rag!==cmd.expected_rag)
    throw new ApiError('DEVIATION_CONFLICT',`Статус отклонения изменился на ${rag}: обновите сетку перед постановкой задачи.`);
  return {threshold:t,value:Number(fact.value),basis_value:basis_value as number,rag};
}

/**
 * Отклонение показателя → задача ответственному. Задача создаётся штатным
 * сервисом задач (права РМ, допуск филиала, шаблон, аудит), а связь фиксирует
 * основание: филиал, показатель, период, версия снимка и версия порога.
 */
export async function createDeviationTask(auth:AuthedUser,ctx:ActorContext,body:any,idemKey:string) {
  const cmd=parse(body);
  const checked=await withTransaction(c=>verifyDeviation(c,auth,cmd));

  const existing=await withTransaction(async c=>(await c.query(
    `SELECT d.id,d.work_item_id,w.status FROM metric_deviation_tasks d JOIN work_items w ON w.id=d.work_item_id
     WHERE d.org_unit_id=$1 AND d.metric=$2 AND d.period_start=$3 AND d.period_end=$4
       AND d.snapshot_id=$5 AND d.threshold_id=$6`,
    [cmd.org_unit_id,cmd.metric,cmd.period_start,cmd.period_end,cmd.snapshot_id,checked.threshold.id])).rows[0]??null);
  if(existing)throw new ApiError('DEVIATION_CONFLICT','По этому отклонению задача уже поставлена.',
    {work_item_id:existing.work_item_id,status:existing.status});

  const created=await workItems.createWorkItem(ctx,idemKey,
    {org_unit_id:cmd.org_unit_id,template_code:cmd.template_code,title:cmd.title,due_at:cmd.due_at});
  const workItemId=(created.body as any).id as string;

  const link=await withTransaction(async c=>{
    const id=randomUUID();
    const audit=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:'REGIONAL_MANAGER',orgUnitId:cmd.org_unit_id,workItemId,
      action:'metric.deviation.task_created',aggregateType:'metric_deviation',aggregateId:id,aggregateVersion:1,
      requestId:ctx.requestId,beforeState:null,
      afterState:{work_item_id:workItemId,metric:cmd.metric,rag:checked.rag,threshold_id:checked.threshold.id,
        snapshot_id:cmd.snapshot_id,period_start:cmd.period_start,period_end:cmd.period_end},
      reason:cmd.reason,resolution:'APPLIED',retentionClass:'WORK_ITEM_STANDARD',
      ip:ctx.ip,userAgent:ctx.userAgent,eventType:'metric.deviation.task_created',
      payload:{work_item_id:workItemId,metric:cmd.metric,rag:checked.rag},
    });
    const inserted=await c.query(`INSERT INTO metric_deviation_tasks(id,work_item_id,org_unit_id,metric,
      period_start,period_end,snapshot_id,threshold_id,rag,observed_value,basis,basis_value,reason,created_by,audit_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT ON CONSTRAINT metric_deviation_tasks_unique DO NOTHING RETURNING id`,
    [id,workItemId,cmd.org_unit_id,cmd.metric,cmd.period_start,cmd.period_end,cmd.snapshot_id,
      checked.threshold.id,checked.rag,checked.value,checked.threshold.basis,checked.basis_value,
      cmd.reason,auth.userId,audit]);
    return inserted.rows[0]?{id,audit_id:audit}:null;
  });
  if(!link)throw new ApiError('DEVIATION_CONFLICT','По этому отклонению задача уже поставлена.',{work_item_id:workItemId});

  let assignment:{assigned:boolean;assignee_user_id:string|null}={assigned:false,assignee_user_id:null};
  if(cmd.assignee_user_id) {
    const card:any=(await workItems.assignWorkItem(ctx,workItemId,`${idemKey}-assign`,
      {expected_entity_version:(created.body as any).entity_version,assignee_user_id:cmd.assignee_user_id})).body;
    assignment={assigned:true,assignee_user_id:card?.assignee_user_id??cmd.assignee_user_id};
  }

  return {status:201,body:{deviation_task_id:link.id,work_item_id:workItemId,audit_id:link.audit_id,
    metric:cmd.metric,rag:checked.rag,threshold_id:checked.threshold.id,snapshot_id:cmd.snapshot_id,
    observed_value:checked.value,basis:checked.threshold.basis,basis_value:checked.basis_value,
    ...assignment}};
}

/** Задачи, поставленные по отклонениям за период, в пределах допусков пользователя. */
export async function listDeviationTasks(auth:AuthedUser,query:any) {
  const q=query??{};
  if(Object.keys(q).some(k=>!['start','end','org'].includes(k)))throw invalid('Фильтры не принимаются.');
  if(!date(q.start)||!date(q.end)||q.start>q.end)throw invalid('Укажите точный период.');
  if(q.org!==undefined&&(typeof q.org!=='string'||!uuid.test(q.org)))throw invalid('Филиал указан неверно.');
  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    if(!grants.length)throw new ApiError('FORBIDDEN','Нет отдельного доступа к показателям.');
    const orgs=grants.filter(g=>!q.org||g.org_unit_id===q.org).map(g=>g.org_unit_id);
    if(q.org&&!orgs.length)throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const rows=(await c.query(`SELECT d.id,d.work_item_id,d.org_unit_id,d.metric,d.rag,
      to_char(d.period_start,'YYYY-MM-DD') period_start,to_char(d.period_end,'YYYY-MM-DD') period_end,
      d.observed_value::text observed_value,d.basis,d.basis_value::text basis_value,d.reason,d.created_at,
      w.title,w.status,w.assignee_user_id,w.due_at FROM metric_deviation_tasks d
      JOIN work_items w ON w.id=d.work_item_id
      WHERE d.org_unit_id=ANY($1::uuid[]) AND d.period_start>=$2 AND d.period_end<=$3
      ORDER BY d.created_at DESC LIMIT 500`,[orgs,q.start,q.end])).rows
      .filter((r:any)=>grants.find(g=>g.org_unit_id===r.org_unit_id)?.metrics.includes(r.metric));
    return {items:rows,metric_names:METRIC_NAMES};
  });
}

import { settingNumber } from '../settings/portalSettings';

const OPEN_STATUSES=['DRAFT','ASSIGNED','IN_PROGRESS','SUBMITTED'];

/**
 * «Мои задачи по отклонениям» ТЗ v2.12: перечень задач, где текущий
 * пользователь является ответственным. Доступ к показателям здесь не требуется
 * — человек видит только основания собственных задач. Числовые значения
 * показываются лишь при наличии отдельного допуска к этому показателю филиала;
 * иначе отдаётся статус и текстовое основание без раскрытия цифр.
 */
export async function myDeviationTasks(auth:AuthedUser,query:any) {
  const q=query??{};
  if(Object.keys(q).some(k=>!['state'].includes(k)))throw invalid('Фильтры не принимаются.');
  const state=q.state??'OPEN';
  if(state!=='OPEN'&&state!=='ALL')throw invalid('Фильтр состояния принимает OPEN или ALL.','state');
  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    // Порог «срок близко» задаётся внутри портала, а не в коде.
    const dueSoonHours=await settingNumber(c,'deviation_task_due_soon_hours');
    const rows=(await c.query(`SELECT d.id,d.work_item_id,d.org_unit_id,d.metric,d.rag,
      to_char(d.period_start,'YYYY-MM-DD') period_start,to_char(d.period_end,'YYYY-MM-DD') period_end,
      d.observed_value::text observed_value,d.basis,d.basis_value::text basis_value,d.reason,d.created_at,
      s.unit,n.display_name,w.title,w.status,w.due_at,w.is_blocked,w.blocked_reason,w.entity_version
      FROM metric_deviation_tasks d
      JOIN work_items w ON w.id=d.work_item_id
      JOIN report_fact_snapshots s ON s.id=d.snapshot_id
      JOIN org_directory_name_history n ON n.org_unit_id=d.org_unit_id AND n.effective_to IS NULL
      WHERE w.assignee_user_id=$1 ${state==='OPEN'?'AND w.status=ANY($2::text[])':''}
      ORDER BY w.due_at ASC LIMIT 500`,
    state==='OPEN'?[auth.userId,OPEN_STATUSES]:[auth.userId])).rows;
    const now=Date.now();
    const items=rows.map((r:any)=>{
      const visible=grants.some(g=>g.org_unit_id===r.org_unit_id&&g.metrics.includes(r.metric));
      const due=Date.parse(r.due_at);
      const open=OPEN_STATUSES.includes(r.status);
      return {id:r.id,work_item_id:r.work_item_id,org_unit_id:r.org_unit_id,branch_name:r.display_name,
        metric:r.metric,metric_name:(METRIC_NAMES as Record<string,string>)[r.metric]??r.metric,
        period_start:r.period_start,period_end:r.period_end,rag:r.rag,basis:r.basis,reason:r.reason,
        created_at:r.created_at,title:r.title,status:r.status,due_at:r.due_at,
        is_blocked:r.is_blocked,blocked_reason:r.blocked_reason,entity_version:r.entity_version,
        due_state:!open?'CLOSED':due<now?'OVERDUE':due-now<=dueSoonHours*3600*1000?'DUE_SOON':'ON_TRACK',
        values_visible:visible,
        observed_value:visible?Number(r.observed_value):null,
        basis_value:visible?Number(r.basis_value):null,
        unit:visible?r.unit:null};
    });
    return {items,metric_names:METRIC_NAMES,due_soon_hours:dueSoonHours,
      counts:{total:items.length,overdue:items.filter(i=>i.due_state==='OVERDUE').length,
        due_soon:items.filter(i=>i.due_state==='DUE_SOON').length,
        blocked:items.filter(i=>i.is_blocked).length}};
  });
}
