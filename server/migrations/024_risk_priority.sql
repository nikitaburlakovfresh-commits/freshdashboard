SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- Приоритетность риска в сводках становится настройкой портала.
-- ТЗ v2.12 §1 требует сортировку дневного списка по утверждённой приоритетности
-- риска. Ранее порядок был зашит в код; теперь веса меняются внутри портала с
-- основанием и append-only историей (023_portal_settings.sql).
-- Изменение весов влияет только на порядок вывода и никогда на сами показатели.
INSERT INTO portal_settings(key,value_number) VALUES
 ('risk_weight_red',100),
 ('risk_weight_amber',40),
 ('risk_weight_deviation_without_task',25),
 ('risk_weight_task_overdue',60),
 ('risk_weight_branch_without_data',15)
ON CONFLICT (key) DO NOTHING;
