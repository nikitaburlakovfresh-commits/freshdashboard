-- Каталог агрегатных показателей источников QLIK.
-- Additive: расширяет допустимый перечень показателей, не переписывая
-- применённые миграции и не изменяя ни одной опубликованной величины.
-- Набор показателей становится данными справочника, а не константой в коде:
-- новый показатель добавляется строкой каталога без правки приложения.
SET LOCAL search_path = pilot_r1, public, pg_catalog;

CREATE TABLE metric_catalog (
 code text PRIMARY KEY CHECK(code ~ '^[a-zA-Z][a-zA-Z0-9]{1,48}$'),
 display_name text NOT NULL CHECK(char_length(btrim(display_name)) BETWEEN 3 AND 120),
 unit text NOT NULL CHECK(unit IN('COUNT','RUB','PCT','DAYS','RUB_PER_UNIT')),
 -- Значение обязано быть неотрицательным целым количеством.
 is_count boolean NOT NULL,
 -- Складывается по филиалам до итога отчёта. Для неаддитивных показателей
 -- (доли, удельные значения, сроки) контроль «сумма строк = итог» неприменим.
 is_additive boolean NOT NULL,
 is_active boolean NOT NULL DEFAULT true,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT metric_catalog_count_unit CHECK(NOT is_count OR unit='COUNT'),
 CONSTRAINT metric_catalog_additive_shape CHECK(NOT is_additive OR unit IN('COUNT','RUB'))
);

INSERT INTO metric_catalog(code,display_name,unit,is_count,is_additive) VALUES
 ('sales','Продажи автомобилей','COUNT',true,true),
 ('margin','Маржа + КСО','RUB',false,true),
 ('stock','Автомобили на складе','COUNT',true,true),
 ('aged','Склад 45+','COUNT',true,true),
 ('plan','План продаж','COUNT',true,true),
 ('revenue','Выручка','RUB',false,true),
 ('baseMargin','Маржа без КСО','RUB',false,true),
 ('kso','КСО','RUB',false,true),
 ('stockStart','Склад на начало периода, шт.','COUNT',true,true),
 ('stockStartCost','Склад на начало периода, руб.','RUB',false,true),
 ('stockCost','Склад себестоимость, руб.','RUB',false,true),
 ('stockUnitCost','Склад удельная себестоимость, руб.','RUB_PER_UNIT',false,false),
 ('outflow','Отток, шт.','COUNT',true,true),
 ('turnoverBuyout','Оборачиваемость для мотивации, выкуп','PCT',false,false),
 ('turnoverCommission','Оборачиваемость для мотивации, комиссия','PCT',false,false),
 ('purchasePrice','Цена в закупке, руб.','RUB',false,true),
 ('unitMargin','Факт удельная маржа, руб.','RUB_PER_UNIT',false,false),
 ('unitKso','Факт удельное КСО, руб.','RUB_PER_UNIT',false,false),
 ('unitMarginKso','Факт удельная маржа + КСО, руб.','RUB_PER_UNIT',false,false),
 ('ptzCost','Стоимость ПТЗ, руб.','RUB',false,true),
 ('ptzCount','Количество ПТЗ','COUNT',true,true),
 ('royaltyKso','Сумма к роялти по КСО','RUB',false,true),
 ('mdProfitability','Рентабельность МД по всем видам сделок','PCT',false,false),
 ('saleDays','Срок продажи, дней','DAYS',false,false),
 ('stockDays','Срок стоянки на складе, дней','DAYS',false,false),
 ('agedCost','Склад 45+ себестоимость, руб.','RUB',false,true),
 ('agedShare','Доля 45+ средний возраст','PCT',false,false),
 ('forecast','Прогноз продаж, шт.','COUNT',false,true),
 ('planKso','План КСО, руб.','RUB',false,true),
 ('planIron','План железо, руб.','RUB',false,true),
 ('factIron','Факт железо, руб.','RUB',false,true),
 ('planMargin','План маржа, руб.','RUB',false,true),
 ('forecastMargin','Прогноз маржа, руб.','RUB',false,true),
 ('planUnitKso','План удельное КСО, руб.','RUB_PER_UNIT',false,false),
 ('planUnitMargin','План удельная маржа, руб.','RUB_PER_UNIT',false,false),
 ('suppliesPlan','План поставок, шт.','COUNT',true,true),
 ('suppliesFact','Факт поставок, шт.','COUNT',true,true),
 ('suppliesPlanCost','План себестоимости поставок, руб.','RUB',false,true),
 ('suppliesFactCost','Факт себестоимости поставок, руб.','RUB',false,true),
 ('suppliesForecast','Прогноз поставок, шт.','COUNT',false,true),
 ('suppliesForecastCost','Прогноз поставок, руб.','RUB',false,true),
 ('creditsPlan','План количества кредитов','COUNT',true,true),
 ('creditsGoogle','Факт кредитов (Google), шт.','COUNT',true,true),
 ('creditsCrm','Факт кредитов (CRM), шт.','COUNT',true,true),
 ('brokerPlan','План брокерских сделок','COUNT',true,true),
 ('brokerFact','Факт брокерских сделок','COUNT',true,true),
 ('creditSharePlan','План доли кредита','PCT',false,false),
 ('creditShareFact','Факт доли кредита','PCT',false,false),
 ('creditKsoPlan','План КСО по кредитам, руб.','RUB',false,true),
 ('creditKsoFact','Факт КСО по кредитам, руб.','RUB',false,true),
 ('incomePerCreditPlan','План дохода на 1 кредит, руб.','RUB_PER_UNIT',false,false),
 ('incomePerCreditFact','Факт дохода на 1 кредит, руб.','RUB_PER_UNIT',false,false),
 ('avgCreditPlan','План средней суммы кредита, руб.','RUB_PER_UNIT',false,false),
 ('avgCreditFact','Факт средней суммы кредита, руб.','RUB_PER_UNIT',false,false),
 ('incomeSharePlan','План % дохода от суммы кредита','PCT',false,false),
 ('incomeShareFact','Факт % дохода от суммы кредита','PCT',false,false),
 ('tradeUpTotal','Trade Up, итог','PCT',false,false),
 ('tradeUpCommission','Trade Up, комиссия','PCT',false,false),
 ('tradeUpBuyout','Trade Up, выкуп','PCT',false,false),
 ('creditShareTotal','Кредиты (CRM), итог','PCT',false,false),
 ('creditShareCommission','Кредиты (CRM), комиссия','PCT',false,false),
 ('creditShareBuyout','Кредиты (CRM), выкуп','PCT',false,false),
 ('funnelTraffic','Воронка: трафик','COUNT',true,true),
 ('funnelVisits','Воронка: визиты','COUNT',true,true),
 ('funnelDeals','Воронка: сделки','COUNT',true,true),
 ('funnelTrafficToVisit','Конверсия трафик → визит','PCT',false,false),
 ('funnelVisitToDeal','Конверсия визит → сделка','PCT',false,false),
 ('funnelTrafficToDeal','Конверсия трафик → сделка','PCT',false,false);

