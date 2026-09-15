# Private report staging — bounded candidate

This is **not a completed import/Data Engine**. The new page is `/prepared-reports`.
The existing dashboard remains browser-local and receives no automatic server
snapshot. Neither migration nor upload creates networks, branches, assignments,
vehicles, employees, financial records or canonical metrics.

## Exact boundary

1. An explicitly enabled personal bootstrap administrator selects an existing
   non-demo root OrgUnit UUID and uploads one or two original aggregate XLSX files.
2. PostgreSQL reserves an immutable upload intent and file manifest. Originals
   are stored under cryptographic UUIDs in a private volume, outside the webroot.
3. A separate server worker validates the original bytes and runs the **same
   aggregate parser** as the browser. The parser now has one source location:
   `server/src/reporting/shared/`; browser imports are re-exports.
4. A valid structural preview is persisted as `NEEDS_MAPPING`, with report totals,
   branch rows, reconciliation, source sheet/cell provenance, parser version,
   unresolved mapping version and preview SHA-256. Invalid packages are
   `REJECTED`; one invalid file rejects the whole preview, with no partial records.
5. Every branch mapping has `org_unit_id: null`. `network_id` references the
   existing organization ledger; raw names are not new directory entities.
   There is **no commit or mapping-write endpoint** in this stage.

Only the two existing header-recognized aggregate formats are accepted:
summary sales/stock and sales/KSO/margin. No filename classification; no VIN,
manager-detail, BDR or other workbook formats. Cached formula values are not
accepted as facts: **any formula causes server rejection**, including an
otherwise recognized aggregate. Do not weaken this to make a workbook pass.

## Period and identity

Default metadata is `period: {state: "REQUIRES_CONFIRMATION"}`. Upload date, file
name, stock date and machine UTC date never confirm sales periods.
Confirmed metadata requires explicit sales dates and human confirmation text.
Plan dates are independent and optional together; their absence is flagged.
The confirmation records the signed-in actor's assertion, not external signoff.
Metadata is immutable: a genuinely different period makes a separate staged
packet; there is no edit/reclassify operation.

Content deduplication is persisted in PostgreSQL and covers actor + source code +
network UUID + sorted original SHA-256s + normalized period + parser/mapping
versions. Submitted filename/order and reworded confirmation do not affect
identity. Re-upload/re-probe of a completed packet returns its existing preview
without a new audit transition or canonical mutation.

## Access

Migration `004_report_staging.sql` only creates schema/catalog entries. It grants
**nothing** and never changes the seven `SUPER_ADMIN` role permissions.
`data_source.probe` is a proposed narrow catalog capability bound to the
pre-existing bootstrap NETWORK grant in `report_staging_access`; it is not a new
role, a financial entitlement or an all-network business-data grant.

Only after operator authority for this exact stage is established:

```sh
node server/dist/scripts/provisionReportStaging.js EXISTING_LOGIN \
  'Explicit approval reference for private aggregate staging only'
```

The CLI verifies the singleton named bootstrap user, current NETWORK grant and
exact existing seven editor permissions, writes audit/outbox atomically and
refuses silent reactivation. Passwords are neither generated nor updated.
No HTTP provisioning route exists. The original seven permissions returned by
`/me` remain unchanged; this capability is checked by the staging gateway.

Every list/detail/upload/probe/download request checks current session,
auth epoch, password rotation, active individual account, role permission,
bootstrap binding, grant validity/revocation and capability validity/revocation.
Database authorization locks are reacquired after uploads and worker processing.
Reads are scoped to **the current administrator's own staged packets**; an RM/RF
does not see raw network totals, names, packet existence or filenames.
There are no public object URLs or unauthenticated static source files.
Changing `network_id` or guessed client scopes cannot expand access.

## Quarantine and limits

**Antivirus is not connected in this candidate.** `malware_scan=NOT_SCANNED`
remains explicit even after structural preview. All originals stay in quarantine;
the authenticated download gateway deliberately refuses even administrator
downloads. This is conservative preparation, not §45.5 antivirus acceptance.
Do not describe XLSX validation as malware scanning or promote these files.

Server checks:

- Multipart: 1 metadata field (4 KiB), 1–2 XLSX, 8 MiB/file, 17 MiB request,
  20-second receive deadline; streaming byte count does not trust Content-Length.
- One receiving upload and one worker per app process; existing session rate
  limits also apply. Across instances PostgreSQL locks serialize quota/dedup.
- At most 100 stored packets / 256 MiB originals per actor. No automatic eviction.
- ZIP: signature/EOCD/central and local headers, nonoverlap, CRC, duplicate names,
  100 entries, 8 MiB/entry, 16 MiB expanded total, bounded compression ratio.
