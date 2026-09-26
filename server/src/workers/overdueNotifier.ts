import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';

/**
 * Уведомление постановщику о просрочке (решение владельца 26.09.2026).
 * Раз в несколько минут ищет открытые задачи (кроме самих ежедневников и
 * личных записей), срок которых остался во вчерашнем или более раннем дне по
 * Москве, и пишет автору задачи одно уведомление на пару «задача + срок».
 * Уведомление идёт через журнал событий, как и остальные; событие с типом
 * notification обработчиком входящих не рассылается повторно.
 */
export async function runOverdueNoticesOnce(): Promise<number> {
  return withTransaction(async (c) => {
    const rows = (await c.query(
      `SELECT w.id, w.org_unit_id, w.due_at, w.created_by, w.title,
              to_char(w.due_at AT TIME ZONE 'Europe/Moscow','DD.MM HH24:MI') due_local,
              coalesce(ex.full_name,'исполнитель не назначен') executor, ou.display_name branch
         FROM work_items w
         JOIN templates t ON t.id=w.template_version_id
         JOIN app_users author ON author.id=w.created_by AND author.is_active
         LEFT JOIN app_users ex ON ex.id=w.assignee_user_id
         LEFT JOIN org_units ou ON ou.id=w.org_unit_id
        WHERE w.status IN ('ASSIGNED','IN_PROGRESS')
          AND w.due_at IS NOT NULL AND w.due_at > now() - interval '3 days'
          AND (w.due_at AT TIME ZONE 'Europe/Moscow')::date < (now() AT TIME ZONE 'Europe/Moscow')::date
          AND w.created_by IS DISTINCT FROM w.assignee_user_id
          AND t.code NOT LIKE 'personal_daily_%' AND t.code NOT LIKE 'personal_note_%'
          AND NOT EXISTS (SELECT 1 FROM work_item_overdue_notices n WHERE n.work_item_id=w.id AND n.due_at=w.due_at)
        ORDER BY w.due_at LIMIT 200
        FOR UPDATE OF w SKIP LOCKED`)).rows;
    for (const r of rows) {
      const noticeId = randomUUID();
      const title = String(r.title).length > 120 ? String(r.title).slice(0, 117) + '…' : r.title;
      const message = `Просрочена задача «${title}»: ${r.executor}${r.branch ? `, ${r.branch}` : ''}, срок был ${r.due_local} МСК.`.slice(0, 300);
      const audit = (await c.query(
        `INSERT INTO audit_log (actor_user_id, org_unit_id, work_item_id, action, aggregate_type,
            aggregate_id, aggregate_version, request_id, after_state, resolution, retention_class)
         VALUES (NULL,$1,$2,'OVERDUE_NOTICE','notification',$3,1,$3,$4,'APPLIED','WORK_ITEM_STANDARD') RETURNING id`,
        [r.org_unit_id, r.id, noticeId, JSON.stringify({ recipient_id: r.created_by, due_at: r.due_at })])).rows[0].id;
      const ev = (await c.query(
        `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version,
            org_unit_id, actor_id, correlation_id, audit_id, payload)
         VALUES ('work_item.overdue_notice','notification',$1,1,$2,NULL,$1,$3,$4) RETURNING event_id`,
        [noticeId, r.org_unit_id, audit, JSON.stringify({ work_item_id: r.id })])).rows[0].event_id;
      const n = (await c.query(
        `INSERT INTO notifications (event_id, recipient_user_id, org_unit_id, work_item_id, message)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`, [ev, r.created_by, r.org_unit_id, r.id, message])).rows[0].id;
      await c.query(
        `INSERT INTO work_item_overdue_notices (work_item_id, org_unit_id, due_at, recipient_user_id, notification_id)
         VALUES ($1,$2,$3,$4,$5)`, [r.id, r.org_unit_id, r.due_at, r.created_by, n]);
    }
    return rows.length;
  });
}

let handle: NodeJS.Timeout | null = null;
export function startOverdueNotifierLoop(intervalMs = 5 * 60 * 1000): void {
  if (handle) return;
  const tick = () => runOverdueNoticesOnce().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('overdue notifier error', err);
  });
  setTimeout(tick, 30_000);
  handle = setInterval(tick, intervalMs);
}
