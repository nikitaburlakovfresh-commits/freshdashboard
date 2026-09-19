SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- ТЗ v2.12, настраиваемость: политика рассылки уведомлений управляется внутри
-- портала, а не правкой кода. Каталог событий уже хранит notification_policy;
-- миграция добавляет историю изменений политики и право администрирования.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy'));

-- Append-only история: кто, когда и на каком основании менял политику рассылки.
CREATE TABLE notification_policy_changes (
 id uuid PRIMARY KEY,
 event_type text NOT NULL REFERENCES event_catalog(event_type),
 policy_before text NOT NULL CHECK(policy_before IN('NONE','ASSIGNEE','REVIEWERS')),
 policy_after text NOT NULL CHECK(policy_after IN('NONE','ASSIGNEE','REVIEWERS')),
 reason text NOT NULL CHECK(char_length(btrim(reason))>=16 AND char_length(reason)<=500),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_policy_changes_event ON notification_policy_changes(event_type,created_at DESC);

CREATE OR REPLACE FUNCTION notification_policy_changes_guard() RETURNS trigger AS $$
BEGIN
 RAISE EXCEPTION 'notification_policy_changes is append-only';
END $$ LANGUAGE plpgsql;
CREATE TRIGGER notification_policy_changes_no_update BEFORE UPDATE OR DELETE ON notification_policy_changes
 FOR EACH ROW EXECUTE FUNCTION notification_policy_changes_guard();

INSERT INTO event_catalog(event_type,notification_policy) VALUES('notification.policy.changed','NONE')
 ON CONFLICT DO NOTHING;
INSERT INTO permissions(code,description) VALUES
 ('notification.policy.manage','Настраивать политику рассылки уведомлений внутри портала');
INSERT INTO role_permissions(role_code,permission_code) VALUES('SUPER_ADMIN','notification.policy.manage')
 ON CONFLICT DO NOTHING;

-- Уведомление ответственному по отклонению доставляется штатным событием
-- назначения задачи: текст выбирается по связи задачи с отклонением. Событие
-- фиксации отклонения остаётся доказательным и рассылку не порождает.
UPDATE event_catalog SET notification_policy='ASSIGNEE' WHERE event_type='work_item.assigned';
