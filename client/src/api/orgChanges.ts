import { apiFetch } from './client';
export interface OrgChange {
  operation:'ORG_UNIT_CREATE'|'ORG_UNIT_RENAME'|'ORG_UNIT_MOVE_TO_CLUSTER'|'ORG_UNIT_ACTIVATE';
  target_id?:string;
  code?:string;
  kind?:string;
  display_name?:string;
  parent_id?:string|null;
  type_code?:string|null;
  business_model?:string|null;
  effective_from:string;
  reason:string;
}
export interface OrgProposal {
  id:string;target_id:string;version:number;status:'DRAFT'|'PREVIEW'|'APPLIED';
  change:OrgChange;created_by:string;updated_by:string;updated_at:string;
  preview_token:string|null;preview_actor:string|null;preview_expires_at:string|null;
  applied_by:string|null;applied_at:string|null;
  preview_summary:null|{
    valid:boolean;issues:{path:string;issue:string}[];
    affected:Record<string,number>;warning:string;
    before:null|{names:{display_name:string}[];affiliations:{parent_id:string|null}[]};
  };
  history?:{actor_user_id:string;action:string;aggregate_version:number;occurred_at:string}[];
}
export const listOrgProposals=()=>apiFetch<{items:OrgProposal[];limit:number}>('/organization/proposals');
export const getOrgProposal=(id:string)=>apiFetch<OrgProposal>(`/organization/proposals/${encodeURIComponent(id)}`);
export const createOrgProposal=(change:OrgChange)=>apiFetch<OrgProposal>('/organization/proposals',{method:'POST',idempotent:true,body:{change}});
export const editOrgProposal=(p:OrgProposal,change:OrgChange)=>apiFetch<OrgProposal>(`/organization/proposals/${p.id}`,{method:'PATCH',idempotent:true,body:{expected_version:p.version,change}});
export const previewOrgProposal=(p:OrgProposal)=>apiFetch<OrgProposal>(`/organization/proposals/${p.id}/preview`,{method:'POST',idempotent:true,body:{expected_version:p.version}});
export const applyOrgProposal=(p:OrgProposal)=>apiFetch<OrgProposal>(`/organization/proposals/${p.id}/apply`,{method:'POST',idempotent:true,body:{expected_version:p.version,preview_token:p.preview_token}});
