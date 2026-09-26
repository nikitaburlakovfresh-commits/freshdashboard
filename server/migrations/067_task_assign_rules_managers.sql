SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 067. Одна кнопка «Поставить задачу» и задачи внутри УК (решение владельца 26.09.2026).
--
-- 1. Прежнее окно РМ «Новая задача» (шаблон на роль) убирается: РМ и
--    дивизиональный ставят задачу конкретному сотруднику филиала тем же окном.
-- 2. «Всем всем в УК»: любой сотрудник управляющей компании ставит задачу
--    любому другому сотруднику УК. Цель правила — 'UK_ANY'.
-- 3. Задача УК относится ко всей сети или к конкретному филиалу. Для этого
--    work_items (и журнал/исходящие события этой задачи) допускают узел сети.
--    Роли и назначения сотрудников продолжают требовать точный филиал.
--
-- Состав ролей УК — данные таблицы правил, меняются без релиза.
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
--   UPDATE task_assign_rules SET revoked_at=now()
--    WHERE note LIKE 'Решение владельца 26.09.2026: одна кнопка%' OR target='UK_ANY';
--   (функции проверки возвращаются прежним CREATE OR REPLACE из 010.)

INSERT INTO task_assign_rules(setter_role,target,note)
SELECT s, t, 'Решение владельца 26.09.2026: одна кнопка постановки' FROM (VALUES
  ('REGIONAL_MANAGER'),('DIVISION_MANAGER')) sv(s)
CROSS JOIN (VALUES ('RF'),('ROP'),('ROO'),('RKSO'),('STOCK'),('MARKETING'),
  ('SMOP'),('SMOO'),('MOP'),('EO'),('KSO_STAFF')) tv(t)
WHERE EXISTS (SELECT 1 FROM roles r WHERE r.code=sv.s)
ON CONFLICT DO NOTHING;

-- Операционный маркетинг УК (решение владельца 26.09.2026): функциональный
-- сотрудник УК, отдельно от маркетолога филиала.
INSERT INTO roles (code, display_name, scope_kind, is_system)
VALUES ('MARKETING_UC', 'Операционный маркетинг УК', 'NETWORK', true)
ON CONFLICT (code) DO NOTHING;

-- Роли управляющей компании: ставят задачи друг другу («всем всем в УК»).
INSERT INTO task_assign_rules(setter_role,target,note)
SELECT s, 'UK_ANY', 'Решение владельца 26.09.2026: задачи внутри УК' FROM (VALUES
  ('SUPER_ADMIN'),('REGIONAL_MANAGER'),('DIVISION_MANAGER'),('COMMERCIAL_DIRECTOR'),('FINANCE_HEAD'),
  ('FRESH_ACADEMY'),('HR_UC'),('KSO_HEAD'),('LEGAL_UC'),('QUALITY_CONTROL'),('ACCOUNTANT'),
  ('TECHNICAL_COORDINATOR'),('MARKETING_UC')) v(s)
WHERE EXISTS (SELECT 1 FROM roles r WHERE r.code=v.s)
ON CONFLICT DO NOTHING;

-- Шаблон задачи УК. Поле результата принадлежит условной роли UK_STAFF:
-- исполнитель — назначенный сотрудник УК, это проверяет сервер.
INSERT INTO templates (id, code, version, requires_acceptance, field_schema_version, display_name,
    is_system, field_schema, field_ownership_rules, field_visibility_rules)
SELECT gen_random_uuid(), 'uk_task_v1', 1, true, 1, 'Задача УК', true,
  '[{"type": "text", "label": "Результат", "required": true, "max_chars": 4000, "min_chars": 1, "field_path": "completion_summary"}]'::jsonb,
  '{"completion_summary": "UK_STAFF"}'::jsonb, '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM templates WHERE code='uk_task_v1');

-- Узел сети допустим для задачи и её журнала, но не для назначения ролей.
CREATE OR REPLACE FUNCTION check_canonical_branch_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pilot_r1', 'pg_catalog' AS $$
DECLARE d org_directory_units%ROWTYPE;
BEGIN
  IF NEW.org_unit_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO d FROM org_directory_units WHERE id=NEW.org_unit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown canonical branch' USING ERRCODE='23503';
  END IF;
  IF d.kind='NETWORK' AND TG_TABLE_NAME IN ('work_items','audit_log','outbox_events') THEN
    RETURN NEW;
  END IF;
  IF d.kind<>'ORG_UNIT' OR (d.is_demo AND d.pilot_org_unit_id IS DISTINCT FROM d.id) THEN
    RAISE EXCEPTION 'Expected a supported exact branch scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_new_work_branch() RETURNS trigger
LANGUAGE plpgsql SET search_path TO 'pilot_r1', 'pg_catalog' AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM org_directory_units d WHERE d.id=NEW.org_unit_id
      AND d.kind='NETWORK' AND d.effective_to IS NULL) THEN
    RETURN NEW;
  END IF;
  IF NOT org_accepts_new_work(NEW.org_unit_id) THEN
    RAISE EXCEPTION 'Branch does not accept new work' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
