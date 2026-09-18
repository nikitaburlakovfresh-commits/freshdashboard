import { PoolClient } from 'pg';
import { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { beginIdempotent, completeIdempotent } from '../domain/idempotency';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { ApiError } from '../util/errors';
import { stagingAccess } from './access';
import { hash, uuid } from './storage';
import { validatePeriod, type Report } from './shared/reportModel';
import type { ReviewView, ReviewRevision, DraftMapping, DraftPeriod, SavedOverview, SavedBranch } from './shared/reviewModel';

const invalid=(message:string)=>new ApiError('VALIDATION_ERROR',message);
const missing=()=>new ApiError('NOT_FOUND','Пакет или строка не найдены.');
const conflict=()=>new ApiError('ENTITY_VERSION_CONFLICT','Черновик изменился. Откройте сохранённую версию; ваши изменения не применены.');
function object(value:any,keys:string[]) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)))
    throw invalid('Неизвестные поля или неверная форма команды.');
  return value;
}
// UUIDv8 derived from immutable source coordinates, never normalized branch names.
export function sourceItemId(batch:string,kind:string,row:number) {
  const h=hash(JSON.stringify(['report-row-v1',batch,kind,row]));
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;
}
function draftPeriod(raw:any):DraftPeriod|null {
  if(raw===null)return null;
  const p=object(raw,['start','end','planStart','planEnd','basis']);
  if(!['start','end','planStart','planEnd','basis'].every(k=>typeof p[k]==='string') ||
    p.basis.trim().length<10 || p.basis.length>500)throw invalid('Укажите даты и основание предложения периода (10–500 символов).');
  try{validatePeriod(p);}catch{throw invalid('Некорректные даты предложения периода.');}
  return {start:p.start,end:p.end,planStart:p.planStart,planEnd:p.planEnd,basis:p.basis.trim()};
}
async function context(c:PoolClient,auth:AuthedUser,id:string) {
  const grant=await stagingAccess(c,auth);
  // Same ordering as organization editor: access → directory → aggregate.
  await c.query('LOCK TABLE org_directory_units,org_directory_name_history,org_directory_affiliation_history IN SHARE MODE');
  if(!uuid.test(id))throw missing();
  const b=(await c.query('SELECT * FROM report_staging_batches WHERE id=$1 AND actor_user_id=$2 FOR UPDATE',[id,auth.userId])).rows[0];
  if(!b)throw missing();
  id=b.id; // PostgreSQL UUID spelling is canonical; path casing cannot change row identity.
  if(b.storage_state!=='READY' || !b.preview?.valid_structure || b.status!=='NEEDS_MAPPING')
    throw invalid('Сначала нужна успешная проверка сохранённых оригиналов.');
  const reports=b.preview.reports as Report[];
  const candidates=(await c.query(`WITH RECURSIVE tree AS (
    SELECT d.id FROM org_directory_units d JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id
    WHERE d.id=$1 AND d.kind='NETWORK' AND NOT d.is_demo AND NOT d.demo_locked AND d.effective_to IS NULL
      AND d.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
      AND a.parent_id IS NULL AND a.effective_to IS NULL AND a.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
    UNION ALL SELECT d.id FROM org_directory_units d
    JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id JOIN tree t ON t.id=a.parent_id
    WHERE NOT d.is_demo AND NOT d.demo_locked AND d.effective_to IS NULL
      AND d.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
      AND a.effective_to IS NULL AND a.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date)
    SELECT d.id,d.code,org_lifecycle_at(d.id,(now() AT TIME ZONE 'UTC')::date) lifecycle_state,n.display_name FROM tree t JOIN org_directory_units d ON d.id=t.id
    JOIN org_directory_name_history n ON n.org_unit_id=d.id AND n.effective_to IS NULL
      AND n.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
    WHERE d.kind='ORG_UNIT' AND org_lifecycle_at(d.id,(now() AT TIME ZONE 'UTC')::date)<>'CLOSED' ORDER BY d.code`,[b.network_id])).rows;
  const revisions=(await c.query(`SELECT version,period,mappings,revision_hash,created_at,reason
    FROM report_review_revisions WHERE batch_id=$1 ORDER BY version DESC LIMIT 20`,[id])).rows
    .map(r=>({...r,version:Number(r.version)})) as ReviewRevision[];
  const current:ReviewRevision=revisions[0] ?? {version:0,period:null,mappings:[],revision_hash:null,created_at:null,reason:''};
  const proposed=new Map(current.mappings.map(m=>[m.item_id,m.org_unit_id]));
  const eligible=new Set(candidates.map(r=>r.id));
  const rows=reports.flatMap(r=>r.branches.map(row=>{
    const item_id=sourceItemId(id,r.kind,row.row), org_unit_id=proposed.get(item_id) ?? null;
    return {item_id,report_kind:r.kind,source_name:row.name,source_row:row.row,org_unit_id,
      status:org_unit_id?(eligible.has(org_unit_id)?'PROPOSED' as const:'STALE' as const):'UNRESOLVED' as const};
  }));
  const view:ReviewView={batch_id:id,preview_hash:b.preview_hash,status:'DRAFT',canonical_applied:false,current,rows,candidates,
    history:revisions.map(({version,created_at,reason,revision_hash})=>({version,created_at:created_at!,reason,revision_hash:revision_hash!}))};
  return {grant,b,reports,view};
}
export async function getReview(auth:AuthedUser,id:string) {
  return withTransaction(async c=>(await context(c,auth,id)).view);
}
export async function saveReview(auth:AuthedUser,id:string,raw:unknown,key:string|undefined,requestId:string) {
  return withTransaction(async c=>{
    const {view,b,grant}=await context(c,auth,id);
    id=b.id;
    const body=object(raw,['expected_version','preview_hash','period','edits','reason']);
    if(!Number.isSafeInteger(body.expected_version) || body.expected_version<0 || typeof body.preview_hash!=='string' ||
      !Array.isArray(body.edits) || body.edits.length>100 || typeof body.reason!=='string' ||
      body.reason.trim().length<10 || body.reason.length>500)throw invalid('Нужны версия, hash проверки, основание и не более 100 изменений привязки.');
    const period=draftPeriod(body.period);
    if(!key || !/^[A-Za-z0-9._:-]{16,128}$/.test(key))throw invalid('Требуется Idempotency-Key.');
    const idem=await beginIdempotent(c,auth.userId,'reportReviewDraft',key,id,body);
    if('replay' in idem)return idem.replay.body;
    if(body.expected_version!==view.current.version || body.preview_hash!==view.preview_hash)throw conflict();
    if(view.current.version>=1000)throw invalid('Достигнут лимит версий черновика. Автоматического удаления нет.');
    const source=new Map(view.rows.map(row=>[row.item_id,row]));
    const eligible=new Set(view.candidates.map(row=>row.id));
    const proposals=new Map(view.current.mappings.map(m=>[m.item_id,m.org_unit_id]));
    const edited=new Set<string>();
    for(const rawEdit of body.edits) {
      const edit=object(rawEdit,['item_id','org_unit_id']);
      if(typeof edit.item_id!=='string' || !source.has(edit.item_id) || edited.has(edit.item_id) ||
        !(edit.org_unit_id===null || (typeof edit.org_unit_id==='string' && eligible.has(edit.org_unit_id))))
        throw invalid('Неизвестная/повторная строка или недоступный OrgUnit. Выберите существующий филиал этой сети.');
      edited.add(edit.item_id);
      if(edit.org_unit_id===null)proposals.delete(edit.item_id);else proposals.set(edit.item_id,edit.org_unit_id);
    }
    const targets=new Set<string>();
    for(const [item,target] of proposals) {
      if(!eligible.has(target))throw invalid('Ранее предложенная привязка устарела. Снимите или замените её.');
      const identity=`${source.get(item)!.report_kind}:${target}`;
      if(targets.has(identity))throw invalid('Две строки одного отчёта нельзя привязать к одному OrgUnit.');
      targets.add(identity);
    }
    const mappings:DraftMapping[]=[...proposals].sort(([a],[b])=>a.localeCompare(b)).map(([item_id,org_unit_id])=>({item_id,org_unit_id}));
    const version=view.current.version+1, streamId=sourceItemId(id,'review-stream',0);
    const reason=body.reason.trim();
    const revisionHash=hash(JSON.stringify({batch_id:id,version,preview_hash:view.preview_hash,period,mappings,reason}));
    await c.query(`INSERT INTO report_review_revisions(batch_id,version,stream_id,actor_user_id,grant_id,preview_hash,period,mappings,reason,revision_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[id,version,streamId,auth.userId,grant,view.preview_hash,
      period?JSON.stringify(period):null,JSON.stringify(mappings),reason,revisionHash]);
    await writeAuditAndOutbox(c,{actorUserId:auth.userId,actorRole:'SUPER_ADMIN',orgUnitId:null,workItemId:null,
      action:'REPORT_REVIEW_DRAFT_SAVED',aggregateType:'report_stage',aggregateId:streamId,aggregateVersion:version,requestId,
      beforeState:{revision_hash:view.current.revision_hash},afterState:{batch_id:id,revision_hash:revisionHash,canonical_applied:false},
      reason:'Private draft only; not business approval',resolution:'APPLIED',retentionClass:'SECURITY_5Y',
      eventType:'report.review.drafted',payload:{batch_id:id,revision:version,canonical_applied:false}});
    // Result receipt is small and contains no mutable directory labels on replay.
    const result={batch_id:b.id,version,revision_hash:revisionHash,status:'DRAFT',canonical_applied:false};
    await completeIdempotent(c,auth.userId,'reportReviewDraft',key,200,result);
    return result;
  });
}
export async function savedOverview(auth:AuthedUser,id:string):Promise<SavedOverview> {
  return withTransaction(async c=>{
    const {b,reports,view}=await context(c,auth,id);
    id=b.id;
    const files=(await c.query('SELECT id,display_name,content_hash,byte_size FROM report_staging_files WHERE batch_id=$1 ORDER BY id',[id])).rows;
    return {batch_id:id,network_id:b.network_id,mode:'PREVIEW',canonical_applied:false,commit_available:false,malware_scan:'NOT_SCANNED',
      preview_hash:b.preview_hash,parser_version:b.parser_version,created_at:b.created_at,original_period:b.period,review:view,reports,
      rows:view.rows,files,controls:b.preview.controls ?? [],comparison:b.preview.comparison ?? []};
  });
}
export async function savedBranch(auth:AuthedUser,id:string,itemId:string):Promise<SavedBranch> {
  // Do not trust name/path mapping from the browser. Resolve the stable source row.
  const overview=await savedOverview(auth,id);
  const mapping=overview.rows.find(row=>row.item_id===itemId);
  if(!mapping)throw missing();
  const report=overview.reports.find(r=>r.kind===mapping.report_kind)!;
  const row=report.branches.find(r=>r.row===mapping.source_row)!;
  const {branches,total,...source}=report;
  return {batch_id:overview.batch_id,mode:'PREVIEW',canonical_applied:false,preview_hash:overview.preview_hash,
    review_version:overview.review.current.version,period:overview.review.current.period,mapping,report:source,row,files:overview.files};
}
