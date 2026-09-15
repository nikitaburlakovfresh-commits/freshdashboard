# FRESH Portal — visual shell stage (TZ v2.12)

This is a visual implementation stage, NOT completion of the full specification.
It restores the recognizable dark network overview: sidebar, compact KPI rows,
light focus panels and expandable branches. The optional light theme persists
only `fresh-theme`. Inter, Fresh Blue #003DFF and the FRESH wordmark follow the
brand requirements. Dense dashboard typography is an adaptation of the brand
hierarchy; dark surfaces are an explicitly requested visual adaptation.

## What works now

- Existing R1 task actions, role grants, authentication and API contracts remain
  separate from the browser-local business data.
- QLIK Excel import is in a native modal drawer, available from the sidebar and
  overview toolbar. Explicit actual-sales dates, independent optional plan dates,
  period confirmation, limits, whole-batch validation and provenance are retained.
- Values come from the existing importer and its original source precedence,
  reconciliation and null rules. No new metric calculation engine was introduced.
- Branch disclosures display the union of uploaded branch names, not a fabricated
  organization hierarchy. Selecting a branch updates the original metric cards
  and source table. The table of all branches remains available.
- Import exists only in component memory. Navigation away from the dashboard,
  switching demo role, logout and reload clear it. Changing theme or opening and
  closing the drawer does not clear data. Reset clears data and reopens the drawer.
- Layout, task pages, notifications, login and module placeholders support dark
  and light themes and responsive navigation.

## Explicitly not implemented here

No invented RM names, division assignment, scores, RAG thresholds, RunRate,
turnover, focus targets, fresh-data timestamps or financial totals. Score cards
show no-data; focus panels explain required inputs. A validated OrgUnit mapping,
versioned formula and threshold policies and connected source data are still
required. Completing a task never automatically completes a business KPI.

Analytics, BDR, KPI/MBO, diary and the module map are navigation scaffolds, labelled
as future work. The module map preserves broader TZ scope; it is not an access
engine, Composition Engine, financial engine or complete implementation matrix.
There is no new server import, durable business-data storage, RBAC for local
Excel, offline queue, external integration or production readiness claim.

## Provenance and safe reuse

The user supplied a dark network screenshot as the visual reference. The legacy
division dashboard/sidebar/CSS were read-only references, not copied business
logic. Only the specific FRESH logo was reused after validating its XML: svg,
one g and six path elements, no scripts, URLs, account data or embedded images.
No credentials, personal datasets, legacy calculators or real workbooks belong
in this repository. Screenshot evidence must use empty or synthetic data only.

Canonical and public clients retain BrowserRouter/server authentication. The
separate local demonstration retains HashRouter, synthetic API adapter, role
switching and demo credentials. App and Login files must not be bulk-copied
between those variants. No publish, push or public deployment is part of this
visual stage.
