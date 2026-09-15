import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from './auditOutbox';

export const editorPermissions = [
  'organization.change.draft','organization.change.preview','organization.change.apply',
  'org_unit.create','org_unit.rename','org_unit.move',
] as const;

/** Operator command, never HTTP. Does not create a user or touch a password. */
export async function provisionOrganizationEditor(login: string, approvalReference: string) {
  if (!login || !approvalReference || approvalReference.trim().length < 16) throw new Error('Explicit approval required');
  return withTransaction(async client => {
    await client.query('LOCK TABLE app_users, sessions, role_grants, roles, role_permissions IN SHARE ROW EXCLUSIVE MODE');
    const r = await client.query(`SELECT u.id user_id,g.id grant_id FROM administrator_bootstrap b
      JOIN app_users u ON u.id=b.user_id JOIN role_grants g ON g.id=b.grant_id
      WHERE u.login=$1 AND u.is_active AND u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
        AND g.user_id=u.id AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
        AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR now()<g.valid_until)
        AND (SELECT count(*) FROM role_grants WHERE role_code='SUPER_ADMIN')=1`,[login]);
    if (r.rowCount!==1) throw new Error('Existing singleton personal administrator with NETWORK assignment required');
    const row=r.rows[0];
    const journal=await client.query('SELECT user_id,grant_id FROM organization_editor_provisioning');
    if(journal.rowCount) {
      if(journal.rows[0].user_id!==row.user_id || journal.rows[0].grant_id!==row.grant_id) throw new Error('Provisioning journal mismatch');
      return {status:'ALREADY_PROVISIONED',...row};
    }
    const before=(await client.query("SELECT permission_code FROM role_permissions WHERE role_code='SUPER_ADMIN' ORDER BY permission_code")).rows.map(x=>x.permission_code);
    if(JSON.stringify(before)!==JSON.stringify(['organization.directory.review'])) throw new Error('Unexpected existing administrator permissions');
    for(const permission of editorPermissions) await client.query("INSERT INTO role_permissions VALUES ('SUPER_ADMIN',$1)",[permission]);
    const after={...row,scope_kind:'NETWORK',permissions:[...before,...editorPermissions],approval_reference:approvalReference,provisioner:'AUTHORIZED_OPERATOR'};
    const auditId=await writeAuditAndOutbox(client,{
      actorUserId:null,actorRole:null,orgUnitId:null,workItemId:null,action:'ORGANIZATION_EDITOR_PROVISIONED',
      aggregateType:'access',aggregateId:row.grant_id,aggregateVersion:2,requestId:randomUUID(),
      beforeState:{permissions:before},afterState:after,reason:'Approved bounded draft / preview / explicit apply stage; no business import',
      resolution:'APPLIED',retentionClass:'SECURITY_5Y',eventType:'organization.editor.provisioned',payload:after,
    });
    await client.query('INSERT INTO organization_editor_provisioning(user_id,grant_id,audit_id,approval_reference) VALUES($1,$2,$3,$4)',
      [row.user_id,row.grant_id,auditId,approvalReference]);
    return {status:'PROVISIONED',...row};
  });
}
