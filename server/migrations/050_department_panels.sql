-- Панели управления отделами: ОП, ОО и КСО.
--
-- Источник требований — рабочая таблица «Шаблон панель ОП/ОО/КСО», три листа.
-- Панели устроены ПО СОТРУДНИКУ, тогда как всё, что портал публикует из QLIK,
-- устроено по филиалу. Поэтому факты сотрудника вводит сам сотрудник, планы
-- ставит руководитель отдела, а производные величины портал считает — принимать
-- их руками нельзя, иначе расчёт становится непроверяемым.
--
-- Состав показателей и формулы объявлены данными, а не кодом: добавление
-- показателя в панель или смена знаменателя доли не требуют релиза.
SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Каталог показателей панелей. `kind`:
--   FACT     — вводит сотрудник за период;
--   PLAN     — ставит руководитель отдела;
--   COMPUTED — считает портал по операции и операндам, ввод запрещён.
-- `op` для COMPUTED: RATIO (a/b), SUM (сумма операндов), AVG (среднее),
-- DIFF (a-b). Операнды — коды показателей этого же каталога.
CREATE TABLE IF NOT EXISTS dept_panel_metrics (
  code            text PRIMARY KEY,
  panel_code      text NOT NULL CHECK (panel_code IN ('OP','OO','KSO')),
  display_name    text NOT NULL,
  unit            text NOT NULL CHECK (unit IN ('COUNT','RUB','PCT','TEXT')),
  kind            text NOT NULL CHECK (kind IN ('FACT','PLAN','COMPUTED')),
  op              text CHECK (op IN ('RATIO','SUM','AVG','DIFF')),
  operands        text[] NOT NULL DEFAULT '{}',
  -- Человеческая запись формулы для подсказки у числа: руководитель должен
  -- видеть, откуда взялась величина, не открывая код.
  formula_text    text,
  -- Разрез канала поставки (панель ОО): выкуп, комиссия, Trade-in, Trade-up,
  -- брокерские. NULL — показатель без разреза.
  by_channel      boolean NOT NULL DEFAULT false,
  sort_order      integer NOT NULL,
  effective_from  date NOT NULL DEFAULT current_date,
  CONSTRAINT dept_panel_metrics_computed_shape CHECK (
    (kind = 'COMPUTED' AND op IS NOT NULL AND array_length(operands,1) >= 1)
    OR (kind <> 'COMPUTED' AND op IS NULL AND operands = '{}')),
  CONSTRAINT dept_panel_metrics_ratio_pair CHECK (
    op IS DISTINCT FROM 'RATIO' OR array_length(operands,1) = 2),
  CONSTRAINT dept_panel_metrics_diff_pair CHECK (
    op IS DISTINCT FROM 'DIFF' OR array_length(operands,1) = 2)
);

-- Значения панелей. Период — календарный месяц: панели ведутся за месяц с
-- накоплением внутри него. Хранятся только FACT и PLAN; COMPUTED не хранится
-- никогда, чтобы в базе не появилось двух версий одной величины.
CREATE TABLE IF NOT EXISTS dept_panel_values (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_unit_id  uuid NOT NULL REFERENCES org_directory_units(id),
  panel_code   text NOT NULL CHECK (panel_code IN ('OP','OO','KSO')),
  period_month date NOT NULL,
  user_id      uuid NOT NULL REFERENCES app_users(id),
  metric_code  text NOT NULL REFERENCES dept_panel_metrics(code),
  channel      text CHECK (channel IN ('BUYOUT','COMMISSION','TRADE_IN','TRADE_UP','BROKER')),
  value        numeric NOT NULL,
  updated_by   uuid NOT NULL REFERENCES app_users(id),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  -- Первое число месяца: период объявляется месяцем, а не произвольной датой.
  CONSTRAINT dept_panel_values_month CHECK (period_month = date_trunc('month', period_month)::date)
);
CREATE UNIQUE INDEX IF NOT EXISTS dept_panel_values_key
  ON dept_panel_values (org_unit_id, panel_code, period_month, user_id, metric_code,
                        coalesce(channel, 'ALL'));
CREATE INDEX IF NOT EXISTS dept_panel_values_period
  ON dept_panel_values (org_unit_id, panel_code, period_month);

