import { apiFetch, ApiError, getCsrfToken } from './client';
import type { Report, MetricKey, ImportPeriod } from '../imports/reportModel';

export type StagingPeriod={state:'REQUIRES_CONFIRMATION'} | ({state:'CONFIRMED';confirmation:string}&ImportPeriod);
export interface StagingCapabilities {
  roots:{id:string;code:string;display_name:string}[];
  permission:string;max_files:number;max_file_bytes:number;commit_available:false;malware_scan:'NOT_SCANNED';
}
export interface StagingBatch {
  id:string;version:number;status:'QUARANTINE'|'NEEDS_MAPPING'|'REJECTED';storage_state:'WRITING'|'READY';
  network_id:string;period:StagingPeriod;created_at:string;source_code:string;parser_version:string;mapping_version:string;
  preview_hash:string|null;canonical_applied:false;malware_scan:'NOT_SCANNED';commit_available:false;
  files?:{id:string;display_name:string;content_hash:string;byte_size:number}[];
  preview?:null|{
    valid_structure:boolean;blockers:string[];error?:string;reports?:Report[];comparison?:string[];
    controls?:{kind:string;items:{metric:MetricKey;official:number|null;sum:number|null;delta:number|null;matches:boolean}[]}[];
    mappings?:{report_kind:string;source_key:string;source_name:string;source_row:number;org_unit_id:null;status:'NEEDS_MAPPING'}[];
  };
}
export const getStagingCapabilities=()=>apiFetch<StagingCapabilities>('/report-batches/capabilities');
export const listStagingBatches=()=>apiFetch<{items:StagingBatch[];limit:number}>('/report-batches');
export const getStagingBatch=(id:string)=>apiFetch<StagingBatch>(`/report-batches/${encodeURIComponent(id)}`);
export const probeStagingBatch=(batch:StagingBatch)=>apiFetch<StagingBatch>(`/report-batches/${batch.id}/probe`,{
  method:'POST',body:{expected_version:batch.version},
});
export async function uploadStagingBatch(network_id:string,period:StagingPeriod,files:File[]) {
  const form=new FormData();
  form.append('metadata',JSON.stringify({network_id,period}));
  for(const file of files) form.append('files',file);
  const csrf=getCsrfToken();
  const response=await fetch('/api/v1/report-batches',{method:'POST',credentials:'same-origin',
    headers:csrf?{'X-CSRF-Token':csrf}:{},body:form});
  const body=await response.json().catch(()=>null);
  if(!response.ok) throw new ApiError(body ?? {code:'UNKNOWN',message:'Не удалось сохранить пакет. Обновите список перед повтором.',details:{},request_id:''},response.status);
  return body as StagingBatch & {reused?:boolean};
}

export interface AutoPublishResult {
  batch_id:string|null;stage:'UPLOAD'|'PROBE'|'REVIEW'|'PUBLISH'|'DONE';published:number;
  publication_id:string|null;period:{start:string;end:string};mapped_rows:number;
  recognized:{kind:string;rows:number}[];skipped_files:{name:string;reason:string}[];
  excluded_rows:{row:number;kind:string;name:string;reason:string}[];
  unresolved_rows:{row:number;kind:string;name:string;why:string}[];
  published_metrics:string[];withheld_metrics:string[];message:string;
  vin_registry?:{observed_on:string;published:number;message:string}|null;
}
/** Приём пакета одной операцией: загрузка, привязка филиалов и публикация. */
export async function autoPublishStagingBatch(network_id:string,period:StagingPeriod,files:File[]) {
  const form=new FormData();
  form.append('metadata',JSON.stringify({network_id,period}));
  for(const file of files) form.append('files',file);
  const csrf=getCsrfToken();
  const response=await fetch('/api/v1/report-batches/auto-publish',{method:'POST',credentials:'same-origin',
    headers:csrf?{'X-CSRF-Token':csrf}:{},body:form});
  const body=await response.json().catch(()=>null);
  if(!response.ok) throw new ApiError(body ?? {code:'UNKNOWN',message:'Не удалось принять пакет. Обновите список перед повтором.',details:{},request_id:''},response.status);
  return body as AutoPublishResult;
}
