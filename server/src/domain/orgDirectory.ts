import { pool } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';

// Legacy wire name retained for old clients; scope is now exact canonical
// branch UUIDs, not limited to pilot A/B. No inheritance is introduced.
export const DIRECTORY_SCOPE = 'CURRENT_EXACT_PILOT_GRANTS' as const;
export const ADMIN_DIRECTORY_SCOPE = 'CURRENT_NETWORK_DIRECTORY_REVIEW' as const;

export function parseDirectoryDate(raw: unknown): string {
  if (raw === undefined) return new Date().toISOString().slice(0, 10);
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw) ||
      raw < '1900-01-01' || raw > '9999-12-31' ||
      Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ||
      new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) !== raw) {
    throw new ApiError('VALIDATION_ERROR', 'as_of: требуется существующая дата YYYY-MM-DD, не ранее 1900-01-01.');
  }
  return raw;
}

// Scope and data are resolved in ONE statement at request time. as_of changes
// metadata only, NEVER grant validity. No descendant/ancestor scope expansion.
// Recheck live session/user fences in the same snapshot as the directory read.
const accessCte = `
  WITH live_permissions AS MATERIALIZED (
    SELECT g.org_unit_id,g.scope_kind,rp.permission_code
    FROM role_grants g
    JOIN roles r ON r.code=g.role_code AND r.scope_kind=g.scope_kind
    JOIN role_permissions rp ON rp.role_code = g.role_code
    JOIN app_users u ON u.id = g.user_id
    JOIN sessions s ON s.user_id = u.id AND s.id = $2
    WHERE u.id = $1 AND u.is_active AND u.user_kind = 'INDIVIDUAL'
      AND NOT u.password_last_shared_indicator
      AND s.revoked_at IS NULL AND s.captured_auth_epoch = u.auth_epoch
      AND u.password_hash_updated_at <= s.created_at
      AND s.expires_at > now() AND s.created_at > now() - interval '8 hours'
      AND s.last_seen_at > now() - interval '30 minutes'
      AND g.revoked_at IS NULL AND g.valid_from <= now()
      AND (g.valid_until IS NULL OR now() < g.valid_until)
  ), directory_admin AS MATERIALIZED (
    SELECT 1 FROM live_permissions
    WHERE scope_kind='NETWORK' AND org_unit_id IS NULL
      AND permission_code='organization.directory.review'
  ), allowed AS MATERIALIZED (
    SELECT d.id FROM org_directory_units d
    WHERE EXISTS(SELECT 1 FROM directory_admin)
      OR (d.kind='ORG_UNIT' AND EXISTS (
        SELECT 1 FROM live_permissions g WHERE g.scope_kind='ORG_UNIT'
          AND g.org_unit_id=d.id AND g.permission_code='work_item.read'
      ))
  )`;

