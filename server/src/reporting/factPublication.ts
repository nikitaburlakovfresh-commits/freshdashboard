import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { config } from '../config';
import { ApiError } from '../util/errors';
import { canonicalJsonHash } from '../util/crypto';
import { beginIdempotent,completeIdempotent } from '../domain/idempotency';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { reviewContext,sourceItemId } from './review';
import { factAccess,publisher } from './factAccess';
import { readSource,uuid } from './storage';
import { scanSource,SourceScanResult } from './scanner';
import { METRIC_NAMES,reconcile,validDate,type MetricKey,type ReportKind } from './shared/reportModel';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const conflict=()=>new ApiError('ENTITY_VERSION_CONFLICT','Проверенный состав изменился или срок подтверждения истёк. Выполните новую проверку.');
const digest=(x:unknown)=>canonicalJsonHash(x).toString('hex');
const counts=['sales','stock','aged','plan'];
export function closed(raw:any,keys:string[]) {
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).some(k=>!keys.includes(k)))throw invalid('Неизвестные поля команды.');
  return raw;
}
type Choice={metric:MetricKey;source:ReportKind;methodology:string};
type Command={review_version:number;choices:Choice[];reason:string;confirm_source_aggregates:true};
function command(raw:any):Command {
  const b=closed(raw,['review_version','choices','reason','confirm_source_aggregates']);
  if(!Number.isSafeInteger(b.review_version)||b.review_version<1||b.confirm_source_aggregates!==true||
    typeof b.reason!=='string'||b.reason.trim().length<16||b.reason.length>500||!Array.isArray(b.choices)||!b.choices.length||b.choices.length>8)
    throw invalid('Нужны сохранённая версия, явный выбор метрик, подтверждение и основание 16–500 символов.');
  const seen=new Set<string>();
  for(const item of b.choices) {
    const x=closed(item,['metric','source','methodology']);
    if(!Object.keys(METRIC_NAMES).includes(x.metric)||!['summary','sales'].includes(x.source)||seen.has(x.metric)||
      typeof x.methodology!=='string'||x.methodology.trim().length<20||x.methodology.length>1000)
      throw invalid('Для каждой метрики выберите один источник и опишите утверждённую методику/состав агрегата (20–1000 символов).');
    // Summary revenue header is not validated by legacy parser; fail closed.
    if(x.metric==='revenue'&&x.source==='summary')throw invalid('Выручка из сводки пока не поддержана: нет проверяемого заголовка колонки.');
    seen.add(x.metric);
  }
  return b;
}
async function files(c:PoolClient,batch:string) {
  return (await c.query(`SELECT f.*,s.id scan_id,s.result,s.scanner,
    (s.scanned_at>now()-interval '24 hours') scan_current
    FROM report_staging_files f LEFT JOIN LATERAL (
      SELECT * FROM report_source_scans s WHERE s.file_id=f.id AND s.content_hash=f.content_hash
      ORDER BY s.scanned_at DESC,s.id DESC LIMIT 1) s ON true
    WHERE f.batch_id=$1 ORDER BY f.id`,[batch])).rows;
}
export async function publicationState(auth:AuthedUser,id:string) {
  return withTransaction(async c=>{
    const {b,view,reports}=await reviewContext(c,auth,id);
    const grants=await factAccess(c,auth,'PUBLISH');
    return {review:view,reports,allowed_metrics:grants[0]?.metrics??[],can_publish:grants.length===1,
      files:(await files(c,b.id)).map(f=>({id:f.id,name:f.display_name,result:f.result??'NOT_SCANNED',current:f.scan_current===true})),
      publications:(await c.query(`SELECT p.id,p.created_at,v.review_version FROM report_fact_publications p
        JOIN report_fact_previews v ON v.id=p.preview_id WHERE v.batch_id=$1 ORDER BY p.created_at DESC LIMIT 20`,[b.id])).rows};
  });
}
let scanning=false;
export async function scanBatch(auth:AuthedUser,id:string,raw:any,requestId:string) {
  closed(raw,[]);
  if(scanning)throw new ApiError('TEMPORARILY_UNAVAILABLE','Проверка другого пакета выполняется.');
  scanning=true;
  try {
    const sources=await withTransaction(async c=>{
      const {b}=await reviewContext(c,auth,id);await publisher(c,auth);
      return {id:b.id,files:await files(c,b.id)};
    });
    const receipts:{file:any;scanner:string;result:SourceScanResult}[]=[];
    for(const f of sources.files)receipts.push({file:f,...await scanSource(await readSource(sources.id,f))});
    return await withTransaction(async c=>{
      await reviewContext(c,auth,sources.id);await publisher(c,auth);
      for(const r of receipts) {
        // Integrity is verified again after the scanner returned.
        await readSource(sources.id,r.file);
        const scanId=randomUUID();
        await c.query(`INSERT INTO report_source_scans(id,file_id,content_hash,scanner,result,actor_user_id)
          VALUES($1,$2,$3,$4,$5,$6)`,[scanId,r.file.id,r.file.content_hash,r.scanner,r.result,auth.userId]);
        await writeAuditAndOutbox(c,{actorUserId:auth.userId,actorRole:'SUPER_ADMIN',orgUnitId:null,workItemId:null,
          action:'REPORT_SOURCE_SCANNED',aggregateType:'report_stage',aggregateId:scanId,aggregateVersion:1,requestId,
          beforeState:null,afterState:{file_id:r.file.id,result:r.result},resolution:'APPLIED',retentionClass:'SECURITY_5Y',
          eventType:'report.source.scanned',payload:{file_id:r.file.id,result:r.result}});
      }
      return {results:receipts.map(r=>({file_id:r.file.id,result:r.result}))};
    });
  } finally {scanning=false;}
}
async function proposal(c:PoolClient,auth:AuthedUser,id:string,b:Command) {
  const context=await reviewContext(c,auth,id);
  const access=await publisher(c,auth);
  await c.query('LOCK TABLE report_source_scans IN SHARE MODE');
  const {view,reports}=context,period=view.current.period;
  if(b.review_version!==view.current.version)throw conflict();
  if(b.choices.some(x=>!access.metrics.includes(x.metric)))throw new ApiError('FORBIDDEN','Выбрана метрика вне разрешения публикации.');
  const blockers:string[]=[],rows:any[]=[];
  if(!period)blockers.push('Нет сохранённого предложения периода для подтверждения.');
  const sourceFiles=await files(c,context.b.id);
  for(const f of sourceFiles) {
    await readSource(context.b.id,f);
    // BETA-02. Без проверки публикация допускается только при явно включённом
    // режиме REPORT_SCAN_MODE=off, и только с честным статусом NOT_SCANNED.
    // Заражённый или устаревший результат блокирует публикацию в любом режиме.
    const scanOk=f.scan_current===true&&(f.result==='CLEAN'||
      (f.result==='NOT_SCANNED'&&config.reportScanMode==='off'));
    if(!scanOk)blockers.push(config.reportScanMode==='off'
      ? `Оригинал «${f.display_name}»: нужна отметка проверки источника не старше 24 часов.`
      : `Оригинал «${f.display_name}»: нужна чистая антивирусная проверка не старше 24 часов.`);
  }
  const allTargets=new Set<string>();
  for(const choice of b.choices) {
    const report=reports.find(r=>r.kind===choice.source);
    if(!report||!report.columns[choice.metric]){blockers.push(`${METRIC_NAMES[choice.metric]}: отсутствует выбранный источник.`);continue;}
    const control=reconcile(report).find(r=>r.metric===choice.metric);
    if(!control?.matches)blockers.push(`${METRIC_NAMES[choice.metric]}: итог отчёта не согласуется с полным набором строк.`);
    const sourceFile=sourceFiles.find(f=>f.display_name===report.file);
    if(!sourceFile){blockers.push('Не установлена связь отчёта с оригиналом.');continue;}
    const start=counts.slice(1,3).includes(choice.metric)?report.stockDate:choice.metric==='plan'?period?.planStart:period?.start;
    const end=counts.slice(1,3).includes(choice.metric)?report.stockDate:choice.metric==='plan'?period?.planEnd:period?.end;
    if(!start||!end||!validDate(start)||!validDate(end)||start>end){blockers.push(`${METRIC_NAMES[choice.metric]}: не подтверждён период/дата среза.`);continue;}
    for(const row of report.branches) {
      const item=sourceItemId(context.b.id,report.kind,row.row),mapping=view.rows.find(m=>m.item_id===item);
      if(!mapping?.org_unit_id||mapping.status!=='PROPOSED'){blockers.push(`Строка ${report.kind}:${row.row}: нет допустимой UUID-привязки.`);continue;}
      const org=mapping.org_unit_id;
      // Every path edge must cover the WHOLE period. Never use today's hierarchy
      // to silently assign historical facts to another network.
      const historical=await c.query(`WITH RECURSIVE ancestry AS (
        SELECT d.id,a.parent_id,ARRAY[d.id] path FROM org_directory_units d
        JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id
        WHERE d.id=$1 AND NOT d.is_demo AND NOT d.demo_locked AND d.effective_from<=$2::date
          AND (d.effective_to IS NULL OR d.effective_to>$3::date) AND a.effective_from<=$2::date
          AND (a.effective_to IS NULL OR a.effective_to>$3::date)
        UNION ALL SELECT d.id,a.parent_id,t.path||d.id FROM ancestry t
        JOIN org_directory_units d ON d.id=t.parent_id JOIN org_directory_affiliation_history a ON a.org_unit_id=d.id
        WHERE NOT d.id=ANY(t.path) AND NOT d.is_demo AND NOT d.demo_locked AND d.effective_from<=$2::date
          AND (d.effective_to IS NULL OR d.effective_to>$3::date) AND a.effective_from<=$2::date
          AND (a.effective_to IS NULL OR a.effective_to>$3::date)
        ) SELECT 1 FROM ancestry WHERE id=$4 AND parent_id IS NULL`,[org,start,end,context.b.network_id]);
      if(!historical.rowCount){blockers.push(`Строка ${report.kind}:${row.row}: историческая структура не покрывает весь период.`);continue;}
      const value=row.values[choice.metric];
      if(value==null||!Number.isFinite(value)){blockers.push(`Строка ${report.kind}:${row.row}: нет числового значения, ноль не подставляется.`);continue;}
      const key=`${org}:${choice.metric}:${start}:${end}`;
      if(allTargets.has(key)){blockers.push('Повторная метрика филиала в одном периоде.');continue;}allTargets.add(key);
      const previous=(await c.query(`SELECT s.id,s.revision,s.value FROM report_fact_current p
        JOIN report_fact_snapshots s ON s.id=p.snapshot_id
        WHERE p.org_unit_id=$1 AND p.metric=$2 AND p.period_start=$3 AND p.period_end=$4`,[org,choice.metric,start,end])).rows[0];
      rows.push({org_unit_id:org,branch:view.candidates.find(x=>x.id===org)!.display_name,metric:choice.metric,
        period_start:start,period_end:end,value,unit:counts.includes(choice.metric)?'COUNT':'RUB',
        previous_id:previous?.id??null,previous_value:previous?.value??null,revision:(previous?.revision??0)+1,
        provenance:{kind:'APPROVED_SOURCE_AGGREGATE',channel:'FORM_UI',producer:'QLIK',batch_id:context.b.id,
          file_id:sourceFile.id,file_hash:sourceFile.content_hash,scan_id:sourceFile.scan_id??null,
          scan_status:sourceFile.result??'NOT_SCANNED',scan_mode:config.reportScanMode,
          report_kind:report.kind,sheet:report.sheet,address:report.columns[choice.metric]!+row.row,
          parser_version:context.b.parser_version,review_hash:view.current.revision_hash,
          extraction:'SOURCE_CELL_V1',methodology:choice.methodology,source_selection_reason:b.reason,
          period_basis:period?.basis,aggregation_across_scope:'NOT_AGGREGATED',null_handling:'HOLD',
          metric_engine_status:'NOT_COMPUTED'}});
    }
  }
  rows.sort((a,b)=>`${a.org_unit_id}:${a.metric}`.localeCompare(`${b.org_unit_id}:${b.metric}`));
  return {context,access,data:{rows,blockers:[...new Set(blockers)],review_hash:view.current.revision_hash}};
}
export async function previewPublication(auth:AuthedUser,id:string,raw:any) {
  const b=command(raw);
  return withTransaction(async c=>{
    const p=await proposal(c,auth,id,b),previewId=randomUUID(),proposalHash=digest(p.data);
    if(p.data.blockers.length)return {...p.data,preview_id:null,proposal_hash:null,can_commit:false};
    const saved=await c.query(`INSERT INTO report_fact_previews(id,batch_id,actor_user_id,review_version,review_hash,command,proposal,proposal_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at`,
    [previewId,p.context.b.id,auth.userId,b.review_version,p.data.review_hash,JSON.stringify(b),JSON.stringify(p.data),proposalHash]);
    return {...p.data,preview_id:previewId,proposal_hash:proposalHash,expires_at:saved.rows[0].expires_at,can_commit:true};
  });
}
export async function commitPublication(auth:AuthedUser,id:string,raw:any,key:string|undefined,requestId:string) {
  const b=closed(raw,['preview_id','proposal_hash','confirm']);
  if(typeof b.preview_id!=='string'||!uuid.test(b.preview_id)||typeof b.proposal_hash!=='string'||
    !/^[a-f0-9]{64}$/.test(b.proposal_hash)||b.confirm!==true||!key||!/^[A-Za-z0-9._:-]{16,128}$/.test(key))throw invalid('Нужны проверенный preview, hash, подтверждение и Idempotency-Key.');
  return withTransaction(async c=>{
    const ctx=await reviewContext(c,auth,id);await publisher(c,auth);
    const v=(await c.query('SELECT *,expires_at>now() AS valid FROM report_fact_previews WHERE id=$1 AND batch_id=$2 AND actor_user_id=$3',
      [b.preview_id,ctx.b.id,auth.userId])).rows[0];
    if(!v)throw new ApiError('NOT_FOUND','Проверка не найдена.');
    const access=await publisher(c,auth);
    if(v.command.choices.some((x:Choice)=>!access.metrics.includes(x.metric)))throw new ApiError('FORBIDDEN','Разрешение на метрику отозвано.');
    const idem=await beginIdempotent(c,auth.userId,'reportFactPublish',key,ctx.b.id,b);
    if('replay' in idem)return idem.replay.body;
    // Serializes publications across ALL batches before checking current IDs.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('report-fact-publication-v1'))");
    const unexpired=(await c.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[v.expires_at])).rows[0].valid;
    if(!unexpired||v.proposal_hash!==b.proposal_hash)throw conflict();
    const p=await proposal(c,auth,ctx.b.id,command(v.command));
    if(p.data.blockers.length||digest(p.data)!==v.proposal_hash)throw conflict();
    if((await c.query('SELECT 1 FROM report_fact_publications WHERE preview_id=$1',[v.id])).rowCount)throw conflict();
    const publicationId=randomUUID();
    const audit=await writeAuditAndOutbox(c,{actorUserId:auth.userId,actorRole:'SUPER_ADMIN',orgUnitId:null,workItemId:null,
      action:'REPORT_FACTS_PUBLISHED',aggregateType:'report_stage',aggregateId:publicationId,aggregateVersion:1,requestId,
      beforeState:{preview_id:v.id},afterState:{batch_id:ctx.b.id,proposal_hash:v.proposal_hash,count:p.data.rows.length},
      reason:v.command.reason,resolution:'APPLIED',retentionClass:'SECURITY_5Y',
      eventType:'report.facts.published',payload:{publication_id:publicationId,count:p.data.rows.length}});
    await c.query('INSERT INTO report_fact_publications(id,preview_id,actor_user_id,grant_id,audit_id) VALUES($1,$2,$3,$4,$5)',
      [publicationId,v.id,auth.userId,access.grant_id,audit]);
    for(const row of p.data.rows) {
      const snapshotId=randomUUID();
      await c.query(`INSERT INTO report_fact_snapshots(id,publication_id,org_unit_id,metric,period_start,period_end,value,unit,revision,replaces,provenance)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[snapshotId,publicationId,row.org_unit_id,row.metric,row.period_start,row.period_end,
        row.value,row.unit,row.revision,row.previous_id,JSON.stringify(row.provenance)]);
      await c.query(`INSERT INTO report_fact_current(org_unit_id,metric,period_start,period_end,snapshot_id)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_unit_id,metric,period_start,period_end) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,
      [row.org_unit_id,row.metric,row.period_start,row.period_end,snapshotId]);
    }
    const result={publication_id:publicationId,count:p.data.rows.length,status:'PUBLISHED_SOURCE_AGGREGATES'};
    await completeIdempotent(c,auth.userId,'reportFactPublish',key,200,result);
    return result;
  });
}
export async function readPublished(auth:AuthedUser,query:any) {
  const q=closed(query,['start','end','org','history']);
  if(typeof q.start!=='string'||typeof q.end!=='string'||!validDate(q.start)||!validDate(q.end)||q.start>q.end||
    (q.org!==undefined&&(typeof q.org!=='string'||!uuid.test(q.org)))||(q.history!==undefined&&q.history!=='true'))throw invalid('Укажите точный период опубликованного среза.');
  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    if(!grants.length)throw new ApiError('FORBIDDEN','Нет отдельного доступа к опубликованным бизнес-показателям.');
    if(q.org&&!grants.some(g=>g.org_unit_id===q.org))throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const orgs=[...new Set(grants.map(g=>g.org_unit_id!))].filter(x=>!q.org||x===q.org);
    const allowed=grants.filter(g=>orgs.includes(g.org_unit_id!)).flatMap(g=>g.metrics.map(metric=>({org:g.org_unit_id,metric})));
    const rows=(await c.query(`SELECT s.id,s.org_unit_id,s.metric,to_char(s.period_start,'YYYY-MM-DD') period_start,
      to_char(s.period_end,'YYYY-MM-DD') period_end,s.value,s.unit,s.revision,s.replaces,s.provenance,s.created_at,
      (p.snapshot_id=s.id) AS is_current,n.display_name
      FROM report_fact_snapshots s JOIN report_fact_current p USING(org_unit_id,metric,period_start,period_end)
      JOIN org_directory_name_history n ON n.org_unit_id=s.org_unit_id AND n.effective_to IS NULL
        AND n.effective_from<=(now() AT TIME ZONE 'Europe/Moscow')::date
      WHERE s.period_start=$1 AND s.period_end=$2 AND ($3 OR s.id=p.snapshot_id)
        AND EXISTS(SELECT 1 FROM jsonb_to_recordset($4::jsonb) a(org uuid,metric text)
          WHERE a.org=s.org_unit_id AND a.metric=s.metric)
      ORDER BY n.display_name,s.metric,s.revision DESC LIMIT 2001`,[q.start,q.end,q.history==='true',JSON.stringify(allowed)])).rows;
    if(rows.length>2000)throw invalid('Слишком много версий: выберите один филиал.');
    return {mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:q.start,period_end:q.end,items:rows,
      aggregation:'NONE',freshness:'NOT_EVALUATED',metric_engine:'NOT_COMPUTED'};
  });
}