-- История правок: величина в панели влияет на оценку работы сотрудника,
-- поэтому изменение задним числом должно быть видно, а не затирать прежнее.
CREATE TABLE IF NOT EXISTS dept_panel_value_history (
  id           bigserial PRIMARY KEY,
  value_id     uuid NOT NULL REFERENCES dept_panel_values(id) ON DELETE CASCADE,
  old_value    numeric,
  new_value    numeric NOT NULL,
  changed_by   uuid NOT NULL REFERENCES app_users(id),
  changed_at   timestamptz NOT NULL DEFAULT now(),
  reason       text
);

-- Категория сотрудника (А/В/С). В таблице она проставлена руками и формулы не
-- имеет, поэтому и здесь это решение руководителя, а не расчёт. Хранится
-- отдельно от числовых значений.
CREATE TABLE IF NOT EXISTS dept_panel_grades (
  org_unit_id  uuid NOT NULL REFERENCES org_directory_units(id),
  panel_code   text NOT NULL CHECK (panel_code IN ('OP','OO','KSO')),
  period_month date NOT NULL,
  user_id      uuid NOT NULL REFERENCES app_users(id),
  grade        text NOT NULL CHECK (grade IN ('A','B','C')),
  set_by       uuid NOT NULL REFERENCES app_users(id),
  set_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_unit_id, panel_code, period_month, user_id)
);

-- ============================ ПАНЕЛЬ ОП ============================
-- Соответствие столбцам листа «Отдел Продаж» сохранено; формулы перенесены
-- буквально: E=B+C+D, F=M/E, O=M/N, R=Q/M, T=R/S, V=U/M, X=V/W, Z=Y/(I-J),
-- AB=AA/(I+K), AF=AD/AE, AG=СРЗНАЧ(X;T;O).
INSERT INTO dept_panel_metrics(code,panel_code,display_name,unit,kind,op,operands,formula_text,sort_order) VALUES
 ('op_calls','OP','Звонки','COUNT','FACT',NULL,'{}',NULL,10),
 ('op_visits','OP','Визиты','COUNT','FACT',NULL,'{}',NULL,20),
 ('op_chats','OP','Чаты','COUNT','FACT',NULL,'{}',NULL,30),
 ('op_leads','OP','Всего лидов','COUNT','COMPUTED','SUM','{op_calls,op_visits,op_chats}','звонки + визиты + чаты',40),
 ('op_call_quality','OP','Качество звонка','PCT','FACT',NULL,'{}',NULL,50),
 ('op_deals_buyout','OP','Выкуп / Комиссия','COUNT','FACT',NULL,'{}',NULL,60),
 ('op_deals_broker','OP','Брокерская сделка','COUNT','FACT',NULL,'{}',NULL,70),
 ('op_deals_interactive','OP','Интерактивная сделка','COUNT','FACT',NULL,'{}',NULL,80),
 ('op_deals_marketplace','OP','Маркетплейс продажа','COUNT','FACT',NULL,'{}',NULL,90),
 ('op_deals_total','OP','Всего сделок','COUNT','COMPUTED','SUM',
   '{op_deals_buyout,op_deals_broker,op_deals_interactive,op_deals_marketplace}',
   'сумма сделок по типам',100),
 ('op_strike_rate','OP','StrikeRate','PCT','COMPUTED','RATIO','{op_deals_total,op_leads}','всего сделок / всего лидов',110),
 ('op_strike_rate_plan','OP','StrikeRate план','PCT','PLAN',NULL,'{}',NULL,120),
 ('op_deals_plan','OP','План сделок','COUNT','PLAN',NULL,'{}',NULL,130),
 ('op_plan_done','OP','Процент выполнения плана','PCT','COMPUTED','RATIO','{op_deals_total,op_deals_plan}','всего сделок / план сделок',140),
 ('op_forecast','OP','Прогноз','COUNT','FACT',NULL,'{}',NULL,150),
 ('op_trade_in','OP','Trade In','COUNT','FACT',NULL,'{}',NULL,160),
 ('op_trade_in_share','OP','Доля Trade In','PCT','COMPUTED','RATIO','{op_trade_in,op_deals_total}','Trade In / всего сделок',170),
 ('op_trade_in_share_plan','OP','Доля Trade In план','PCT','PLAN',NULL,'{}',NULL,180),
 ('op_trade_in_done','OP','Trade In выполнение','PCT','COMPUTED','RATIO','{op_trade_in_share,op_trade_in_share_plan}','доля Trade In / план доли',190),
 ('op_credit','OP','Кредит','COUNT','FACT',NULL,'{}',NULL,200),
 ('op_credit_share','OP','Доля Кредит','PCT','COMPUTED','RATIO','{op_credit,op_deals_total}','кредит / всего сделок',210),
 ('op_credit_share_plan','OP','Доля Кредит план','PCT','PLAN',NULL,'{}',NULL,220),
 ('op_credit_done','OP','Кредит выполнение','PCT','COMPUTED','RATIO','{op_credit_share,op_credit_share_plan}','доля кредита / план доли',230),
 ('op_to0','OP','ТО-0','COUNT','FACT',NULL,'{}',NULL,240),
 ('op_deals_own','OP','Сделки без брокерских','COUNT','COMPUTED','DIFF','{op_deals_buyout,op_deals_broker}','выкуп/комиссия − брокерские',250),
 ('op_to0_share','OP','Доля ТО-0','PCT','COMPUTED','RATIO','{op_to0,op_deals_own}','ТО-0 / сделки без брокерских',260),
 ('op_ptz','OP','ПТЗ','COUNT','FACT',NULL,'{}',NULL,270),
 ('op_ptz_base','OP','База ПТЗ','COUNT','COMPUTED','SUM','{op_deals_buyout,op_deals_interactive}','выкуп/комиссия + интерактивные',280),
 ('op_ptz_share','OP','Доля ПТЗ','PCT','COMPUTED','RATIO','{op_ptz,op_ptz_base}','ПТЗ / база ПТЗ',290),
 ('op_reviews','OP','Отзывы','COUNT','FACT',NULL,'{}',NULL,300),
 ('op_price_tag_sold','OP','Продано в ценник','COUNT','FACT',NULL,'{}',NULL,310),
 ('op_price_tag_plan','OP','План продаж в ценник','COUNT','PLAN',NULL,'{}',NULL,320),
 ('op_price_tag_done','OP','Выполнение продаж в ценник','PCT','COMPUTED','RATIO','{op_price_tag_sold,op_price_tag_plan}','продано в ценник / план',330),
 ('op_rating','OP','Общий рейтинг','PCT','COMPUTED','AVG','{op_credit_done,op_trade_in_done,op_plan_done}',
   'среднее трёх выполнений: кредит, Trade In, план сделок',340)
