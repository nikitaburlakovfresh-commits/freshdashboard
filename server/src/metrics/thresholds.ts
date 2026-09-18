import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from '../domain/accessChanges';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { ApiError } from '../util/errors';
import { METRIC_NAMES } from '../reporting/shared/reportModel';
import { uuid } from '../reporting/storage';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
// Календарная дата: 2026-02-30 и подобные значения не принимаются.
const date=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v))return false;
  const t=Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;
};

export type Rag='RED'|'AMBER'|'GREEN'|'NONE';
export interface Threshold {
  id:string; metric:string; scope_kind:'NETWORK'|'ORG_UNIT'; org_unit_id:string|null;
  direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER'; basis:'ABSOLUTE'|'PLAN_PERCENT';
  unit:'COUNT'|'RUB'|'PCT'; green_from:string; amber_from:string;
  effective_from:string; effective_to:string|null; reason:string;
}
interface Command {
  metric:string; scope_kind:'NETWORK'|'ORG_UNIT'; org_unit_id:string|null;
  direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER'; basis:'ABSOLUTE'|'PLAN_PERCENT';
  unit:'COUNT'|'RUB'|'PCT'; green_from:number; amber_from:number;
  effective_from:string; reason:string;
}
const KEYS=['metric','scope_kind','org_unit_id','direction','basis','unit','green_from','amber_from','effective_from','reason'];
function parse(raw:any):Command {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!KEYS.includes(k)))
    throw invalid('Передайте только поля настройки порога.');
  const {metric,scope_kind,direction,basis,unit,green_from,amber_from,effective_from,reason}=raw;
  const org_unit_id=raw.org_unit_id??null;
  if(typeof metric!=='string'||!Object.hasOwn(METRIC_NAMES,metric))throw invalid('Выберите показатель из справочника.');
  if(!['NETWORK','ORG_UNIT'].includes(scope_kind))throw invalid('Область порога — сеть или филиал.');
  if(scope_kind==='ORG_UNIT'?(typeof org_unit_id!=='string'||!uuid.test(org_unit_id)):org_unit_id!==null)
    throw invalid('Для порога филиала укажите филиал, для сетевого — не указывайте.');
  if(!['HIGHER_IS_BETTER','LOWER_IS_BETTER'].includes(direction))throw invalid('Укажите направление показателя.');
  if(!['ABSOLUTE','PLAN_PERCENT'].includes(basis))throw invalid('Укажите базу расчёта порога.');
  if(!['COUNT','RUB','PCT'].includes(unit))throw invalid('Укажите единицу измерения порога.');
  if(basis==='PLAN_PERCENT'&&unit!=='PCT')throw invalid('Порог от плана задаётся в процентах.');
  if(!Number.isFinite(green_from)||!Number.isFinite(amber_from))throw invalid('Пороги задаются числами.');
  if(direction==='HIGHER_IS_BETTER'?!(green_from>amber_from):!(green_from<amber_from))
    throw invalid('Зелёный порог должен быть строго лучше жёлтого по выбранному направлению.');
  if(!date(effective_from))throw invalid('Укажите дату вступления в силу в формате ГГГГ-ММ-ДД.');
  if(typeof reason!=='string'||reason.trim().length<16||reason.length>500)
    throw invalid('Укажите основание изменения порога (16–500 символов).');
  return {metric,scope_kind,org_unit_id,direction,basis,unit,green_from,amber_from,effective_from,reason:reason.trim()};
}

/** Действующие пороги на дату. Ближайшая область (филиал) вытесняет сетевую. */
export async function resolveThresholds(c:PoolClient,on:string):Promise<Threshold[]> {
  return (await c.query(`SELECT id,metric,scope_kind,org_unit_id,direction,basis,unit,
    green_from::text green_from,amber_from::text amber_from,
    to_char(effective_from,'YYYY-MM-DD') effective_from,
    to_char(effective_to,'YYYY-MM-DD') effective_to,reason
    FROM metric_thresholds WHERE effective_from<=$1 AND (effective_to IS NULL OR effective_to>$1)`,[on])).rows;
}
export function thresholdFor(list:Threshold[],metric:string,orgUnitId:string):Threshold|null {
  return list.find(t=>t.metric===metric&&t.org_unit_id===orgUnitId)
    ??list.find(t=>t.metric===metric&&t.scope_kind==='NETWORK')??null;
}
/** Статус показателя. Отсутствие данных или порога — NONE, никогда не зелёный и не ноль. */
export function evaluateRag(t:Threshold|null,value:number|null,plan:number|null):{rag:Rag;basis_value:number|null} {
  if(!t||value===null||!Number.isFinite(value))return {rag:'NONE',basis_value:null};
  let basis=value;
  if(t.basis==='PLAN_PERCENT') {
    if(plan===null||!Number.isFinite(plan)||plan===0)return {rag:'NONE',basis_value:null};
    basis=(value/plan)*100;
  }
  const green=Number(t.green_from),amber=Number(t.amber_from);
  const rag:Rag=t.direction==='HIGHER_IS_BETTER'
    ?(basis>=green?'GREEN':basis>=amber?'AMBER':'RED')
    :(basis<=green?'GREEN':basis<=amber?'AMBER':'RED');
  return {rag,basis_value:basis};
}

