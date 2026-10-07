-- Фокусы внимания октября 2026 (решение владельца 07.10.2026):
-- новый показатель «Отток комиссионного склада» и понятные подписи
-- показателей, которые выбраны в фокусы. Только добавление и подписи.
SET LOCAL search_path = pilot_r1, public, pg_catalog;

INSERT INTO focus_metric_catalog(code,label,direction,format,default_plan,requires_vin_level,requires_daily_logs,sort_order)
VALUES ('commission_outflow_share','Отток комиссионного склада','LOWER_IS_BETTER','PCT',10,true,false,22)
ON CONFLICT (code) DO NOTHING;

UPDATE focus_metric_catalog SET label='Продажи' WHERE code='sales_units' AND label='Продажи, шт';
UPDATE focus_metric_catalog SET label='Дисциплина переоценки склада' WHERE code='reprice_discipline' AND label='Дисциплина переоценки';
UPDATE focus_metric_catalog SET label='Доля авто в рынке' WHERE code='in_market_share' AND label='Доля VIN в рынке';
UPDATE focus_metric_catalog SET label='Доля общего склада 45+' WHERE code='hangers45_total' AND label='Висяки 45+ всего';
UPDATE focus_metric_catalog SET label='Доля выкупа 45+' WHERE code='hangers45_buyback' AND label='Висяки 45+ выкуп';
UPDATE focus_metric_catalog SET label='Доля комиссии 45+' WHERE code='hangers45_commission' AND label='Висяки 45+ комиссия';
