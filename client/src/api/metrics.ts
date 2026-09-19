import { apiFetch } from './client';

import type { Rag } from '../components/metricThresholdModel';
export type { Rag };
export interface MetricCell {
  metric:string; metric_name:string; value:number; unit:'COUNT'|'RUB';
  rag:Rag; basis:'ABSOLUTE'|'PLAN_PERCENT'|null; basis_value:number|null;
  threshold_id:string|null; revision:number; published_at:string; snapshot_id:string;
  deviation_task:{id:string;work_item_id:string;status:string;title:string;assignee_user_id:string|null}|null;
}
export interface DeviationTaskCommand {
  org_unit_id:string; metric:string; period_start:string; period_end:string; snapshot_id:string;
  expected_rag:'RED'|'AMBER'; template_code:string; title:string; due_at:string; reason:string;
  assignee_user_id?:string|null;
}
export interface DeviationTaskRow {
  id:string; work_item_id:string; org_unit_id:string; metric:string; rag:'RED'|'AMBER';
  period_start:string; period_end:string; observed_value:string; basis:string; basis_value:string;
  reason:string; created_at:string; title:string; status:string; assignee_user_id:string|null; due_at:string;
}
export interface BranchCard {
  org_unit_id:string; display_name:string; rag:Rag;
  metrics:MetricCell[]; metrics_without_threshold:string[];
}
export interface Overview {
  mode:string; period_start:string; period_end:string;
  branches:BranchCard[]; thresholds_configured:boolean;
  metric_names:Record<string,string>;
}
export interface ThresholdRow {
  id:string; metric:string; scope_kind:'NETWORK'|'ORG_UNIT'; org_unit_id:string|null; display_name:string|null;
  direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER'; basis:'ABSOLUTE'|'PLAN_PERCENT'; unit:'COUNT'|'RUB'|'PCT';
  green_from:string; amber_from:string; effective_from:string; effective_to:string|null; reason:string;
}
export interface ThresholdCommand {
  metric:string; scope_kind:'NETWORK'|'ORG_UNIT'; org_unit_id:string|null;
  direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER'; basis:'ABSOLUTE'|'PLAN_PERCENT'; unit:'COUNT'|'RUB'|'PCT';
  green_from:number; amber_from:number; effective_from:string; reason:string;
}

export const readOverview=(start:string,end:string,org?:string)=>
  apiFetch<Overview>('/metrics/overview',{query:{start,end,org}});
export const readThresholds=(history=false)=>
  apiFetch<{items:ThresholdRow[];metric_names:Record<string,string>;history:boolean}>('/metrics/thresholds',
    {query:{history:history?'true':undefined}});
export const saveThreshold=(body:ThresholdCommand)=>
  apiFetch<{id:string;previous_id:string|null;audit_id:string;effective_from:string}>('/metrics/thresholds',
    {method:'POST',body});

export type Outcome='NO_PUBLISHED_VALUE'|'NOT_REPUBLISHED'|'STATUS_IMPROVED'|'STATUS_WORSENED'
  |'STATUS_UNKNOWN'|'UNCHANGED'|'VALUE_IMPROVED'|'VALUE_WORSENED';
