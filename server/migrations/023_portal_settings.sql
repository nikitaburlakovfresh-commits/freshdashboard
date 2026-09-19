SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- ТЗ v2.12, настраиваемость: числовые параметры управленческого цикла задаются
-- внутри портала. Значение хранится в реестре настроек, изменения историчны и
-- имеют основание; текущее значение читается на каждом расчёте.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting'));

CREATE TABLE portal_settings (
 key text PRIMARY KEY,
 value_number numeric NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE portal_setting_changes (
 id uuid PRIMARY KEY,
 key text NOT NULL REFERENCES portal_settings(key),
 value_before numeric NOT NULL,
 value_after numeric NOT NULL,
 reason text NOT NULL CHECK(char_length(btrim(reason))>=16 AND char_length(reason)<=500),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX portal_setting_changes_key ON portal_setting_changes(key,created_at DESC);

CREATE OR REPLACE FUNCTION portal_setting_changes_guard() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'portal_setting_changes is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER portal_setting_changes_no_update BEFORE UPDATE OR DELETE ON portal_setting_changes
 FOR EACH ROW EXECUTE FUNCTION portal_setting_changes_guard();

INSERT INTO permissions(code,description) VALUES
 ('portal.setting.manage','Настраивать числовые параметры портала внутри портала');
INSERT INTO role_permissions(role_code,permission_code) VALUES('SUPER_ADMIN','portal.setting.manage')
 ON CONFLICT DO NOTHING;
INSERT INTO event_catalog(event_type,notification_policy) VALUES('portal.setting.changed','NONE')
 ON CONFLICT DO NOTHING;

-- Ранее зашитое в коде значение: «срок близко» = 72 часа до срока задачи.
INSERT INTO portal_settings(key,value_number) VALUES('deviation_task_due_soon_hours',72);
