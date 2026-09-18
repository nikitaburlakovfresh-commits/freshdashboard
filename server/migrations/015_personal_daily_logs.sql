-- Personal beta journals reuse the WorkItem lifecycle; never a shared branch form.
-- Policies have no seeded business defaults. RM explicitly configures each role.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
CREATE TABLE daily_log_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
  role_code text NOT NULL REFERENCES roles(code),
  version integer NOT NULL CHECK(version > 0),
  effective_from date NOT NULL,
  base_open_time time NOT NULL,
  base_close_time time NOT NULL CHECK(base_close_time > base_open_time),
  early_open_hours integer NOT NULL CHECK(early_open_hours BETWEEN 0 AND 24),
  late_close_hours integer NOT NULL CHECK(late_close_hours BETWEEN 0 AND 48),
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 5 AND 500),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(org_unit_id,role_code,version)
);
CREATE TRIGGER daily_policy_immutable BEFORE UPDATE OR DELETE ON daily_log_policies
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TABLE daily_log_records (
  work_item_id uuid PRIMARY KEY REFERENCES work_items(id),
  org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
  user_id uuid NOT NULL REFERENCES app_users(id),
  role_code text NOT NULL REFERENCES roles(code),
  business_date date NOT NULL,
  policy_id uuid NOT NULL REFERENCES daily_log_policies(id),
  base_open timestamptz NOT NULL,
  base_close timestamptz NOT NULL,
  window_open timestamptz NOT NULL,
  window_close timestamptz NOT NULL,
  UNIQUE(org_unit_id,user_id,role_code,business_date),
  FOREIGN KEY(work_item_id,org_unit_id) REFERENCES work_items(id,org_unit_id),
  CHECK(window_open <= base_open AND base_open < base_close AND base_close <= window_close)
);
CREATE TRIGGER daily_record_immutable BEFORE UPDATE OR DELETE ON daily_log_records
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TABLE daily_log_links (
  daily_log_id uuid NOT NULL REFERENCES daily_log_records(work_item_id),
  submission_id uuid NOT NULL REFERENCES submissions(id),
  linked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(daily_log_id,submission_id)
);
CREATE TRIGGER daily_link_immutable BEFORE UPDATE OR DELETE ON daily_log_links
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
INSERT INTO templates(id,code,version,display_name,is_system,field_schema,field_ownership_rules,field_visibility_rules)
SELECT gen_random_uuid(),'personal_daily_'||lower(role)||'_v1',1,'Личный ежедневник '||role||' · beta',true,
  '[{"field_path":"day_plan","label":"План и действия дня","type":"text","required":true,"max_chars":4000},
    {"field_path":"completion_summary","label":"Итог дня и следующий шаг","type":"text","required":true,"max_chars":4000},
    {"field_path":"risks","label":"Отклонения, риски и необходимая помощь (или «нет»)","type":"text","required":true,"max_chars":4000}]'::jsonb,
  jsonb_build_object('day_plan',role,'completion_summary',role,'risks',role),'{}'::jsonb
FROM (VALUES('RF'),('ROP'),('ROO')) r(role);
-- Reporting marker is separate from submissions' existing task deadline marker.
-- This avoids rewriting old immutable submissions and supports EARLY precisely.
CREATE TABLE daily_submission_markers (
  submission_id uuid PRIMARY KEY REFERENCES submissions(id),
  marker text NOT NULL CHECK(marker IN ('EARLY','ON_TIME','LATE'))
);
CREATE TRIGGER daily_marker_immutable BEFORE UPDATE OR DELETE ON daily_submission_markers
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
