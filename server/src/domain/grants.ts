import { PoolClient } from 'pg';

interface GrantBase {
  id: string;
  validFrom: string;
  validUntil: string | null;
  permissions: string[];
}
export type EffectiveGrant = GrantBase & (
  { role: 'REGIONAL_MANAGER' | 'RF'; scopeKind:'ORG_UNIT'; orgUnitId:string } |
  { role: 'SUPER_ADMIN'; scopeKind:'NETWORK'; orgUnitId:null }
);

// Only effective, not expired/revoked grants (contract getMe description +
// §2 requirement R1-02). Uses `client` so it participates in the caller's
// transaction/lock ordering when needed (fences must be consistent).
export async function getEffectiveGrants(client: PoolClient, userId: string): Promise<EffectiveGrant[]> {
  const res = await client.query(
    `SELECT rg.id, rg.role_code as role, rg.scope_kind, rg.org_unit_id, rg.valid_from, rg.valid_until,
            array_agg(rp.permission_code) as permissions
     FROM role_grants rg
     JOIN role_permissions rp ON rp.role_code = rg.role_code
     WHERE rg.user_id = $1
       AND rg.revoked_at IS NULL
       AND rg.valid_from <= now()
       AND (rg.valid_until IS NULL OR rg.valid_until > now())
     GROUP BY rg.id, rg.role_code, rg.org_unit_id, rg.valid_from, rg.valid_until`,
    [userId],
  );
  return res.rows.map((r) => ({
    id: r.id,
    role: r.role,
    scopeKind: r.scope_kind,
    orgUnitId: r.org_unit_id,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    permissions: r.permissions,
  }));
}

export async function hasGrant(
  client: PoolClient,
  userId: string,
  role: 'REGIONAL_MANAGER' | 'RF',
  orgUnitId: string,
): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM role_grants
     WHERE user_id = $1 AND role_code = $2 AND org_unit_id = $3
       AND revoked_at IS NULL AND valid_from <= now()
       AND (valid_until IS NULL OR valid_until > now())`,
    [userId, role, orgUnitId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function isActiveRfWithGrant(client: PoolClient, userId: string, orgUnitId: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM app_users u
     JOIN role_grants rg ON rg.user_id = u.id
     WHERE u.id = $1 AND u.is_active AND NOT u.password_last_shared_indicator
       AND rg.role_code = 'RF' AND rg.org_unit_id = $2
       AND rg.revoked_at IS NULL AND rg.valid_from <= now()
       AND (rg.valid_until IS NULL OR rg.valid_until > now())`,
    [userId, orgUnitId],
  );
  return (res.rowCount ?? 0) > 0;
}
