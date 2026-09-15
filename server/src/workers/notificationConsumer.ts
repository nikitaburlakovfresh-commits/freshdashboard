import { pool } from '../db/pool';
import { withTransaction } from '../db/pool';
import { PoolClient } from 'pg';

const CONSUMER_NAME = 'in_app_v1';

// Fixed, safe template text per event type (contract §7: "notification
// содержит фиксированный шаблонный текст ... не snapshot completion_summary").
const MESSAGE_BY_EVENT: Record<string, string> = {
  'work_item.assigned': 'Вам назначена задача.',
  'work_item.submitted': 'Результат сдан на приёмку.',
  'work_item.accepted': 'Задача принята.',
  'work_item.rework_requested': 'Задача возвращена на доработку.',
  'work_item.cancelled': 'Задача отменена.',
  'work_item.reopened': 'Задача возобновлена.',
};

const POLICY_BY_EVENT: Record<string, 'ASSIGNEE' | 'REVIEWERS' | 'NONE'> = {
  'work_item.created': 'NONE',
  'work_item.assigned': 'ASSIGNEE',
  'work_item.started': 'NONE',
  'work_item.fields_patched': 'NONE',
  'work_item.submitted': 'REVIEWERS',
  'work_item.accepted': 'ASSIGNEE',
  'work_item.rework_requested': 'ASSIGNEE',
  'work_item.cancelled': 'ASSIGNEE',
  'work_item.reopened': 'ASSIGNEE',
};

/**
 * Resolves current recipients for an event under the SAME authorization
 * fences as regular reads (contract §4 "IN_APP consumer / callbacks"):
 * re-resolves grants at processing time, not at event-creation time.
 */
async function resolveRecipients(
  client: PoolClient,
  policy: 'ASSIGNEE' | 'REVIEWERS' | 'NONE',
  workItemId: string,
  actorId: string | null,
): Promise<string[]> {
  if (policy === 'NONE') return [];
  const wi = await client.query('SELECT assignee_user_id, org_unit_id, created_by FROM work_items WHERE id = $1', [workItemId]);
  if (wi.rowCount === 0) return [];
  const { assignee_user_id, org_unit_id } = wi.rows[0];

  if (policy === 'ASSIGNEE') {
    if (!assignee_user_id || assignee_user_id === actorId) return [];
    const active = await client.query(
      `SELECT 1 FROM app_users u JOIN role_grants rg ON rg.user_id = u.id
       WHERE u.id = $1 AND u.is_active AND rg.role_code = 'RF' AND rg.org_unit_id = $2
         AND rg.revoked_at IS NULL AND rg.valid_from <= now() AND (rg.valid_until IS NULL OR rg.valid_until > now())`,
      [assignee_user_id, org_unit_id],
    );
    return (active.rowCount ?? 0) > 0 ? [assignee_user_id] : [];
  }

  if (policy === 'REVIEWERS') {
    const rms = await client.query(
      `SELECT rg.user_id FROM role_grants rg JOIN app_users u ON u.id = rg.user_id
       WHERE rg.role_code = 'REGIONAL_MANAGER' AND rg.org_unit_id = $1
         AND rg.revoked_at IS NULL AND rg.valid_from <= now() AND (rg.valid_until IS NULL OR rg.valid_until > now())
         AND u.is_active AND u.id <> ALL($2::uuid[])`,
      [org_unit_id, [actorId, assignee_user_id].filter(Boolean)],
    );
    return rms.rows.map((r) => r.user_id);
  }
  return [];
}