- Reject ZIP64/encryption/macros/embedded parts, external relationships, DTD/
  entities, any formula, unsupported worksheet layout and arbitrary extraction.
- Existing aggregate parser: one sheet, max 500 branches and 64 columns; strict
  numbers, immutable official total row 2, null is never silently zero.
- Worker: 10-second deadline, 96 MiB old generation + 16 MiB young generation,
  4 MiB stack; terminated on completion/error/timeout. ZIP bounds separately
  bound external typed-array allocations. No file evaluation, LLM or network fetch.
- Unhandled staging diagnostics log only request ID, not private source values.

## Private storage and crash behavior

`REPORT_STORAGE_DIR=/var/lib/fresh/report-quarantine` is backed by the named
`fresh_report_quarantine` Compose volume. Image directory owner is the non-root
`node` runtime user, mode 0700; batch directories are 0700, originals 0600.
Display names are sanitized; storage paths use generated UUIDs exclusively.
Exclusive/no-follow creation, fsync of files/directories and hash-verified reads
protect against overwrite, path traversal, symlink/hardlink and truncation.

The transaction boundary is **durable intent → private bytes → READY transition**.
The DB never advertises a ready packet before its source bytes are durable.
If reserve/audit fails, no files were written. If disk/process/final audit fails,
the committed `WRITING` intent remains visible as incomplete quarantine. A probe
can recover that intent only if **all** expected original bytes match their
immutable size/hash. Missing or partial originals remain blocked, never silently
replaced. Concurrent finalization returns an already-completed state.
An ambiguous DB commit is never followed by an unsafe unlink.

This avoids untracked application-created orphan blobs: every newly created
directory has a previously committed DB intent. The inventory CLI below reports
unreferenced/missing/tampered storage and incomplete intents without exposing
contents or deleting old files:

```sh
node server/dist/scripts/inventoryReportQuarantine.js
```

Automatic removal/retention and antivirus release remain **not implemented**.
An interrupted incomplete packet cannot be blindly retried to overwrite its
original manifest. Operator investigation is required; retain original bytes.
Backups must include both DB and this private volume consistently. Restoring
one without the other cannot be called a successful restore.

## Candidate release procedure (operator gate, not an executed deployment)

1. Obtain a successful explicit root receipt or reuse existing real FRESH root.
   Do not seed real branches from report names. Check current live commit first.
2. Privately back up DB/config/source and existing volume if present; record
   hashes, current app image and unchanged PostgreSQL/Caddy container identities.
3. Build the candidate Node 22 image and verify compiled worker, SQL 004 and
   non-root private volume ownership. Runtime-only dependency audit must pass.
4. Rehearse migration/replay and source+DB restore in an isolated PostgreSQL 16
   deployment with distinct storage. Do not mount production data volumes.
5. Apply additive migration 004; separately run the approved provisioning CLI.
6. Promote the app only (`--no-deps --no-build`), preserving DB and Caddy. Confirm
   named volume persists after app recreation; never `down -v`.
7. Test actual authenticated HTTPS with current grants. Only then upload the two
   authorized original aggregates privately, retaining unknown period if needed.
8. App-only rollback may leave additive staging data/permissions present but
   unreachable in the old UI. Never drop schema, reset credentials or restore a
   live database merely to roll back an app image.

Do not execute this checklist merely because it exists. The task handoff records
whether root/provisioning/deployment/real-file upload actually occurred.

## Local tests

Use the existing guarded local `fresh_pilot_test` PostgreSQL 16 database and
Node 22; never production credentials. Build the worker before the source tests:

```sh
npm ci --include=dev
npm run build
npm test --workspace=server
npm test --workspace=server -- --testMatch '**/test/orgChanges.editor.ts'
npm test --workspace=server -- --testMatch '**/test/reportBatches.staging.ts'
```

All committed fixtures are synthetic. Browser QA and original-source tests must
not add real workbooks, private screenshots, credentials or audit exports to Git.
This page is not connected to the separate demo preview application.

## Confirmed future delivery channel

Owner clarification, 15 September 2026, 21:02 MSK: QLIK aggregates will be
available from cloud storage on a schedule. Manual upload here is a temporary
verification/reserve channel, not the target recurring operating process.
Future scheduled delivery must reuse this private quarantine, original-byte
validation, immutable manifests, period provenance and unresolved Org UUID
mapping boundary. No cloud credentials, transport URL, scheduler, connector or
Computer recurring task is configured by this release. Re-attaching the same
workbooks does not establish a new business period or authorize more formats.
