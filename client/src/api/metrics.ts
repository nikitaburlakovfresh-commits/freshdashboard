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
  /** Балл филиала: null, когда данных или модели нет. Это не ноль. */
  score:number|null; score_rag:Rag;
  score_components:ScoreComponent[]; score_reasons:string[];
}
export type RunRateCode='sales_runrate'|'stock_turnover'|'margin_runrate'|'supplies_runrate'|'avg_sale_price';
export interface RunRateTile {
  code:RunRateCode; label:string; hint:string; value:number|null;
  format:'PCT'|'COUNT'|'RUB'|'RATIO'; fact:number|null; plan:number|null; basis:string|null;
}
export interface Overview {
  mode:string; period_start:string; period_end:string;
  branches:BranchCard[]; thresholds_configured:boolean;
  metric_names:Record<string,string>;
  scoring:{configured:boolean;model_id:string|null;month_progress:number|null};
  run_rates:RunRateTile[];
  network:{branches_with_score:number;average_score:number|null;
    green:number;amber:number;red:number;without_score:number};
  focus:{month:string;configured:boolean;configuration_id?:string|null;
    slots:{slot:number;metric_code:string;label:string;
      direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER';format:'COUNT'|'PCT'|'RUB'|'RUB_MLN';
      plan:number|null;requires_vin_level:boolean;requires_daily_logs:boolean;
      fact:number|null;fact_basis:string}[]};
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

/** Основание отклонения из строки сводки: достаточно для постановки задачи. */
export interface OpenDeviation {
  metric:string; metric_name:string; rag:'RED'|'AMBER'; snapshot_id:string;
  value:number; unit:'COUNT'|'RUB'; revision:number;
  basis:'ABSOLUTE'|'PLAN_PERCENT'|null; basis_value:number|null; threshold_id:string|null;
  has_task:boolean; work_item_id:string|null; task_status:string|null;
}
export interface DivisionBranchRow {
  org_unit_id:string; display_name:string; division_id:string|null; division_name:string|null;
  regional_manager_user_id:string|null; regional_manager_name:string|null;
  metrics_accessible:number; metrics_published:string[]; metrics_missing:string[];
  metrics_without_threshold:string[]; red:string[]; amber:string[]; rag:'RED'|'AMBER'|'GREEN'|'NONE';
  deviations_with_task:number; deviations_without_task:number;
  tasks_open:number; tasks_overdue:number; tasks_due_soon:number;
  open_deviations:OpenDeviation[]; risk_score:number;
}
export interface DivisionManagerRow {
  user_id:string|null; full_name:string|null; is_vacant:boolean; branches_total:number;
  red:number; amber:number; deviations_without_task:number; tasks_open:number; tasks_overdue:number;
  branches_without_data:number; risk_score:number; branch_ids:string[];
}
export interface DivisionSummaryRow {
  division_id:string|null; division_name:string; branches_total:number;
  branches_with_data:number; branches_without_data:number;
  red:number; amber:number; green:number; unknown:number;
  deviations_total:number; deviations_without_task:number;
  tasks_open:number; tasks_overdue:number; tasks_due_soon:number;
  metrics_without_threshold:string[]; risk_score:number;
  by_metric:Record<string,{red:number;amber:number;without_task:number}>;
  managers:DivisionManagerRow[]; branches:DivisionBranchRow[];
}
export interface DivisionSummary {
  mode:string; period_start:string; period_end:string; metric_names:Record<string,string>;
  due_soon_hours:number; thresholds_configured:boolean;
  risk_weights:{risk_weight_red:number;risk_weight_amber:number;
    risk_weight_deviation_without_task:number;risk_weight_task_overdue:number;
    risk_weight_branch_without_data:number};
  totals:{divisions:number;branches:number;branches_without_data:number;red:number;amber:number;
    deviations_without_task:number;tasks_open:number;tasks_overdue:number;tasks_due_soon:number};
  divisions:DivisionSummaryRow[];
}
export const readDivisionSummary=(start:string,end:string,division?:string)=>
  apiFetch<DivisionSummary>('/metrics/divisions/deviations',{query:{start,end,division}});

export { focusOrder,managerLabel,missingLabel,riskScore,RISK_WEIGHT_LABELS } from '../components/divisionSummaryModel';
export { POLICY_LABELS,EVENT_LABELS,settingHint,settingValueValid,reasonValid } from '../components/portalSettingsModel';
export { DUE_LABELS,dueTone,basisLabel } from '../components/myDeviationTasksModel';
export { OUTCOME_LABELS,outcomeTone,deltaLabel } from '../components/deviationOutcomeModel';
export { RAG_LABELS,UNIT_LABELS,formatValue,ragReason,thresholdOrderValid } from '../components/metricThresholdModel';

/* ── Балл филиала, светофор и фокусы месяца (шаг C) ─────────────────────────
   Клиент ничего не досчитывает: балл, статус, основания и средний балл сети
   приходят с сервера по модели, настроенной внутри портала. */
export type Evaluation='RUN_RATE'|'RATIO_X100'|'CONVERSION_BANDS';
export type RuleRole='ORDINARY'|'REVENUE'|'TURNOVER_STOP';
export interface ScoreComponent {
  metric:string; metric_name:string; weight:number; evaluation:Evaluation; rule_role:RuleRole;
  fact:number|null; plan:number|null; score:number|null;
  missing:'FACT_NOT_PUBLISHED'|'PLAN_NOT_PUBLISHED'|'PLAN_NOT_POSITIVE'|null;
}
export interface ScoringWeight {
  metric:string; weight:number; evaluation:Evaluation; plan_metric:string|null; rule_role:RuleRole;
}
export const SCORING_MODEL_FIELDS=['score_cap','red_score_below','red_revenue_runrate_below',
  'red_weak_metric_below','red_weak_metric_count','stop_turnover_below','green_score_above',
  'green_revenue_above','green_turnover_above','green_no_metric_below','conversion_green_from',
  'conversion_green_score','conversion_amber_from','conversion_amber_score','conversion_red_score'] as const;
export type ScoringModelField=typeof SCORING_MODEL_FIELDS[number];
export const SCORING_FIELD_LABELS:Record<ScoringModelField,string>={
  score_cap:'Ограничение балла компонента',
  red_score_below:'Красный: балл ниже',
  red_revenue_runrate_below:'Красный: run-rate выручки ниже',
  red_weak_metric_below:'Красный: показатель слабее',
  red_weak_metric_count:'Красный: слабых показателей от',
  stop_turnover_below:'Стоп-фактор: оборачиваемость ниже',
  green_score_above:'Зелёный: балл выше',
  green_revenue_above:'Зелёный: выручка выше',
  green_turnover_above:'Зелёный: оборачиваемость выше',
  green_no_metric_below:'Зелёный: ни одного показателя ниже',
  conversion_green_from:'Конверсия: зелёная полоса от, %',
  conversion_green_score:'Конверсия: балл зелёной полосы',
  conversion_amber_from:'Конверсия: жёлтая полоса от, %',
  conversion_amber_score:'Конверсия: балл жёлтой полосы',
  conversion_red_score:'Конверсия: балл красной полосы',
};
export const EVALUATION_LABELS:Record<Evaluation,string>={
  RUN_RATE:'Run-rate к плану',RATIO_X100:'Коэффициент ×100',CONVERSION_BANDS:'Полосы конверсии'};
export const RULE_ROLE_LABELS:Record<RuleRole,string>={
  ORDINARY:'Обычный показатель',REVENUE:'Выручка (правила светофора)',TURNOVER_STOP:'Оборачиваемость (стоп-фактор)'};
export const COMPONENT_MISSING_LABELS:Record<string,string>={
  FACT_NOT_PUBLISHED:'Факт не опубликован',PLAN_NOT_PUBLISHED:'План не опубликован',
  PLAN_NOT_POSITIVE:'План не положителен'};
export interface ScoringModelRow extends Record<ScoringModelField,string> {
  id:string; effective_from:string; effective_to:string|null; reason:string; created_at:string;
  weights:(ScoringWeight&{model_id:string;weight:string})[];
}
export type ScoringModelCommand=Record<ScoringModelField,number>&{
  weights:ScoringWeight[]; effective_from:string; reason:string};
export const readScoringModels=(history=false)=>
  apiFetch<{items:ScoringModelRow[];metric_names:Record<string,string>;history:boolean}>('/metrics/scoring',
    {query:{history:history?'true':undefined}});
export const saveScoringModel=(body:ScoringModelCommand)=>
  apiFetch<{id:string;previous_id:string|null;audit_id:string;effective_from:string}>('/metrics/scoring',
    {method:'POST',body});

export interface FocusCatalogRow {
  code:string; label:string; direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER';
  format:'COUNT'|'PCT'|'RUB'|'RUB_MLN'; default_plan:string|null;
  requires_vin_level:boolean; requires_daily_logs:boolean;
}
export interface FocusConfigurationRow {
  id:string; month:string; effective_from:string; effective_to:string|null; reason:string; created_at:string;
  slots:{slot:number;metric_code:string;plan:string|number|null}[];
}
export interface FocusCommand {
  month:string; effective_from:string; reason:string;
  slots:{slot:number;metric_code:string;plan:number|null}[];
}
export const readFocusCatalog=(month?:string,history=false)=>
  apiFetch<{slot_count:number;catalog:FocusCatalogRow[];configurations:FocusConfigurationRow[];history:boolean}>(
    '/metrics/focus',{query:{month,history:history?'true':undefined}});
export const saveFocusConfiguration=(body:FocusCommand)=>
  apiFetch<{id:string;previous_id:string|null;audit_id:string;month:string;effective_from:string}>('/metrics/focus',
    {method:'POST',body});

export interface SourceAliasRow {
  id:string; org_unit_id:string; source_name:string; source_name_norm:string;
  effective_from:string; effective_to:string|null; reason:string; display_name:string|null; code:string;
}
export interface SourceExclusionRow {
  id:string; source_name:string; source_name_norm:string; effective_from:string;
  revoked_at:string|null; reason:string;
}
export const readSourceNaming=(history=false)=>
  apiFetch<{aliases:SourceAliasRow[];exclusions:SourceExclusionRow[];history:boolean}>('/metrics/source-naming',
    {query:{history:history?'true':undefined}});
export const saveSourceAlias=(body:{org_unit_id:string;source_name:string;effective_from:string;reason:string})=>
  apiFetch<{id:string;previous_id:string|null;effective_from:string}>('/metrics/source-naming/aliases',
    {method:'POST',body});
export const saveSourceExclusion=(body:{network_id:string;source_name:string;effective_from:string;reason:string})=>
  apiFetch<{id:string;source_name:string}>('/metrics/source-naming/exclusions',{method:'POST',body});
export const revokeSourceExclusion=(id:string,reason:string)=>
  apiFetch<{id:string;revoked:boolean}>(`/metrics/source-naming/exclusions/${id}/revoke`,
    {method:'POST',body:{reason}});
