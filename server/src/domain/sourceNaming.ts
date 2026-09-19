import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from './accessChanges';
import { writeAuditAndOutbox } from './auditOutbox';
import { ApiError } from '../util/errors';
import { uuid } from '../reporting/storage';
import { normalizeBranchName } from './branchNameMatch';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const date=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v))return false;
  const t=Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;
};
const text=(v:unknown,min:number,max:number,message:string):string=>{
  if(typeof v!=='string'||v.trim().length<min||v.trim().length>max)throw invalid(message);
  return v.trim();
};

/** Название строки источника и его нормализованная форма сравнения. */
function sourceName(raw:unknown):{source_name:string;norm:string} {
  const source_name=text(raw,2,200,'Укажите название строки из выгрузки (2–200 символов).');
  const norm=normalizeBranchName(source_name);
  if(!norm)throw invalid('Название строки не содержит значимых символов для сопоставления.');
  return {source_name,norm};
}

export interface SourceAlias {
  id:string; org_unit_id:string; source_name:string; source_name_norm:string;
  effective_from:string; effective_to:string|null; reason:string; display_name:string|null;
}
export interface SourceExclusion {
  id:string; source_name:string; source_name_norm:string; effective_from:string;
  revoked_at:string|null; reason:string;
}

/** Действующие псевдонимы филиалов на дату: норма названия → org_unit_id. */
export async function resolveSourceAliases(c:PoolClient,on:string):Promise<Map<string,string>> {
  const rows=(await c.query(`SELECT source_name_norm,org_unit_id FROM org_source_aliases
    WHERE effective_from<=$1 AND (effective_to IS NULL OR effective_to>$1)`,[on])).rows;
  return new Map(rows.map((r:any)=>[r.source_name_norm as string,r.org_unit_id as string]));
}

/** Действующие исключения названий вне контура сети на дату. */
export async function resolveSourceExclusions(c:PoolClient,networkId:string,on:string):Promise<Map<string,string>> {
  const rows=(await c.query(`SELECT source_name_norm,reason FROM report_source_exclusions
    WHERE network_id=$1 AND revoked_at IS NULL AND effective_from<=$2`,[networkId,on])).rows;
  return new Map(rows.map((r:any)=>[r.source_name_norm as string,r.reason as string]));
}

export async function listSourceNaming(auth:AuthedUser,query:any) {
  if(Object.keys(query??{}).some(k=>k!=='history'))throw invalid('Фильтры настройки не принимаются.');
  const history=query?.history==='true';
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['report.source_naming.manage']);
    const aliases=(await c.query(`SELECT a.id,a.org_unit_id,a.source_name,a.source_name_norm,
      to_char(a.effective_from,'YYYY-MM-DD') effective_from,to_char(a.effective_to,'YYYY-MM-DD') effective_to,
      a.reason,a.created_at,n.display_name,u.code
      FROM org_source_aliases a
      JOIN org_directory_units u ON u.id=a.org_unit_id
      LEFT JOIN org_directory_name_history n ON n.org_unit_id=a.org_unit_id AND n.effective_to IS NULL
      WHERE $1 OR a.effective_to IS NULL
      ORDER BY n.display_name NULLS LAST,a.source_name,a.effective_from DESC LIMIT 1001`,[history])).rows;
    const exclusions=(await c.query(`SELECT id,source_name,source_name_norm,
      to_char(effective_from,'YYYY-MM-DD') effective_from,revoked_at,reason,created_at
      FROM report_source_exclusions WHERE $1 OR revoked_at IS NULL
      ORDER BY source_name LIMIT 1001`,[history])).rows;
    return {aliases,exclusions,history};
  });
}

