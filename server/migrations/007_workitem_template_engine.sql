-- 007: WorkItem template engine generalization (Phase A, ТЗ §13.13.1-13.13.5)
--
-- The R1 pilot hardcoded exactly one template ('pilot_task_v1'), one field
-- per work item ('completion_summary'), and a single-column submission
-- snapshot. ТЗ §13.13.1 requires a template designer where field_schema,
-- field_ownership_rules and field_visibility_rules are per-template and
-- admin-configurable, with system templates (daily_log_branch, mbo_target,
-- hr_reminder -- §13.13.4) versioned by adding new template_version rows,
-- never by mutating existing ones.
--
-- This migration only widens the schema. It changes NO existing row's
-- observable behavior: the pilot_task_v1 template, and every existing
-- work_item/work_item_fields/submissions row, keep working exactly as
-- before. workItemService.ts in this same change reads field_schema /
-- field_ownership_rules from the template instead of hardcoded literals,
-- but for pilot_task_v1 those values describe exactly the one field that
-- already existed, so no regression is introduced (covered by the full
-- existing test suite plus new template-engine tests).
--
-- Deliberately NOT done in this migration (tracked as follow-up, not
-- silently promised): multi-field submissions storage is added
-- (field_values jsonb) but createWorkItem still rejects templates whose
-- field_schema has more than one field, because submissions.completion_summary
-- is still NOT NULL / still assumed single-valued by reviewers reading a
-- submission snapshot. Lifting that limit is a separate, explicitly scoped
-- migration once the multi-field submission review UI/API contract is
-- decided.

SET LOCAL search_path = pilot_r1, pg_catalog;

-- ---- templates: replace fixed-value CHECKs with format-only CHECKs ----
ALTER TABLE templates DROP CONSTRAINT templates_code_check;
ALTER TABLE templates ADD CONSTRAINT templates_code_check
    CHECK (code ~ '^[a-z][a-z0-9_]{1,63}$');

ALTER TABLE templates DROP CONSTRAINT templates_version_check;
ALTER TABLE templates ADD CONSTRAINT templates_version_check
    CHECK (version >= 1);

ALTER TABLE templates DROP CONSTRAINT templates_field_schema_version_check;
ALTER TABLE templates ADD CONSTRAINT templates_field_schema_version_check
    CHECK (field_schema_version >= 1);

-- templates.field_path / templates.max_field_chars predate field_schema
-- below and were never read by server code (grep confirmed: only
-- work_item_fields.field_path and hardcoded string literals were read) --
-- drop them instead of leaving two unused columns that still assert a
-- single fixed field name/length at the template level.
ALTER TABLE templates DROP CONSTRAINT templates_field_path_check;
ALTER TABLE templates DROP CONSTRAINT templates_max_field_chars_check;
ALTER TABLE templates DROP COLUMN field_path;
ALTER TABLE templates DROP COLUMN max_field_chars;

-- ---- templates: add generalized template-engine columns ----
-- DEFAULT is used only to backfill the single existing pilot_task_v1 row
-- (templates_immutable blocks any later UPDATE, so backfill-via-DEFAULT is
-- the only way to give that frozen row real values); DROP DEFAULT
-- immediately after so every future INSERT must state its own
-- display_name/is_system/field_schema/field_ownership_rules/
-- field_visibility_rules explicitly instead of silently inheriting the
-- pilot template's shape.

ALTER TABLE templates ADD COLUMN display_name text NOT NULL
    DEFAULT 'Задача (пилот)';
ALTER TABLE templates ALTER COLUMN display_name DROP DEFAULT;

-- is_system: true for the existing pilot template (and future system
-- templates such as daily_log_branch/mbo_target/hr_reminder per
-- §13.13.4); future custom templates created via admin UI default false.
ALTER TABLE templates ADD COLUMN is_system boolean NOT NULL DEFAULT true;
ALTER TABLE templates ALTER COLUMN is_system SET DEFAULT false;

-- field_schema: ordered array of field definitions, e.g.
--   [{ "field_path": "completion_summary", "label": "Итог выполнения",
--      "type": "text", "required": true, "min_chars": 1, "max_chars": 4000 }]
-- Validated in application code against this shape; CHECK below only
-- guards the outer container (non-empty JSON array).
ALTER TABLE templates ADD COLUMN field_schema jsonb NOT NULL DEFAULT
    '[{"field_path":"completion_summary","label":"Итог выполнения","type":"text","required":true,"min_chars":1,"max_chars":4000}]'::jsonb
    CHECK (jsonb_typeof(field_schema) = 'array' AND jsonb_array_length(field_schema) >= 1);
ALTER TABLE templates ALTER COLUMN field_schema DROP DEFAULT;

-- field_ownership_rules: field_path -> role_code allowed to write that
-- field (§13.13.1). Pilot: only RF (the assignee) may write
-- completion_summary -- this is exactly the check patchWorkItemFields
-- already enforced in code; it is now data-driven instead of hardcoded.
ALTER TABLE templates ADD COLUMN field_ownership_rules jsonb NOT NULL DEFAULT
    '{"completion_summary":"RF"}'::jsonb
    CHECK (jsonb_typeof(field_ownership_rules) = 'object');
ALTER TABLE templates ALTER COLUMN field_ownership_rules DROP DEFAULT;

-- field_visibility_rules: field_path -> array of extra role_codes allowed
-- to read that field beyond the standard RM(scope)/assignee-RF card
-- visibility already enforced by getWorkItem/listWorkItems. Empty object
-- == no extra restriction, matching current pilot behavior where both RM
-- and the assignee RF see the one field on the card.
ALTER TABLE templates ADD COLUMN field_visibility_rules jsonb NOT NULL DEFAULT
    '{}'::jsonb CHECK (jsonb_typeof(field_visibility_rules) = 'object');
ALTER TABLE templates ALTER COLUMN field_visibility_rules DROP DEFAULT;

-- ---- work_item_fields: one row per (work_item, field), not per work_item ----
ALTER TABLE work_item_fields DROP CONSTRAINT work_item_fields_field_path_check;
ALTER TABLE work_item_fields ADD CONSTRAINT work_item_fields_field_path_check
    CHECK (field_path ~ '^[a-z][a-z0-9_]{1,63}$');

ALTER TABLE work_item_fields DROP CONSTRAINT work_item_fields_pkey;
ALTER TABLE work_item_fields ADD PRIMARY KEY (work_item_id, field_path);

-- No more single hardcoded default: every INSERT now states which field
-- path it is creating a row for (createWorkItem loops over
-- template.field_schema instead of relying on a column default).
ALTER TABLE work_item_fields ALTER COLUMN field_path DROP DEFAULT;

-- ---- submissions: add forward-compatible multi-field snapshot ----
-- completion_summary keeps its NOT NULL + length CHECK: every template in
-- this release still has exactly one field, so the legacy column keeps
-- holding that field's value verbatim and no existing reader of
-- s.completion_summary breaks. field_values is populated in parallel
-- ({field_path: value} for every field on the template, so pilot_task_v1
-- submissions get {"completion_summary": "..."} too) so that a future
-- migration lifting the single-field limit does not need to touch
-- already-written (immutable) submission rows again.
ALTER TABLE submissions ADD COLUMN field_values jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(field_values) = 'object');
ALTER TABLE submissions ALTER COLUMN field_values DROP DEFAULT;
