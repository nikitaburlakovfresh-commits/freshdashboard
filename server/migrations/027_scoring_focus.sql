SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- Шаг C: модель балла филиала (веса и правила светофора) и 5 фокусных слотов месяца
-- настраиваются внутри портала. Версии историчны, имеют дату вступления в силу
-- и не перезаписываются: прошлая отчётность не искажается новой настройкой.
INSERT INTO permissions(code,description) VALUES
 ('metric.scoring.manage','Настраивать веса и правила балла филиала внутри портала'),
 ('metric.focus.manage','Настраивать фокусы внимания месяца внутри портала');
INSERT INTO role_permissions(role_code,permission_code) VALUES
 ('SUPER_ADMIN','metric.scoring.manage'),('SUPER_ADMIN','metric.focus.manage')
 ON CONFLICT DO NOTHING;

ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus'));
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('metric.scoring.changed','NONE'),('metric.focus.changed','NONE');

-- Модель балла: cap, правила RED/GREEN, стоп-фактор и полосы конверсии.
-- Ни одно из значений не зашито в код; расчёт без действующей версии не выполняется.
CREATE TABLE scoring_models (
 id uuid PRIMARY KEY,
 score_cap numeric NOT NULL CHECK(score_cap>0 AND score_cap<=1000),
 red_score_below numeric NOT NULL CHECK(red_score_below>0),
 red_revenue_runrate_below numeric NOT NULL CHECK(red_revenue_runrate_below>0),
 red_weak_metric_below numeric NOT NULL CHECK(red_weak_metric_below>0),
 red_weak_metric_count smallint NOT NULL CHECK(red_weak_metric_count>=1 AND red_weak_metric_count<=20),
 stop_turnover_below numeric NOT NULL CHECK(stop_turnover_below>0),
 green_score_above numeric NOT NULL CHECK(green_score_above>0),
 green_revenue_above numeric NOT NULL CHECK(green_revenue_above>0),
 green_turnover_above numeric NOT NULL CHECK(green_turnover_above>0),
 green_no_metric_below numeric NOT NULL CHECK(green_no_metric_below>0),
 conversion_green_from numeric NOT NULL CHECK(conversion_green_from>0),
 conversion_green_score numeric NOT NULL CHECK(conversion_green_score>0),
 conversion_amber_from numeric NOT NULL CHECK(conversion_amber_from>0),
 conversion_amber_score numeric NOT NULL CHECK(conversion_amber_score>0),
 conversion_red_score numeric NOT NULL CHECK(conversion_red_score>=0),
 effective_from date NOT NULL,
 effective_to date,
 reason text NOT NULL CHECK(char_length(btrim(reason))>=16 AND char_length(reason)<=500),
 created_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT scoring_models_period CHECK(effective_to IS NULL OR effective_to>effective_from),
 CONSTRAINT scoring_models_green_above_red CHECK(green_score_above>=red_score_below),
 CONSTRAINT scoring_models_cap CHECK(score_cap>=green_score_above),
 CONSTRAINT scoring_models_conversion_bands CHECK(
   conversion_green_from>conversion_amber_from
   AND conversion_green_score>=conversion_amber_score
   AND conversion_amber_score>=conversion_red_score),
 -- Одновременно действует не более одной модели балла.
 EXCLUDE USING gist (daterange(effective_from,effective_to,'[)') WITH &&)
);
CREATE FUNCTION scoring_models_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'scoring_models is append-only'; END IF;
 IF NEW.id<>OLD.id OR NEW.effective_from<>OLD.effective_from OR NEW.reason<>OLD.reason
   OR NEW.created_by<>OLD.created_by OR NEW.audit_id<>OLD.audit_id OR NEW.created_at<>OLD.created_at
   OR NEW.score_cap<>OLD.score_cap OR NEW.red_score_below<>OLD.red_score_below
   OR NEW.red_revenue_runrate_below<>OLD.red_revenue_runrate_below
   OR NEW.red_weak_metric_below<>OLD.red_weak_metric_below
   OR NEW.red_weak_metric_count<>OLD.red_weak_metric_count
   OR NEW.stop_turnover_below<>OLD.stop_turnover_below
   OR NEW.green_score_above<>OLD.green_score_above OR NEW.green_revenue_above<>OLD.green_revenue_above
   OR NEW.green_turnover_above<>OLD.green_turnover_above OR NEW.green_no_metric_below<>OLD.green_no_metric_below
   OR NEW.conversion_green_from<>OLD.conversion_green_from OR NEW.conversion_green_score<>OLD.conversion_green_score
   OR NEW.conversion_amber_from<>OLD.conversion_amber_from OR NEW.conversion_amber_score<>OLD.conversion_amber_score
   OR NEW.conversion_red_score<>OLD.conversion_red_score THEN
   RAISE EXCEPTION 'scoring_models allows closing effective_to only';
 END IF;
 IF OLD.effective_to IS NOT NULL THEN RAISE EXCEPTION 'scoring_models version already closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER scoring_models_append_only BEFORE UPDATE OR DELETE ON scoring_models
 FOR EACH ROW EXECUTE FUNCTION scoring_models_guard();

