# Local Excel source: sales and stock

This feature is a browser-local aggregate report viewer. It is not a server data
integration or an authorization boundary. No uploaded workbook or its contents
belong in this repository, in `dist`, in fixtures, or in screenshots.

## Supported source contracts

One worksheet, headers in row 1, official network total in row 2 (A2 may be
blank), branch rows from row 3. Detection is based on headers, never filenames.

* Summary: H = actual units; W = margin **including KSO**; E = stock units;
  AB = stock 45+ units. N is margin excluding KSO; U is KSO. Stock snapshot
  dates in E1 and AB1 must be valid and identical.
* Sales/KSO/margin: C = actual units; P = margin **including KSO**; B = plan
  units. M is margin excluding KSO; J is KSO.
* Other schemas are skipped. Unsupported detail rows are not converted into
  application records or displayed. Only aggregate selected columns leave the
  parsing worker. No VINs, staff, CRM URLs or unused columns are retained.

The user must declare and confirm actual-sales start/end dates for the entire
batch. Do not infer them from filenames, the current month or the stock date.
Optional plan start/end dates are separate. Without a declared plan period the
plan value is hidden. A completion ratio is calculated only when plan and actual
dates exactly match and both values exist, with a positive plan.

## State and precedence

* Each successful import atomically replaces the full previous batch.
* Multiple reports of the same type reject the new batch. Invalid new files
  never partially overwrite the current batch.
* If present, the summary is the sole source for sales/margin cards, even when
  an individual branch or cell is absent. There is no per-cell fallback.
* The network figure is the official row 2, not network-plus-branches and not a
  sum of both reports. Reconciliation separately compares official totals to
  complete branch sums (monetary tolerance below 0.01).
* Branch choices are a union, not an inner join. Missing per-report branches
  remain missing. Task grants/org units never filter this local file view.
* Nulls/dashes remain missing. Negative money is valid; negative/fractional
  counts are rejected. Formula caches are read; formulas are never executed.
* Component-local React state only. No storage API, API calls, uploads,
  telemetry, persistence or export. Navigation, role change, reset and reload
  discard the local state. Worker references and selected file inputs are
  cleared after processing, and workers terminate on completion/unmount.

## Bounds and dependencies

At most 9 files, 15 MiB per file, 40 MiB per batch. ZIP preflight checks at most
250 unique entries and 50 MiB total expanded data (30 MiB per entry) before
decompression. Recognized aggregates allow 500 branches, 64 columns, valid
unique cell/row references; VBA and unsupported structures are rejected.
A cancelable worker enforces a 30-second timeout. These are practical client
bounds, not a server-side malware-scanning claim.

Pinned reader: `read-excel-file@9.3.10`, using its universal entry point inside
the worker; ZIP preflight: `fflate@0.8.3`. No CDN runtime dependency and no
SheetJS `xlsx@0.18.5`. Run `npm audit --omit=dev` from the workspace root to
check production dependencies. Existing dev-tool findings are separate.

## Local build and synthetic tests

From this client directory (after installing workspace dependencies):

```sh
./node_modules/.bin/tsc -b
./node_modules/.bin/vite build --base=./
./node_modules/.bin/esbuild tests/localImport.test.ts --bundle --platform=node \
  --format=esm --outfile=/tmp/fresh-local-import-test.mjs
node --test /tmp/fresh-local-import-test.mjs
```

In an npm workspace, binaries may be at `../node_modules/.bin/` instead.
Use `npm run build --workspace=client` from the repository root for the
canonical same-origin build. The standalone demo uses `--base=./`.

Tests deliberately construct anonymous synthetic workbooks in memory. They
cover types, missing/negative values, dates, total/branch separation, margin
semantics, duplicate names, branch unions, actual ZIP/XML decoding, shared and
inline strings, cached/uncached formulas, unsupported files and sparse/duplicate
cell guards. Uploaded user workbooks are validated only in local browser QA,
never added as fixtures. Public screenshots must contain synthetic data only.

## Scope / limitations

This is the first source on the dashboard, not a complete analytics suite.
Seven other report formats are intentionally unsupported. Headers, layout and
sheet structure must follow the contracts above; renamed files are fine, but
rearranged columns, title rows and multi-sheet variants are not supported.
No server sync, historical comparison, automated freshness, forecast or RBAC
for the uploaded branches is claimed. Saved formula caches can be stale; the
viewer does not recalculate Excel. Full analytics/BDR/KPI modules remain
placeholders; branch drilldown and source reconciliation are on the dashboard.
