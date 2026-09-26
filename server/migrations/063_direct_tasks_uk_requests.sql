SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 063. Постановка задач сверху вниз и «Запрос в УК» (решение владельца 26.09.2026).
--
-- Кто кому может поставить задачу — данные, а не код: таблица правил
-- «роль постановщика → роль исполнителя». Меняется без релиза.
-- Особая цель UK_REQUEST — запрос в управляющую компанию: он уходит
-- региональному менеджеру филиала, дальше РМ отвечает или передаёт.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- DROP TABLE IF EXISTS task_assign_rules; шаблон uk_request_v1 остаётся (шаблоны неизменяемы).

CREATE TABLE IF NOT EXISTS task_assign_rules (
  setter_role text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  -- Код роли исполнителя или 'UK_REQUEST' — запрос в УК.
  target text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  note text,
  PRIMARY KEY (setter_role, target)
);

INSERT INTO task_assign_rules(setter_role,target,note)
SELECT s, t, 'Решение владельца 26.09.2026' FROM (VALUES
  ('BH','RF'),('BH','ROP'),('BH','ROO'),('BH','RKSO'),('BH','STOCK'),('BH','MARKETING'),
  ('BH','SMOP'),('BH','SMOO'),('BH','MOP'),('BH','EO'),('BH','KSO_STAFF'),('BH','UK_REQUEST'),
  ('RF','ROP'),('RF','ROO'),('RF','RKSO'),('RF','STOCK'),('RF','MARKETING'),
  ('RF','SMOP'),('RF','SMOO'),('RF','MOP'),('RF','EO'),('RF','KSO_STAFF'),('RF','UK_REQUEST'),
  ('ROP','SMOP'),('ROP','MOP'),
  ('ROO','SMOO'),('ROO','EO'),
  ('RKSO','KSO_STAFF'),
  ('SMOP','MOP'),('SMOO','EO')
) v(s,t)
WHERE EXISTS (SELECT 1 FROM roles r WHERE r.code=v.s)
ON CONFLICT DO NOTHING;

-- Шаблон запроса в УК: отвечает региональный менеджер филиала, принимает автор.
INSERT INTO templates (id, code, version, requires_acceptance, field_schema_version, display_name,
    is_system, field_schema, field_ownership_rules, field_visibility_rules)
SELECT gen_random_uuid(), 'uk_request_v1', 1, true, 1, 'Запрос в УК', true,
  '[{"type": "text", "label": "Ответ УК", "required": true, "max_chars": 4000, "min_chars": 1, "field_path": "completion_summary"}]'::jsonb,
  '{"completion_summary": "REGIONAL_MANAGER"}'::jsonb, '{}'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM templates WHERE code='uk_request_v1');
