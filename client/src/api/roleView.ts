import { apiFetch } from './client';

// Просмотр «глазами роли». Серверный контракт — routes/roleView.ts.

export interface RoleViewStatus {
  viewing: boolean;
  as: { login: string; full_name: string } | null;
  admin: { login: string; full_name: string } | null;
  expires_at: string | null;
}

export interface RoleViewCandidate {
  user_id: string;
  login: string;
  full_name: string;
  role_code: string;
  role_name: string;
  scope_kind: string;
  org_unit_id: string | null;
  org_unit_name: string | null;
}

export interface RoleViewRole {
  role_code: string;
  role_name: string;
  scope_kind: string;
  candidates: RoleViewCandidate[];
}

export function getRoleViewStatus() {
  return apiFetch<RoleViewStatus>('/view-as/status');
}

export function getRoleViewCandidates() {
  return apiFetch<{ roles: RoleViewRole[] }>('/view-as/candidates');
}

export function enterRoleView(userId: string) {
  return apiFetch<{ ok: true; viewing: { login: string; full_name: string }; expires_at: string }>(
    '/view-as',
    { method: 'POST', body: { user_id: userId } },
  );
}

export function exitRoleView() {
  return apiFetch<{ ok: true; restored_as: { login: string; full_name: string } }>(
    '/view-as/exit',
    { method: 'POST' },
  );
}
