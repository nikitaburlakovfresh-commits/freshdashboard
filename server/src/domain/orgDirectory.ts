import { pool } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';

export const DIRECTORY_SCOPE = 'CURRENT_EXACT_PILOT_GRANTS' as const;

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
  WITH allowed AS MATERIALIZED (
    SELECT DISTINCT d.id
    FROM org_directory_units d
    JOIN role_grants g ON g.org_unit_id = d.pilot_org_unit_id
    JOIN role_permissions rp ON rp.role_code = g.role_code AND rp.permission_code = 'work_item.read'
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
      AND d.is_demo AND d.pilot_org_unit_id = d.id
  )`;

export async function getDirectoryTree(auth: AuthedUser, asOf: string) {
  const result = await pool.query(`${accessCte},
    visible AS MATERIALIZED (
      SELECT d.id,d.code,d.kind,d.type_code,d.lifecycle_state,d.is_demo,d.demo_locked,
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
    ) ORDER BY v.code), '[]'::jsonb) AS items FROM visible v`,
  [auth.userId, auth.sessionId, asOf]);
  return {
    as_of: asOf,
    scope_mode: DIRECTORY_SCOPE,
    items: result.rows[0].items,
    admin_review: { authorized: false, reason: 'ADMIN_ASSIGNMENT_NOT_CONFIGURED' },
  };
}

export async function getDirectoryHistory(auth: AuthedUser, id: string) {
  // Invalid and unknown IDs get the same no-existence response as hidden IDs.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new ApiError('NOT_FOUND', 'Организационная единица не найдена.');
  }
  const result = await pool.query(`${accessCte}
    SELECT d.id,
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
  return { ...result.rows[0], scope_mode: DIRECTORY_SCOPE };
}
