import { apiFetch } from './client';

export interface PermissionInfo { code: string; description: string | null }
export interface RoleInfo {
  code: string; display_name: string; scope_kind: string; is_system: boolean;
  permissions: string[]; grants: number;
}
export interface RoleChange {
  role_code: string; permission_code: string; action: 'GRANTED' | 'REVOKED';
  actor_login: string; reason: string | null; created_at: string;
}
export interface RegistrationRequest {
  id: string; login: string; full_name: string; primary_email: string | null;
  phone: string | null; comment: string | null;
  requested_role_code: string; role_name: string;
  requested_org_unit_id: string | null; org_unit_name: string | null;
  status: string; decision_reason: string | null;
  created_at: string; decided_at: string | null; decided_by_login: string | null;
}

/** Зона РМ или дивизион с филиалами — для закрепления РМ/ДР целиком. */
export interface RegistrationZone {
  id: string; kind: 'CLUSTER' | 'DIVISION'; display_name: string;
  branches: { id: string; display_name: string }[];
}

export const getRoleMatrix = () =>
  apiFetch<{ permissions: PermissionInfo[]; roles: RoleInfo[]; history: RoleChange[] }>('/admin-settings/roles');

export const saveRolePermissions = (code: string, permissionCodes: string[], reason: string) =>
  apiFetch<{ role_code: string; granted: string[]; revoked: string[]; permissions: string[] }>(
    `/admin-settings/roles/${encodeURIComponent(code)}/permissions`,
    { method: 'POST', body: { permission_codes: permissionCodes, reason } });

export const getPendingRegistrations = () =>
  apiFetch<{ pending: number }>('/admin-settings/registrations/pending-count');

export const listRegistrations = (status: string) =>
  apiFetch<{ status: string; items: RegistrationRequest[]; zones?: RegistrationZone[] }>('/admin-settings/registrations', { query: { status } });

export const decideRegistration = (
  id: string, action: 'approve' | 'reject',
  body: { reason?: string; role_code?: string; org_unit_id?: string },
) => apiFetch<{ ok: true; status: string }>(
  `/admin-settings/registrations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });

// Открытый контур: вызывается со страницы регистрации до входа в портал.
export const getRegistrationDirectory = () =>
  apiFetch<{ roles: { code: string; display_name: string; scope_kind: string }[];
    branches: { id: string; display_name: string }[] }>('/registration/directory');

export const submitRegistration = (body: Record<string, string>) =>
  apiFetch<{ ok: true; message: string }>('/registration', { method: 'POST', body });

// Восстановление пароля: заявка открыта до входа, решение — владелец платформы.
export interface PasswordResetRequest {
  id: string; login: string; full_name: string; primary_email: string | null;
  comment: string | null; created_at: string;
}
export const submitPasswordReset = (body: { login: string; password: string; comment?: string }) =>
  apiFetch<{ ok: true; message: string }>('/registration/password-reset', { method: 'POST', body });
export const listPasswordResets = () =>
  apiFetch<{ items: PasswordResetRequest[] }>('/admin-settings/password-resets');
export const decidePasswordReset = (id: string, action: 'approve' | 'reject', body: { reason?: string }) =>
  apiFetch<{ ok: true; status: string }>(`/admin-settings/password-resets/${encodeURIComponent(id)}/${action}`, { method: 'POST', body });