/** Processes all PENDING/RETRY outbox events at least once, idempotently. */
export async function runNotificationConsumerOnce(): Promise<number> {
  let processed = 0;
  // Loop draining events one at a time so each is its own transaction and a
  // failure on one event doesn't block later ones (still ordered by
  // next_attempt_at/occurred_at through the outbox_pending index).
  for (;;) {
    const didWork = await withTransaction(async (client) => {
      const res = await client.query(
        `SELECT event_id, event_type, aggregate_type, aggregate_id, org_unit_id, actor_id
         FROM outbox_events
         WHERE delivery_status IN ('PENDING','RETRY')
         ORDER BY next_attempt_at, occurred_at
         LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (res.rowCount === 0) return false;
      const event = res.rows[0];

      await client.query(
        `UPDATE outbox_events SET delivery_status = 'PROCESSING' WHERE event_id = $1`,
        [event.event_id],
      );

      const already = await client.query(
        `SELECT 1 FROM consumer_receipts WHERE consumer = $1 AND event_id = $2`,
        [CONSUMER_NAME, event.event_id],
      );
      if ((already.rowCount ?? 0) > 0) {
        await client.query(
          `UPDATE outbox_events SET delivery_status = 'PROCESSED', processed_at = now() WHERE event_id = $1`,
          [event.event_id],
        );
        return true;
      }

      const policy = POLICY_BY_EVENT[event.event_type] ?? 'NONE';
      if (event.aggregate_type !== 'work_item' || policy === 'NONE') {
        await client.query(
          `INSERT INTO consumer_receipts (consumer, event_id, outcome) VALUES ($1,$2,'APPLIED')`,
          [CONSUMER_NAME, event.event_id],
        );
        await client.query(
          `UPDATE outbox_events SET delivery_status = 'PROCESSED', processed_at = now() WHERE event_id = $1`,
          [event.event_id],
        );
        return true;
      }

      const recipients = await resolveRecipients(client, policy, event.aggregate_id, event.actor_id);
      if (recipients.length === 0) {
        await client.query(
          `INSERT INTO consumer_receipts (consumer, event_id, outcome, reason)
           VALUES ($1,$2,'SKIPPED_ACCESS_REVOKED',$3)`,
          [CONSUMER_NAME, event.event_id, 'No currently authorized recipient at processing time'],
        );
        await client.query(
          `UPDATE outbox_events SET delivery_status = 'PROCESSED', processed_at = now() WHERE event_id = $1`,
          [event.event_id],
        );
        return true;
      }

      const message = MESSAGE_BY_EVENT[event.event_type] ?? 'Обновление по задаче.';
      for (const recipientId of recipients) {
        const inserted = await client.query(
          `INSERT INTO notifications (event_id, recipient_user_id, org_unit_id, work_item_id, message)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (event_id, recipient_user_id) DO NOTHING
           RETURNING id`,
          [event.event_id, recipientId, event.org_unit_id, event.aggregate_id, message],
        );
        if (inserted.rowCount && inserted.rowCount > 0) {
          const notifId = inserted.rows[0].id;
          const auditRes = await client.query(
            `INSERT INTO audit_log (actor_user_id, org_unit_id, work_item_id, action, aggregate_type,
                aggregate_id, aggregate_version, request_id, after_state, resolution, retention_class)
             VALUES (NULL,$1,$2,'NOTIFICATION_CREATED','notification',$3,1,$4,$5,'APPLIED','WORK_ITEM_STANDARD')
             RETURNING id`,
            [event.org_unit_id, event.aggregate_id, notifId, event.event_id, JSON.stringify({ recipient_id: recipientId })],
          );
          await client.query(
            `INSERT INTO outbox_events (event_type, aggregate_type, aggregate_id, aggregate_version,
                org_unit_id, actor_id, correlation_id, audit_id, payload)
             VALUES ('notification.created','notification',$1,1,$2,NULL,$3,$4,$5)`,
            [notifId, event.org_unit_id, event.event_id, auditRes.rows[0].id, JSON.stringify({ event_id: event.event_id })],
          );
        }
      }

      await client.query(
        `INSERT INTO consumer_receipts (consumer, event_id, outcome) VALUES ($1,$2,'APPLIED')`,
        [CONSUMER_NAME, event.event_id],
      );
      await client.query(
        `UPDATE outbox_events SET delivery_status = 'PROCESSED', processed_at = now() WHERE event_id = $1`,
        [event.event_id],
      );
      return true;
    });
    if (!didWork) break;
    processed += 1;
  }
  return processed;
}

let intervalHandle: NodeJS.Timeout | null = null;

export function startNotificationConsumerLoop(intervalMs = 500): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    runNotificationConsumerOnce().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('notification consumer error', err);
    });
  }, intervalMs);
}

export function stopNotificationConsumerLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

export async function drainNotificationsForTests(): Promise<void> {
  await runNotificationConsumerOnce();
}

void pool; // keep pool import for potential direct use/tests
