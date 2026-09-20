import { randomUUID } from 'crypto';
import { PoolClient } from 'pg';
import { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { ApiError } from '../util/errors';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { stagingAccess } from './access';
import { hash, uuid, safeName, persistSources, readSource, UploadFile, SourceFile, MAX_FILE_BYTES, MAX_BATCH_FILES } from './storage';
import { probeFiles, PARSER_VERSION } from './probe';
import { validatePeriod } from './shared/reportModel';

const invalid=(message:string)=>new ApiError('VALIDATION_ERROR',message);
const notFound=()=>new ApiError('NOT_FOUND','Пакет не найден.');
const SOURCE='QLIK_AGGREGATE_MANUAL';
export function parseMetadata(raw:any) {
  if(!raw || typeof raw!=='object' || Array.isArray(raw) ||
    Object.keys(raw).some(k=>!['network_id','period'].includes(k)) || typeof raw.network_id!=='string' || !uuid.test(raw.network_id))
    throw invalid('Выберите подтверждённую корневую сеть.');
  const period=raw.period;
  if(!period || typeof period!=='object' || Array.isArray(period)) throw invalid('Укажите состояние периода.');
  if(period.state==='REQUIRES_CONFIRMATION' && Object.keys(period).length===1)
    return {network_id:raw.network_id,period:{state:'REQUIRES_CONFIRMATION'}};
  if(period.state!=='CONFIRMED' || Object.keys(period).some(k=>!['state','start','end','planStart','planEnd','confirmation'].includes(k)) ||
    !['start','end','planStart','planEnd','confirmation'].every(k=>typeof period[k]==='string') ||
    period.confirmation.trim().length<10 || period.confirmation.length>500) throw invalid('Подтвердите даты и основание периода; дата файла не подтверждает период продаж.');
  try {validatePeriod(period);} catch {throw invalid('Некорректный подтверждённый период.');}
  return {network_id:raw.network_id,period:{state:'CONFIRMED',start:period.start,end:period.end,
    planStart:period.planStart,planEnd:period.planEnd,confirmation:period.confirmation.trim()}};
}
async function network(client:PoolClient,id:string) {
  const r=await client.query(`SELECT d.id FROM org_directory_units d
    JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id
    WHERE d.id=$1 AND d.kind='NETWORK' AND NOT d.is_demo AND NOT d.demo_locked
      AND d.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date AND d.effective_to IS NULL
      AND a.parent_id IS NULL AND a.effective_to IS NULL
      AND a.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date`,[id]);
  if(r.rowCount!==1) throw invalid('Нужна существующая реальная корневая сеть. Загрузка не создаёт оргструктуру.');
}
async function audit(client:PoolClient,auth:AuthedUser,id:string,version:number,action:string,state:unknown,requestId:string) {
  await writeAuditAndOutbox(client,{actorUserId:auth.userId,actorRole:'SUPER_ADMIN',orgUnitId:null,workItemId:null,
    action,aggregateType:'report_stage',aggregateId:id,aggregateVersion:version,requestId,
    beforeState:null,afterState:state,resolution:'APPLIED',retentionClass:'SECURITY_5Y',
    reason:'Private staging only; no canonical snapshot or organization mapping applied',
    eventType:'report.staging.recorded',payload:{batch_id:id,stage:action}});
}
async function load(client:PoolClient,auth:AuthedUser,id:string) {
  if(!uuid.test(id)) throw notFound();
  const r=await client.query('SELECT * FROM report_staging_batches WHERE id=$1 AND actor_user_id=$2 FOR UPDATE',[id,auth.userId]);
  if(!r.rowCount) throw notFound();
  const files=(await client.query('SELECT id,display_name,content_hash,byte_size FROM report_staging_files WHERE batch_id=$1 ORDER BY id',[id])).rows as SourceFile[];
  return {...r.rows[0],files};
}
function publicBatch(row:any) {
  const {grant_id,fingerprint,...visible}=row;
  return {...visible,canonical_applied:false,malware_scan:'NOT_SCANNED',quarantine_retained:true,
    period_state:row.period.state,scope_mode:'CURRENT_ADMIN_OWN_STAGING',commit_available:false};
}
export async function capabilities(auth:AuthedUser) {
  return withTransaction(async c=>{
    await stagingAccess(c,auth);
    const roots=(await c.query(`SELECT d.id,d.code,n.display_name FROM org_directory_units d
      JOIN org_directory_name_history n ON n.org_unit_id=d.id AND n.effective_to IS NULL
      JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id AND a.effective_to IS NULL AND a.parent_id IS NULL
      WHERE d.kind='NETWORK' AND NOT d.is_demo AND NOT d.demo_locked AND d.effective_to IS NULL
        AND d.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
        AND n.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date
        AND a.effective_from<=(clock_timestamp() AT TIME ZONE 'Europe/Moscow')::date ORDER BY d.code`)).rows;
    return {permission:'data_source.probe',max_files:2,max_file_bytes:MAX_FILE_BYTES,roots,commit_available:false,malware_scan:'NOT_SCANNED'};
  });
}
export async function listBatches(auth:AuthedUser) {
  return withTransaction(async c=>{
    await stagingAccess(c,auth);
    const r=await c.query(`SELECT id,source_code,network_id,period,status,storage_state,version,created_at,updated_at,
      parser_version,mapping_version,preview_hash FROM report_staging_batches
      WHERE actor_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100`,[auth.userId]);
    return {items:r.rows.map(publicBatch),limit:100};
  });
}
export async function detail(auth:AuthedUser,id:string) {
  return withTransaction(async c=>{await stagingAccess(c,auth);return publicBatch(await load(c,auth,id));});
}
export async function uploadBatch(auth:AuthedUser,raw:unknown,uploads:UploadFile[],requestId:string) {
  const meta=parseMetadata(raw);
  if(!uploads.length || uploads.length>MAX_BATCH_FILES || uploads.some(f=>!f.bytes.length || f.bytes.length>MAX_FILE_BYTES ||
    !/\.xlsx$/i.test(f.name) || f.bytes.length<4 || f.bytes.readUInt32LE(0)!==0x04034b50)) throw invalid(`Допустимы 1–${MAX_BATCH_FILES} XLSX до 8 МиБ каждый.`);
  const files=uploads.map(f=>({meta:{id:randomUUID(),display_name:safeName(f.name),byte_size:f.bytes.length,content_hash:hash(f.bytes)},bytes:f.bytes}));
  if(new Set(files.map(f=>f.meta.content_hash)).size!==files.length) throw invalid('Одинаковый файл дважды в пакете.');
  // Confirmation prose is provenance, not business identity: rewording the
  // same confirmed period must not duplicate the same source contents.
  const identityPeriod=meta.period.state==='CONFIRMED'
    ? {state:meta.period.state,start:meta.period.start,end:meta.period.end,planStart:meta.period.planStart,planEnd:meta.period.planEnd}
    : {state:meta.period.state};
  const fingerprint=hash(JSON.stringify({period:identityPeriod,hashes:files.map(f=>f.meta.content_hash).sort(),parser:PARSER_VERSION,mapping:'UNRESOLVED_V1'}));
  const batchId=randomUUID();
  const intent=await withTransaction(async c=>{
    const grant=await stagingAccess(c,auth);
    // Protect actor quota/dedup even across multiple app processes.
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['report-upload:'+auth.userId]);
    await network(c,meta.network_id);
    const existing=await c.query(`SELECT id FROM report_staging_batches
      WHERE actor_user_id=$1 AND source_code=$2 AND network_id=$3 AND fingerprint=$4`,[auth.userId,SOURCE,meta.network_id,fingerprint]);
    if(existing.rowCount) return {id:existing.rows[0].id as string,reused:true};
    const quota=(await c.query(`SELECT count(DISTINCT b.id)::int count,coalesce(sum(f.byte_size),0)::bigint bytes
      FROM report_staging_batches b LEFT JOIN report_staging_files f ON f.batch_id=b.id WHERE b.actor_user_id=$1`,[auth.userId])).rows[0];
    if(Number(quota.bytes)+files.reduce((n,f)=>n+f.meta.byte_size,0)>256*1024*1024 || quota.count>=100)
      throw invalid('Лимит закрытого этапа: 100 пакетов / 256 МиБ. Требуется операторская политика хранения, автоматического удаления нет.');
    await c.query(`INSERT INTO report_staging_batches(id,actor_user_id,grant_id,network_id,source_code,period,fingerprint,
      status,storage_state,parser_version,mapping_version) VALUES($1,$2,$3,$4,$5,$6,$7,'QUARANTINE','WRITING',$8,'UNRESOLVED_V1')`,
      [batchId,auth.userId,grant,meta.network_id,SOURCE,meta.period,fingerprint,PARSER_VERSION]);
    for(const f of files) await c.query(`INSERT INTO report_staging_files(id,batch_id,display_name,content_hash,byte_size)
      VALUES($1,$2,$3,$4,$5)`,[f.meta.id,batchId,f.meta.display_name,f.meta.content_hash,f.meta.byte_size]);
    await audit(c,auth,batchId,1,'REPORT_UPLOAD_RESERVED',{network_id:meta.network_id,file_hashes:files.map(f=>f.meta.content_hash),period_state:meta.period.state},requestId);
    return {id:batchId,reused:false};
  });
  if(intent.reused) return {...await detail(auth,intent.id),reused:true};
  // Intent survives crash/disk-full/auth-revocation. Partial bytes cannot be
  // previewed/downloaded. Probe can recover complete hash-verified WRITING intent.
  await persistSources(batchId,files);
  return withTransaction(async c=>{
    await stagingAccess(c,auth);const batch=await load(c,auth,batchId);
    if(batch.storage_state==='READY' || batch.status!=='QUARANTINE') return publicBatch(batch);
    await c.query(`UPDATE report_staging_batches SET storage_state='READY',version=version+1,updated_at=now() WHERE id=$1`,[batchId]);
    await audit(c,auth,batchId,batch.version+1,'REPORT_QUARANTINED',{file_count:files.length},requestId);
    return publicBatch({...batch,storage_state:'READY',version:batch.version+1});
  });
}
export async function probeBatch(auth:AuthedUser,id:string,raw:any,requestId:string) {
  if(!raw || Object.keys(raw).length!==1 || !Number.isSafeInteger(raw.expected_version)) throw invalid('Требуется expected_version.');
  const snapshot=await withTransaction(async c=>{
    await stagingAccess(c,auth);const batch=await load(c,auth,id);
    if(batch.status!=='QUARANTINE') return {batch,files:null};
    if(batch.version!==raw.expected_version) throw new ApiError('ENTITY_VERSION_CONFLICT','Откройте актуальную версию пакета.');
    // Bounded source integrity read happens before leaving authorization locks.
    const files:UploadFile[]=[];
    try {for(const file of batch.files) files.push({name:file.display_name,bytes:await readSource(id,file)});}
    catch {throw invalid('Исходники не завершены или нарушена целостность. Пакет сохранён в карантине; автоматического удаления и перезаписи нет.');}
    return {batch,files};
  });
  if(!snapshot.files) return detail(auth,id);
  const result=await probeFiles(snapshot.files);
  return withTransaction(async c=>{
    await stagingAccess(c,auth);const batch=await load(c,auth,id);
    if(batch.status!=='QUARANTINE') return publicBatch(batch);
    if(batch.version!==snapshot.batch.version) throw new ApiError('ENTITY_VERSION_CONFLICT','Пакет изменился; откройте заново.');
    // Публикация в канонический контур реализована (report_fact_publications),
    // поэтому исторический блокер CANONICAL_COMMIT_NOT_IMPLEMENTED снят.
    // Антивирусная проверка выполняется отдельным этапом scanBatch и не
    // объявляется блокером структурной проверки.
    const blockers=['NEEDS_MAPPING'];
    if(batch.period.state!=='CONFIRMED') blockers.push('PERIOD_REQUIRES_CONFIRMATION');
    if(batch.period.state==='CONFIRMED' && !batch.period.planStart) blockers.push('PLAN_PERIOD_UNCONFIRMED');
    const preview=result.ok ? {...result.preview,valid_structure:true,blockers,network_id:batch.network_id,
      mappings:result.preview.reports.flatMap((r:any)=>r.branches.map((branch:any)=>({
        report_kind:r.kind,source_key:branch.key,source_name:branch.name,source_row:branch.row,
        org_unit_id:null,status:'NEEDS_MAPPING'})))} : {valid_structure:false,error:result.error,blockers:['INVALID_SOURCE',...blockers]};
    const previewHash=hash(JSON.stringify({preview,file_hashes:batch.files.map((f:SourceFile)=>f.content_hash),
      period:batch.period,network_id:batch.network_id,parser_version:batch.parser_version,mapping_version:batch.mapping_version}));
    const status=result.ok?'NEEDS_MAPPING':'REJECTED';
    await c.query(`UPDATE report_staging_batches SET status=$2,storage_state='READY',preview=$3,preview_hash=$4,
      version=version+1,updated_at=now() WHERE id=$1`,[id,status,preview,previewHash]);
    await audit(c,auth,id,batch.version+1,'REPORT_PROBED',{status,preview_hash:previewHash,canonical_applied:false},requestId);
    return publicBatch({...batch,status,storage_state:'READY',preview,preview_hash:previewHash,version:batch.version+1});
  });
}
export async function downloadSource(auth:AuthedUser,id:string,fileId:string,requestId:string) {
  return withTransaction(async c=>{
    await stagingAccess(c,auth);const batch=await load(c,auth,id);
    const file=batch.files.find((f:SourceFile)=>f.id===fileId);
    // Fail closed: unscanned quarantine is NOT downloadable, even by admin.
    // Endpoint deliberately exists to enforce and test the gateway boundary.
    if(!file) throw notFound();
    await writeAuditAndOutbox(c,{actorUserId:auth.userId,actorRole:'SUPER_ADMIN',orgUnitId:null,workItemId:null,
      action:'REPORT_DOWNLOAD_BLOCKED',aggregateType:'report_stage',aggregateId:id,aggregateVersion:batch.version,
      requestId,beforeState:null,afterState:{reason:'MALWARE_SCAN_REQUIRED'},reason:'Unscanned quarantine is not downloadable',
      resolution:'REJECTED',retentionClass:'SECURITY_5Y'});
    return {blocked:true as const,message:'Исходник в карантине: скачивание закрыто до отдельной антивирусной проверки.'};
  });
}
