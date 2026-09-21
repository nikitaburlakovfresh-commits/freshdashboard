import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { config } from '../config';
import { ApiError } from '../util/errors';
import { canonicalJsonHash } from '../util/crypto';
import { beginIdempotent,completeIdempotent } from '../domain/idempotency';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { reviewContext } from './review';
import { detailAccess,detailPublisher } from './detailAccess';
import { factAccess } from './factAccess';
import { readSource,uuid } from './storage';
import { parseAnyWorkbook } from './shared/parseWorkbook';
import { validDate,normalize } from './shared/reportModel';
import { closed } from './factPublication';
import { DETAIL_NAMES,type DetailKind,type DetailReport } from './shared/detailModel';
import { resolveSourceAliases } from '../domain/sourceNaming';
import { normalizeBranchName } from '../domain/branchNameMatch';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const conflict=()=>new ApiError('ENTITY_VERSION_CONFLICT','Проверенный состав изменился или срок подтверждения истёк. Выполните новую проверку.');
const digest=(x:unknown)=>canonicalJsonHash(x).toString('hex');
// Персональные данные менеджеров: срок хранения объявлен в миграции (5 лет).
const DISCOUNT_RETENTION_DAYS=1826;

type Command={kind:DetailKind;file_id:string;observed_on:string;declaration:string;confirm_detail_rows:true};
function command(raw:any):Command {
  const b=closed(raw,['kind','file_id','observed_on','declaration','confirm_detail_rows']);
  if(b.kind!=='vinInventory'&&b.kind!=='managerDiscounts')throw invalid('Укажите вид детальной выгрузки.');
  if(typeof b.file_id!=='string'||!uuid.test(b.file_id))throw invalid('Укажите загруженный оригинал.');
  // Источник не объявляет дату среза: её объявляет публикатор и отвечает за неё.
  if(typeof b.observed_on!=='string'||!validDate(b.observed_on))throw invalid('Объявите дату среза детальной выгрузки: источник её не содержит.');
  if(typeof b.declaration!=='string'||b.declaration.trim().length<10||b.declaration.length>500)throw invalid('Нужно основание 10–500 символов.');
  if(b.confirm_detail_rows!==true)throw invalid('Требуется подтверждение публикации построчных данных.');
  return b as Command;
}
async function sourceFile(c:PoolClient,batch:string,fileId:string) {
  const f=(await c.query(`SELECT f.*,s.id scan_id,s.result,(s.scanned_at>now()-interval '24 hours') scan_current
    FROM report_staging_files f LEFT JOIN LATERAL (
      SELECT * FROM report_source_scans s WHERE s.file_id=f.id AND s.content_hash=f.content_hash
      ORDER BY s.scanned_at DESC,s.id DESC LIMIT 1) s ON true
    WHERE f.batch_id=$1 AND f.id=$2`,[batch,fileId])).rows[0];
  if(!f)throw new ApiError('NOT_FOUND','Оригинал не найден в этом пакете.');
  return f;
}
async function proposal(c:PoolClient,auth:AuthedUser,id:string,b:Command) {
  const ctx=await reviewContext(c,auth,id);
  const access=await detailPublisher(c,auth,b.kind);
  const file=await sourceFile(c,ctx.b.id,b.file_id);
  const buffer=await readSource(ctx.b.id,file);
  // Разбор ждёт ArrayBuffer, а хранилище отдаёт Buffer. Прежде здесь стояло
  // приведение типа, и разбор отказывал с INPUT_TYPE_NOT_SUPPORTED: детальный
  // путь ни разу не выполнялся целиком, поэтому дефект не проявлялся.
  const bytes=Buffer.isBuffer(buffer)?buffer:Buffer.from(buffer as ArrayBuffer);
  const parsed=await parseAnyWorkbook(
    bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength) as ArrayBuffer,
    file.display_name);
  if(!parsed||parsed.type!=='DETAIL')throw invalid('Файл не распознан как детальная выгрузка.');
  const report=parsed.report as DetailReport;
  if(report.kind!==b.kind)throw invalid(`Файл распознан как «${DETAIL_NAMES[report.kind]}», а публикация запрошена для другого вида.`);
  const blockers:string[]=[];
  const scanOk=file.scan_current===true&&(file.result==='CLEAN'||(file.result==='NOT_SCANNED'&&config.reportScanMode==='off'));
  if(!scanOk)blockers.push(`Оригинал «${file.display_name}»: нужна отметка проверки источника не старше 24 часов.`);
  // Повторный идентификатор или неразличимые строки решает человек до публикации.
  // Повторный идентификатор автомобиля внутри одной выгрузки — дефект
  // источника. Прежде он останавливал публикацию всего реестра сети: из-за
  // двух строк не публиковался склад по всем филиалам. Теперь повторные строки
  // не публикуются и перечисляются как исключённые, а первая строка по этому
  // автомобилю принимается. Конфликты сохраняются в записи публикации целиком,
  // поэтому видно, что именно источник прислал дважды.
  for(const x of report.conflicts)report.excluded.push({row:x.row,label:x.label,
    reason:`${x.reason} Строка не публикуется, принята первая строка по этому автомобилю.`});
  const duplicateRows=new Set(report.conflicts.map(x=>x.row));
  const provenance={kind:'APPROVED_SOURCE_DETAIL',producer:'QLIK',batch_id:ctx.b.id,file_id:file.id,
    file_hash:file.content_hash,scan_id:file.scan_id??null,scan_status:file.result??'NOT_SCANNED',
    scan_mode:config.reportScanMode,sheet:report.sheet,parser_version:ctx.b.parser_version,
    observed_on_basis:'DECLARED_BY_PUBLISHER',declaration:b.declaration,
    personal_columns_dropped:report.personalColumnsDropped,aggregation_across_scope:'NOT_AGGREGATED'};
  const vehicles:any[]=[],discounts:any[]=[];
  if(report.kind==='vinInventory') {
    // Филиал берётся только из справочника по действующему наименованию на дату
    // среза. Несопоставленная локация блокирует публикацию, а не угадывается.
    const map=new Map<string,string>();
    // Локация в выгрузке названа «Fresh Дагомыс», а в справочнике филиал
    // называется «Дагомыс»: приставка сети — часть названия точки в источнике,
    // а не отдельный филиал. Поэтому она снимается, затем применяются
    // объявленные в портале алиасы названий источника — те же, что у агрегатов,
    // — и только потом действующее наименование справочника. Ничего не
    // угадывается: совпадение либо точное, либо объявленное человеком.
    const aliases=await resolveSourceAliases(c,b.observed_on);
    const unmapped:string[]=[];
    for(const location of report.locations) {
      const bare=location.replace(/^\s*fresh\s+/i,'').trim();
      const alias=aliases.get(normalizeBranchName(bare))??aliases.get(normalizeBranchName(location));
      if(alias!==undefined){map.set(normalize(location),alias);continue;}
      const hit=(await c.query(`SELECT n.org_unit_id FROM org_directory_name_history n
        JOIN org_directory_units d ON d.id=n.org_unit_id
        WHERE lower(btrim(translate(n.display_name,'Ёё','Ее')))=lower(btrim(translate($1,'Ёё','Ее')))
          AND NOT d.is_demo AND NOT d.demo_locked
          AND n.effective_from<=$2::date AND (n.effective_to IS NULL OR n.effective_to>$2::date)
          AND d.effective_from<=$2::date AND (d.effective_to IS NULL OR d.effective_to>$2::date)`,
      [bare,b.observed_on])).rows;
      if(hit.length===1)map.set(normalize(location),hit[0].org_unit_id);
      else if(hit.length>1)blockers.push(`Локация «${location}»: наименование неоднозначно в справочнике на ${b.observed_on}.`);
      // Локация без филиала в справочнике не останавливает весь реестр: её
      // строки не публикуются и перечисляются отдельно, как это сделано для
      // агрегатов. Иначе один неизвестный адрес обнулял бы склад всей сети.
      else unmapped.push(location);
    }
    if(unmapped.length)report.excluded.push(...unmapped.map(location=>({row:0,label:location,
      reason:`Нет филиала с таким действующим наименованием на ${b.observed_on} — строки локации не публикуются.`})));
    for(const v of report.vehicles) {
      if(duplicateRows.has(v.row))continue;
      const org=map.get(v.locationKey);
      if(!org)continue;
      vehicles.push({source_row:v.row,vehicle_key:v.vin,key_kind:v.keyKind,org_unit_id:org,
        supply_type:v.supplyType,days_on_stock:v.daysOnStock,margin_rub:v.marginRub,profitability:v.profitability,
        cost_rub:v.costRub,sale_price_rub:v.salePriceRub,market_price_rub:v.marketPriceRub,leads:v.leads,
        not_advertised_share:v.notAdvertisedShare,arrival_date:v.arrivalDate,advertised_date:v.advertisedDate,
        city:v.city,make:v.make,model:v.model,production_year:v.productionYear,color:v.color,mileage:v.mileage,
        advertising_status:v.advertisingStatus,ppp_sum_rub:v.pppSumRub,market_diff_rub:v.marketDiffRub,
        price_changes_count:v.priceChangesCount,price_changes_sum_rub:v.priceChangesSumRub,
        price_changes_days:v.priceChangesDays,erk_count:v.erkCount,erk_days:v.erkDays,
        avito_cost_rub:v.avitoCostRub});
    }
    if(!vehicles.length)blockers.push('Нет ни одной строки склада с подтверждённой привязкой к филиалу.');
  } else {
    // Выгрузка скидок не содержит филиала. Строки хранятся как персональные,
    // ожидающие подтверждённого сопоставления «менеджер → сотрудник/филиал»:
    // выдумывать филиал нельзя, поэтому org_unit_id остаётся пустым.
    const failed=report.reconciliation.filter(r=>!r.matches);
    for(const r of failed)blockers.push(`Показатель ${r.metric}: сумма строк ${r.rows} не совпадает с итогом источника ${r.total}.`);
    for(const m of report.managers)discounts.push({source_row:m.row,source_manager_name:m.manager,vehicle_key:null,
      cars_issued:m.carsIssued,discount_count:m.discountCount,discount_share:m.discountShare,
      discount_sum_rub:m.discountSumRub,unit_discount_rub:m.unitDiscountRub,sale_price_rub:m.salePriceRub,
      discount_of_price:m.discountOfPrice});
    for(const v of report.vehicleDiscounts)discounts.push({source_row:v.row,source_manager_name:v.manager,
      vehicle_key:v.vin,key_kind:v.keyKind,cars_issued:v.carsIssued,discount_count:v.discountCount,
      discount_share:v.discountShare,discount_sum_rub:v.discountSumRub,unit_discount_rub:v.unitDiscountRub,
      sale_price_rub:v.salePriceRub,discount_of_price:v.discountOfPrice});
    if(!discounts.length)blockers.push('Нет ни одной строки менеджера.');
  }
  const data={kind:report.kind,file:file.display_name,observed_on:b.observed_on,
    vehicles,discounts,
    accepted_rows:vehicles.length+discounts.length,
    excluded:report.excluded,conflicts:report.conflicts,
    source_rows:report.vehicles.length+report.managers.length+report.vehicleDiscounts.length+report.excluded.length,
    key_kinds:report.keyKinds,reconciliation:report.reconciliation,
    branch_binding:report.kind==='managerDiscounts'?'PENDING_PERSON_MAPPING':'FROM_DIRECTORY',
    personal_columns_dropped:report.personalColumnsDropped,
    blockers:[...new Set(blockers)],provenance};
  return {ctx,access,file,data};
}
export async function detailState(auth:AuthedUser,id:string) {
  return withTransaction(async c=>{
    const ctx=await reviewContext(c,auth,id);
    const grants=await detailAccess(c,auth,'report_detail.publish');
    return {can_publish:grants.length===1,allowed_kinds:grants[0]?.kinds??[],
      publications:(await c.query(`SELECT id,kind,to_char(observed_on,'YYYY-MM-DD') observed_on,accepted_rows,
        excluded_rows,created_at FROM report_detail_publications WHERE batch_id=$1 ORDER BY created_at DESC LIMIT 20`,[ctx.b.id])).rows};
  });
}
export async function previewDetail(auth:AuthedUser,id:string,raw:any) {
  const b=command(raw);
  return withTransaction(async c=>{
    const p=await proposal(c,auth,id,b);
    const summary={...p.data,vehicles:p.data.vehicles.slice(0,20),discounts:p.data.discounts.slice(0,20)};
    if(p.data.blockers.length)return {...summary,preview_id:null,proposal_hash:null,can_commit:false};
    const previewId=randomUUID(),hash=digest(p.data);
    const saved=await c.query(`INSERT INTO report_detail_previews(id,batch_id,file_id,actor_user_id,kind,command,proposal,proposal_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING expires_at`,
    [previewId,p.ctx.b.id,p.file.id,auth.userId,b.kind,JSON.stringify(b),JSON.stringify(p.data),hash]);
    return {...summary,preview_id:previewId,proposal_hash:hash,expires_at:saved.rows[0].expires_at,can_commit:true};
  });
}
async function vehicleId(c:PoolClient,key:string,kind:'VIN'|'FRAME') {
  const found=(await c.query('SELECT id,key_kind FROM vehicle_identity WHERE vehicle_key=$1',[key])).rows[0];
  if(found) {
    if(found.key_kind!==kind)throw conflict();
    return found.id as string;
  }
  const id=randomUUID();
  await c.query('INSERT INTO vehicle_identity(id,vehicle_key,key_kind) VALUES($1,$2,$3)',[id,key,kind]);
  return id;
}
export async function commitDetail(auth:AuthedUser,id:string,raw:any,key:string|undefined,requestId:string) {
  const b=closed(raw,['preview_id','proposal_hash','confirm']);
  if(typeof b.preview_id!=='string'||!uuid.test(b.preview_id)||typeof b.proposal_hash!=='string'||
    !/^[a-f0-9]{64}$/.test(b.proposal_hash)||b.confirm!==true||!key||!/^[A-Za-z0-9._:-]{16,128}$/.test(key))
    throw invalid('Нужны проверенный preview, hash, подтверждение и Idempotency-Key.');
  return withTransaction(async c=>{
    const ctx=await reviewContext(c,auth,id);
    const v=(await c.query('SELECT * FROM report_detail_previews WHERE id=$1 AND batch_id=$2 AND actor_user_id=$3',
      [b.preview_id,ctx.b.id,auth.userId])).rows[0];
    if(!v)throw new ApiError('NOT_FOUND','Проверка не найдена.');
    const access=await detailPublisher(c,auth,v.kind);
    const idem=await beginIdempotent(c,auth.userId,'reportDetailPublish',key,ctx.b.id,b);
    if('replay' in idem)return idem.replay.body;
    await c.query("SELECT pg_advisory_xact_lock(hashtext('report-detail-publication-v1'))");
    const unexpired=(await c.query('SELECT $1::timestamptz>clock_timestamp() AS valid',[v.expires_at])).rows[0].valid;
    if(!unexpired||v.proposal_hash!==b.proposal_hash)throw conflict();
    const p=await proposal(c,auth,ctx.b.id,command(v.command));
    if(p.data.blockers.length||digest(p.data)!==v.proposal_hash)throw conflict();
    if((await c.query('SELECT 1 FROM report_detail_publications WHERE preview_id=$1',[v.id])).rowCount)throw conflict();
    const publicationId=randomUUID();
    const audit=await writeAuditAndOutbox(c,{actorUserId:auth.userId,actorRole:'SUPER_ADMIN',orgUnitId:null,workItemId:null,
      action:'REPORT_DETAIL_PUBLISHED',aggregateType:'report_stage',aggregateId:publicationId,aggregateVersion:1,requestId,
      beforeState:{preview_id:v.id},afterState:{batch_id:ctx.b.id,kind:v.kind,count:p.data.accepted_rows},
      reason:p.data.provenance.declaration,resolution:'APPLIED',retentionClass:'SECURITY_5Y',
      eventType:'report.detail.published',payload:{publication_id:publicationId,kind:v.kind,count:p.data.accepted_rows}});
    await c.query(`INSERT INTO report_detail_publications(id,preview_id,batch_id,kind,actor_user_id,grant_id,
      observed_on,declaration,source_rows,accepted_rows,excluded_rows,conflicts,provenance,audit_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [publicationId,v.id,ctx.b.id,v.kind,auth.userId,access.grant_id,p.data.observed_on,p.data.provenance.declaration,
      p.data.source_rows,p.data.accepted_rows,p.data.excluded.length,JSON.stringify(p.data.conflicts),
      // Запись аудита не передавалась вовсе: 13 значений на 14 столбцов.
      // Ещё один след того, что детальная публикация никогда не выполнялась.
      JSON.stringify(p.data.provenance),audit]);
    for(const row of p.data.vehicles) {
      await c.query(`INSERT INTO vehicle_stock_rows(id,publication_id,vehicle_id,org_unit_id,source_row,observed_on,
        supply_type,days_on_stock,margin_rub,profitability,cost_rub,sale_price_rub,market_price_rub,leads,
        not_advertised_share,arrival_date,advertised_date,
        city,make,model,production_year,color,mileage,advertising_status,ppp_sum_rub,market_diff_rub,
        price_changes_count,price_changes_sum_rub,price_changes_days,erk_count,erk_days,avito_cost_rub)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
        $18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)`,
      [randomUUID(),publicationId,await vehicleId(c,row.vehicle_key,row.key_kind),row.org_unit_id,row.source_row,
        p.data.observed_on,row.supply_type,row.days_on_stock,row.margin_rub,row.profitability,row.cost_rub,
        row.sale_price_rub,row.market_price_rub,row.leads,row.not_advertised_share,row.arrival_date,row.advertised_date,
        row.city,row.make,row.model,row.production_year,row.color,row.mileage,row.advertising_status,
        row.ppp_sum_rub,row.market_diff_rub,row.price_changes_count,row.price_changes_sum_rub,
        row.price_changes_days,row.erk_count,row.erk_days,row.avito_cost_rub]);
    }
    for(const row of p.data.discounts) {
      await c.query(`INSERT INTO manager_discount_rows(id,publication_id,source_row,source_manager_name,vehicle_id,
        observed_on,cars_issued,discount_count,discount_share,discount_sum_rub,unit_discount_rub,sale_price_rub,
        discount_of_price,purge_after)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,($6::date+$14::int))`,
      [randomUUID(),publicationId,row.source_row,row.source_manager_name,
        row.vehicle_key?await vehicleId(c,row.vehicle_key,row.key_kind):null,
        p.data.observed_on,row.cars_issued,row.discount_count,row.discount_share,row.discount_sum_rub,
        row.unit_discount_rub,row.sale_price_rub,row.discount_of_price,DISCOUNT_RETENTION_DAYS]);
    }
    const result={publication_id:publicationId,kind:v.kind,count:p.data.accepted_rows,
      branch_binding:p.data.branch_binding,status:'PUBLISHED_SOURCE_DETAIL'};
    await completeIdempotent(c,auth.userId,'reportDetailPublish',key,200,result);
    return result;
  });
}
export async function readDetailStock(auth:AuthedUser,query:any) {
  const q=closed(query,['observed_on','org']);
  if(typeof q.observed_on!=='string'||!validDate(q.observed_on)||
    (q.org!==undefined&&(typeof q.org!=='string'||!uuid.test(q.org))))throw invalid('Укажите дату среза.');
  return withTransaction(async c=>{
    // Реестр виден по обычной видимости филиалов роли — той же, по которой
    // работают главная страница и карточка филиала. Отдельное право на каждый
    // филиал не требуется: роли отличаются уровнем видимости, а не набором
    // отдельных защит. Персональные столбцы источника в портал не переносятся,
    // поэтому отдельного режима обработки они не требуют.
    const grants=await factAccess(c,auth,'READ');
    const allowed=[...new Set(grants.map(g=>g.org_unit_id))];
    if(!allowed.length)throw new ApiError('FORBIDDEN','Нет доступа к показателям филиалов.');
    if(q.org&&!allowed.includes(q.org))throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const orgs=q.org?[q.org]:allowed;
    const rows=(await c.query(`SELECT r.id,r.org_unit_id,i.vehicle_key,i.key_kind,r.supply_type,r.days_on_stock,
      r.margin_rub,r.profitability,r.cost_rub,r.sale_price_rub,r.market_price_rub,r.leads,r.not_advertised_share,
      r.city,r.make,r.model,r.production_year,r.color,r.mileage,r.advertising_status,r.market_diff_rub,
      r.price_changes_count,r.price_changes_sum_rub,r.price_changes_days,
      to_char(r.arrival_date,'YYYY-MM-DD') arrival_date,to_char(r.advertised_date,'YYYY-MM-DD') advertised_date
      FROM vehicle_stock_rows r JOIN vehicle_identity i ON i.id=r.vehicle_id
      WHERE r.observed_on=$1 AND r.org_unit_id=ANY($2::uuid[])
      ORDER BY r.org_unit_id,i.vehicle_key LIMIT 2001`,[q.observed_on,orgs])).rows;
    if(rows.length>2000)throw invalid('Слишком много строк: выберите один филиал.');
    return {mode:'PUBLISHED_SOURCE_DETAIL',observed_on:q.observed_on,items:rows,aggregation:'NONE'};
  });
}
