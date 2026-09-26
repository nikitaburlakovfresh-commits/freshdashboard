SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 065. Ссылка на карточку ТС в CRM — отдельной таблицей.
-- vehicle_identity неизменяема (триггер reject_immutable_change), поэтому столбец
-- crm_url из 064 не заполняется и не используется; он остаётся пустым (удаление
-- столбцов запрещено правилами проекта). Ссылка обновляется при каждой загрузке
-- «Анализа склада»: у машины она постоянная, но CRM может её сменить.
-- Откат: DROP TABLE IF EXISTS vehicle_crm_links.

CREATE TABLE IF NOT EXISTS vehicle_crm_links (
  vehicle_id uuid PRIMARY KEY REFERENCES vehicle_identity(id) ON DELETE RESTRICT,
  crm_url text NOT NULL CHECK (crm_url ~ '^https://crm\.freshauto\.ru/[A-Za-z0-9/_.\-]{1,300}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
