SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- 072. Отзыв ошибочной публикации реестра VIN (решение владельца 30.09.2026).
-- 30.09 пакет за 29.09 по ошибке опубликован с датой 26.09. Публикации неизменяемы,
-- поэтому ошибочная не удаляется, а отмечается отозванной, и расчёты её не читают.
CREATE TABLE IF NOT EXISTS report_detail_withdrawals (
  publication_id uuid PRIMARY KEY REFERENCES report_detail_publications(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  actor_user_id uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE VIEW vehicle_stock_current AS
SELECT r.* FROM vehicle_stock_rows r
WHERE r.publication_id IN (
  SELECT DISTINCT ON (p.observed_on) p.id FROM report_detail_publications p
  WHERE p.kind = 'vinInventory'
    AND NOT EXISTS (SELECT 1 FROM report_detail_withdrawals w WHERE w.publication_id = p.id)
  ORDER BY p.observed_on, p.created_at DESC, p.id DESC);
