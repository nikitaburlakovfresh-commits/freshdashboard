SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 064. Карточка филиала (решения владельца 26.09.2026).
-- 1) Ссылка на карточку ТС в CRM из столбца «Ссылка на ТС» отчёта «Анализ склада»:
--    хранится у автомобиля, а не в строке среза — ссылка у машины постоянная.
-- 2) Окно списка «Переоценки вверх» — 10 дней с момента события; параметр
--    меняется в админ-панели, без релиза.
-- Аддитивная, повторный прогон безопасен. Откат: ALTER TABLE vehicle_identity DROP COLUMN crm_url;
-- DELETE FROM portal_settings WHERE key='repricing_window_days' (после удаления истории изменений).

ALTER TABLE vehicle_identity ADD COLUMN IF NOT EXISTS crm_url text;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vehicle_identity_crm_url_check') THEN
    ALTER TABLE vehicle_identity ADD CONSTRAINT vehicle_identity_crm_url_check
      CHECK (crm_url IS NULL OR crm_url ~ '^https://crm\.freshauto\.ru/[A-Za-z0-9/_.\-]{1,300}$');
  END IF;
END $$;

INSERT INTO portal_settings(key,value_number) VALUES('repricing_window_days',10)
ON CONFLICT (key) DO NOTHING;