export async function getDirectoryTree(auth: AuthedUser, asOf: string) {
  const result = await pool.query(`${accessCte},
    visible AS MATERIALIZED (
      SELECT d.id,d.code,d.kind,d.type_code,org_lifecycle_at(d.id,$3::date) lifecycle_state,d.is_demo,d.demo_locked,
             n.display_name,n.effective_from AS name_from,n.effective_to AS name_to,
             a.parent_id,a.business_model,a.effective_from AS affiliation_from,a.effective_to AS affiliation_to
      FROM allowed x JOIN org_directory_units d ON d.id=x.id
      JOIN org_directory_name_history n ON n.org_unit_id=d.id
        AND $3::date >= n.effective_from AND (n.effective_to IS NULL OR $3::date < n.effective_to)
      JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id
        AND $3::date >= a.effective_from AND (a.effective_to IS NULL OR $3::date < a.effective_to)
      WHERE $3::date >= d.effective_from AND (d.effective_to IS NULL OR $3::date < d.effective_to)
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',v.id,'code',v.code,'kind',v.kind,'type_code',v.type_code,
      'lifecycle_state',v.lifecycle_state,'is_demo',v.is_demo,'demo_locked',v.demo_locked,
      'display_name',v.display_name,
      'parent_id',CASE WHEN EXISTS(SELECT 1 FROM visible p WHERE p.id=v.parent_id) THEN v.parent_id ELSE NULL END,
      'business_model',v.business_model,
      'name_effective_from',to_char(v.name_from,'YYYY-MM-DD'),
      'name_effective_to',to_char(v.name_to,'YYYY-MM-DD'),
      'affiliation_effective_from',to_char(v.affiliation_from,'YYYY-MM-DD'),
      'affiliation_effective_to',to_char(v.affiliation_to,'YYYY-MM-DD')
    ) ORDER BY v.code), '[]'::jsonb) AS items,
    EXISTS(SELECT 1 FROM directory_admin) AS admin_authorized FROM visible v`,
  [auth.userId, auth.sessionId, asOf]);
  return {
    as_of: asOf,
    scope_mode: result.rows[0].admin_authorized ? ADMIN_DIRECTORY_SCOPE : DIRECTORY_SCOPE,
    items: result.rows[0].items,
    admin_review: result.rows[0].admin_authorized
      ? { authorized:true, permission:'organization.directory.review', writes_authorized:false }
      : { authorized:false, reason:'ADMIN_REVIEW_PERMISSION_REQUIRED' },
  };
}

export async function getAdministrationReview(auth: AuthedUser, asOf: string) {
  // Same statement/snapshot as metadata: no separate role-name bypass.
  const tree = await getDirectoryTree(auth, asOf);
  if (!tree.admin_review.authorized) {
    throw new ApiError('FORBIDDEN','Для проверки справочника требуется действующее административное назначение и permission.');
  }
  return tree;
}

export async function getDirectoryHistory(auth: AuthedUser, id: string) {
  // Invalid and unknown IDs get the same no-existence response as hidden IDs.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError('NOT_FOUND', 'Организационная единица не найдена.');
  }
  const result = await pool.query(`${accessCte}
    SELECT d.id, EXISTS(SELECT 1 FROM directory_admin) AS admin_authorized,
      jsonb_build_object('state',d.lifecycle_state,'effective_from',to_char(d.effective_from,'YYYY-MM-DD')) AS lifecycle_baseline,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('state','ACTIVE',
        'effective_from',to_char(a.effective_from,'YYYY-MM-DD'),'recorded_at',a.recorded_at)
        ORDER BY a.effective_from),'[]'::jsonb) FROM org_branch_activations a WHERE a.org_unit_id=d.id) AS lifecycle,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'display_name',n.display_name,'effective_from',to_char(n.effective_from,'YYYY-MM-DD'),
        'effective_to',to_char(n.effective_to,'YYYY-MM-DD')
      ) ORDER BY n.effective_from),'[]'::jsonb) FROM org_directory_name_history n WHERE n.org_unit_id=d.id) AS names,
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
        'parent_id',CASE WHEN EXISTS(SELECT 1 FROM allowed p WHERE p.id=a.parent_id) THEN a.parent_id ELSE NULL END,
        'business_model',a.business_model,'effective_from',to_char(a.effective_from,'YYYY-MM-DD'),
        'effective_to',to_char(a.effective_to,'YYYY-MM-DD')
      ) ORDER BY a.effective_from),'[]'::jsonb) FROM org_directory_affiliation_history a WHERE a.org_unit_id=d.id) AS affiliations
    FROM allowed x JOIN org_directory_units d ON d.id=x.id WHERE d.id=$3::uuid`,
  [auth.userId, auth.sessionId, id]);
  if (!result.rowCount) throw new ApiError('NOT_FOUND', 'Организационная единица не найдена.');
  const { admin_authorized, ...history } = result.rows[0];
  return { ...history, scope_mode: admin_authorized ? ADMIN_DIRECTORY_SCOPE : DIRECTORY_SCOPE };
}
