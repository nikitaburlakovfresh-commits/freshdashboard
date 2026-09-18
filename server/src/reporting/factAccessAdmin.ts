import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from '../domain/accessChanges';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { canonicalJsonHash } from '../util/crypto';
import { ApiError } from '../util/errors';
import { METRIC_NAMES } from './shared/reportModel';
import { uuid } from './storage';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const stale=()=>new ApiError('ENTITY_VERSION_CONFLICT','Проверка устарела. Обновите данные и проверьте изменение заново.');
type Command={operation:'GRANT'|'REVOKE';grant_id:string;capability:'READ'|'PUBLISH';
 metrics:string[];valid_from:string;valid_until:string|null;reason:string};
const iso=(v:unknown):v is string=>typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
 &&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
function parse(raw:any):Command {
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||
   Object.keys(raw).some(k=>!['operation','grant_id','capability','metrics','valid_from','valid_until','reason'].includes(k))||
   !['GRANT','REVOKE'].includes(raw.operation)||typeof raw.grant_id!=='string'||!uuid.test(raw.grant_id)||
   !['READ','PUBLISH'].includes(raw.capability)||typeof raw.reason!=='string'||raw.reason.trim().length<16||raw.reason.length>500)
   throw invalid('Выберите назначение, действие, допуск и основание (16–500 символов).');
 if(raw.operation==='REVOKE') {
   if(['metrics','valid_from','valid_until'].some(k=>raw[k]!==undefined))throw invalid('Отзыв не принимает новые метрики и даты.');
   return {...raw,reason:raw.reason.trim()};
 }
 if(!Array.isArray(raw.metrics)||!raw.metrics.length||raw.metrics.length>8||
   new Set(raw.metrics).size!==raw.metrics.length||raw.metrics.some((m:any)=>typeof m!=='string'||!Object.hasOwn(METRIC_NAMES,m))||
   (raw.valid_from!=='NOW'&&!iso(raw.valid_from))||(raw.valid_until!==null&&!iso(raw.valid_until)))
   throw invalid('Нужен явный набор метрик и корректный интервал UTC.');
 return {...raw,metrics:[...raw.metrics].sort(),reason:raw.reason.trim()};
}
async function authorize(c:PoolClient,auth:AuthedUser) {
 await authorizeNetworkPermissions(c,auth,['access.directory.read','report.fact_access.manage']);
 // Same order as existing access/activation/publication flows.
 await c.query('LOCK TABLE org_directory_units,report_staging_access,report_fact_access IN SHARE ROW EXCLUSIVE MODE');
}
async function state(c:PoolClient,auth:AuthedUser,cmd:Command) {
 const g=(await c.query(`SELECT g.*,u.login,u.full_name,u.is_active,u.user_kind,u.password_last_shared_indicator
   FROM role_grants g JOIN app_users u ON u.id=g.user_id WHERE g.id=$1`,[cmd.grant_id])).rows[0];
 const previous=(await c.query('SELECT * FROM report_fact_access WHERE grant_id=$1 AND capability=$2',
   [cmd.grant_id,cmd.capability])).rows[0]??null;
 const now=(await c.query('SELECT clock_timestamp() now')).rows[0].now as Date;
 const branch=g?.org_unit_id?(await c.query(`SELECT id,code,kind,is_demo,demo_locked,
   org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date) lifecycle_state,
   effective_from,effective_to FROM org_directory_units WHERE id=$1`,[g.org_unit_id])).rows[0]:null;
 const staging=cmd.capability==='PUBLISH'?(await c.query(`SELECT a.* FROM report_staging_access a
   JOIN administrator_bootstrap b ON b.grant_id=a.grant_id WHERE a.grant_id=$1`,[cmd.grant_id])).rows[0]??null:null;
 const issues:string[]=[];
 if(!g)issues.push('Назначение не найдено.');
 if(g?.user_id===auth.userId)issues.push('Изменение собственного допуска запрещено.');
 if(cmd.operation==='REVOKE') {
   // Revocation is allowed even for disabled users/expired grants: never strand access.
   if(!previous||previous.revoked_at)issues.push('Нет неотозванного допуска.');
 } else {
   if(!g?.is_active||g?.user_kind!=='INDIVIDUAL'||g?.password_last_shared_indicator)
     issues.push('Нужна активная личная учётная запись.');
   const start=cmd.valid_from==='NOW'?now:new Date(cmd.valid_from),end=cmd.valid_until?new Date(cmd.valid_until):null;
   if(start<now||(end&&end<=start))issues.push('Начало только сейчас или в будущем; окончание позже начала.');
   if(g&&(g.revoked_at||start<new Date(g.valid_from)||
      (g.valid_until&&(!end||end>new Date(g.valid_until)||start>=new Date(g.valid_until)))))
     issues.push('Допуск должен находиться внутри срока неотозванного назначения.');
   if(previous&&!previous.revoked_at&&(!previous.valid_until||new Date(previous.valid_until)>now))
     issues.push('Существующий допуск не перезаписывается: сначала отзовите его отдельным подтверждением.');
   if(cmd.capability==='READ'&&(!g||g.scope_kind!=='ORG_UNIT'||!branch||branch.kind!=='ORG_UNIT'||
      branch.is_demo||branch.demo_locked||branch.lifecycle_state!=='ACTIVE'))
     issues.push('Чтение разрешается только на один активный реальный филиал.');
   if(cmd.capability==='READ'&&branch&&
      (start<new Date(branch.effective_from)||(branch.effective_to&&(!end||end>new Date(branch.effective_to)))))
     issues.push('Интервал выходит за даты существования филиала.');
   if(cmd.capability==='PUBLISH'&&(!g||g.scope_kind!=='NETWORK'||g.org_unit_id||g.role_code!=='SUPER_ADMIN'||
      !staging||staging.revoked_at||start<new Date(staging.valid_from)||
      (staging.valid_until&&(!end||end>new Date(staging.valid_until)))))
     issues.push('Публикация требует существующего bootstrap-назначения SUPER_ADMIN и допуска к загрузке на весь срок.');
 }
 const summary={valid:issues.length===0,issues,operation:cmd.operation,
   user:g?{id:g.user_id,login:g.login,full_name:g.full_name}:null,
   branch:branch?{id:branch.id,code:branch.code}:null,role:g?.role_code??null,
   capability:cmd.capability,metrics:cmd.operation==='GRANT'?cmd.metrics:previous?.metrics??[],
   valid_from:cmd.operation==='GRANT'?cmd.valid_from:null,valid_until:cmd.operation==='GRANT'?cmd.valid_until:null,
   previous,reason:cmd.reason,warning:'Только допуск к метрикам. Роли, задачи, ежедневники и опубликованные значения не изменяются. Отзыв действует сразу.'};
 return {summary,hash:canonicalJsonHash({cmd,g,previous,branch,staging}).toString('hex')};
}
export async function factAccessDirectory(auth:AuthedUser) {
 return withTransaction(async c=>{
   await authorize(c,auth);
   const grants=(await c.query(`SELECT g.id,g.user_id,g.role_code,g.scope_kind,g.org_unit_id,g.valid_from,g.valid_until,g.revoked_at,
     u.login,u.full_name,u.is_active,o.code branch_code,
     COALESCE(o.kind='ORG_UNIT' AND NOT o.is_demo AND NOT o.demo_locked
       AND org_lifecycle_at(o.id,(now() AT TIME ZONE 'UTC')::date)='ACTIVE',false) readable_branch
     FROM role_grants g JOIN app_users u ON u.id=g.user_id
     LEFT JOIN org_directory_units o ON o.id=g.org_unit_id
     WHERE u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
     ORDER BY u.login,g.id LIMIT 5001`)).rows;
   const access=(await c.query('SELECT * FROM report_fact_access ORDER BY grant_id,capability LIMIT 5001')).rows;
   if(grants.length>5000||access.length>5000)throw invalid('Справочник требует серверной пагинации.');
   const history=(await c.query(`SELECT a.id,a.actor_user_id,u.full_name actor_name,a.action,a.occurred_at,
     a.before_state,a.after_state,a.reason FROM audit_log a LEFT JOIN app_users u ON u.id=a.actor_user_id
     WHERE a.action IN ('REPORT_FACT_ACCESS_ADMIN','REPORT_FACT_ACCESS_PROVISIONED')
     ORDER BY a.occurred_at DESC,a.id DESC LIMIT 100`)).rows;
   return {grants,access,history,history_limit:100,metrics:METRIC_NAMES};
 });
}
export async function previewFactAccess(auth:AuthedUser,raw:unknown) {
 return withTransaction(async c=>{
   await authorize(c,auth);const cmd=parse(raw),s=await state(c,auth,cmd);
   if(!s.summary.valid)return {id:null,...s.summary,expires_at:null};
   const id=randomUUID();
   const row=(await c.query(`INSERT INTO fact_access_previews(id,actor_user_id,command,state_hash,summary)
     VALUES($1,$2,$3,$4,$5) RETURNING expires_at`,[id,auth.userId,cmd,s.hash,s.summary])).rows[0];
   return {id,...s.summary,expires_at:row.expires_at};
 });
}
export async function applyFactAccess(auth:AuthedUser,raw:any,requestId:string) {
 return withTransaction(async c=>{
   await authorize(c,auth);
   if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!['preview_id','confirmed'].includes(k))||
     typeof raw.preview_id!=='string'||!uuid.test(raw.preview_id)||raw.confirmed!==true)
     throw invalid('Нужны проверка и явное подтверждение.');
   const p=(await c.query('SELECT * FROM fact_access_previews WHERE id=$1',[raw.preview_id])).rows[0];
   if(!p||p.actor_user_id!==auth.userId)throw stale();
   // Preview identity is the idempotency key; re-authorize before returning a receipt.
   const receipt=(await c.query('SELECT result FROM fact_access_receipts WHERE preview_id=$1',[p.id])).rows[0];
   if(receipt)return receipt.result;
   const cmd=parse(p.command),s=await state(c,auth,cmd);
   const now=(await c.query('SELECT clock_timestamp() now')).rows[0].now;
   if(new Date(p.expires_at)<=now||!s.summary.valid||p.state_hash!==s.hash)throw stale();
   const result={preview_id:p.id,status:'APPLIED',...s.summary,applied_at:now};
   const audit=await writeAuditAndOutbox(c,{actorUserId:auth.userId,actorRole:null,orgUnitId:null,workItemId:null,
     action:'REPORT_FACT_ACCESS_ADMIN',aggregateType:'access',aggregateId:p.id,aggregateVersion:1,requestId,
     beforeState:s.summary.previous,afterState:result,reason:cmd.reason,resolution:'APPLIED',retentionClass:'SECURITY_5Y',
     eventType:'report.facts.access',payload:{grant_id:cmd.grant_id,capability:cmd.capability,operation:cmd.operation}});
   if(cmd.operation==='REVOKE') await c.query(`UPDATE report_fact_access SET revoked_at=$3,audit_id=$4,
     approval_reference=$5 WHERE grant_id=$1 AND capability=$2`,[cmd.grant_id,cmd.capability,now,audit,cmd.reason]);
   else await c.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,valid_from,valid_until,approval_reference,audit_id)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(grant_id,capability) DO UPDATE SET
     metrics=EXCLUDED.metrics,valid_from=EXCLUDED.valid_from,valid_until=EXCLUDED.valid_until,
     revoked_at=NULL,approval_reference=EXCLUDED.approval_reference,audit_id=EXCLUDED.audit_id`,
     [cmd.grant_id,cmd.capability,cmd.metrics,cmd.valid_from==='NOW'?now:cmd.valid_from,cmd.valid_until,cmd.reason,audit]);
   await c.query('INSERT INTO fact_access_receipts(preview_id,audit_id,result) VALUES($1,$2,$3)',[p.id,audit,result]);
   // JSON normalization ensures first response and transport retry are identical.
   return JSON.parse(JSON.stringify(result));
 });
}
