import { apiFetch } from './client';
import type { MetricKey,Report,ReportKind } from '../imports/reportModel';
import type { ReviewView } from './reportReview';
export type FactChoice={metric:MetricKey;source:ReportKind;methodology:string};
export type FactCommand={review_version:number;choices:FactChoice[];reason:string;confirm_source_aggregates:true};
export interface FactRow {
  id?:string;org_unit_id:string;branch?:string;display_name?:string;metric:MetricKey;period_start:string;period_end:string;
  value:number|string;unit:'COUNT'|'RUB';revision:number;previous_id?:string|null;previous_value?:string|null;is_current?:boolean;
  provenance:{report_kind:ReportKind;sheet:string;address:string;extraction:string;file_hash:string;
    methodology:string;source_selection_reason:string;period_basis:string;batch_id:string;[key:string]:unknown};
}
export interface PublicationState {
  review:ReviewView;reports:Report[];allowed_metrics:MetricKey[];can_publish:boolean;
  files:{id:string;name:string;result:string;current:boolean}[];
  publications:{id:string;created_at:string;review_version:number}[];
}
export interface FactPreview {rows:FactRow[];blockers:string[];preview_id:string|null;proposal_hash:string|null;can_commit:boolean;expires_at?:string}
export const getPublication=(id:string)=>apiFetch<PublicationState>(`/report-facts/${encodeURIComponent(id)}/publication`);
export const scanPublication=(id:string)=>apiFetch(`/report-facts/${id}/scan`,{method:'POST',body:{}});
export const previewFacts=(id:string,body:FactCommand)=>apiFetch<FactPreview>(`/report-facts/${id}/preview`,{method:'POST',body});
export const publishFacts=(id:string,p:FactPreview)=>apiFetch<{publication_id:string;count:number}>(`/report-facts/${id}/publish`,
  {method:'POST',idempotent:true,body:{preview_id:p.preview_id,proposal_hash:p.proposal_hash,confirm:true}});
export const readFacts=(start:string,end:string,org?:string,history=false)=>apiFetch<{items:FactRow[]}>('/report-facts',
  {query:{start,end,org,history:history?'true':undefined}});
