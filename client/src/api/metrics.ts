import { apiFetch } from './client';

import type { Rag } from '../components/metricThresholdModel';
export type { Rag };
export interface MetricCell {
  metric:string; metric_name:string; value:number; unit:'COUNT'|'RUB';
  rag:Rag; basis:'ABSOLUTE'|'PLAN_PERCENT'|null; basis_value:number|null;
  threshold_id:string|null; revision:number; published_at:string;
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

export { RAG_LABELS,UNIT_LABELS,formatValue,ragReason,thresholdOrderValid } from '../components/metricThresholdModel';
