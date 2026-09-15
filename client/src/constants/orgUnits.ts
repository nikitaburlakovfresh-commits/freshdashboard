// PILOT ASSUMPTION: the OpenAPI contract never returns an org_unit display
// name in any response (Grant, WorkItem, Notification all expose only
// org_unit_id as a UUID) — see contracts/openapi.yaml schemas Grant/WorkItem.
// The pilot's schema.sql seeds exactly two fixed, deterministic org units
// ('A' / 'B') with these exact UUIDs (see contracts/schema.sql lines
// ~323-325). Mapping them here is a client-only display convenience for a
// closed, fixed pilot data set — not fabricated data — so the create-task
// form and grant labels show a human name instead of a raw UUID. If R2
// introduces more branches or a real identity adapter, this must be
// replaced by a server-provided display_name field instead.
export const ORG_UNIT_LABELS: Record<string, string> = {
  '00000000-0000-4000-8000-00000000000a': 'Синтетический филиал A',
  '00000000-0000-4000-8000-00000000000b': 'Синтетический филиал B',
};

export function orgUnitLabel(id: string): string {
  return ORG_UNIT_LABELS[id] ?? id;
}
