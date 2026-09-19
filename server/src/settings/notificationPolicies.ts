import { randomUUID } from 'crypto';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from '../domain/accessChanges';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import type { ActorContext } from '../domain/workItemService';
import { ApiError } from '../util/errors';

const invalid=(s:string,path?:string)=>new ApiError('VALIDATION_ERROR',s,path?{issues:[{path,issue:'invalid'}]}:undefined);
const POLICIES=['NONE','ASSIGNEE','REVIEWERS'];

/** Политика рассылки по каждому событию каталога и история её изменений. */
export async function listNotificationPolicies(auth:AuthedUser,query:any) {
  const q=query??{};
  if(Object.keys(q).length)throw invalid('Фильтры не принимаются.');
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['notification.policy.manage']);
    const items=(await c.query(`SELECT event_type,notification_policy,consumer_name FROM event_catalog
      ORDER BY event_type`)).rows;
    const history=(await c.query(`SELECT h.event_type,h.policy_before,h.policy_after,h.reason,h.created_at,
      u.login changed_by_login FROM notification_policy_changes h JOIN app_users u ON u.id=h.changed_by
      ORDER BY h.created_at DESC LIMIT 200`)).rows;
    return {items,history,policies:POLICIES};
  });
}

/**
 * Изменение политики рассылки внутри портала: без правки кода, с основанием,
 * аудитом и append-only историей. Новая политика применяется к событиям,
 * которые ещё не обработаны потребителем; уже созданные уведомления не
 * переписываются.
 */
export async function setNotificationPolicy(auth:AuthedUser,ctx:ActorContext,raw:any,idemKey:string) {
  if(!idemKey)throw invalid('Требуется заголовок Idempotency-Key.');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)
    ||Object.keys(raw).some(k=>!['event_type','policy','reason'].includes(k)))
    throw invalid('Передайте только поля изменения политики рассылки.');
  const {event_type,policy,reason}=raw;
  if(typeof event_type!=='string'||!/^[a-z][a-z0-9_.]{2,63}$/.test(event_type))
    throw invalid('Событие указано неверно.','event_type');
  if(typeof policy!=='string'||!POLICIES.includes(policy))
    throw invalid('Политика принимает NONE, ASSIGNEE или REVIEWERS.','policy');
  if(typeof reason!=='string'||reason.trim().length<16||reason.length>500)
    throw invalid('Укажите основание изменения политики (16–500 символов).','reason');
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['notification.policy.manage']);
    const row=(await c.query(`SELECT notification_policy FROM event_catalog WHERE event_type=$1 FOR UPDATE`,
      [event_type])).rows[0];
    if(!row)throw new ApiError('NOT_FOUND','Событие отсутствует в каталоге.');
    const before=row.notification_policy as string;
    if(before===policy)return {status:200,body:{event_type,notification_policy:before,changed:false}};
    await c.query(`UPDATE event_catalog SET notification_policy=$2 WHERE event_type=$1`,[event_type,policy]);
    const id=randomUUID();
    const audit=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,action:'notification.policy.changed',
      aggregateType:'notification_policy',aggregateId:id,aggregateVersion:1,requestId:ctx.requestId,
      beforeState:{notification_policy:before},afterState:{notification_policy:policy},
      resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'notification.policy.changed',
      payload:{event_type,policy_before:before,policy_after:policy},
    });
    await c.query(`INSERT INTO notification_policy_changes(id,event_type,policy_before,policy_after,reason,
      changed_by,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id,event_type,before,policy,reason.trim(),auth.userId,audit]);
    return {status:200,body:{event_type,notification_policy:policy,changed:true,policy_before:before}};
  });
}