/** Новый псевдоним филиала. Действующий псевдоним того же названия закрывается датой. */
export async function setSourceAlias(auth:AuthedUser,body:any,requestId:string) {
  if(!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(k=>!['org_unit_id','source_name','effective_from','reason'].includes(k)))
    throw invalid('Передайте только филиал, название строки, дату вступления в силу и основание.');
  const {source_name,norm}=sourceName(body.source_name);
  if(typeof body.org_unit_id!=='string'||!uuid.test(body.org_unit_id))throw invalid('Выберите филиал.');
  if(!date(body.effective_from))throw invalid('Укажите дату вступления в силу в формате ГГГГ-ММ-ДД.');
  const reason=text(body.reason,16,500,'Укажите основание (16–500 символов).');
  const effective_from=body.effective_from as string;
  const org_unit_id=body.org_unit_id as string;
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['report.source_naming.manage']);
    await c.query('LOCK TABLE org_source_aliases IN SHARE ROW EXCLUSIVE MODE');
    const unit=(await c.query('SELECT id,kind FROM org_directory_units WHERE id=$1 AND effective_to IS NULL',[org_unit_id])).rows[0];
    if(!unit||unit.kind!=='ORG_UNIT')throw new ApiError('NOT_FOUND','Филиал не найден.');
    const active=(await c.query(`SELECT id,org_unit_id,to_char(effective_from,'YYYY-MM-DD') effective_from
      FROM org_source_aliases WHERE source_name_norm=$1 AND effective_to IS NULL`,[norm])).rows[0]??null;
    if(active&&active.org_unit_id===org_unit_id)
      throw invalid('Это название уже закреплено за выбранным филиалом.');
    if(active&&active.effective_from>=effective_from)
      throw invalid('Дата вступления в силу должна быть позже действующей записи этого названия.');
    const excluded=(await c.query(`SELECT id FROM report_source_exclusions
      WHERE source_name_norm=$1 AND revoked_at IS NULL`,[norm])).rows[0]??null;
    if(excluded)throw invalid('Это название сейчас исключено из приёма. Сначала отмените исключение.');
    const id=randomUUID();
    const audit=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:org_unit_id,workItemId:null,
      action:'report.source_alias.set',aggregateType:'source_naming',aggregateId:id,aggregateVersion:1,
      requestId,beforeState:active,afterState:{id,org_unit_id,source_name,effective_from},
      reason,resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'report.source_naming.changed',
      payload:{kind:'ALIAS',source_name,org_unit_id,effective_from},
    });
    if(active)await c.query('UPDATE org_source_aliases SET effective_to=$2 WHERE id=$1',[active.id,effective_from]);
    await c.query(`INSERT INTO org_source_aliases(id,org_unit_id,source_name,source_name_norm,
      effective_from,actor_user_id,reason,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,org_unit_id,source_name,norm,effective_from,auth.userId,reason,audit]);
    return {id,previous_id:active?.id??null,audit_id:audit,source_name,org_unit_id,effective_from};
  });
}

/** Название вне контура сети: строка не публикуется и не становится филиалом. */
export async function excludeSourceName(auth:AuthedUser,body:any,requestId:string) {
  if(!body||typeof body!=='object'||Array.isArray(body)||
    Object.keys(body).some(k=>!['network_id','source_name','effective_from','reason'].includes(k)))
    throw invalid('Передайте только сеть, название строки, дату вступления в силу и основание.');
  const {source_name,norm}=sourceName(body.source_name);
  if(typeof body.network_id!=='string'||!uuid.test(body.network_id))throw invalid('Укажите сеть.');
  if(!date(body.effective_from))throw invalid('Укажите дату вступления в силу в формате ГГГГ-ММ-ДД.');
  const reason=text(body.reason,16,500,'Укажите основание исключения (16–500 символов).');
  const network_id=body.network_id as string,effective_from=body.effective_from as string;
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['report.source_naming.manage']);
    await c.query('LOCK TABLE report_source_exclusions IN SHARE ROW EXCLUSIVE MODE');
    const network=(await c.query(`SELECT id FROM org_directory_units
      WHERE id=$1 AND kind='NETWORK' AND effective_to IS NULL`,[network_id])).rows[0];
    if(!network)throw new ApiError('NOT_FOUND','Сеть не найдена.');
    const alias=(await c.query(`SELECT id FROM org_source_aliases
      WHERE source_name_norm=$1 AND effective_to IS NULL`,[norm])).rows[0]??null;
    if(alias)throw invalid('Это название закреплено за филиалом. Сначала закройте псевдоним.');
    const active=(await c.query(`SELECT id FROM report_source_exclusions
      WHERE network_id=$1 AND source_name_norm=$2 AND revoked_at IS NULL`,[network_id,norm])).rows[0]??null;
    if(active)throw invalid('Это название уже исключено из приёма.');
    const id=randomUUID();
    const audit=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,
      action:'report.source_exclusion.set',aggregateType:'source_naming',aggregateId:id,aggregateVersion:1,
      requestId,beforeState:null,afterState:{id,source_name,effective_from},
      reason,resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'report.source_naming.changed',
      payload:{kind:'EXCLUSION',source_name,effective_from},
    });
    await c.query(`INSERT INTO report_source_exclusions(id,network_id,source_name,source_name_norm,
      effective_from,actor_user_id,reason,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id,network_id,source_name,norm,effective_from,auth.userId,reason,audit]);
    return {id,audit_id:audit,source_name,effective_from};
  });
}

/** Отмена исключения. Запись не удаляется: фиксируется момент отмены. */
export async function revokeSourceExclusion(auth:AuthedUser,id:string,body:any,requestId:string) {
  if(typeof id!=='string'||!uuid.test(id))throw invalid('Укажите исключение.');
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='reason'))
    throw invalid('Передайте только основание отмены.');
  const reason=text(body.reason,16,500,'Укажите основание отмены исключения (16–500 символов).');
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['report.source_naming.manage']);
    const row=(await c.query(`SELECT id,source_name FROM report_source_exclusions
      WHERE id=$1 AND revoked_at IS NULL FOR UPDATE`,[id])).rows[0];
    if(!row)throw new ApiError('NOT_FOUND','Действующее исключение не найдено.');
    const audit=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,
      action:'report.source_exclusion.revoke',aggregateType:'source_naming',aggregateId:id,aggregateVersion:2,
      requestId,beforeState:{id,source_name:row.source_name},afterState:{id,revoked:true},
      reason,resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'report.source_naming.changed',
      payload:{kind:'EXCLUSION_REVOKED',source_name:row.source_name},
    });
    await c.query('UPDATE report_source_exclusions SET revoked_at=now() WHERE id=$1',[id]);
    return {id,audit_id:audit,revoked:true};
  });
}
