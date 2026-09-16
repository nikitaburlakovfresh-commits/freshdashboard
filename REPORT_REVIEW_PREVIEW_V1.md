# Saved reports → draft review → network preview

Local candidate; no canonical publication, no new grants. This extends the same
private staging pipeline, not a second business data engine.

## Contract before implementation

- GET `/api/v1/report-batches/:id/review`: current draft (version 0 when absent),
  eligible **current** same-root, non-demo OrgUnit candidates, source row UUIDs,
  last 20 immutable revision summaries, stale mapping indicators.
- POST same path: `Idempotency-Key`, `expected_version`, `preview_hash`,
  `period` (null or explicit inclusive dates + basis), `edits` (0–100 pairs
  `{item_id,org_unit_id}`; null clears), `reason` (10–500 chars).
  Edits address stable source row UUIDs, never array offsets. Unmentioned rows
  retain their proposal. Entire command is atomic. Maximum JSON remains 32 KiB.
- GET `/api/v1/report-batches/:id/overview`: immutable aggregate source values
  + current saved draft, provenance/control totals and per-source branch cards.
- GET `/api/v1/report-batches/:id/branches/:itemId`: one exact source row,
  same authorization and provenance. A source row is NOT an activated branch.
- Every endpoint: current individual bootstrap admin + current NETWORK grant
  + separately provisioned `data_source.probe` + own batch. Current grant/session
  and capability are rechecked, including idempotent replay. RM/RF denied.
- Common errors: 401 session, 403 capability/origin/CSRF, 404 foreign/unknown
  batch/row, 409 version/hash/idempotency conflict, 422 shape/date/mapping/limit,
  429 rate limit, 503 temporary failure. No public downloads or cached data.

Migration 005 only adds append-only draft revisions and one command/event code.
It does not modify source hashes, immutable period metadata, original probe,
OrgUnits, assignments, permissions or official snapshots. Audit + NONE-policy
outbox + idempotent response commit with each revision. No runtime migration.
Code rollback to 004-compatible app leaves review rows intact; forward migration
has no destructive down. Maximum 1000 draft revisions per batch.

## Honest UI and business boundary

Screenshots inform structure only: dark FRESH shell, summary cards, source
selector, branch grid and detail. Source formats remain separate tabs; totals
are their own row 2, never added together. Identical names across files are NOT
merged into an identity. Draft UUIDs do not merge facts or change access.
No RAG, score, RM grouping, run-rate, focus tasks or ratio is inferred.
Null is not zero. Numeric cells retain sheet/column/row and source hash.

Period entries are proposals, not owner approvals; `period=null` means unknown.
Dates display inclusive; no business time interval is published. Current mapping
candidates are not historical affiliation evidence. Effective-period membership,
business models, responsible managers and authoritative period still need owner
review. AV is NOT_SCANNED and originals stay quarantined. Even a complete draft
cannot publish. API has no approval or commit action.

QLIK cloud scheduled delivery remains the target; manual upload is a temporary
test/reserve channel. No connector/auth/scheduler included in this slice.

## Verification and release boundary

Run with Node 22 and an isolated PostgreSQL 16 `fresh_pilot_test` database,
never with production connection variables:

```
npm run build
npm test --workspace=server
npm test --workspace=server -- --testMatch '**/test/orgChanges.editor.ts'
npm test --workspace=server -- --testMatch '**/test/reportBatches.staging.ts'
npm test --workspace=server -- --testMatch '**/test/reportReview.drafts.ts'
```

The additional 31 API/DB tests cover current permission expiry/revocation,
ownership, CSRF/origin, idempotency replay, CAS/concurrency, stale candidates,
atomic audit rollback, source immutability and fresh application reads. Client
model checks are in `client/tests/savedReportModel.test.ts` (five tests).
Synthetic browser QA must additionally exercise both formats, filtering,
source-detail provenance, draft persistence, conflicting tabs, revoked-access
clearing, desktop/mobile and both themes. No real workbook fixtures belong in
the repository or static bundle.

This is a local development candidate, not release authorization. A later
controlled release requires separate review, backup/restore rehearsal and
deployment checks. Existing runtime dependency versions are unchanged. No
claim of full TZ §45, canonical ingestion or production readiness is implied.
