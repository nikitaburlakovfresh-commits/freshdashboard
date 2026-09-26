-- Решение владельца 26.09.2026: в полях «План/факт продажи» и «План/факт
-- поставки» вводится % выполнения месячного плана на дату, а цвет считается
-- порталом по темпу RunRate. Новая версия правил с basis PORTAL; версия 1
-- сохраняется в истории.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO daily_field_color_rules (field_path, version, effective_from, basis, rule, reason)
SELECT v.fp, 2, DATE '2026-09-01', 'PORTAL',
       '{"bands":[{"color":"GREEN","gte":100},{"color":"AMBER","gte":90,"lt":100},{"color":"RED","lt":90}]}'::jsonb,
       'Решение владельца 26.09.2026: цвет по RunRate, в поле — % месячного плана'
FROM (VALUES ('t1_sales_pct'),('t1_supply_pct')) v(fp)
WHERE NOT EXISTS (SELECT 1 FROM daily_field_color_rules r WHERE r.field_path=v.fp AND r.version=2);
