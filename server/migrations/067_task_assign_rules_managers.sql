SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 067. Одна кнопка «Поставить задачу» (решение владельца 26.09.2026).
--
-- Прежнее окно РМ «Новая задача» (шаблон на роль филиала) убирается: РМ и
-- дивизиональный ставят задачу конкретному сотруднику тем же окном, что РФ.
-- «Запрос в УК» им не нужен — они сами УК.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- UPDATE task_assign_rules SET revoked_at=now() WHERE setter_role IN ('REGIONAL_MANAGER','DIVISION_MANAGER');

INSERT INTO task_assign_rules(setter_role,target,note)
SELECT s, t, 'Решение владельца 26.09.2026: одна кнопка постановки' FROM (VALUES
  ('REGIONAL_MANAGER'),('DIVISION_MANAGER')) sv(s)
CROSS JOIN (VALUES ('RF'),('ROP'),('ROO'),('RKSO'),('STOCK'),('MARKETING'),
  ('SMOP'),('SMOO'),('MOP'),('EO'),('KSO_STAFF')) tv(t)
WHERE EXISTS (SELECT 1 FROM roles r WHERE r.code=sv.s)
ON CONFLICT DO NOTHING;
