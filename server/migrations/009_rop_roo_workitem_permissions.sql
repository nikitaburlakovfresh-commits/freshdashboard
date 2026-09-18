-- Data-only migration. Seeds the executor-side work_item.* permission set
-- for ROP and ROO, mirroring exactly what RF already holds.
--
-- Why this is needed (found 2026-09-18 while generalizing work-item
-- authorization away from a hardcoded 'RF' literal, per "Авторизация по
-- всем ролям индивидуальная"): getEffectiveGrants() in
-- server/src/domain/grants.ts INNER JOINs role_grants to role_permissions
-- on role_code. A role with zero role_permissions rows produces zero
-- effective-grant rows for that role, even though role_grants correctly
-- records the user's grant. Migration 006 added ROP/ROO to the roles
-- catalog but never gave them any role_permissions rows, so a ROP/ROO
-- grant was silently invisible to every authorization check in
-- workItemService.ts -- not a code bug in that file, a missing seed here.
-- Caught by test/templateEngine.test.ts TE-09 (a ROP-owned template,
-- assigned to a ROP-grant-only user, failed to start with 403 FORBIDDEN
-- until this migration was added).
--
-- Scope: only ROP and ROO get this seed, because these are the two roles
-- with concrete evidence (the daily-log screenshots this session) of being
-- real work-item executors today. Per the project's standing rule against
-- inventing scope, no other role in the 20+ role catalog is seeded here
-- speculatively -- extending this same INSERT to another role is a one-line
-- follow-up once that role is actually assigned to own a template.
SET LOCAL search_path = pilot_r1, pg_catalog;

INSERT INTO role_permissions(role_code, permission_code)
SELECT r.role_code, p.code
FROM (VALUES ('ROP'), ('ROO')) AS r(role_code)
CROSS JOIN permissions p
WHERE p.code IN (
  'work_item.read', 'work_item.start', 'work_item.fields.write',
  'work_item.submit', 'work_item.history.read', 'notification.read'
)
ON CONFLICT (role_code, permission_code) DO NOTHING;
