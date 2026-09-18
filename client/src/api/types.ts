export type WorkItemStatus = 'DRAFT' | 'ASSIGNED' | 'IN_PROGRESS' | 'SUBMITTED' | 'COMPLETED' | 'CANCELLED';

export interface User {
  id: string;
  login: string;
  full_name: string;
  user_kind: 'INDIVIDUAL';
}

interface GrantBase {
  id: string;
  valid_from: string;
  valid_until: string | null;
  permissions: string[];
}
// role is any ORG_UNIT-scoped role code from the server's role catalog
// (REGIONAL_MANAGER, RF, ROP, ROO, ...), not just RF -- generalized
// 2026-09-18 alongside the server-side authorization generalization in
// workItemService.ts/grants.ts. NETWORK scope stays SUPER_ADMIN-only
// (unchanged, separate concern).
export type Grant = GrantBase & (
  { role:string; scope_kind?:'ORG_UNIT'; org_unit_id:string } |
  { role:'SUPER_ADMIN'; scope_kind:'NETWORK'; org_unit_id:null }
);

export interface SessionResponse {
  user: User;
  csrf_token: string;
  expires_at: string;
}

export interface MeResponse extends SessionResponse {
  grants: Grant[];
  // BETA-01. Признак ограниченного выпуска. Старые ответы без поля
  // трактуются как «контур доступен», чтобы не выдумывать состояние.
  features?: { report_intake?: boolean; source_scan_mode?: 'clamav' | 'off' };
}

export interface SavedField {
  field_path: string;
  value: string | null;
  field_version: number;
  updated_at: string;
  updated_by: string;
}

export interface Submission {
  id: string;
  revision: number;
  completion_summary: string;
  field_version: number;
  entity_version: number;
  template_version_id: string;
  due_at: string;
  submitted_at: string;
  submitted_by: string;
  submission_marker: 'ON_TIME' | 'LATE';
}

export interface WorkItem {
  daily_log?: import('./dailyLogs').DailyMeta|null;
  daily_links?: import('./dailyLogs').DailyLink[];
  current_business_date?:string;
  id: string;
  org_unit_id: string;
  template_code: string;
  template_display_name: string;
  field_schema: FieldDef[];
  field_ownership_rules: Record<string, string>;
  owner_role: string | null;
  template_version_id: string;
  requires_acceptance: boolean;
  title: string;
  due_at: string;
  status: WorkItemStatus;
  assignee_user_id: string | null;
  created_by: string;
  entity_version: number;
  is_blocked: boolean;
  blocked_reason: string | null;
  fields: SavedField[];
  submission_revision: number;
  current_submission: Submission | null;
  rework_count: number;
  created_at: string;
  updated_at: string;
}

export interface WorkItemPage {
  items: WorkItem[];
  next_cursor: string | null;
  current_business_date: string;
}

export interface FieldDef {
  field_path: string;
  label: string;
  type: 'text' | 'number' | 'url' | 'date' | 'select' | 'repeatable_group';
  required: boolean;
  section?: string;
  min_chars?: number;
  max_chars?: number;
  min_value?: number;
  max_value?: number;
  options?: string[];
  child_fields?: FieldDef[];
  min_items?: number;
  max_items?: number;
}

export interface TaskTemplate {
  code: string;
  display_name: string;
  version: number;
  owner_role: string;
  field_schema: FieldDef[];
  requires_acceptance: boolean;
}

export interface HistoryEntry {
  event_id: string;
  event_type: string;
  aggregate_version: number;
  occurred_at: string;
  actor_id: string;
  from_status: WorkItemStatus | null;
  to_status: WorkItemStatus;
  reason: string | null;
  field_change: { field_path: string; previous_value: string | null; new_value: string; field_version: number } | null;
  submission: Submission | null;
  reviewed_submission_id: string | null;
  reviewed_submission_revision: number | null;
}

export interface HistoryPage {
  items: HistoryEntry[];
  next_cursor: string | null;
}

export interface Notification {
  id: string;
  event_id: string;
  recipient_user_id: string;
  org_unit_id: string;
  work_item_id: string;
  channel: 'IN_APP';
  message: string;
  entity_version: number;
  created_at: string;
  read_at: string | null;
}

export interface NotificationPage {
  items: Notification[];
  next_cursor: string | null;
}
