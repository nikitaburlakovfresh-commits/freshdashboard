SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- ТЗ v2.12: пороги показателей задаются настройками портала, а не кодом.
-- Версии порогов историчны, имеют дату вступления в силу и не перезаписываются.
INSERT INTO permissions(code,description) VALUES
 ('metric.threshold.manage','Настраивать пороги светофора показателей внутри портала');
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage','metric_threshold'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage','metric_threshold'));
CREATE TABLE metric_thresholds (
 id uuid PRIMARY KEY,
 metric text NOT NULL CHECK(metric IN('sales','margin','stock','aged','plan','revenue','baseMargin','kso')),
 scope_kind text NOT NULL CHECK(scope_kind IN('NETWORK','ORG_UNIT')),
 org_unit_id uuid REFERENCES org_directory_units(id),
 -- Направление показателя: больше лучше (продажи) или меньше лучше (склад 45+).
 direction text NOT NULL CHECK(direction IN('HIGHER_IS_BETTER','LOWER_IS_BETTER')),
 -- Пороги в единицах измерения показателя либо в процентах исполнения плана.
 basis text NOT NULL CHECK(basis IN('ABSOLUTE','PLAN_PERCENT')),
 unit text NOT NULL CHECK(unit IN('COUNT','RUB','PCT')),
 green_from numeric NOT NULL,
 amber_from numeric NOT NULL,
 effective_from date NOT NULL,
 effective_to date,
 reason text NOT NULL CHECK(char_length(btrim(reason))>=16 AND char_length(reason)<=500),
 created_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT metric_thresholds_scope_shape CHECK(
   (scope_kind='NETWORK' AND org_unit_id IS NULL) OR (scope_kind='ORG_UNIT' AND org_unit_id IS NOT NULL)),
 CONSTRAINT metric_thresholds_period CHECK(effective_to IS NULL OR effective_to>effective_from),
 CONSTRAINT metric_thresholds_order CHECK(
   (direction='HIGHER_IS_BETTER' AND green_from>amber_from) OR
   (direction='LOWER_IS_BETTER' AND green_from<amber_from)),
 CONSTRAINT metric_thresholds_percent_unit CHECK(basis<>'PLAN_PERCENT' OR unit='PCT'),
 -- Одновременно действует не более одной версии на показатель и область.
 EXCLUDE USING gist (metric WITH =, COALESCE(org_unit_id,'00000000-0000-0000-0000-000000000000'::uuid) WITH =,
   daterange(effective_from,effective_to,'[)') WITH &&)
);
CREATE INDEX metric_thresholds_lookup ON metric_thresholds(metric,org_unit_id,effective_from DESC);
-- Разрешено только закрытие действующей версии: остальные поля неизменяемы.
CREATE FUNCTION metric_thresholds_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'metric_thresholds is append-only'; END IF;
 IF NEW.id<>OLD.id OR NEW.metric<>OLD.metric OR NEW.scope_kind<>OLD.scope_kind
   OR COALESCE(NEW.org_unit_id,'00000000-0000-0000-0000-000000000000'::uuid)
      <>COALESCE(OLD.org_unit_id,'00000000-0000-0000-0000-000000000000'::uuid)
   OR NEW.direction<>OLD.direction OR NEW.basis<>OLD.basis OR NEW.unit<>OLD.unit
   OR NEW.green_from<>OLD.green_from OR NEW.amber_from<>OLD.amber_from
   OR NEW.effective_from<>OLD.effective_from OR NEW.reason<>OLD.reason
   OR NEW.created_by<>OLD.created_by OR NEW.audit_id<>OLD.audit_id OR NEW.created_at<>OLD.created_at THEN
   RAISE EXCEPTION 'metric_thresholds allows closing effective_to only';
 END IF;
 IF OLD.effective_to IS NOT NULL THEN RAISE EXCEPTION 'metric_thresholds version already closed'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER metric_thresholds_append_only BEFORE UPDATE OR DELETE ON metric_thresholds
 FOR EACH ROW EXECUTE FUNCTION metric_thresholds_guard();
INSERT INTO event_catalog(event_type,notification_policy) VALUES ('metric.threshold.changed','NONE');
