-- Аддитивное расширение каталога показателей: склад на конец месяца по плану,
-- скидки (количество и сумма) и план выручки из ручной формы. Ни одна
-- опубликованная величина не изменяется, существующие строки не переписываются.
SET LOCAL search_path = pilot_r1, public, pg_catalog;

INSERT INTO metric_catalog(code,display_name,unit,is_count,is_additive) VALUES
 ('stockPlanMonthEnd','План склада на конец месяца, шт.','COUNT',true,true),
 ('discountCount','Количество скидок','COUNT',true,true),
 ('discountAmount','Сумма скидок, руб.','RUB',false,true),
 ('planRevenue','План выручки, руб.','RUB',false,true)
ON CONFLICT (code) DO NOTHING;
