import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { METRIC_NAMES } from './shared/reportModel';
import { uuid } from './storage';

// Explicit operator bootstrap for this beta only. No migration/startup grants.
// Scope is a named EXISTING grant and a closed metric allowlist, not role-wide.
export async function provisionFactAccess(grant:string,capability:string,metrics:string[],approval:string) {
  if(!uuid.test(grant)||!['READ','PUBLISH'].includes(capability)||!metrics.length||metrics.length>80||
    new Set(metrics).size!==metrics.length||metrics.some(m=>!Object.keys(METRIC_NAMES).includes(m))||
    approval.trim().length<16||approval.length>500)throw new Error('Explicit grant, capability, metric allowlist and approval required');
  return withTransaction(async c=>{
    await c.query('LOCK TABLE app_users,sessions,role_grants,roles,role_permissions,report_staging_access,report_fact_access IN SHARE ROW EXCLUSIVE MODE');
    const g=(await c.query(`SELECT g.* FROM role_grants g JOIN app_users u ON u.id=g.user_id
      WHERE g.id=$1 AND u.is_active AND u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
        AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())`,[grant])).rows[0];
    if(!g||(capability==='READ'&&(g.scope_kind!=='ORG_UNIT'||!g.org_unit_id))||
      (capability==='PUBLISH'&&(g.scope_kind!=='NETWORK'||g.role_code!=='SUPER_ADMIN'||g.org_unit_id)))
      throw new Error('Invalid scope; no implicit network reader');
    if(capability==='PUBLISH'&&!(await c.query(`SELECT 1 FROM administrator_bootstrap b JOIN report_staging_access a ON a.grant_id=b.grant_id
      WHERE b.grant_id=$1 AND a.revoked_at IS NULL AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now())`,[grant])).rowCount)
      throw new Error('Existing bootstrap and staging capability required');
    if((await c.query('SELECT 1 FROM report_fact_access WHERE grant_id=$1 AND capability=$2',[grant,capability])).rowCount)
      throw new Error('Existing capability cannot be overwritten or reactivated; use extendFactAccess to add metrics');
    const eventId=randomUUID();
    const audit=await writeAuditAndOutbox(c,{actorUserId:null,actorRole:null,orgUnitId:null,workItemId:null,
      action:'REPORT_FACT_ACCESS_PROVISIONED',aggregateType:'access',aggregateId:eventId,aggregateVersion:1,requestId:eventId,
      beforeState:null,afterState:{grant_id:grant,capability,metrics,approval_reference:approval},reason:approval,
      resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'report.facts.access',payload:{grant_id:grant,capability}});
    await c.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
      VALUES($1,$2,$3,$4,$5)`,[grant,capability,metrics,approval.trim(),audit]);
    return {grant_id:grant,capability,metrics,status:'PROVISIONED'};
  });
}

/**
 * Аддитивное расширение состава показателей действующего допуска. Операция
 * только добавляет показатели: существующий состав не сужается, срок действия
 * и субъект не меняются, отзыв допуска не восстанавливается. Каждое расширение
 * пишется в аудит с явным основанием.
 */
export async function extendFactAccess(grant:string,capability:string,metrics:string[],approval:string) {
  if(!uuid.test(grant)||!['READ','PUBLISH'].includes(capability)||!metrics.length||
    new Set(metrics).size!==metrics.length||metrics.some(m=>!Object.keys(METRIC_NAMES).includes(m))||
    approval.trim().length<16||approval.length>500)throw new Error('Explicit grant, capability, metric list and approval required');
  return withTransaction(async c=>{
    await c.query('LOCK TABLE report_fact_access IN SHARE ROW EXCLUSIVE MODE');
    const row=(await c.query(`SELECT metrics FROM report_fact_access
      WHERE grant_id=$1 AND capability=$2 AND revoked_at IS NULL
        AND valid_from<=now() AND (valid_until IS NULL OR valid_until>now())`,[grant,capability])).rows[0];
    if(!row)throw new Error('No active capability to extend');
    const before:string[]=row.metrics;
    const after=[...new Set([...before,...metrics])];
    if(after.length>80)throw new Error('Metric allowlist limit exceeded');
    if(after.length===before.length)return {grant_id:grant,capability,metrics:before,status:'UNCHANGED'};
    const eventId=randomUUID();
    const audit=await writeAuditAndOutbox(c,{actorUserId:null,actorRole:null,orgUnitId:null,workItemId:null,
      action:'REPORT_FACT_ACCESS_EXTENDED',aggregateType:'access',aggregateId:eventId,aggregateVersion:1,requestId:eventId,
      beforeState:{grant_id:grant,capability,metrics:before},afterState:{grant_id:grant,capability,metrics:after},
      reason:approval.trim(),resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'report.facts.access',
      payload:{grant_id:grant,capability}});
    await c.query(`UPDATE report_fact_access SET metrics=$3,approval_reference=$4,audit_id=$5
      WHERE grant_id=$1 AND capability=$2`,[grant,capability,after,approval.trim(),audit]);
    return {grant_id:grant,capability,metrics:after,added:after.filter(m=>!before.includes(m)),status:'EXTENDED'};
  });
}