-- Справочник — источник истины вместо перечислений в CHECK.
ALTER TABLE report_fact_snapshots DROP CONSTRAINT IF EXISTS report_fact_snapshots_metric_check;
ALTER TABLE report_fact_snapshots DROP CONSTRAINT IF EXISTS report_fact_snapshots_unit_check;
ALTER TABLE report_fact_snapshots
 ADD CONSTRAINT report_fact_snapshots_metric_fkey FOREIGN KEY(metric) REFERENCES metric_catalog(code),
 ADD CONSTRAINT report_fact_snapshots_unit_check CHECK(unit IN('COUNT','RUB','PCT','DAYS','RUB_PER_UNIT'));

ALTER TABLE report_fact_current
 ADD CONSTRAINT report_fact_current_metric_fkey FOREIGN KEY(metric) REFERENCES metric_catalog(code);

ALTER TABLE metric_thresholds DROP CONSTRAINT IF EXISTS metric_thresholds_metric_check;
ALTER TABLE metric_thresholds DROP CONSTRAINT IF EXISTS metric_thresholds_unit_check;
ALTER TABLE metric_thresholds
 ADD CONSTRAINT metric_thresholds_metric_fkey FOREIGN KEY(metric) REFERENCES metric_catalog(code),
 ADD CONSTRAINT metric_thresholds_unit_check CHECK(unit IN('COUNT','RUB','PCT','DAYS','RUB_PER_UNIT'));

-- Разрешение на публикацию перечисляет коды показателей массивом,
-- поэтому подмножество проверяется триггером, а не CHECK с подзапросом.
ALTER TABLE report_fact_access DROP CONSTRAINT IF EXISTS report_fact_access_metrics_check;
ALTER TABLE report_fact_access
 ADD CONSTRAINT report_fact_access_metrics_shape
 CHECK(cardinality(metrics) BETWEEN 1 AND 80 AND array_position(metrics,NULL) IS NULL);

CREATE FUNCTION metrics_in_catalog() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE unknown_codes text;
BEGIN
 SELECT string_agg(code,', ') INTO unknown_codes FROM (
   SELECT unnest(NEW.metrics) code
   EXCEPT SELECT code FROM metric_catalog WHERE is_active) missing;
 IF unknown_codes IS NOT NULL THEN
   RAISE EXCEPTION 'Показатели вне действующего каталога: %', unknown_codes;
 END IF;
 RETURN NEW;
END $$;

CREATE TRIGGER report_fact_access_metrics_in_catalog BEFORE INSERT OR UPDATE ON report_fact_access
 FOR EACH ROW EXECUTE FUNCTION metrics_in_catalog();