-- Веса метрик версии модели. Вес 0 означает наблюдательную метрику вне балла.
CREATE TABLE scoring_weights (
 id uuid PRIMARY KEY,
 model_id uuid NOT NULL REFERENCES scoring_models(id),
 metric text NOT NULL CHECK(char_length(btrim(metric))BETWEEN 2 AND 64),
 weight numeric NOT NULL CHECK(weight>=0 AND weight<=1000),
 -- Оборачиваемость выкупа приходит мотивационным коэффициентом, а не run-rate.
 evaluation text NOT NULL CHECK(evaluation IN('RUN_RATE','RATIO_X100','CONVERSION_BANDS')),
 -- Показатель плана для run-rate задаётся настройкой, а не кодом.
 plan_metric text CHECK(plan_metric IS NULL OR char_length(btrim(plan_metric))BETWEEN 2 AND 64),
 -- Роль метрики в правилах светофора: выручка и оборачиваемость имеют отдельные правила.
 rule_role text NOT NULL DEFAULT 'ORDINARY' CHECK(rule_role IN('ORDINARY','REVENUE','TURNOVER_STOP')),
 CONSTRAINT scoring_weights_run_rate_plan CHECK(evaluation<>'RUN_RATE' OR plan_metric IS NOT NULL),
 UNIQUE(model_id,metric)
);
CREATE UNIQUE INDEX scoring_weights_single_rule_role ON scoring_weights(model_id,rule_role)
 WHERE rule_role<>'ORDINARY';
CREATE INDEX scoring_weights_model ON scoring_weights(model_id);
CREATE TRIGGER scoring_weights_immutable BEFORE UPDATE OR DELETE ON scoring_weights
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

