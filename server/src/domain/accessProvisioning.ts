import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from './auditOutbox';
import { editorPermissions } from './orgEditorProvisioning';
export const accessPermissions=['access.directory.read','access.change.draft','access.change.preview','access.change.apply','user.assign_role'] as const;
/** Operator-only opt-in. Migration and HTTP requests never provision rights. */
export async function provisionAccessAdministration(login:string,approval:string) {
  if(!login||!approval||approval.trim().length<16||approval.length>500) throw new Error('Explicit bounded approval required');
  return withTransaction(async client=>{
    await client.query('LOCK TABLE app_users,sessions,role_grants,roles,role_permissions IN SHARE ROW EXCLUSIVE MODE');
    const row=(await client.query(`SELECT u.id user_id,g.id grant_id FROM administrator_bootstrap b
      JOIN app_users u ON u.id=b.user_id JOIN role_grants g ON g.id=b.grant_id
      WHERE u.login=$1 AND u.is_active AND u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
        AND g.user_id=u.id AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
        AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR now()<g.valid_until)
        AND (SELECT count(*) FROM role_grants WHERE role_code='SUPER_ADMIN')=1`,[login])).rows[0];
    if(!row) throw new Error('Existing singleton bootstrapped personal administrator required');
    const before=(await client.query("SELECT permission_code FROM role_permissions WHERE role_code='SUPER_ADMIN' ORDER BY permission_code")).rows.map(r=>r.permission_code);
    const old=(await client.query('SELECT * FROM access_administration_provisioning')).rows[0];
    if(old) {
      if(old.user_id!==row.user_id||old.grant_id!==row.grant_id||accessPermissions.some(p=>!before.includes(p))) throw new Error('Provisioning state mismatch; do not silently regrant');
      return {status:'ALREADY_PROVISIONED',...row};
    }
    const expected=['organization.directory.review',...editorPermissions].sort();
    if(JSON.stringify(before)!==JSON.stringify(expected)) throw new Error('Expected reviewed organization-editor baseline');
    for(const permission of accessPermissions) await client.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN',$1)",[permission]);
    const after={...row,permissions:[...before,...accessPermissions],approval_reference:approval,provisioner:'AUTHORIZED_OPERATOR'};
    const auditId=await writeAuditAndOutbox(client,{actorUserId:null,actorRole:null,orgUnitId:null,workItemId:null,
      action:'ACCESS_ADMINISTRATION_PROVISIONED',aggregateType:'access',aggregateId:randomUUID(),aggregateVersion:1,
      requestId:randomUUID(),beforeState:{permissions:before},afterState:after,reason:approval,
      resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'access.administration.provisioned',payload:after});
    await client.query('INSERT INTO access_administration_provisioning(user_id,grant_id,audit_id,approval_reference) VALUES($1,$2,$3,$4)',
      [row.user_id,row.grant_id,auditId,approval]);
    return {status:'PROVISIONED',...row};
  });
}
