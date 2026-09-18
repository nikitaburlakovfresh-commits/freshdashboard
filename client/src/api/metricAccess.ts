import { apiFetch } from './client';
export interface MetricGrant {
 id:string;user_id:string;role_code:string;scope_kind:string;org_unit_id:string|null;
 valid_from:string;valid_until:string|null;revoked_at:string|null;login:string;full_name:string;is_active:boolean;branch_code:string|null;readable_branch:boolean;
}
export interface MetricAccess {
 grant_id:string;capability:'READ'|'PUBLISH';metrics:string[];valid_from:string;valid_until:string|null;revoked_at:string|null;
 approval_reference:string;audit_id:string;
}
export interface MetricPreview {
 id:string|null;valid:boolean;issues:string[];operation:'GRANT'|'REVOKE';capability:'READ'|'PUBLISH';metrics:string[];
 user:{id:string;login:string;full_name:string}|null;branch:{id:string;code:string}|null;role:string|null;
 valid_from:string|null;valid_until:string|null;previous:MetricAccess|null;reason:string;warning:string;expires_at:string|null;
}
export interface MetricDirectory {
 grants:MetricGrant[];access:MetricAccess[];metrics:Record<string,string>;history_limit:number;
 history:{id:string;actor_name:string|null;action:string;occurred_at:string;reason:string;
   before_state:MetricAccess|null;after_state:Partial<MetricPreview>&{grant_id?:string}}[];
}
export type MetricCommand={operation:'GRANT';grant_id:string;capability:'READ'|'PUBLISH';metrics:string[];
 valid_from:string;valid_until:string|null;reason:string}|{operation:'REVOKE';grant_id:string;capability:'READ'|'PUBLISH';reason:string};
export const metricDirectory=()=>apiFetch<MetricDirectory>('/access/metrics');
export const metricPreview=(body:MetricCommand)=>apiFetch<MetricPreview>('/access/metrics/preview',{method:'POST',body});
export const metricApply=(id:string)=>apiFetch<{status:string;preview_id:string}>('/access/metrics/apply',
 {method:'POST',body:{preview_id:id,confirmed:true}});
