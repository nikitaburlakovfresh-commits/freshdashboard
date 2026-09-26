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
// Задачи, поставленные руководителем, — отдельный блок дня. Сервер отдаёт их
// вместе с ежедневником, включая просроченные.
export interface AssignedTask {
  id:string;title:string;status:string;entity_version:number;
  due_at_local:string|null;template_name:string;created_by:string|null;
  created_by_name:string|null;in_daily_log:boolean;
}
export interface PersonalDay {
  business_date:string;current_business_date:string;record:(DailyMeta&{status:string;entity_version:number})|null;
  policy:DailyPolicy|null;links:DailyLink[];assigned_tasks:AssignedTask[];
  primary_storage:string;external_sync_status:string;
}
export interface BranchSummary {
  id:string;code:string;display_name:string;is_demo:boolean;type_code:string|null;lifecycle_state:string;
  business_model:string|null;can_manage:boolean;visibility:'BRANCH'|'PERSONAL';
  open_tasks:number;overdue_tasks:number;awaiting_review:number;completed_tasks:number;
  diary_drafts:number;diary_submitted:number;diary_accepted:number;
  diaries:{id:string;title:string;status:string;role:string}[];
  diary_completion:DiaryCompletion;
}
/**
 * Прогресс заполнения ежедневников филиала за день. Проценты могут быть null:
 * не настроенные окна заполнения означают отсутствие обязанности, а не провал.
 */
export interface DiaryCompletion {
  expected_roles:number;created:number;submitted:number;
  submitted_pct:number|null;fill_pct:number|null;required_fill_pct:number|null;
  fields_filled:number;fields_total:number;
  by_role:{work_item_id:string;role:string|null;status:string;filled:number;total:number;fill_pct:number|null}[];
}
export interface OperationalOverview {
  business_date:string;current_business_date:string;server_time:string;
  branches:BranchSummary[];policies:DailyPolicy[];
  attention:{id:string;org_unit_id:string;title:string;status:string;due_at:string}[];
  metric_state:'SEPARATE_AUTHORIZED_QUERY';
}
export const getDay=(org:string,role:string,date:string)=>apiFetch<PersonalDay>('/daily-logs/day',{query:{org_unit_id:org,role,business_date:date}});
export const openDay=(org:string,role:string,date:string)=>apiFetch<{id:string}>('/daily-logs/open',{method:'POST',body:{org_unit_id:org,role,business_date:date}});
/**
 * Личная запись дня линейной должности — не ежедневник: окна заполнения нет,
 * опоздать нельзя, на балл филиала запись не влияет.
 */
export const LINE_ROLES=['MOP','EO','KSO_STAFF','SMOP','SMOO'] as const;
export const LINE_ROLE_NAMES:Record<string,string>={MOP:'Менеджер отдела продаж',EO:'Эксперт по оценке',
  KSO_STAFF:'Сотрудник КСО',SMOP:'Старший менеджер отдела продаж',SMOO:'Старший менеджер отдела оценки'};
export interface PersonalNoteDay {
  business_date:string;current_business_date:string;role:string;
  record:{work_item_id:string;status:string;entity_version:number;current_submission_id:string|null}|null;
  assigned_tasks:AssignedTask[];fill_window:null;affects_branch_score:boolean;
}
export const getNote=(org:string,role:string,date:string)=>
  apiFetch<PersonalNoteDay>('/daily-logs/note',{query:{org_unit_id:org,role,business_date:date}});
export const openNote=(org:string,role:string,date:string)=>
  apiFetch<{id:string}>('/daily-logs/note/open',{method:'POST',body:{org_unit_id:org,role,business_date:date}});

export const getOverview=(date:string,org?:string)=>apiFetch<OperationalOverview>('/daily-logs/overview',{query:{business_date:date,org_unit_id:org}});
/**
 * Одинаковое окно на все филиалы и роли сразу. Время пока московское: часовые
 * пояса филиалов не реализованы.
 */
export interface BulkPolicyResult {
  effective_from:string;roles:string[];base_open_time:string;base_close_time:string;branches:number;
  applied:{org_unit_id:string;display_name:string|null;role:string;version:number}[];
  unchanged:{org_unit_id:string;display_name:string|null;role:string}[];
  timezone:string;timezone_note:string;
}
export const savePolicyForAll=(body:{roles?:string[];effective_from:string;base_open_time:string;
  base_close_time:string;reason:string})=>
  apiFetch<BulkPolicyResult>('/daily-logs/policies-bulk',{method:'POST',body});

export const savePolicy=(org:string,body:unknown)=>apiFetch<{id:string;version:number}>(`/daily-logs/policies/${org}`,{method:'POST',body});

// Поручения из строки ежедневника (решение владельца 26.09.2026): машина,
// звонок, вывод по трафику — конкретному человеку на конкретный день.
export interface DelegationTarget { user_id:string;full_name:string;login:string;role_code:string;role_name:string }
export interface DiaryDelegation {
  id:string;title:string;status:string;brief:string|null;due_date:string;assignee_name:string|null;template_name:string;
  source_ref:{section_num:number|null;field_path:string|null;row_index:number|null;link:string|null}|null;
}
export interface DelegationDraft {
  assignee_user_id:string;role_code:string;due_date:string;title:string;brief?:string;
  section_num?:number|null;field_path?:string|null;row_index?:number|null;link?:string|null;
}
export const delegationTargets=(diary:string)=>apiFetch<{self_user_id:string;business_date:string;targets:DelegationTarget[]}>(`/daily-logs/${diary}/delegation-targets`);
export const diaryDelegations=(diary:string)=>apiFetch<DiaryDelegation[]>(`/daily-logs/${diary}/delegations`);
export const createDelegation=(diary:string,body:DelegationDraft)=>apiFetch<{id:string;due_date:string}>(`/daily-logs/${diary}/delegations`,{method:'POST',body});

// Подсказки из опубликованных данных портала: значение, источник, срез, формула.
export interface DiaryHint { field_path:string;value:number;unit:string;as_of:string;period:string;source:string;formula:string;note?:string;check?:'MIN'|'MATCH';min?:number;tolerance?:number }
export const diaryReference=(diary:string)=>apiFetch<{business_date:string;hints:DiaryHint[]}>(`/daily-logs/${diary}/reference`);
