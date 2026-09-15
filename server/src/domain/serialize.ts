function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  return d.toISOString().replace(/\.000Z$/, 'Z');
}

export function serializeWorkItem(row: any, field: any, submission: any | null) {
  return {
    id: row.id,
    org_unit_id: row.org_unit_id,
    template_code: 'pilot_task_v1',
    template_version_id: row.template_version_id,
    requires_acceptance: row.requires_acceptance,
    title: row.title,
    due_at: toIso(row.due_at),
    status: row.status,
    assignee_user_id: row.assignee_user_id,
    created_by: row.created_by,
    entity_version: Number(row.entity_version),
    is_blocked: row.is_blocked,
    blocked_reason: row.blocked_reason,
    fields: [
      {
        field_path: 'completion_summary',
        value: field.value,
        field_version: Number(field.field_version),
        updated_at: toIso(field.updated_at),
        updated_by: field.updated_by,
      },
    ],
    submission_revision: row.submission_revision,
    current_submission: submission ? serializeSubmission(submission) : null,
    rework_count: row.rework_count,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function serializeSubmission(s: any) {
  return {
    id: s.id,
    revision: s.revision,
    completion_summary: s.completion_summary,
    field_version: Number(s.field_version),
    entity_version: Number(s.entity_version),
    template_version_id: s.template_version_id,
    due_at: toIso(s.due_at),
    submitted_at: toIso(s.submitted_at),
    submitted_by: s.submitted_by,
    submission_marker: s.submission_marker,
  };
}

export function serializeNotification(n: any) {
  return {
    id: n.id,
    event_id: n.event_id,
    recipient_user_id: n.recipient_user_id,
    org_unit_id: n.org_unit_id,
    work_item_id: n.work_item_id,
    channel: n.channel,
    message: n.message,
    entity_version: Number(n.entity_version),
    created_at: toIso(n.created_at),
    read_at: toIso(n.read_at),
  };
}

export { toIso };
