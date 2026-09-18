-- Additive generic personal tasks for ROP/ROO. No users, grants, work
-- items or KPI facts are created. These are NOT approved daily-log forms.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO templates
  (id, code, version, display_name, is_system, field_schema, field_ownership_rules, field_visibility_rules)
SELECT gen_random_uuid(), 'personal_' || lower(role_code) || '_task_v1', 1,
       CASE role_code WHEN 'ROP' THEN 'Личное поручение РОП' ELSE 'Личное поручение РОО' END,
       true,
       '[{"field_path":"completion_summary","label":"Результат выполнения","type":"text","required":true,"min_chars":1,"max_chars":4000}]'::jsonb,
       jsonb_build_object('completion_summary', role_code), '{}'::jsonb
FROM (VALUES ('ROP'), ('ROO')) AS owner(role_code)
ON CONFLICT (code) DO NOTHING;