export interface DeviationHistoryRow {
  id:string; work_item_id:string; metric:string; metric_name:string; period_start:string; period_end:string;
  rag_at_creation:'RED'|'AMBER'; observed_value:number; basis:string; basis_value:number; unit:'COUNT'|'RUB'|null;
  reason:string; created_at:string; task:{title:string;status:string;assignee_user_id:string|null;due_at:string};
  current_value:number|null; current_revision:number|null; outcome:Outcome; delta:number|null;
  rag_now:Rag|null; task_closed?:boolean;
}
export interface BranchCardData {
  mode:string; period_start:string; period_end:string;
  branch:{org_unit_id:string;code:string;display_name:string;lifecycle_state:string};
  metrics:(Omit<MetricCell,'deviation_task'>&{direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER'|null})[];
  metrics_without_threshold:string[]; deviations:DeviationHistoryRow[];
  metric_names:Record<string,string>; thresholds_configured:boolean;
}
export type DueState='OVERDUE'|'DUE_SOON'|'ON_TRACK'|'CLOSED';
export interface MyDeviationTask {
  id:string; work_item_id:string; org_unit_id:string; branch_name:string; metric:string; metric_name:string;
  period_start:string; period_end:string; rag:'RED'|'AMBER'; basis:string; reason:string; created_at:string;
  title:string; status:string; due_at:string; is_blocked:boolean; blocked_reason:string|null;
  entity_version:number; due_state:DueState; values_visible:boolean;
  observed_value:number|null; basis_value:number|null; unit:'COUNT'|'RUB'|null;
}
export interface MyDeviationTasks {
  items:MyDeviationTask[]; metric_names:Record<string,string>;
  counts:{total:number;overdue:number;due_soon:number;blocked:number}; due_soon_hours:number;
}
export const readMyDeviationTasks=(state:'OPEN'|'ALL') =>
  apiFetch<MyDeviationTasks>('/metrics/deviation-tasks/mine',{query:{state}});

export const readBranchCard=(org:string,start:string,end:string)=>
  apiFetch<BranchCardData>(`/metrics/branches/${org}`,{query:{start,end}});

export const createDeviationTask=(body:DeviationTaskCommand)=>
  apiFetch<{deviation_task_id:string;work_item_id:string;rag:string;assigned:boolean}>(
    '/metrics/deviation-tasks',{method:'POST',body,idempotent:true});
export const readDeviationTasks=(start:string,end:string,org?:string)=>
  apiFetch<{items:DeviationTaskRow[];metric_names:Record<string,string>}>('/metrics/deviation-tasks',
    {query:{start,end,org}});

export interface PortalSetting {
  key:string; value_number:number; updated_at:string; title:string; unit:string;
  min:number|null; max:number|null; integer:boolean;
}
export interface PortalSettingChange {
  key:string; value_before:number; value_after:number; reason:string; created_at:string; changed_by_login:string;
}
export const readPortalSettings=()=>apiFetch<{items:PortalSetting[];history:PortalSettingChange[]}>(
  '/metrics/portal-settings');
export const savePortalSetting=(key:string,value:number,reason:string)=>
  apiFetch<{key:string;value_number:number;changed:boolean;value_before?:number}>('/metrics/portal-settings',
    {method:'POST',body:{key,value,reason},idempotent:true});

export type NotificationPolicy='NONE'|'ASSIGNEE'|'REVIEWERS';
export interface NotificationPolicyRow {
  event_type:string; notification_policy:NotificationPolicy; consumer_name:string;
}
export interface NotificationPolicyChange {
  event_type:string; policy_before:NotificationPolicy; policy_after:NotificationPolicy;
  reason:string; created_at:string; changed_by_login:string;
}
export const readNotificationPolicies=()=>apiFetch<{items:NotificationPolicyRow[];
  history:NotificationPolicyChange[];policies:NotificationPolicy[]}>('/metrics/notification-policies');
export const saveNotificationPolicy=(event_type:string,policy:NotificationPolicy,reason:string)=>
  apiFetch<{event_type:string;notification_policy:NotificationPolicy;changed:boolean;
    policy_before?:NotificationPolicy}>('/metrics/notification-policies',
    {method:'POST',body:{event_type,policy,reason},idempotent:true});

export { POLICY_LABELS,EVENT_LABELS,settingHint,settingValueValid,reasonValid } from '../components/portalSettingsModel';
export { DUE_LABELS,dueTone,basisLabel } from '../components/myDeviationTasksModel';
export { OUTCOME_LABELS,outcomeTone,deltaLabel } from '../components/deviationOutcomeModel';
export { RAG_LABELS,UNIT_LABELS,formatValue,ragReason,thresholdOrderValid } from '../components/metricThresholdModel';