ON CONFLICT (code) DO NOTHING;

-- ============================ ПАНЕЛЬ ОО ============================
-- Лист «Отдел Оценки»: строка на эксперта с разрезом по каналам поставки.
INSERT INTO dept_panel_metrics(code,panel_code,display_name,unit,kind,op,operands,formula_text,by_channel,sort_order) VALUES
 ('oo_supply_plan','OO','План поставки, шт','COUNT','PLAN',NULL,'{}',NULL,true,10),
 ('oo_stock_first','OO','Факт склад на 1-е число','COUNT','FACT',NULL,'{}',NULL,true,20),
 ('oo_supply_fact','OO','Факт поставки на дату','COUNT','FACT',NULL,'{}',NULL,true,30),
 ('oo_supply_done','OO','Выполнение плана поставок','PCT','COMPUTED','RATIO','{oo_supply_fact,oo_supply_plan}','факт поставок / план поставок',true,40),
 ('oo_commission_plan','OO','План по проданным комиссиям','COUNT','PLAN',NULL,'{}',NULL,false,50),
 ('oo_sold_fact','OO','Факт проданные авто','COUNT','FACT',NULL,'{}',NULL,true,60),
 ('oo_outflow','OO','Отток комиссий','COUNT','FACT',NULL,'{}',NULL,true,70),
 ('oo_commission_done','OO','Выполнение плана по комиссиям','PCT','COMPUTED','RATIO','{oo_sold_fact,oo_commission_plan}','факт проданных / план по комиссиям',false,80),
 ('oo_stock_turnover','OO','Оборачиваемость склада','PCT','COMPUTED','RATIO','{oo_sold_fact,oo_stock_first}','проданные авто / склад на 1-е число',true,90),
 ('oo_backlog','OO','Наработки, срез каждый понедельник','COUNT','FACT',NULL,'{}',NULL,false,100),
 ('oo_visit_to_deal','OO','Конверсия визит / сделка','PCT','FACT',NULL,'{}',NULL,false,110),
 ('oo_cc_backlog','OO','Наработки КЦ','COUNT','FACT',NULL,'{}',NULL,false,120),
 ('oo_cc_deals','OO','Сделки КЦ','COUNT','FACT',NULL,'{}',NULL,false,130),
 ('oo_cc_conversion','OO','Конверсия КЦ','PCT','COMPUTED','RATIO','{oo_cc_deals,oo_cc_backlog}','сделки КЦ / наработки КЦ',false,140),
 ('oo_km_rub','OO','КМ, руб','RUB','FACT',NULL,'{}',NULL,true,150)
