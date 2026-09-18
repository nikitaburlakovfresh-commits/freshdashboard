import { apiFetch } from './client';
export const moscowToday=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export interface DailyMeta {
  work_item_id:string;business_date:string;role_code:string;policy_id:string;
  base_open:string;base_close:string;window_open:string;window_close:string;can_fill:boolean;
}
export interface DailyLink {
  submission_id:string;work_item_id:string;title:string;completion_summary:string;revision:number;
  submitted_at:string;current_task_status:string;
}
export interface DailyPolicy {
  id:string;role_code:string;version:number;effective_from:string;base_open_time:string;base_close_time:string;
  early_open_hours:number;late_close_hours:number;reason:string;
}
export interface PersonalDay {
  business_date:string;current_business_date:string;record:(DailyMeta&{status:string;entity_version:number})|null;
  policy:DailyPolicy|null;links:DailyLink[];primary_storage:string;external_sync_status:string;
}
export interface BranchSummary {
  id:string;code:string;display_name:string;is_demo:boolean;type_code:string|null;lifecycle_state:string;
  business_model:string|null;can_manage:boolean;visibility:'BRANCH'|'PERSONAL';
  open_tasks:number;overdue_tasks:number;awaiting_review:number;completed_tasks:number;
  diary_drafts:number;diary_submitted:number;diary_accepted:number;
  diaries:{id:string;title:string;status:string;role:string}[];
}
export interface OperationalOverview {
  business_date:string;current_business_date:string;server_time:string;
  branches:BranchSummary[];policies:DailyPolicy[];
  attention:{id:string;org_unit_id:string;title:string;status:string;due_at:string}[];
  metric_state:'NOT_PUBLISHED';
}
export const getDay=(org:string,role:string,date:string)=>apiFetch<PersonalDay>('/daily-logs/day',{query:{org_unit_id:org,role,business_date:date}});
export const openDay=(org:string,role:string,date:string)=>apiFetch<{id:string}>('/daily-logs/open',{method:'POST',body:{org_unit_id:org,role,business_date:date}});
export const getOverview=(date:string,org?:string)=>apiFetch<OperationalOverview>('/daily-logs/overview',{query:{business_date:date,org_unit_id:org}});
export const savePolicy=(org:string,body:unknown)=>apiFetch<{id:string;version:number}>(`/daily-logs/policies/${org}`,{method:'POST',body});
