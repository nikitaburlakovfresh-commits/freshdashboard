SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- 071. Повторная публикация среза склада за ту же дату (29.09.2026).
-- Срез 26.09 опубликован дважды: отдельным срезом склада 26.09 и в пакете от 27.09.
-- Строки неизменяемы и не удаляются, поэтому расчёты читают только последнюю
-- публикацию реестра VIN за каждую дату. Раньше обе складывались: Саратов 284 вместо 145.
CREATE OR REPLACE VIEW vehicle_stock_current AS
SELECT r.* FROM vehicle_stock_rows r
WHERE r.publication_id IN (
  SELECT DISTINCT ON (p.observed_on) p.id FROM report_detail_publications p
  WHERE p.kind = 'vinInventory'
  ORDER BY p.observed_on, p.created_at DESC, p.id DESC);