ON CONFLICT (code) DO NOTHING;

-- ============================ ПАНЕЛЬ КСО ============================
-- Лист «КСО». Показатели вводятся сотрудником КСО; разрез по МОП в панели ОП.
INSERT INTO dept_panel_metrics(code,panel_code,display_name,unit,kind,op,operands,formula_text,sort_order) VALUES
 ('kso_leads','KSO','Подводы','COUNT','FACT',NULL,'{}',NULL,10),
 ('kso_applications','KSO','Подача заявки','COUNT','FACT',NULL,'{}',NULL,20),
 ('kso_approved','KSO','Одобрение','COUNT','FACT',NULL,'{}',NULL,30),
 ('kso_issued','KSO','Выдачи без брокерских','COUNT','FACT',NULL,'{}',NULL,40),
 ('kso_broker_deals','KSO','Брокерские сделки','COUNT','FACT',NULL,'{}',NULL,50),
 ('kso_deals_total','KSO','Сделки итого','COUNT','COMPUTED','SUM','{kso_issued,kso_broker_deals}','выдачи без брокерских + брокерские',60),
 ('kso_approval_conv','KSO','Конверсия одобрено / выдано','PCT','COMPUTED','RATIO','{kso_issued,kso_approved}','выдачи / одобрения',70),
 ('kso_gross','KSO','Вал итого','RUB','FACT',NULL,'{}',NULL,80),
 ('kso_avg_check','KSO','Средний чек','RUB','COMPUTED','RATIO','{kso_gross,kso_deals_total}','вал итого / сделки итого',90),
 ('kso_osago','KSO','ОСАГО, шт','COUNT','FACT',NULL,'{}',NULL,100),
 ('kso_cars_sold','KSO','Всего проданных авто (кредит + наличные)','COUNT','FACT',NULL,'{}',NULL,110),
 ('kso_osago_share','KSO','Доля ОСАГО','PCT','COMPUTED','RATIO','{kso_osago,kso_cars_sold}','ОСАГО / всего проданных авто',120),
 ('kso_life','KSO','СЖ','COUNT','FACT',NULL,'{}',NULL,130),
 ('kso_life_cancel','KSO','Расторжение СЖ','COUNT','FACT',NULL,'{}',NULL,140),
 ('kso_life_cancel_share','KSO','Расторжение СЖ, %','PCT','COMPUTED','RATIO','{kso_life_cancel,kso_life}','расторжения / СЖ',150),
 ('kso_credit_share','KSO','Доля в кредит с брокерскими','PCT','COMPUTED','RATIO','{kso_deals_total,kso_cars_sold}','сделки итого / всего проданных авто',160),
 ('kso_forecast','KSO','Прогноз','RUB','FACT',NULL,'{}',NULL,170),
 ('kso_forecast_done','KSO','Прогноз, %','PCT','COMPUTED','RATIO','{kso_gross,kso_forecast}','вал итого / прогноз',180)
ON CONFLICT (code) DO NOTHING;

-- Аудит принимает новый вид сущности: изменение величины в панели отдела
-- фиксируется наравне с остальными действиями, иначе правка задним числом
-- осталась бы только в истории самой таблицы.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus','service_intake',
   'source_naming','dept_panel_value'));
