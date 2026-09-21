SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Реестр автомобилей (VIN): поля отчёта «Анализ склада» QLIK.
--
-- Портал уже хранил из этого отчёта срок хранения, маржу, себестоимость, цену
-- продажи, рыночную цену, лиды и долю не в рекламе. Для реестра в том виде, в
-- каком он работает на старом портале, нужны ещё описание автомобиля и
-- счётчики изменений цены из того же отчёта.
--
-- Отдельно о переоценках вверх. Счётчики изменений в самом отчёте
-- («Итого изменений Цены продажи, руб.» и «Изменения Цены продажи, дн.») для
-- переоценки вверх не подходят: проверка на данных 20.09.2026 дала по Дагомысу
-- 0 и по Владимиру 4, тогда как боевой портал показывает 2 и 8. Это суммарное
-- изменение, в котором рост и снижение гасят друг друга. Старый портал считает
-- переоценки сравнением соседних ежедневных срезов реестра и держит их в своей
-- базе. Портал делает так же — по накопленным срезам `vehicle_stock_rows`.
-- Столбцы отчёта сохраняются как справочная величина источника, а не как
-- источник показателя «переоценки вверх».
--
-- Аддитивная, повторный прогон безопасен.
-- Неразрушающий откат: столбцы можно оставить — они необязательные.

ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS city text;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS make text;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS production_year integer;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS color text;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS mileage integer;
-- «Реклама Выгружена»: текстовое состояние источника («Да», «Ожидает», …).
-- Не приводим к логическому значению: состав значений источника не утверждён.
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS advertising_status text;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS ppp_sum_rub numeric;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS market_diff_rub numeric;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS price_changes_count integer;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS price_changes_sum_rub numeric;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS price_changes_days numeric;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS erk_count numeric;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS erk_days numeric;
ALTER TABLE vehicle_stock_rows ADD COLUMN IF NOT EXISTS avito_cost_rub numeric;

-- Год выпуска и пробег в разумных границах: опечатка источника не должна
-- попасть в реестр молча.
DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='vehicle_stock_rows_year_range') THEN
    ALTER TABLE vehicle_stock_rows ADD CONSTRAINT vehicle_stock_rows_year_range CHECK (
      production_year IS NULL OR (production_year BETWEEN 1950 AND 2100));
  END IF;
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='vehicle_stock_rows_mileage_range') THEN
    ALTER TABLE vehicle_stock_rows ADD CONSTRAINT vehicle_stock_rows_mileage_range CHECK (
      mileage IS NULL OR (mileage >= 0 AND mileage <= 3000000));
  END IF;
END $$;

-- Чтение реестра идёт по филиалу и дате среза, а расчёт переоценок — по
-- автомобилю во времени.
CREATE INDEX IF NOT EXISTS vehicle_stock_rows_org_date_idx
  ON vehicle_stock_rows(org_unit_id, observed_on);
CREATE INDEX IF NOT EXISTS vehicle_stock_rows_vehicle_date_idx
  ON vehicle_stock_rows(vehicle_id, observed_on);
