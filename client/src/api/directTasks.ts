import { apiFetch } from './client';

export interface AssignPerson { user_id: string; full_name: string; role_code: string; role_name: string }
export interface AssignScope {
  org_unit_id: string; org_name: string; setter_role: string;
  people: AssignPerson[]; uk_request: boolean; uk_managers: { user_id: string; full_name: string }[];
}
export interface UkOptions {
  people: AssignPerson[]; network_id: string | null; branches: { org_unit_id: string; org_name: string }[];
}
export const getAssignOptions = () => apiFetch<{ scopes: AssignScope[]; uk: UkOptions | null }>('/work-items/assign-options');
export const createDirectTask = (body: {
  kind: 'TASK' | 'UK_REQUEST' | 'UK_TASK'; org_unit_id: string; assignee_user_id: string; role_code?: string;
  due_date: string; title: string; brief?: string;
}) => apiFetch<{ id: string; due_date: string }>('/work-items/direct', { method: 'POST', body });