-- Каталог метрик фокусов: код, подпись, направление, формат и план по умолчанию.
CREATE TABLE focus_metric_catalog (
 code text PRIMARY KEY CHECK(code ~ '^[a-z][a-z0-9_]{2,63}$'),
 label text NOT NULL CHECK(char_length(btrim(label))BETWEEN 2 AND 120),
 direction text NOT NULL CHECK(direction IN('HIGHER_IS_BETTER','LOWER_IS_BETTER')),
 format text NOT NULL CHECK(format IN('COUNT','PCT','RUB','RUB_MLN')),
 default_plan numeric,
 requires_vin_level boolean NOT NULL DEFAULT false,
 requires_daily_logs boolean NOT NULL DEFAULT false,
 sort_order smallint NOT NULL
);
INSERT INTO focus_metric_catalog(code,label,direction,format,default_plan,requires_vin_level,requires_daily_logs,sort_order) VALUES
 ('sales_units','Продажи, шт','HIGHER_IS_BETTER','COUNT',2500,false,false,1),
 ('sales_forecast_pct','RunRate продаж','HIGHER_IS_BETTER','PCT',100,false,false,2),
 ('avg_sale_price','Средняя стоимость авто','HIGHER_IS_BETTER','RUB',NULL,false,false,3),
 ('margin_fact','Маржа факт, млн ₽','HIGHER_IS_BETTER','RUB_MLN',NULL,false,false,4),
 ('margin_runrate','RunRate маржи','HIGHER_IS_BETTER','PCT',100,false,false,5),
 ('turnover_commission','Оборач. комиссии','HIGHER_IS_BETTER','PCT',40,false,false,6),
 ('turnover_buyback','Оборач. выкупа','HIGHER_IS_BETTER','PCT',80,false,false,7),
 ('hangers45_buyback','Висяки 45+ выкуп','LOWER_IS_BETTER','PCT',7,false,false,8),
 ('hangers45_commission','Висяки 45+ комиссия','LOWER_IS_BETTER','PCT',40,false,false,9),
 ('hangers45_total','Висяки 45+ всего','LOWER_IS_BETTER','PCT',20,false,false,10),
 ('stock_units_end','Склад на конец, шт','HIGHER_IS_BETTER','COUNT',NULL,false,false,11),
 ('trade_up_total','Trade-Up доля','HIGHER_IS_BETTER','PCT',30,false,false,12),
 ('credits_completion','Кредиты % выполнения','HIGHER_IS_BETTER','PCT',100,false,false,13),
 ('conversion_traffic_to_deal','Звонок → Сделка','HIGHER_IS_BETTER','PCT',15,false,false,14),
 ('conversion_visit_to_deal','Визит → Сделка','HIGHER_IS_BETTER','PCT',40,false,false,15),
 ('traffic_count','Трафик, шт','HIGHER_IS_BETTER','COUNT',NULL,false,false,16),
 ('not_in_ads_share','Доля авто не в рекламе','LOWER_IS_BETTER','PCT',5,true,false,17),
 ('leads_per_car','Лидов на 1 авто','HIGHER_IS_BETTER','COUNT',NULL,true,false,18),
 ('daily_usage_pct','Ежедневник, среднее заполнение','HIGHER_IS_BETTER','PCT',100,false,true,19),
 ('reprice_discipline','Дисциплина переоценки','HIGHER_IS_BETTER','PCT',95,true,false,20),
 ('in_market_share','Доля VIN в рынке','HIGHER_IS_BETTER','PCT',80,true,false,21);

-- Конфигурация фокусов месяца: ровно 5 слотов, историчные версии по месяцу.
CREATE TABLE focus_configurations (
 id uuid PRIMARY KEY,
 month date NOT NULL CHECK(date_trunc('month',month)::date=month),
 effective_from date NOT NULL,
 effective_to date,
 reason text NOT NULL CHECK(char_length(btrim(reason))>=16 AND char_length(reason)<=500),
 created_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT focus_configurations_period CHECK(effective_to IS NULL OR effective_to>effective_from),
 EXCLUDE USING gist (month WITH =, daterange(effective_from,effective_to,'[)') WITH &&)
);
CREATE FUNCTION focus_configurations_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'focus_configurations is append-only'; END IF;
 IF NEW.id<>OLD.id OR NEW.month<>OLD.month OR NEW.effective_from<>OLD.effective_from
   OR NEW.reason<>OLD.reason OR NEW.created_by<>OLD.created_by OR NEW.audit_id<>OLD.audit_id
   OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'focus_configurations allows closing effective_to only';
 END IF;
 IF OLD.effective_to IS NOT NULL THEN RAISE EXCEPTION 'focus_configurations version already closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER focus_configurations_append_only BEFORE UPDATE OR DELETE ON focus_configurations
 FOR EACH ROW EXECUTE FUNCTION focus_configurations_guard();

CREATE TABLE focus_slots (
 id uuid PRIMARY KEY,
 configuration_id uuid NOT NULL REFERENCES focus_configurations(id),
 slot smallint NOT NULL CHECK(slot BETWEEN 1 AND 5),
 metric_code text NOT NULL REFERENCES focus_metric_catalog(code),
 -- План слота задаётся вручную; отсутствие плана не равно нулю.
 plan numeric,
 UNIQUE(configuration_id,slot),
 UNIQUE(configuration_id,metric_code)
);
CREATE TRIGGER focus_slots_immutable BEFORE UPDATE OR DELETE ON focus_slots
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