export async function listThresholds(auth:AuthedUser,query:any) {
  if(Object.keys(query??{}).some(k=>k!=='history'))throw invalid('Фильтры настройки не принимаются.');
  const history=query?.history==='true';
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['metric.threshold.manage']);
    const rows=(await c.query(`SELECT t.id,t.metric,t.scope_kind,t.org_unit_id,t.direction,t.basis,t.unit,
      t.green_from::text green_from,t.amber_from::text amber_from,
      to_char(t.effective_from,'YYYY-MM-DD') effective_from,to_char(t.effective_to,'YYYY-MM-DD') effective_to,
      t.reason,t.created_at,n.display_name
      FROM metric_thresholds t
      LEFT JOIN org_directory_name_history n ON n.org_unit_id=t.org_unit_id AND n.effective_to IS NULL
      WHERE $1 OR t.effective_to IS NULL
      ORDER BY t.metric,t.scope_kind,t.effective_from DESC LIMIT 1001`,[history])).rows;
    return {items:rows,metric_names:METRIC_NAMES,history:history};
  });
}

/** Новая версия порога. Действующая версия закрывается датой вступления в силу новой. */
export async function setThreshold(auth:AuthedUser,body:any,requestId:string) {
  const cmd=parse(body);
  return withTransaction(async c=>{
    await authorizeNetworkPermissions(c,auth,['metric.threshold.manage']);
    await c.query('LOCK TABLE metric_thresholds IN SHARE ROW EXCLUSIVE MODE');
    if(cmd.org_unit_id) {
      const branch=(await c.query('SELECT id,kind FROM org_directory_units WHERE id=$1',[cmd.org_unit_id])).rows[0];
      if(!branch||branch.kind!=='ORG_UNIT')throw new ApiError('NOT_FOUND','Филиал не найден.');
    }
    const previous=(await c.query(`SELECT id,green_from::text green_from,amber_from::text amber_from,direction,basis,unit,
      to_char(effective_from,'YYYY-MM-DD') effective_from FROM metric_thresholds
      WHERE metric=$1 AND COALESCE(org_unit_id,'00000000-0000-0000-0000-000000000000'::uuid)
        =COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND effective_to IS NULL`,
    [cmd.metric,cmd.org_unit_id])).rows[0]??null;
    if(previous&&previous.effective_from>=cmd.effective_from)
      throw invalid('Дата вступления в силу должна быть позже текущей версии порога.');
    const id=randomUUID();
    const audit=await writeAuditAndOutbox(c,{
      actorUserId:auth.userId,actorRole:null,orgUnitId:cmd.org_unit_id,workItemId:null,
      action:'metric.threshold.set',aggregateType:'metric_threshold',aggregateId:id,aggregateVersion:1,
      requestId,beforeState:previous,afterState:{...cmd,id},reason:cmd.reason,resolution:'APPLIED',
      retentionClass:'SECURITY_5Y',eventType:'metric.threshold.changed',
      payload:{metric:cmd.metric,scope_kind:cmd.scope_kind,org_unit_id:cmd.org_unit_id,effective_from:cmd.effective_from},
    });
    if(previous)await c.query('UPDATE metric_thresholds SET effective_to=$2 WHERE id=$1',[previous.id,cmd.effective_from]);
    await c.query(`INSERT INTO metric_thresholds(id,metric,scope_kind,org_unit_id,direction,basis,unit,
      green_from,amber_from,effective_from,reason,created_by,audit_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id,cmd.metric,cmd.scope_kind,cmd.org_unit_id,cmd.direction,cmd.basis,cmd.unit,
      cmd.green_from,cmd.amber_from,cmd.effective_from,cmd.reason,auth.userId,audit]);
    return {id,previous_id:previous?.id??null,audit_id:audit,effective_from:cmd.effective_from};
  });
}
