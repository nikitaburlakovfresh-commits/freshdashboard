import type { TemplateRow } from './workItemRepo';

function toIso(v: Date | string | null): string | null {
  if (v === null) return null;
  const d = typeof v === 'string' ? new Date(v) : v;
  return d.toISOString().replace(/\.000Z$/, 'Z');
}

// `template` is the templates row referenced by row.template_version_id --
// template_code is read from it instead of a hardcoded literal, so this
// stays correct once more than one template exists (§13.13.1). `fields` is
// every work_item_fields row for this work item, in field_path order --
// today that is always exactly the one field pilot_task_v1 defines, but the
// shape no longer assumes that.
export function serializeWorkItem(row: any, template: TemplateRow, fields: any[], submission: any | null) {
  return {
    id: row.id,
    org_unit_id: row.org_unit_id,
    template_code: template.code,
    template_display_name: template.display_name,
    field_schema: template.field_schema,
    field_ownership_rules: template.field_ownership_rules,
    owner_role: [...new Set(Object.values(template.field_ownership_rules))].length === 1
      ? Object.values(template.field_ownership_rules)[0] : null,
    template_version_id: row.template_version_id,
    requires_acceptance: row.requires_acceptance,
    title: row.title,
    due_at: toIso(row.due_at),
    status: row.status,
    assignee_user_id: row.assignee_user_id,
    created_by: row.created_by,
    // Суть поручения словами постановщика и строка ежедневника, из которой оно
    // пришло (машина, звонок). Для обычных задач — null.
    brief: row.brief ?? null,
    source_ref: row.source_ref ?? null,
    parent_work_item_id: row.parent_work_item_id ?? null,
    entity_version: Number(row.entity_version),
    is_blocked: row.is_blocked,
    blocked_reason: row.blocked_reason,
    fields: fields.map((field) => ({
      field_path: field.field_path,
      value: field.value,
      field_version: Number(field.field_version),
      updated_at: toIso(field.updated_at),
      updated_by: field.updated_by,
    })),
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
    field_values: s.field_values,
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
