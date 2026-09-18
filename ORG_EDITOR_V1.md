# Organization editor — bounded change-set release

**Canonical scope addendum (local, 2026-09-18):** migration 010 and
`ORG_CANONICAL_SCOPE_V1.md` remove the A/B-only task/grant FK dependency.
This editor STILL creates PRE_LAUNCH only and grants no operational access.
Activation and assignment administration remain separate work, with no
automatic change to existing UUIDs, histories, permissions or grants.

Implements the approved next slice of TZ v2.12 §§2/3/16D/45.1/45.2/45.9, not
completion of the complete reorganization engine or approval of real mappings.

## Editable boundary

- One stable-unit operation per persisted change set: ORG_UNIT_CREATE,
  ORG_UNIT_RENAME, ORG_UNIT_MOVE_TO_CLUSTER (the latter supports legal parent
  kinds NETWORK/DIVISION/CLUSTER under the existing directory hierarchy rules).
- CREATE supports NETWORK, DIVISION, CLUSTER, ORG_UNIT, initially PRE_LAUNCH.
  No root is seeded. User explicitly creates/checks/applies the NETWORK.
- Renames and moves are limited to non-demo PRE_LAUNCH units originally created
  through this editor. Synthetic A/B, bridged task identities, imported or
  already-active identities cannot be modified. This is not a live-business
  reorganization with aggregate recomputation.
- Type and business model remain nullable when unconfirmed. The existing TZ
  enums are enforced; type_code is available only for ORG_UNIT. The TZ does not
  specify that missing information may be guessed. No legal references offered.
- No lifecycle transitions, owner changes, user/role grants, business activation,
  tasks, finance, metric recalculation, archive mappings or imports.
- Non-root creation needs an explicit valid parent. Parent kind, demo isolation,
  cycles, upstream orphans and future interval coverage are validated.
  Backdating is not supported. Rename/move dates must be strictly after the
  latest open interval start. Closed history cannot be overwritten.

## Contract and authorization

See `contracts/organization-changes.openapi.yaml`.

The standard shared roles/permissions/grants engine remains authoritative.
Phase permissions `organization.change.draft`, `.preview`, `.apply` are
release-defined catalog extensions. Operation permissions use the exact
§3.2 names `org_unit.create`, `org_unit.rename`, `org_unit.move`. Every request
needs current NETWORK assignment with null scope reference and current
`organization.directory.review`, the phase permission and operation permission.
Role text alone never authorizes. RM/RF retain 403 on editor endpoints.
No historical metadata date changes current grant evaluation.

Migration 003 only defines catalog/storage. It does NOT grant editor authority.
The operator-only `server/dist/scripts/provisionOrgEditor.js` command takes
`ORG_EDITOR_LOGIN` and `ORG_EDITOR_APPROVAL` (non-credential approval reference).
It requires the existing first-administrator bootstrap identity/assignment,
exact initial review-only permissions and no other SUPER_ADMIN grant. It adds
six role permissions, audit/outbox and immutable singleton provisioning journal
in one transaction. A replay returns ALREADY_PROVISIONED, never resets a
password or creates an identity. No HTTP provisioning endpoint.
Future assignment-management work must explicitly review SUPER_ADMIN's updated
role catalog; this release offers no means of creating another assignment.

## State, concurrency and evidence

DRAFT v1 → explicit preview → PREVIEW when valid, otherwise DRAFT with persisted
issues. Each successful save/preview/apply increases proposal bigint version.
Edits invalidate token and preview. Preview binds actor, content hash, proposal
version, whole-directory revision and 15-minute expiry. Apply requires the
exact expected version/token and revalidates under serialized directory locks.
Unrelated directory commits conservatively invalidate previews too.
APPLIED is immutable; correction requires a new proposal.

All commands require Idempotency-Key (30-day minimum retained shared store);
same key/different body is 409, successful replay rechecks current permission,
same apply with a new key/stale version is 409. No preview/apply combined action.
Identity/history, proposal, audit, outbox and idempotency result share one
transaction. Audit includes actor/time and before/proposed/after metadata;
no human reviewer signoff is fabricated. Event catalog policy is NONE, no
new external notifications. Credential/grant writers are serialized with the
short authorization transaction. Directory writes are table-serialized at
this low-volume administrative stage.

The editor list exposes the latest 100 matching proposals. Reopen loads current
persisted version and transition history. The preview itself is not a second
person's approval; this bounded stage permits the authorized actor to confirm.
The UI uses native HTML dialog for explicit application; local dirty/invalid/
expired/wrong-actor previews cannot enable Apply. Server is authoritative.

## Existing directory bridge and future import

This extends `org_directory_units` and its current name/affiliation history,
not a second org engine. The A/B `pilot_org_unit_id = id` bridge stays unchanged.
New directory units never become `org_units` task targets or grants.
Future reviewed importer must map external stable source keys to these same
directory UUIDs (including manually created units), propose conflicts, and
converge the constrained pilot task/grant references through a separately
reviewed migration. Never auto-create parents from legacy labels.
No actual mapping or archive apply has been approved in this release.

## Tests and operations

Baseline suite: `npm test --workspace=server`.
Independent editor suite, same guarded local fresh_pilot_test setup:
`npm test --workspace=server -- --testMatch '**/test/orgChanges.editor.ts'`.
Client tests: existing localImport/networkModel/organizationModel plus
orgChangeModel (bundle with existing esbuild and execute Node test runner).
Do not run test setup against a production or restored-business database.
The test setup is guarded by local host, exact DB name and PostgreSQL 16.

Migration 001/002 and baseline schema remain byte-identical. The existing
Dockerfile packages every migration, including 003. Rehearse a real DB backup
restore in isolated PG16; run compiled migrate and provisioning there; test
all three commands there. Rehearse old app against the additive database.
Production smoke must not apply business units: only read/auth and, if approved,
a clearly marked test draft/preview. Rollback application only; retain additive
DB, histories, account and provisioning journal. No DB restart or drop.

Canonical UI uses same-origin real API. Separate demo adapter is not synchronized
with the administrative editor and must not pretend to grant/write server data.
Full management gates/people approvals in DECISIONS_AND_GATES are not claimed.
