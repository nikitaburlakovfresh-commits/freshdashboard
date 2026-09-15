import { apiFetch } from './client';

export interface DirectoryUnit {
  id: string;
  code: string;
  kind: 'NETWORK' | 'DIVISION' | 'CLUSTER' | 'ORG_UNIT';
  type_code: 'CITY_FLAG' | 'EXPRESS' | 'FULL_SERVICE' | 'PICKUP_POINT' | 'OUTLET' | null;
  lifecycle_state: 'PRE_LAUNCH' | 'ACTIVE' | 'PAUSED' | 'CLOSED';
  is_demo: boolean;
  demo_locked: boolean;
  display_name: string;
  parent_id: string | null;
  business_model: 'FRANCHISE' | 'OWN_OPERATION' | 'UC' | null;
  name_effective_from: string;
  name_effective_to: string | null;
  affiliation_effective_from: string;
  affiliation_effective_to: string | null;
}
export interface DirectoryTree {
  as_of: string;
  scope_mode: 'CURRENT_EXACT_PILOT_GRANTS' | 'SYNTHETIC_DEMO_ONLY' | 'CURRENT_NETWORK_DIRECTORY_REVIEW';
  items: DirectoryUnit[];
  admin_review: { authorized:false; reason:string } |
    { authorized:true; permission:'organization.directory.review'; writes_authorized:false };
}
export interface DirectoryHistory {
  id: string;
  names: { display_name: string; effective_from: string; effective_to: string | null }[];
  affiliations: { parent_id: string | null; business_model: DirectoryUnit['business_model']; effective_from: string; effective_to: string | null }[];
}

export const getOrganizationTree = (asOf: string) =>
  apiFetch<DirectoryTree>('/organization/tree', { query: { as_of: asOf } });
export const getOrganizationHistory = (id: string) =>
  apiFetch<DirectoryHistory>(`/organization/units/${encodeURIComponent(id)}/history`);
export const checkOrganizationAdministration = (asOf: string) =>
  apiFetch<DirectoryTree>('/organization/admin-review', { query:{ as_of:asOf } });
