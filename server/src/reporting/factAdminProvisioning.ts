import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from '../domain/auditOutbox';

// One explicit deployment opt-in, not startup behavior or an HTTP endpoint.
// End-user READ/PUBLISH grants still require the admin workflow separately.
export async function provisionFactAdministrator(login:string,approval:string) {
 if(!login||typeof approval!=='string'||approval.trim().length<16||approval.length>500)
   throw new Error('Named administrator and explicit bounded approval required');
 return withTransaction(async c=>{
   await c.query('LOCK TABLE app_users,sessions,role_grants,roles,role_permissions IN SHARE ROW EXCLUSIVE MODE');
   const r=(await c.query(`SELECT u.id user_id,g.id grant_id FROM administrator_bootstrap b
     JOIN app_users u ON u.id=b.user_id JOIN role_grants g ON g.id=b.grant_id
     WHERE u.login=$1 AND u.is_active AND u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
       AND g.user_id=u.id AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
       AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp()
       AND (g.valid_until IS NULL OR g.valid_until>clock_timestamp())
       AND (SELECT count(*) FROM role_grants WHERE role_code='SUPER_ADMIN')=1
       AND EXISTS(SELECT 1 FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='access.directory.read')`,
     [login])).rows[0];
   if(!r)throw new Error('Existing singleton personal bootstrap administrator with directory access required');
   const existing=(await c.query(`SELECT 1 FROM role_permissions WHERE role_code='SUPER_ADMIN'
     AND permission_code='report.fact_access.manage'`)).rowCount;
   const journal=(await c.query(`SELECT after_state FROM audit_log WHERE action='REPORT_FACT_ADMIN_PROVISIONED'
     ORDER BY occurred_at DESC LIMIT 1`)).rows[0];
   if(journal) {
     if(!existing||journal.after_state.grant_id!==r.grant_id)throw new Error('Provisioning mismatch; no silent regrant');
     return {...r,status:'ALREADY_PROVISIONED'};
   }
   if(existing)throw new Error('Unreviewed pre-existing permission; no silent adoption');
   const id=randomUUID(),after={...r,permission:'report.fact_access.manage',approval_reference:approval.trim()};
   await c.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','report.fact_access.manage')");
   await writeAuditAndOutbox(c,{actorUserId:null,actorRole:null,orgUnitId:null,workItemId:null,
     action:'REPORT_FACT_ADMIN_PROVISIONED',aggregateType:'access',aggregateId:id,aggregateVersion:1,
     requestId:id,beforeState:null,afterState:after,reason:approval.trim(),resolution:'APPLIED',
     retentionClass:'SECURITY_5Y',eventType:'report.facts.access',payload:after});
   return {...r,status:'PROVISIONED'};
 });
}
