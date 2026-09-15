# Org Directory V1 — release boundary

Implemented against TZ v2.12 §2, §3, §16D, §45.1. This is a **read-only foundation**, not completion of roadmap stage 1, full RBAC or real-network onboarding.

## Model and migration

- `server/migrations/001_org_directory.sql` adds `org_directory_units`, `org_directory_name_history`, `org_directory_affiliation_history` to `pilot_r1`; `schema_migrations` records SQL filename and SHA-256. No baseline rewrite, task FK change, existing identity edit or grant insert.
- Directory UUID = pilot UUID for A/B, enforced by the bridge CHECK + FK. Existing A/B `org_units` rows and their restricted constraints remain unchanged. Additional NETWORK/DIVISION/CLUSTER/ORG_UNIT identities can exist in the directory, but cannot automatically become task targets or grants.
- Backfill only existing synthetic A/B. Name/affiliation history starts on the migration date: earlier business history is not fabricated. Parent, business model, branch type and legal references are unknown, not guessed.
- Name/affiliation intervals are PostgreSQL `daterange` `[from,to)` with `btree_gist` exclusion constraints. Closing an open interval once and appending a successor is allowed; overwriting/deleting committed history or reopening a closed interval is rejected. Stable identity rows are immutable in V1.
- Parent kinds increase strictly NETWORK → DIVISION → CLUSTER → ORG_UNIT (branches may also attach directly to NETWORK/DIVISION). This prevents cycles without recursive update races. Demo/non-demo edges cannot mix. Unconfirmed parents may be null.
- Legal entity/contract UUIDs are **reserved nullable fields**, not functioning registries or validated relationships. Their FK/approval contract is deferred. Type/lifecycle values are initial read-only metadata, not a complete transition engine.
- `aliases` has a storage field only; alias resolution, uniqueness governance, temporal parent coverage, full state histories and approved import mapping are not implemented.

This parallel directory is an additive rollout boundary around the constrained R1 pilot. The next reviewed migration must converge real OrgUnit/task references and grants; it must not create an independent alternative access engine.

## Access and API

See `contracts/organization-v1.openapi.yaml`.

- `GET /api/v1/organization/tree?as_of=YYYY-MM-DD`
- `GET /api/v1/organization/units/{id}/history`
- `GET /api/v1/organization/admin-review` — 403 for all implemented pilot identities.

V1 deliberately projects basic branch metadata using the existing exact `work_item.read` scope. Neither role names nor a historical `as_of` date grant access. Current active user/session and unexpired/unrevoked grants are joined in the same database statement as metadata. No ancestor names/IDs, sibling branches, people, aliases, legal names/entities/contracts, or free-text reasons are exposed. Unknown/hidden history IDs use indistinguishable 404 responses. Responses remain no-store.

No access-resolution audit registry, field policy engine, production grant writer, restriction engine, branch administrator, break-glass, or multi-role catalog is claimed. In-flight concurrent revocation follows PostgreSQL statement snapshot semantics; requests after a committed revocation are tested. Full serialization with a future grant writer still needs design/tests.

## Administration and roles

`rm_a` is still REGIONAL_MANAGER with exactly its A grant. RF remains RF. No role, permission or production assignment is added.

Exact §45.1 aliases for the **future approved registry**:

| Input alias | Canonical code |
|---|---|
| COMDIR | COMMERCIAL_DIRECTOR |
| DIVISION_HEAD | DIVISION_MANAGER |
| RM / RM_DIVISION | REGIONAL_MANAGER |
| BRANCH_MANAGER | RF |
| CFO | FINANCE_HEAD |
| HR_BP_UC | HR_UC |
| ACADEMY_HEAD | FRESH_ACADEMY |

This table is requirements documentation, **not an operational seed or implemented role resolver**. COMMERCIAL_DIRECTOR must never be substituted by REGIONAL_MANAGER. The initial 30-role catalog, extra §45.1 roles, documented-expiry signatory, PRIMARY/ACTING/SUPPORTING, owner relations, approvals, history and UI catalog remain future work.

No authenticated pilot can save or approve a proposal. All guessed unsafe organization routes enforce Origin/session/CSRF then deny. We did not add a superficially administrative role or persist proposals under RM permissions. Next slice needs an approved named administrator, explicit permissions, preview/CAS/idempotency/audit/approval contracts, and controlled grant provisioning.

## UI and variants

`/organization` replaces the old non-interactive structure note with a directory: date, scoped search, selected-unit facts, name/affiliation history, empty/error states, refresh and live admin permission check. Missing parents do not imply reorganization. Task and local network/import features are unchanged.

Canonical/clean variants call the real same-origin API. The separate `fresh-pplx-demo` uses only an in-memory synthetic adapter; its optional `demo_reviewer` is **not** a server role and has no task grants or administrative writes. Default A/B demo identities remain unchanged. Never copy the demo auth adapter into the canonical project.

## Release and rollback (review before executing)

1. Review the additive SQL/checksum, backups/restore evidence, deployed runtime and packaged SQL paths. Required runtime remains Node 22 + PostgreSQL 16.
2. Stop short of deploy until the release owner confirms it. No remote operations were performed by the org-feature work.
3. Run the migration with the reviewed migration account; use the same existing private environment, never test credentials. Source: `npm run db:migrate --workspace=server`; compiled: `node server/dist/scripts/migrate.js`. Ensure `server/migrations/001_org_directory.sql` is in the image.
4. Migration runner serializes with a session advisory lock. Every version + ledger insert commits atomically; rerun validates checksum and skips already applied versions. Never edit an applied SQL file—add a successor.
5. Promote the app only after migration succeeds; smoke-test A, B, hidden IDs, admin 403, tasks and sessions.
6. Roll back **application only** to the previous image if needed. Leave additive tables/ledger/history in place. No schema/table drops or reverse history rewrites. Failure inside the migration transaction rolls back its new objects automatically.
7. Migration extension installation privileges must be reviewed for the release environment; test role capability is not production least-privilege evidence.

## Evidence

Automated scope and remaining requirements: `ORG_STAGE1_REQUIREMENTS.tsv`; module-level source plan: `ROADMAP_MODULE_COVERAGE.tsv`.
The handoff outside this repository carries exact executed test/build results, paths to screenshots and private approval materials. No real structure, user roster or uploaded workbook content belongs in public sources.
