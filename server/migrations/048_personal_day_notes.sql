SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Личная запись дня линейного сотрудника.
--
-- Решение владельца 21.09.2026: ежедневник линейным должностям не нужен, нужна
-- личная запись дня — несколько свободных полей, без окна заполнения и без
-- дисциплины сдачи.
--
-- Поэтому это НЕ ежедневник и намеренно не использует его механику:
--   * нет политики окна заполнения, значит нельзя опоздать и нельзя не успеть;
--   * нет отметок «вовремя / с опозданием»;
--   * запись не влияет на балл филиала и не является источником показателей;
--   * заполняет её сотрудник сам себе, никто её не назначает.
-- Ежедневник РФ, РОП и РОО с его 28 жёсткими задачами и окнами остаётся как
-- есть: две сущности не пересекаются.
--
-- Общего с задачами ровно то, что запись живёт в work_items. Это даёт историю,
-- аудит, вложения и сдачу итога без единой новой строки в этих механизмах.
--
-- Аддитивная. Повторный прогон безопасен.
-- Неразрушающий откат:
--   -- убрать маршруты личной записи в коде; таблица и шаблоны остаются,
--   -- строки не удаляются.

CREATE TABLE IF NOT EXISTS personal_day_notes (
  work_item_id uuid PRIMARY KEY REFERENCES work_items(id),
  org_unit_id  uuid NOT NULL REFERENCES org_directory_units(id),
  user_id      uuid NOT NULL REFERENCES app_users(id),
  role_code    text NOT NULL REFERENCES roles(code),
  business_date date NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_unit_id, user_id, role_code, business_date)
);

COMMENT ON TABLE personal_day_notes IS
  'Личная запись дня линейного сотрудника: без окна заполнения, без отметок опоздания, не источник показателей.';

-- Шаблоны по одному на должность: портал допускает исполнителем только
-- обладателя роли, названной владельцем полей шаблона, и запись сотрудник
-- заводит сам себе.
INSERT INTO templates(id,code,version,display_name,is_system,field_schema,field_ownership_rules,field_visibility_rules)
SELECT gen_random_uuid(),'personal_note_'||lower(role)||'_v1',1,'Личная запись дня · '||title,true,
  '[{"field_path":"completion_summary","label":"Что сделал за день","type":"text","required":true,"max_chars":4000},
    {"field_path":"own_results","label":"Наработки за день","type":"text","required":false,"max_chars":4000},
    {"field_path":"blockers","label":"Что мешает или нужна помощь","type":"text","required":false,"max_chars":4000}]'::jsonb,
  jsonb_build_object('completion_summary',role,'own_results',role,'blockers',role),
  '{}'::jsonb
FROM (VALUES
  ('MOP','менеджер отдела продаж'),
  ('EO','эксперт отдела оценки'),
  ('KSO_STAFF','сотрудник КСО'),
  ('SMOP','старший менеджер отдела продаж'),
  ('SMOO','старший менеджер отдела оценки')
) r(role,title)
WHERE NOT EXISTS(SELECT 1 FROM templates WHERE code='personal_note_'||lower(r.role)||'_v1');
