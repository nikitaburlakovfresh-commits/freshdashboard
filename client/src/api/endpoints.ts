import { apiFetch } from './client';
import type {
  MeResponse,
  SessionResponse,
  WorkItem,
  WorkItemPage,
  HistoryPage,
  NotificationPage,
  Notification,
  WorkItemStatus,
  TaskTemplate,
} from './types';

export function login(login_: string, password: string) {
  return apiFetch<SessionResponse>('/auth/login', { method: 'POST', body: { login: login_, password } });
}

export function logout() {
  return apiFetch<{ revoked: true; revoked_at: string }>('/auth/logout', { method: 'POST', body: {} });
}

export function getMe() {
  return apiFetch<MeResponse>('/me');
}

export function listWorkItems(params: { org_unit_id?: string; status?: WorkItemStatus; limit?: number; cursor?: string; mine?: boolean; role?: string }) {
  return apiFetch<WorkItemPage>('/work-items', { query: params });
}

export function getWorkItem(id: string) {
  return apiFetch<WorkItem>(`/work-items/${id}`);
}

export function listTaskTemplates() {
  return apiFetch<{items: TaskTemplate[]}>('/work-items/templates');
}

export function createWorkItem(body: { org_unit_id: string; title: string; due_at: string; template_code?: string }) {
  return apiFetch<WorkItem>('/work-items', {
    method: 'POST',
    idempotent: true,
    body: { template_code: 'pilot_task_v1', ...body },
  });
}

export function assignWorkItem(id: string, body: { expected_entity_version: number; assignee_user_id: string }) {
  return apiFetch<WorkItem>(`/work-items/${id}/assign`, { method: 'POST', idempotent: true, body });
}

export function startWorkItem(id: string, body: { expected_entity_version: number }) {
  return apiFetch<WorkItem>(`/work-items/${id}/start`, { method: 'POST', idempotent: true, body });
}

export function patchWorkItemFields(id: string, body: { changes: [{ field_path: string; expected_version: number; new_value: string }] }) {
  return apiFetch<WorkItem>(`/work-items/${id}/fields`, { method: 'PATCH', idempotent: true, body });
}

export function submitWorkItem(id: string, body: { expected_entity_version: number; add_to_daily_log?:boolean;business_date?:string }) {
  return apiFetch<WorkItem>(`/work-items/${id}/submit`, { method: 'POST', idempotent: true, body });
}

export function acceptWorkItem(id: string, body: { expected_entity_version: number; submission_id: string; submission_revision: number }) {
  return apiFetch<WorkItem>(`/work-items/${id}/accept`, { method: 'POST', idempotent: true, body });
}

export function reworkWorkItem(id: string, body: { expected_entity_version: number; submission_id: string; submission_revision: number; reason: string }) {
  return apiFetch<WorkItem>(`/work-items/${id}/rework`, { method: 'POST', idempotent: true, body });
}

export function cancelWorkItem(id: string, body: { expected_entity_version: number; reason: string }) {
  return apiFetch<WorkItem>(`/work-items/${id}/cancel`, { method: 'POST', idempotent: true, body });
}

export function reopenWorkItem(id: string, body: { expected_entity_version: number; reason: string }) {
  return apiFetch<WorkItem>(`/work-items/${id}/reopen`, { method: 'POST', idempotent: true, body });
}

export function getWorkItemHistory(id: string, params: { limit?: number; cursor?: string }) {
  return apiFetch<HistoryPage>(`/work-items/${id}/history`, { query: params });
}

export function listNotifications(params: { unread_only?: boolean; limit?: number; cursor?: string }) {
  return apiFetch<NotificationPage>('/notifications', { query: params });
}

export function readNotification(id: string, body: { expected_entity_version: number }) {
  return apiFetch<Notification>(`/notifications/${id}/read`, { method: 'POST', idempotent: true, body });
}
