SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 066. Исправление проверки адреса CRM из 065: в PostgreSQL повтор {1,300}
-- превышает допустимый предел (255) и проверка падала на первой же вставке.
-- Таблица пуста, данные не затрагиваются. Откат не требуется.
ALTER TABLE vehicle_crm_links DROP CONSTRAINT IF EXISTS vehicle_crm_links_crm_url_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='vehicle_crm_links_url_check') THEN
    ALTER TABLE vehicle_crm_links ADD CONSTRAINT vehicle_crm_links_url_check
      CHECK (char_length(crm_url) <= 320 AND crm_url ~ '^https://crm\.freshauto\.ru/[A-Za-z0-9/_.-]+$');
  END IF;
END $$;
