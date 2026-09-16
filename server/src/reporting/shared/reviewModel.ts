import type { ImportPeriod, Report, ReportKind, ReportRow } from './reportModel';

/** Proposal only. Never a confirmation or canonical ingest envelope. */
export interface DraftPeriod extends ImportPeriod { basis:string }
export interface DraftMapping { item_id:string; org_unit_id:string }
export interface ReviewRevision {
  version:number; period:DraftPeriod|null; mappings:DraftMapping[];
  revision_hash:string|null; created_at:string|null; reason:string;
}
export interface ReviewRow {
  item_id:string; report_kind:ReportKind; source_name:string; source_row:number;
  org_unit_id:string|null; status:'UNRESOLVED'|'PROPOSED'|'STALE';
}
export interface ReviewView {
  batch_id:string; preview_hash:string; status:'DRAFT'; canonical_applied:false;
  current:ReviewRevision; rows:ReviewRow[];
  candidates:{id:string;code:string;display_name:string;lifecycle_state:string}[];
  history:{version:number;created_at:string;reason:string;revision_hash:string}[];
}
export interface ReviewCommand {
  expected_version:number;preview_hash:string;period:DraftPeriod|null;
  edits:{item_id:string;org_unit_id:string|null}[];reason:string;
}
export interface SavedOverview {
  batch_id:string;network_id:string;mode:'PREVIEW';canonical_applied:false;commit_available:false;
  malware_scan:'NOT_SCANNED';preview_hash:string;parser_version:string;created_at:string;
  original_period:unknown;review:ReviewView;
  reports:Report[];rows:ReviewRow[];
  files:{id:string;display_name:string;content_hash:string;byte_size:number}[];
  controls:{kind:ReportKind;items:{metric:string;official:number|null;sum:number|null;delta:number|null;matches:boolean}[]}[];
  comparison:string[];
}
export interface SavedBranch {
  batch_id:string;mode:'PREVIEW';canonical_applied:false;preview_hash:string;
  review_version:number;period:DraftPeriod|null;mapping:ReviewRow;
  report:Omit<Report,'branches'|'total'>;row:ReportRow;
  files:SavedOverview['files'];
}
