-- Уведомление постановщику о просроченной задаче (решение владельца 26.09.2026).
-- На следующий день после срока автор задачи получает одно уведомление на
-- пару «задача + срок»; перенос срока даёт новое уведомление при новой просрочке.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO event_catalog(event_type,notification_policy) VALUES ('work_item.overdue_notice','NONE')
  ON CONFLICT (event_type) DO NOTHING;
CREATE TABLE IF NOT EXISTS work_item_overdue_notices (
  work_item_id uuid NOT NULL,
  org_unit_id uuid NOT NULL,
  due_at timestamptz NOT NULL,
  recipient_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  notification_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (work_item_id, due_at),
  FOREIGN KEY (work_item_id, org_unit_id) REFERENCES work_items(id, org_unit_id) ON DELETE RESTRICT
);
