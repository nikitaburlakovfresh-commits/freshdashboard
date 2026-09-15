# First administrator — bounded bootstrap

## Requirement and effective permission

TZ v2.12 §3.2A names `SUPER_ADMIN` **«Владелец платформы»**, with default `NETWORK` scope. §45.1 explicitly prohibits automatic financial/HR access even for SUPER_ADMIN and requires permission + current assignment + scope checks. This release enforces exactly one new permission: `organization.directory.review`.

It permits read-only organizational directory metadata and name/affiliation history across the network, including synthetic A/B. It does **not** grant pilot task roles, task reads/writes, financial approvals, HR/personnel data, other users' notifications, legal records, break-glass, role writes, organization changes or import approvals. No actual business organization or legacy credential is imported.

This is not implementation of the full future administrator console, 30-role seed, generic role editor, permissions editor, reorganization workflow, or credential-rotation delivery service.

## Storage and authorization

- Additive `002_first_administrator.sql`; baseline and checksum-locked `001` remain unchanged.
- `roles` remains the shared catalog; its old two-value code constraint becomes a validated catalog identifier. Only `SUPER_ADMIN` is added. Scope currently supports `ORG_UNIT` and `NETWORK`; other full-TZ scopes remain future work.
- `role_grants` remains the sole assignment store, with explicit `scope_kind`. Existing grants default to `ORG_UNIT`, retaining their UUIDs and values. Composite FK enforces the role's scope. A NETWORK grant has no synthetic branch FK; it does not pretend the admin is an RM in A/B.
- A role name is not an authorization bypass. Directory queries join permissions, current grants, live user and session fences in the same SQL snapshot. Metadata dates never extend grant validity.
- `/me` returns scope and actual permissions. Client network grants have a null `org_unit_id` and do not become task-filter options.
- `/organization/admin-review` returns the directory read projection only when permission and NETWORK assignment are effective. RM/RF remain 403; hidden histories remain 404. All organization writes remain 403 after Origin/CSRF checks.

## One-shot operator procedure

There is no HTTP bootstrap endpoint. `server/scripts/bootstrapFirstAdmin.ts`, compiled with the server, reads `BOOTSTRAP_INPUT_FILE`: an absolute regular JSON file, mode 0600, root/current-user owned. Do not pass a password through argv, environment, shell history, source code or logs.

Input fields: `login` (lowercase personal login), `fullName` (explicitly confirmed name or login), `password` (operator-generated cryptographically random, at least 32 characters), `reason`, `approvalReference`. Never derive an email or reuse a legacy password.

Use a root-private file outside source repositories and a one-shot container with the reviewed production environment. The ordinary app continues to run as non-root. The operation:

1. Takes an advisory lock and identity/grant/catalog locks.
2. Refuses if any bootstrap journal, any previous SUPER_ADMIN grant (even revoked), or case-insensitive matching login exists. It never upgrades, resets or overwrites an existing identity.
3. Refuses if SUPER_ADMIN's permission set is anything other than the reviewed single directory-review permission.
4. Inserts one INDIVIDUAL with Argon2id password hash, one NETWORK grant, append-only audit and registered outbox event, and an immutable singleton bootstrap journal in one transaction.
5. Records authorization reference and reason; actor is null with explicit operator-bootstrap attribution, not a fabricated logged-in session. Credentials and hashes do not enter the audit payload.
6. A replay refuses safely; it does not rotate the password or invalidate any existing user's sessions.

Generate the initial credential exactly once in a protected operator input file, preserve it during any failed attempt, and only hand over the private access document after successful provisioning and HTTPS login checks. Logs contain status and IDs only. Protect backups too: they contain hashes, sessions and configuration.

## Password lifecycle boundary

TZ §3.7 describes operator-initiated bulk rotation and revocation fences; no automatic first-login password-change mandate was found in the reviewed §§3/45.1. This release adds neither a change-password UI nor forced-first-login rotation. Do not tell the account holder that a forced-change screen exists. Use a password manager, do not share the initial secret, and arrange a private operator-assisted rotation before routine long-term use; preserve existing auth-epoch/password-timestamp session fences when that separately reviewed operation is implemented.

## Release and rollback gates

Run all existing lifecycle/directory regressions plus `firstAdministrator.test.ts` on isolated Node 22/PostgreSQL 16. Rehearse the final migration and replay on a restored production backup, then bootstrap a separate synthetic test identity only in that isolated restore and exercise real API permission checks before production promotion.

Before production: backup database/globals/source/config/cert state, checksum archives, preserve previous image, compare business-table hashes, build candidate, verify original migration checksum. Production adds only the reviewed catalog data, one new personal identity/grant/journal, and normal login audit/session records. Existing business users/grants/tasks/organizations must be unchanged.

Promote app only; do not restart PostgreSQL/Caddy, reseed, drop schema, reset identities, replace secrets, disable TLS validation or change DNS. Retain additive schema on app rollback; do not restore a live database merely to roll back the application. A failed post-bootstrap deployment can leave the new account persisted; never rerun bootstrap to overwrite it.
