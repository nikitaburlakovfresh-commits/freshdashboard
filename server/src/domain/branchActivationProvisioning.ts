import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from './auditOutbox';

export const activationPermission = 'org_unit.activate';

/** Operator command, never HTTP. Adds only the separate first-activation
 * permission to the existing singleton administrator role, on explicit approval.
 * It creates no user, touches no password, and activates no branch itself. */
export async function provisionBranchActivation(login: string, approvalReference: string) {
  if (!login || !approvalReference || approvalReference.trim().length < 16) throw new Error('Explicit approval required');
  return withTransaction(async client => {
    await client.query('LOCK TABLE app_users, role_grants, roles, role_permissions IN SHARE ROW EXCLUSIVE MODE');
    const r = await client.query(`SELECT u.id user_id,g.id grant_id FROM administrator_bootstrap b
      JOIN organization_editor_provisioning e ON e.user_id=b.user_id AND e.grant_id=b.grant_id
      JOIN app_users u ON u.id=b.user_id JOIN role_grants g ON g.id=b.grant_id
      WHERE u.login=$1 AND u.is_active AND u.user_kind='INDIVIDUAL' AND NOT u.password_last_shared_indicator
        AND g.user_id=u.id AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
        AND g.revoked_at IS NULL AND g.valid_from<=now() AND (g.valid_until IS NULL OR now()<g.valid_until)
        AND (SELECT count(*) FROM role_grants WHERE role_code='SUPER_ADMIN')=1`, [login]);
    if (r.rowCount !== 1) throw new Error('Existing singleton personal administrator with a provisioned editor stage required');
    const row = r.rows[0];
    const before = (await client.query("SELECT permission_code FROM role_permissions WHERE role_code='SUPER_ADMIN' ORDER BY permission_code")).rows.map(x => x.permission_code);
    if (before.includes(activationPermission)) return { status: 'ALREADY_PROVISIONED', ...row };
    await client.query('INSERT INTO role_permissions VALUES($1,$2)', ['SUPER_ADMIN', activationPermission]);
    const after = { ...row, scope_kind: 'NETWORK', permissions: [...before, activationPermission].sort(), approval_reference: approvalReference };
    await writeAuditAndOutbox(client, {
      actorUserId: null, actorRole: null, orgUnitId: null, workItemId: null, action: 'BRANCH_ACTIVATION_PERMISSION_PROVISIONED',
      aggregateType: 'access', aggregateId: row.grant_id, aggregateVersion: 3, requestId: randomUUID(),
      beforeState: { permissions: before }, afterState: after,
      reason: 'Approved separate first-activation permission for the network administrator; no branch activated here',
      // No outbox event: this stage introduces no new published event contract.
      resolution: 'APPLIED', retentionClass: 'SECURITY_5Y',
    });
    return { status: 'PROVISIONED', ...row };
  });
}
