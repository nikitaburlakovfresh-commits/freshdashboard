import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from '../domain/accessChanges';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import type { ActorContext } from '../domain/workItemService';
import { ApiError } from '../util/errors';

const invalid=(s:string,path?:string)=>new ApiError('VALIDATION_ERROR',s,path?{issues:[{path,issue:'invalid'}]}:undefined);

/**
 * Реестр настраиваемых числовых параметров. Новый параметр объявляется здесь и
 * в миграции со значением по умолчанию: границы проверяются на сервере, чтобы
 * настройка внутри портала не могла увести расчёт в бессмысленный диапазон.
 */
export const SETTING_SPECS:Record<string,{title:string;unit:string;min:number;max:number;integer:boolean}>={
  deviation_task_due_soon_hours:{title:'Срок задачи считается близким, часов до срока',
    unit:'HOURS',min:1,max:720,integer:true},
};

/** Текущее значение параметра. Отсутствие строки — ошибка конфигурации, не ноль. */
export async function settingNumber(c:PoolClient,key:string):Promise<number> {
  const row=(await c.query('SELECT value_number::float8 v FROM portal_settings WHERE key=$1',[key])).rows[0];
  if(!row)throw new ApiError('SCHEMA_MISMATCH',`Настройка ${key} отсутствует в реестре портала.`);
  return row.v as number;
}

export async function listPortalSettings(auth:AuthedUser,query:any) {
  if(Object.keys(query??{}).length)throw invalid('Фильтры не принимаются.');
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['portal.setting.manage']);
    const rows=(await c.query(`SELECT key,value_number::float8 value_number,updated_at FROM portal_settings
      ORDER BY key`)).rows;
    const items=rows.map(r=>({...r,...(SETTING_SPECS[r.key]??{title:r.key,unit:'NUMBER',min:null,max:null,integer:false})}));
    const history=(await c.query(`SELECT h.key,h.value_before::float8 value_before,h.value_after::float8 value_after,
      h.reason,h.created_at,u.login changed_by_login FROM portal_setting_changes h
      JOIN app_users u ON u.id=h.changed_by ORDER BY h.created_at DESC LIMIT 200`)).rows;
    return {items,history};
  });
}

/**
 * Изменение параметра внутри портала: с основанием, аудитом и append-only
 * историей. Значение применяется к последующим расчётам; ранее рассчитанные и
 * опубликованные показатели не переписываются.
 */
export async function setPortalSetting(auth:AuthedUser,ctx:ActorContext,raw:any,idemKey:string) {
  if(!idemKey)throw invalid('Требуется заголовок Idempotency-Key.');
  if(!raw||typeof raw!=='object'||Array.isArray(raw)
    ||Object.keys(raw).some(k=>!['key','value','reason'].includes(k)))
    throw invalid('Передайте только поля изменения настройки.');
  const {key,value,reason}=raw;
  if(typeof key!=='string'||!Object.hasOwn(SETTING_SPECS,key))
    throw new ApiError('NOT_FOUND','Настройка отсутствует в реестре портала.');
  const spec=SETTING_SPECS[key];
  if(typeof value!=='number'||!Number.isFinite(value)||(spec.integer&&!Number.isInteger(value))
    ||value<spec.min||value>spec.max)
    throw invalid(`Значение должно быть ${spec.integer?'целым ':''}от ${spec.min} до ${spec.max}.`,'value');
  if(typeof reason!=='string'||reason.trim().length<16||reason.length>500)
    throw invalid('Укажите основание изменения настройки (16–500 символов).','reason');
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['portal.setting.manage']);
    const row=(await c.query('SELECT value_number::float8 v FROM portal_settings WHERE key=$1 FOR UPDATE',[key])).rows[0];
    if(!row)throw new ApiError('NOT_FOUND','Настройка отсутствует в реестре портала.');
    const before=row.v as number;
    if(before===value)return {status:200,body:{key,value_number:before,changed:false}};
    await c.query('UPDATE portal_settings SET value_number=$2,updated_at=now() WHERE key=$1',[key,value]);
    const id=randomUUID();
    const auditId=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,action:'portal.setting.changed',
      aggregateType:'portal_setting',aggregateId:id,aggregateVersion:1,requestId:ctx.requestId,
      beforeState:{key,value:before},afterState:{key,value},reason:reason.trim(),resolution:'APPLIED',
      retentionClass:'SECURITY_5Y',eventType:'portal.setting.changed',payload:{key},
    });
    await c.query(`INSERT INTO portal_setting_changes(id,key,value_before,value_after,reason,changed_by,audit_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,key,before,value,reason.trim(),auth.userId,auditId]);
    return {status:200,body:{key,value_number:value,changed:true,value_before:before}};
  });
}
