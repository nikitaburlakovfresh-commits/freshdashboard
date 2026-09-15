import argon2 from 'argon2';
import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from './auditOutbox';

export interface BootstrapInput {
  login: string;
  fullName: string;
  password: string;
  reason: string;
  approvalReference: string;
}

/** Operator-only, one-shot bootstrap. No default identity or credentials, no
 * elevation of an existing user, no HTTP route, no task/finance permission. */
export async function bootstrapFirstAdministrator(input: BootstrapInput) {
  if (typeof input.login !== 'string' || !/^[a-z][a-z0-9._-]{2,79}$/.test(input.login) ||
      typeof input.fullName !== 'string' || !input.fullName.trim() || input.fullName.length > 200 ||
      typeof input.password !== 'string' || input.password.length < 32 || input.password.length > 200 ||
      typeof input.reason !== 'string' || input.reason.trim().length < 16 ||
      typeof input.approvalReference !== 'string' || input.approvalReference.trim().length < 16) {
    throw new Error('Invalid bootstrap input; lowercase personal login, strong credential and approval evidence required');
  }
  const passwordHash = await argon2.hash(input.password, { type: argon2.argon2id });
  return withTransaction(async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('fresh:first-administrator'))");
    // Serialize with any out-of-band identity/grant provisioning too.
    await client.query('LOCK TABLE app_users, role_grants, role_permissions IN SHARE ROW EXCLUSIVE MODE');
    const existing = await client.query(`SELECT
      EXISTS(SELECT 1 FROM administrator_bootstrap) AS bootstrapped,
      EXISTS(SELECT 1 FROM role_grants WHERE role_code='SUPER_ADMIN') AS assigned,
      EXISTS(SELECT 1 FROM app_users WHERE lower(login)=lower($1)) AS login_taken`, [input.login]);
    if (Object.values(existing.rows[0]).some(Boolean)) throw new Error('Bootstrap refused: administrator history or login already exists');
    const catalog = await client.query(`SELECT r.scope_kind, array_agg(rp.permission_code ORDER BY rp.permission_code) permissions
      FROM roles r JOIN role_permissions rp ON rp.role_code=r.code
      WHERE r.code='SUPER_ADMIN' GROUP BY r.scope_kind`);
    if (catalog.rowCount !== 1 || catalog.rows[0].scope_kind !== 'NETWORK' ||
        JSON.stringify(catalog.rows[0].permissions) !== JSON.stringify(['organization.directory.review'])) {
      throw new Error('Bootstrap refused: administrator permissions differ from the reviewed minimum');
    }
    const user = await client.query(`INSERT INTO app_users(login,full_name,password_hash,password_hash_updated_at)
      VALUES ($1,$2,$3,now()) RETURNING id`, [input.login,input.fullName.trim(),passwordHash]);
    const userId = user.rows[0].id;
    const grant = await client.query(`INSERT INTO role_grants(user_id,role_code,scope_kind,org_unit_id,valid_from)
      VALUES ($1,'SUPER_ADMIN','NETWORK',NULL,now()) RETURNING id`, [userId]);
    const grantId = grant.rows[0].id;
    const requestId = randomUUID();
    const state = { user_id:userId, grant_id:grantId, role:'SUPER_ADMIN', scope_kind:'NETWORK',
      permissions:['organization.directory.review'], approval_reference:input.approvalReference,
      provisioner:'AUTHORIZED_OPERATOR_BOOTSTRAP' };
    const auditId = await writeAuditAndOutbox(client, {
      actorUserId:null, actorRole:null, orgUnitId:null, workItemId:null,
      action:'FIRST_ADMINISTRATOR_BOOTSTRAP', aggregateType:'access', aggregateId:grantId,
      aggregateVersion:1, requestId, beforeState:null, afterState:state, reason:input.reason,
      resolution:'APPLIED', retentionClass:'SECURITY_5Y', eventType:'access.first_administrator_bootstrapped',
      payload:state,
    });
    await client.query(`INSERT INTO administrator_bootstrap(user_id,grant_id,audit_id,reason,approval_reference)
      VALUES ($1,$2,$3,$4,$5)`,[userId,grantId,auditId,input.reason,input.approvalReference]);
    return { userId, grantId, auditId, role:'SUPER_ADMIN', permissions:['organization.directory.review'] };
  });
}
