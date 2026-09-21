-- 054. Висяки 45+ как несколько разных показателей, а не один.
--
-- Висяки считают по-разному, и это не оттенки одной цифры:
--   по выкупу — машина выкупа стоит денег компании, и её себестоимость и есть
--     суть вопроса; это основная база;
--   по комиссии — отдельный разговор, деньги в машине не наши;
--   по всему складу — когда речь о ликвидности склада в целом.
-- И каждая база считается в двух мерах: в штуках и в себестоимости.
--
-- В старом портале висяки были одной формулой stock_45plus_units /
-- stock_units_end, то есть штуки по всему складу. Ответить по выкупу или по
-- себестоимости старый портал не мог.
--
-- Источник всех вариантов — реестр VIN (vehicle_stock_rows), где у каждой машины
-- известен тип поставки, срок хранения и себестоимость. Поэтому это вычисляемые
-- показатели, а не поля загружаемого отчёта.
--
-- Откат неразрушающий: возврат прежнего metric_code у stock_45plus и удаление
-- добавленных строк шаблона.

SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Основная база висяков — выкуп по себестоимости. Именно она отвечает на
-- вопрос, сколько наших денег заморожено в зависшем складе.
UPDATE mbo_kpi_template
   SET kpi_name = 'Висяки 45+ в выкупе по себестоимости',
       metric_code = 'aged45_buyout_cost',
       metric_code_base = NULL,
       updated_at = now()
 WHERE kpi_code = 'stock_45plus';

-- Остальные варианты заведены выключенными: включаются в настройках, когда
-- вопрос поставлен именно так, без правки кода.
INSERT INTO mbo_kpi_template (kpi_code, kpi_name, unit, default_weight, metric_code,
                              metric_code_base, ratio_as_percent, year_aggregation,
                              direction, sort_order, active)
VALUES
  ('aged45_buyout_units', 'Висяки 45+ в выкупе, штуки', '%', NULL, 'aged45_buyout_units',
   NULL, true, 'AVERAGE', 'LOWER_IS_BETTER', 5, false),
  ('aged45_commission_units', 'Висяки 45+ в комиссии, штуки', '%', NULL, 'aged45_commission_units',
   NULL, true, 'AVERAGE', 'LOWER_IS_BETTER', 6, false),
  ('aged45_commission_cost', 'Висяки 45+ в комиссии по себестоимости', '%', NULL, 'aged45_commission_cost',
   NULL, true, 'AVERAGE', 'LOWER_IS_BETTER', 7, false),
  ('aged45_all_units', 'Висяки 45+ по всему складу, штуки', '%', NULL, 'aged45_all_units',
   NULL, true, 'AVERAGE', 'LOWER_IS_BETTER', 8, false),
  ('aged45_all_cost', 'Висяки 45+ по всему складу, себестоимость', '%', NULL, 'aged45_all_cost',
   NULL, true, 'AVERAGE', 'LOWER_IS_BETTER', 9, false)
ON CONFLICT (kpi_code) DO NOTHING;

-- Справочник вариантов: чтобы область и меру можно было выбрать в отчёте или
-- задаче, не помня наизусть коды и не заглядывая в исходники.
CREATE TABLE IF NOT EXISTS aged45_variants (
  code text PRIMARY KEY,
  display_name text NOT NULL,
  -- Область склада: выкуп, комиссия или весь склад.
  scope text NOT NULL CONSTRAINT aged45_variants_scope
    CHECK (scope IN ('BUYOUT','COMMISSION','ALL')),
  -- Мера: штуки или себестоимость в рублях.
  measure text NOT NULL CONSTRAINT aged45_variants_measure
    CHECK (measure IN ('UNITS','COST')),
  note text,
  sort_order integer NOT NULL DEFAULT 0
);

INSERT INTO aged45_variants (code, display_name, scope, measure, note, sort_order) VALUES
  ('aged45_buyout_cost', 'Висяки 45+ в выкупе по себестоимости', 'BUYOUT', 'COST',
   'Основная база: сколько денег компании заморожено в зависшем выкупе.', 1),
  ('aged45_buyout_units', 'Висяки 45+ в выкупе, штуки', 'BUYOUT', 'UNITS',
   'Сколько машин выкупа зависло. Аналог показателя старого портала, но по выкупу.', 2),
  ('aged45_commission_cost', 'Висяки 45+ в комиссии по себестоимости', 'COMMISSION', 'COST',
   'Комиссия: деньги в машине не наши, поэтому разговор отдельный.', 3),
  ('aged45_commission_units', 'Висяки 45+ в комиссии, штуки', 'COMMISSION', 'UNITS', NULL, 4),
  ('aged45_all_cost', 'Висяки 45+ по всему складу, себестоимость', 'ALL', 'COST',
   'Когда вопрос о ликвидности склада в целом.', 5),
  ('aged45_all_units', 'Висяки 45+ по всему складу, штуки', 'ALL', 'UNITS',
   'Формула старого портала: штуки 45+ ко всему складу.', 6)
ON CONFLICT (code) DO NOTHING;
