import { PoolClient } from 'pg';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';

/** Same current-session/current-grant fences as directory commands.
 * Grant-scoped extension does not change the seven current role permissions. */
export async function stagingAccess(client:PoolClient,auth:AuthedUser) {
  await client.query('LOCK TABLE app_users,sessions,role_grants,roles,role_permissions,report_staging_access IN SHARE MODE');
  const r=await client.query(`SELECT g.id FROM role_grants g
    JOIN administrator_bootstrap b ON b.grant_id=g.id AND b.user_id=g.user_id
    JOIN report_staging_access p ON p.grant_id=g.id AND p.permission_code='data_source.probe'
    JOIN roles role ON role.code=g.role_code AND role.scope_kind=g.scope_kind
    JOIN role_permissions rp ON rp.role_code=role.code AND rp.permission_code='organization.directory.review'
    JOIN app_users u ON u.id=g.user_id JOIN sessions s ON s.user_id=u.id
    WHERE u.id=$1 AND s.id=$2 AND u.is_active AND u.user_kind='INDIVIDUAL'
      AND NOT u.password_last_shared_indicator AND s.revoked_at IS NULL
      AND s.captured_auth_epoch=u.auth_epoch AND u.password_hash_updated_at<=s.created_at
      AND s.expires_at>clock_timestamp() AND s.created_at>clock_timestamp()-interval '8 hours'
      AND s.last_seen_at>clock_timestamp()-interval '30 minutes'
      AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
      AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp()
      AND (g.valid_until IS NULL OR clock_timestamp()<g.valid_until)
      AND p.revoked_at IS NULL AND p.valid_from<=clock_timestamp()
      AND (p.valid_until IS NULL OR clock_timestamp()<p.valid_until)`,[auth.userId,auth.sessionId]);
  if(r.rowCount!==1) throw new ApiError('FORBIDDEN','Нет отдельного права data_source.probe с действующим назначением администратора NETWORK.');
  return r.rows[0].id as string;
}
