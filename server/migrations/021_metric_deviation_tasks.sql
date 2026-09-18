SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- ТЗ v2.12, управленческий цикл: отклонение показателя → задача ответственному.
-- Связь фиксирует, какое именно отклонение (филиал, показатель, период, версия
-- снимка и версия порога) послужило основанием задачи. Связь неизменяема:
-- переоценка отклонения не должна задним числом менять основание задачи.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation'));
CREATE TABLE metric_deviation_tasks (
 id uuid PRIMARY KEY,
 work_item_id uuid NOT NULL UNIQUE REFERENCES work_items(id),
 org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
 metric text NOT NULL CHECK(metric IN('sales','margin','stock','aged','plan','revenue','baseMargin','kso')),
 period_start date NOT NULL,
 period_end date NOT NULL CHECK(period_end>=period_start),
 -- Версия снимка показателя и версия порога на момент постановки задачи.
 snapshot_id uuid NOT NULL REFERENCES report_fact_snapshots(id),
 threshold_id uuid NOT NULL REFERENCES metric_thresholds(id),
 -- Зафиксированное отклонение: только RED или AMBER; NONE и GREEN задачу не создают.
 rag text NOT NULL CHECK(rag IN('RED','AMBER')),
 observed_value numeric NOT NULL,
 basis text NOT NULL CHECK(basis IN('ABSOLUTE','PLAN_PERCENT')),
 basis_value numeric NOT NULL,
 reason text NOT NULL CHECK(char_length(btrim(reason))>=16 AND char_length(reason)<=500),
 created_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 -- Одно отклонение одной версии порога не порождает дубли задач. Новая версия
 -- порога или новая ревизия снимка — это новое основание и новая задача.
 CONSTRAINT metric_deviation_tasks_unique UNIQUE (org_unit_id,metric,period_start,period_end,snapshot_id,threshold_id)
);
CREATE INDEX metric_deviation_tasks_period ON metric_deviation_tasks(org_unit_id,period_start,period_end);
CREATE INDEX metric_deviation_tasks_work_item ON metric_deviation_tasks(work_item_id);
CREATE FUNCTION metric_deviation_tasks_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'metric_deviation_tasks is append-only';
END $$;
CREATE TRIGGER metric_deviation_tasks_append_only BEFORE UPDATE OR DELETE ON metric_deviation_tasks
 FOR EACH ROW EXECUTE FUNCTION metric_deviation_tasks_guard();
INSERT INTO event_catalog(event_type,notification_policy) VALUES ('metric.deviation.task_created','NONE');
