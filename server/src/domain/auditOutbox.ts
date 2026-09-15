import { PoolClient } from 'pg';

export interface AuditEventInput {
  actorUserId: string | null;
  actorRole: string | null;
  orgUnitId: string | null;
  workItemId: string | null;
  action: string;
  aggregateType: 'work_item' | 'session' | 'notification' | 'access' | 'org_change';
  aggregateId: string;
  aggregateVersion: number;
  requestId: string;
  beforeState: unknown;
  afterState: unknown;
  reason?: string | null;
  resolution: 'APPLIED' | 'REJECTED';
  retentionClass: 'WORK_ITEM_STANDARD' | 'SECURITY_5Y' | 'ACCESS_RESOLUTION_90D';
  ip?: string | null;
  userAgent?: string | null;
  eventType?: string; // if provided, also writes outbox_events
  correlationId?: string;
  payload?: unknown; // outbox payload; never includes completion_summary/secrets
}

/**
 * Writes append-only audit_log and, when eventType is given, the matching
 * outbox_events row in the SAME transaction (contract §4 step 6: "audit,
 * outbox, успешный idempotency response в одной PostgreSQL транзакции").
 * Caller must already be inside a transaction using this client.
 */
export async function writeAuditAndOutbox(client: PoolClient, input: AuditEventInput): Promise<string> {
  const auditRes = await client.query(
    `INSERT INTO audit_log
       (actor_user_id, actor_role, org_unit_id, work_item_id, action, aggregate_type,
        aggregate_id, aggregate_version, request_id, before_state, after_state,
        reason, resolution, ip, user_agent, retention_class)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING id`,
    [
      input.actorUserId,
      input.actorRole,
      input.orgUnitId,
      input.workItemId,
      input.action,
      input.aggregateType,
      input.aggregateId,
      input.aggregateVersion,
      input.requestId,
      input.beforeState ? JSON.stringify(input.beforeState) : null,
      input.afterState ? JSON.stringify(input.afterState) : null,
      input.reason ?? null,
      input.resolution,
      input.ip ?? null,
      input.userAgent ?? null,
      input.retentionClass,
    ],
  );
  const auditId = auditRes.rows[0].id;

  if (input.eventType && input.resolution === 'APPLIED') {
    await client.query(
      `INSERT INTO outbox_events
         (event_type, aggregate_type, aggregate_id, aggregate_version, org_unit_id,
          actor_id, correlation_id, audit_id, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        input.eventType,
        input.aggregateType,
        input.aggregateId,
        input.aggregateVersion,
        input.orgUnitId,
        input.actorUserId,
        input.correlationId ?? input.requestId,
        auditId,
        JSON.stringify(input.payload ?? {}),
      ],
    );
  }
  return auditId;
}
