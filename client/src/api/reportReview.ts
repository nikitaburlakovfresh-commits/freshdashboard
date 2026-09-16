import { apiFetch } from './client';
export type { DraftPeriod,ReviewView,ReviewCommand,SavedOverview,SavedBranch,ReviewRow } from '../../../server/src/reporting/shared/reviewModel';
import type { ReviewView,ReviewCommand,SavedOverview,SavedBranch } from '../../../server/src/reporting/shared/reviewModel';
const base=(id:string)=>`/report-batches/${encodeURIComponent(id)}`;
export const getReportReview=(id:string)=>apiFetch<ReviewView>(`${base(id)}/review`);
export const saveReportReview=(id:string,body:ReviewCommand)=>apiFetch<{version:number;revision_hash:string}>(`${base(id)}/review`,{method:'POST',body,idempotent:true});
export const getSavedOverview=(id:string)=>apiFetch<SavedOverview>(`${base(id)}/overview`);
export const getSavedBranch=(id:string,item:string)=>apiFetch<SavedBranch>(`${base(id)}/branches/${encodeURIComponent(item)}`);
