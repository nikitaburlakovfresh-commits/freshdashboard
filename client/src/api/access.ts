import { apiFetch } from './client';
export type AccessChange={operation:'GRANT_ROLE';user_id:string;role_code:string;org_unit_id:string;valid_from:string;valid_until:string|null;reason:string}
 |{operation:'REVOKE_ROLE';grant_id:string;reason:string};
export interface AccessGrant {
  id:string;user_id:string;role_code:string;org_unit_id:string|null;scope_kind:string;
  valid_from:string;valid_until:string|null;revoked_at:string|null;grant_version:number;
}
export interface AccessDirectory {
  users:{id:string;login:string;full_name:string;is_active:boolean;personal:boolean}[];
  grants:AccessGrant[];
  roles:{code:string;display_name:string;permissions:string[]}[];
  branches:{id:string;code:string;lifecycle_state:string}[];
}
export interface AccessProposal {
  id:string;target_id:string;version:number;status:'DRAFT'|'PREVIEW'|'APPLIED';change:AccessChange;
  preview_token:string|null;preview_actor:string|null;preview_expires_at:string|null;updated_at:string;
  preview_summary:null|{
    valid:boolean;issues:string[];warning:string;
    user:{id:string;login:string;full_name:string}|null;
    branch:{id:string;code:string;lifecycle_state:string}|null;
    role:{code:string;display_name:string;permissions:string[]}|null;
    affected:{role_grants:number;active_tasks:number;changed_tasks:number;financial_records:number};
    after_grant?:AccessGrant;
  };
  history?:{actor_user_id:string;action:string;aggregate_version:number;occurred_at:string}[];
}
export const getAccessDirectory=()=>apiFetch<AccessDirectory>('/access/directory');
export const listAccessChanges=()=>apiFetch<{items:AccessProposal[];limit:number}>('/access/proposals');
export const getAccessChange=(id:string)=>apiFetch<AccessProposal>(`/access/proposals/${encodeURIComponent(id)}`);
export const createAccessChange=(change:AccessChange)=>apiFetch<AccessProposal>('/access/proposals',{method:'POST',idempotent:true,body:{change}});
export const previewAccessChange=(p:AccessProposal)=>apiFetch<AccessProposal>(`/access/proposals/${p.id}/preview`,{method:'POST',idempotent:true,body:{expected_version:p.version}});
export const applyAccessChange=(p:AccessProposal)=>apiFetch<AccessProposal>(`/access/proposals/${p.id}/apply`,{method:'POST',idempotent:true,body:{expected_version:p.version,preview_token:p.preview_token}});
