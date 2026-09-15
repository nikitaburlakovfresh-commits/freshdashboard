import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { editorPermissions } from '../domain/orgEditorProvisioning';

/** Operator command only. No implicit grants on migration/startup. */
export async function provisionReportStaging(login:string,approval:string) {
  if(!login || typeof approval!=='string' || approval.trim().length<16 || approval.length>500) throw new Error('Explicit bounded staging approval required');
  return withTransaction(async c=>{
    await c.query('LOCK TABLE app_users,sessions,role_grants,roles,role_permissions,report_staging_access IN SHARE ROW EXCLUSIVE MODE');
    const r=await c.query(`SELECT u.id user_id,g.id grant_id FROM administrator_bootstrap b
      JOIN app_users u ON u.id=b.user_id JOIN role_grants g ON g.id=b.grant_id
      WHERE u.login=$1 AND u.is_active AND u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
        AND g.user_id=u.id AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
        AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR now()<g.valid_until)
        AND (SELECT count(*) FROM role_grants WHERE role_code='SUPER_ADMIN')=1`,[login]);
    if(r.rowCount!==1) throw new Error('Existing singleton personal administrator required');
    const row=r.rows[0];
    const actual=(await c.query("SELECT permission_code FROM role_permissions WHERE role_code='SUPER_ADMIN' ORDER BY permission_code")).rows.map(x=>x.permission_code);
    const expected=['organization.directory.review',...editorPermissions].sort();
    if(JSON.stringify(actual)!==JSON.stringify(expected)) throw new Error('Expected unchanged seven bounded editor permissions');
    const prior=await c.query('SELECT * FROM report_staging_access WHERE grant_id=$1',[row.grant_id]);
    if(prior.rowCount) {
      if(prior.rows[0].revoked_at || prior.rows[0].valid_until) throw new Error('Never silently reactivate a revoked/temporary capability');
      return {status:'ALREADY_PROVISIONED',...row};
    }
    const auditId=await writeAuditAndOutbox(c,{actorUserId:null,actorRole:null,orgUnitId:null,workItemId:null,
      action:'REPORT_STAGING_PROVISIONED',aggregateType:'access',aggregateId:row.grant_id,aggregateVersion:3,
      requestId:randomUUID(),beforeState:{role_permissions:actual},afterState:{capability:'data_source.probe',grant_id:row.grant_id,approval_reference:approval,provisioner:'AUTHORIZED_OPERATOR'},
      reason:'Bounded private aggregate quarantine and persisted preview only; no financial access or canonical commit',
      resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'report.staging.provisioned',
      payload:{capability:'data_source.probe',grant_id:row.grant_id}});
    await c.query('INSERT INTO report_staging_access(grant_id,audit_id,approval_reference) VALUES($1,$2,$3)',[row.grant_id,auditId,approval.trim()]);
    return {status:'PROVISIONED',...row};
  });
}
