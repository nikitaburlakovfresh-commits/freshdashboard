SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Названия строк в выгрузках QLIK не совпадают с каноническими названиями
-- филиалов («Fresh Омск» — это «Омск Кольцевая», «Fresh Мурманск Кольский» —
-- «Мурманск»). Соответствие задаётся внутри портала, а не в коде: у филиала
-- может быть несколько действующих названий-источников с историей.
-- Отдельно фиксируются названия вне контура сети: они не блокируют приём и
-- не превращаются в филиал, а явно исключаются с основанием.
INSERT INTO permissions(code,description) VALUES
 ('report.source_naming.manage','Управление названиями филиалов в источниках и исключениями строк вне контура сети');

CREATE TABLE org_source_aliases (
 id uuid PRIMARY KEY,
 org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
 source_name text NOT NULL CHECK(length(btrim(source_name)) BETWEEN 2 AND 200),
 -- Нормализованная форма для однозначного сравнения; вычисляется приложением.
 source_name_norm text NOT NULL CHECK(length(source_name_norm) BETWEEN 1 AND 200),
 effective_from date NOT NULL,
 effective_to date,
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 16 AND 500),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(effective_to IS NULL OR effective_to > effective_from)
);
-- Одно название источника не может одновременно указывать на два филиала.
CREATE UNIQUE INDEX org_source_aliases_active_norm_idx
 ON org_source_aliases(source_name_norm) WHERE effective_to IS NULL;
CREATE INDEX org_source_aliases_unit_idx ON org_source_aliases(org_unit_id);

CREATE TABLE report_source_exclusions (
 id uuid PRIMARY KEY,
 network_id uuid NOT NULL REFERENCES org_directory_units(id),
 source_name text NOT NULL CHECK(length(btrim(source_name)) BETWEEN 2 AND 200),
 source_name_norm text NOT NULL CHECK(length(source_name_norm) BETWEEN 1 AND 200),
 effective_from date NOT NULL,
 revoked_at timestamptz,
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 16 AND 500),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX report_source_exclusions_active_idx
 ON report_source_exclusions(network_id,source_name_norm) WHERE revoked_at IS NULL;

INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('report.source_naming.changed','NONE');

ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus','service_intake',
   'source_naming'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus','service_intake',
   'source_naming'));
