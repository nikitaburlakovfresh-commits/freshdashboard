import type { PoolClient } from 'pg';

/**
 * Привязка филиала к зоне регионального менеджера и дивизиону на дату конца
 * периода. Подчинённость берётся из истории привязок справочника, поэтому смена
 * структуры не искажает исторические срезы. Отсутствие привязки остаётся
 * отсутствием: портал не подставляет «прочие» и не придумывает руководителя.
 */
export interface BranchAffiliation {
  cluster_id: string | null; cluster_name: string | null;
  division_id: string | null; division_name: string | null;
  manager_user_id: string | null; manager_name: string | null;
  group_label: string; group_key: string;
}

/** «РМ Широкоступ» из «Зона РМ Широкоступ Игорь»; вакансия называется вакансией. */
function labelFromCluster(name: string | null): string {
  if (!name) return 'Филиал без зоны РМ';
  const cleaned = name.replace(/^Зона\s+/i, '').trim();
  if (/вакан/i.test(cleaned)) return 'РМ не назначен';
  const m = /^РМ\s+([^\s]+)/i.exec(cleaned);
  return m ? `РМ ${m[1]}` : cleaned;
}

export async function branchAffiliations(c: PoolClient, branchIds: string[], on: string):
Promise<Map<string, BranchAffiliation>> {
  const result = new Map<string, BranchAffiliation>();
  if (!branchIds.length) return result;
  const rows = (await c.query(`WITH RECURSIVE chain AS (
      SELECT u.id AS leaf, a.parent_id AS node, 1 AS depth
      FROM org_directory_units u
      LEFT JOIN org_directory_affiliation_history a ON a.org_unit_id=u.id
        AND $2::date >= a.effective_from AND (a.effective_to IS NULL OR $2::date < a.effective_to)
      WHERE u.id = ANY($1::uuid[])
      UNION ALL
      SELECT ch.leaf, a.parent_id, ch.depth+1
      FROM chain ch
      JOIN org_directory_affiliation_history a ON a.org_unit_id=ch.node
        AND $2::date >= a.effective_from AND (a.effective_to IS NULL OR $2::date < a.effective_to)
      WHERE ch.node IS NOT NULL AND ch.depth < 10
    )
    SELECT ch.leaf branch_id, n.kind, ch.node node_id, h.display_name
    FROM chain ch
    JOIN org_directory_units n ON n.id=ch.node
    LEFT JOIN org_directory_name_history h ON h.org_unit_id=n.id
      AND $2::date >= h.effective_from AND (h.effective_to IS NULL OR $2::date < h.effective_to)
    WHERE n.kind IN ('CLUSTER','DIVISION')`, [branchIds, on])).rows as
    { branch_id: string; kind: string; node_id: string; display_name: string | null }[];

  for (const id of branchIds) {
    result.set(id, { cluster_id: null, cluster_name: null, division_id: null, division_name: null,
      manager_user_id: null, manager_name: null, group_label: 'Филиал без зоны РМ', group_key: 'none' });
  }
  for (const r of rows) {
    const entry = result.get(r.branch_id);
    if (!entry) continue;
    if (r.kind === 'CLUSTER' && !entry.cluster_id) { entry.cluster_id = r.node_id; entry.cluster_name = r.display_name; }
    if (r.kind === 'DIVISION' && !entry.division_id) { entry.division_id = r.node_id; entry.division_name = r.display_name; }
  }

  // Действующий региональный менеджер зоны: назначение на саму зону РМ.
  const clusters = [...new Set([...result.values()].map(v => v.cluster_id).filter((v): v is string => !!v))];
  if (clusters.length) {
    const managers = (await c.query(`SELECT g.org_unit_id cluster_id,u.id user_id,u.full_name
      FROM role_grants g JOIN app_users u ON u.id=g.user_id
      WHERE g.role_code='REGIONAL_MANAGER' AND g.scope_kind='ORG_UNIT'
        AND g.org_unit_id = ANY($1::uuid[]) AND g.revoked_at IS NULL
        AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now()) AND u.is_active
      ORDER BY g.org_unit_id,g.valid_from`, [clusters])).rows as
      { cluster_id: string; user_id: string; full_name: string | null }[];
    const byCluster = new Map<string, { user_id: string; full_name: string | null }>();
    for (const m of managers) if (!byCluster.has(m.cluster_id)) byCluster.set(m.cluster_id, m);
    for (const entry of result.values()) {
      const m = entry.cluster_id ? byCluster.get(entry.cluster_id) : undefined;
      if (m) { entry.manager_user_id = m.user_id; entry.manager_name = m.full_name; }
    }
  }
  for (const entry of result.values()) {
    const surname = entry.manager_name ? entry.manager_name.trim().split(/\s+/)[0] : null;
    entry.group_label = surname ? `РМ ${surname}` : labelFromCluster(entry.cluster_name);
    entry.group_key = entry.cluster_id ?? 'none';
  }
  return result;
}
