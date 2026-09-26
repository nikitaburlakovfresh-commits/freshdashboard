import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { factAccess, peerAccess } from '../reporting/factAccess';
import { METRIC_NAMES } from '../reporting/shared/reportModel';
import { uuid } from '../reporting/storage';
import { ApiError } from '../util/errors';
import { evaluateRag, resolveThresholds, thresholdFor, type Rag } from './thresholds';
import { resolveEffectivePeriod } from './effectivePeriod';
import { funnelConversions, buyback45Shares, upwardRepricing, upwardRepricingEvents, stockTurnover,
  DERIVED_METRICS } from './derived';
import { settingNumber } from '../settings/portalSettings';
import { resolveScoringModel, computeBranchScore } from './scoring';

/** Окно переоценок — настройка портала repricing_window_days (по решению 26.09.2026 — 10 дней). */
const repricingWindow=(c:any)=>settingNumber(c,'repricing_window_days');

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const validDate=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v))return false;
  const t=Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;
};
const RAG_ORDER:Record<Rag,number>={RED:0,AMBER:1,GREEN:2,NONE:-1};
const CLOSED=['COMPLETED','CANCELLED'];

/**
 * Проверка результата задачи по отклонению. Сравниваются только факты:
 * значение и статус на момент постановки задачи против текущего
 * опубликованного значения того же периода. Отсутствие новой публикации не
 * выдаётся за улучшение, а закрытие задачи не считается влиянием на показатель.
 */
export function verifyOutcome(a:{rag_at_creation:Rag;observed_value:number;direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER'|null;
  current:{snapshot_id:string;value:number;rag:Rag;revision:number}|null;snapshot_id:string;status:string}) {
  if(!a.current)return {outcome:'NO_PUBLISHED_VALUE' as const,delta:null,rag_now:null as Rag|null};
  const rag_now=a.current.rag;
  if(a.current.snapshot_id===a.snapshot_id)
    return {outcome:'NOT_REPUBLISHED' as const,delta:null,rag_now};
  const delta=a.current.value-a.observed_value;
  const better=a.direction==='LOWER_IS_BETTER'?delta<0:delta>0;
  const ragBefore=RAG_ORDER[a.rag_at_creation],ragAfter=RAG_ORDER[rag_now];
  const outcome=rag_now==='NONE'?'STATUS_UNKNOWN' as const
    :ragAfter>ragBefore?'STATUS_IMPROVED' as const
      :ragAfter<ragBefore?'STATUS_WORSENED' as const
        :delta===0?'UNCHANGED' as const
          :better?'VALUE_IMPROVED' as const:'VALUE_WORSENED' as const;
  return {outcome,delta,rag_now,task_closed:CLOSED.includes(a.status)};
}

/**
 * Карточка филиала ТЗ v2.12: опубликованные показатели периода, история
 * отклонений с поставленными задачами и проверка результата по факту
 * последующей публикации. Всё в пределах допусков пользователя к показателям.
 */
export async function branchCard(auth:AuthedUser,orgUnitId:string,query:any) {
  const q=query??{};
  if(Object.keys(q).some(k=>!['start','end'].includes(k)))throw invalid('Фильтры карточки не принимаются.');
  if(typeof orgUnitId!=='string'||!uuid.test(orgUnitId))throw invalid('Филиал указан неверно.');
  if(!validDate(q.start)||!validDate(q.end)||q.start>q.end)throw invalid('Укажите точный период опубликованного среза.');
  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    const peer=await peerAccess(c,auth);
    // Карточка чужого филиала в режиме «вся сеть для просмотра»: показатели и
    // балл видны, задачи филиала — нет.
    const grant=grants.find(g=>g.org_unit_id===orgUnitId)??peer?.grants.find(g=>g.org_unit_id===orgUnitId);
    const peerOnly=!!peer&&!grants.some(g=>g.org_unit_id===orgUnitId);
    const ownBranch=!!peer?.own_org_unit_ids.includes(orgUnitId);
    if(!grant)throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const unit=(await c.query(`SELECT u.id,u.code,u.lifecycle_state,n.display_name
      FROM org_directory_units u JOIN org_directory_name_history n ON n.org_unit_id=u.id AND n.effective_to IS NULL
      WHERE u.id=$1`,[orgUnitId])).rows[0];
    if(!unit)throw new ApiError('NOT_FOUND','Филиал недоступен.');

    // Срез карточки разрешается так же, как на сводном экране: последний
    // опубликованный период не позже выбранной даты. Иначе карточка пустеет при
    // выборе сегодняшнего числа, пока отчёты за него не загружены.
    const period=await resolveEffectivePeriod(c,q.start,q.end,[orgUnitId]);
    const from=period?.start??q.start,on=period?.end??q.end;
    const thresholds=await resolveThresholds(c,on);
    const rows=(await c.query(`SELECT s.id snapshot_id,s.metric,s.value::text value,s.unit,s.revision,s.created_at
      FROM report_fact_snapshots s JOIN report_fact_current p ON p.snapshot_id=s.id
      WHERE s.org_unit_id=$1 AND s.period_start=$2 AND s.period_end=$3 AND s.metric=ANY($4::text[])
      ORDER BY s.metric`,[orgUnitId,from,on,grant.metrics])).rows;
    const plan=rows.find((r:any)=>r.metric==='plan');
    const metrics=rows.map((r:any)=>{
      const t=thresholdFor(thresholds,r.metric,orgUnitId);
      const {rag,basis_value}=evaluateRag(t,Number(r.value),plan?Number(plan.value):null);
      return {metric:r.metric,metric_name:(METRIC_NAMES as Record<string,string>)[r.metric]??r.metric,
        value:Number(r.value),unit:r.unit,rag,basis:t?.basis??null,basis_value,threshold_id:t?.id??null,
        direction:t?.direction??null,revision:r.revision,published_at:r.created_at,snapshot_id:r.snapshot_id};
    });

    // Показатели, которых нет в основном срезе: отчёты приходят в разные дни, и
    // рентабельность или оборачиваемость могла быть опубликована по 20-е, а продажи
    // по 25-е. Для плиток ежедневного контроля берём последнюю публикацию того же
    // месяца не позже выбранной даты и подписываем её дату. В балл они не входят:
    // балл считается по одному срезу.
    const have=new Set(rows.map((r:any)=>r.metric));
    const latest=(await c.query(`SELECT DISTINCT ON (s.metric) s.metric,s.value::text value,s.unit,
        to_char(s.period_end,'YYYY-MM-DD') as_of
      FROM report_fact_snapshots s JOIN report_fact_current p ON p.snapshot_id=s.id
      WHERE s.org_unit_id=$1 AND s.period_start=$2::date AND s.period_end<$3::date
        AND s.metric=ANY($4::text[]) AND NOT (s.metric=ANY($5::text[]))
      ORDER BY s.metric,s.period_end DESC`,[orgUnitId,from,on,grant.metrics,[...have]])).rows
      .map((r:any)=>({metric:r.metric,value:Number(r.value),unit:r.unit,as_of:r.as_of,
        metric_name:(METRIC_NAMES as Record<string,string>)[r.metric]??r.metric}));

    // Склад — состояние на дату, а не итог периода: он публикуется точечным
    // срезом (период из одного дня), тогда как план на конец месяца приходит
    // за период. Поэтому факт склада читается отдельно — последним срезом не
    // позднее конца выбранного периода.
    const stockRows=(await c.query(`SELECT s.metric,s.value::text value,s.unit,
      to_char(s.period_end,'YYYY-MM-DD') observed_on
      FROM report_fact_snapshots s JOIN report_fact_current p ON p.snapshot_id=s.id
      WHERE s.org_unit_id=$1 AND s.period_start=s.period_end AND s.period_end<=$2::date
        AND s.metric=ANY($3::text[]) AND s.metric=ANY($4::text[])
      ORDER BY s.period_end DESC`,
    [orgUnitId,on,['stock','stockCost'],grant.metrics])).rows;
    let stockSnapshot=stockRows.length?{observed_on:stockRows[0].observed_on,
      stock:null as number|null,stock_cost:null as number|null}:null;
    if(stockSnapshot)for(const r of stockRows) {
      if(r.observed_on!==stockSnapshot.observed_on)continue;
      if(r.metric==='stock')stockSnapshot.stock=Number(r.value);
      if(r.metric==='stockCost')stockSnapshot.stock_cost=Number(r.value);
    }

    // Склад по реестру VIN (решение владельца 26.09.2026): реестр приходит с
    // каждым пакетом, а сводный срез склада — реже. Берём последний срез реестра
    // не позже выбранной даты; сводный остаётся, только если реестра нет.
    const vin=(await c.query(`SELECT to_char(r.observed_on,'YYYY-MM-DD') observed_on,count(*)::int n,
        sum(r.cost_rub)::float8 cost FROM vehicle_stock_rows r
      WHERE r.org_unit_id=$1 AND r.observed_on=(SELECT max(observed_on) FROM vehicle_stock_rows
        WHERE org_unit_id=$1 AND observed_on<=$2::date)
      GROUP BY r.observed_on`,[orgUnitId,on])).rows[0];
    let stockSource:'VIN'|'SUMMARY'|null=stockSnapshot?'SUMMARY':null;
    if(vin&&(!stockSnapshot||vin.observed_on>=stockSnapshot.observed_on)) {
      stockSnapshot={observed_on:vin.observed_on,stock:vin.n,stock_cost:vin.cost};
      stockSource='VIN';
    }

    // Производные показатели карточки: конверсии воронки из опубликованных
    // трафика, визитов и сделок, доля 45+ в выкупе и переоценки вверх по
    // реестру VIN. Источника-ячейки у них нет, поэтому они не публикуются как
    // факты, а считаются здесь и помечаются расчётными.
    const values=new Map<string,number>(metrics.map(m=>[m.metric,m.value]));
    const conversions=funnelConversions(values);
    for(const [k,v] of conversions)values.set(k,v);
    const turnover=stockTurnover(values);
    if(turnover!==null)values.set('stockTurnover',turnover);
    const buyback=(await buyback45Shares(c,[orgUnitId],on)).get(orgUnitId)??null;
    if(buyback)values.set('buyback45Share',buyback.share);
    const REPRICING_WINDOW_DAYS=await repricingWindow(c);
    const repricing=(await upwardRepricing(c,[orgUnitId],on,REPRICING_WINDOW_DAYS)).get(orgUnitId)??null;
    // Сколько срезов реестра накоплено: по одному срезу переоценку определить
    // нельзя, и выдавать её отсутствие за ноль нельзя тоже.
    const snapshots=Number((await c.query(
      `SELECT count(DISTINCT observed_on)::int n FROM vehicle_stock_rows
       WHERE org_unit_id=$1 AND observed_on<=$2::date
         AND observed_on>$2::date-($3::int||' days')::interval`,
      [orgUnitId,on,REPRICING_WINDOW_DAYS])).rows[0].n);
    const derivedValues=new Map(conversions);
    if(turnover!==null)derivedValues.set('stockTurnover',turnover);
    const derived=[...derivedValues.entries()].map(([metric,value])=>({metric,
      metric_name:(METRIC_NAMES as Record<string,string>)[metric]??metric,value,unit:'PCT',
      formula:DERIVED_METRICS[metric]?.formula??null,
      components:DERIVED_METRICS[metric]?.components??[]}));
    if(buyback)derived.push({metric:'buyback45Share',
      metric_name:(METRIC_NAMES as Record<string,string>).buyback45Share??'buyback45Share',
      value:buyback.share,unit:'PCT',formula:DERIVED_METRICS.buyback45Share.formula,
      components:DERIVED_METRICS.buyback45Share.components});

    // Балл филиала и его разбивка по показателям — та же модель, что на главной.
    const model=await resolveScoringModel(c,on);
    const score=computeBranchScore(model,values,on);

    // История отклонений: все задачи филиала по доступным показателям, без
    // ограничения выбранным периодом — руководителю нужен ход работы.
    const hist=(await c.query(`SELECT d.id,d.work_item_id,d.metric,d.rag,d.snapshot_id,
      d.observed_value::text observed_value,d.basis,d.basis_value::text basis_value,d.threshold_id,d.reason,
      d.created_at,to_char(d.period_start,'YYYY-MM-DD') period_start,to_char(d.period_end,'YYYY-MM-DD') period_end,
      t.direction,w.title,w.status,w.assignee_user_id,w.due_at,
      cur.id cur_snapshot_id,cur.value::text cur_value,cur.revision cur_revision,cur.unit cur_unit
      FROM metric_deviation_tasks d
      JOIN metric_thresholds t ON t.id=d.threshold_id
      JOIN work_items w ON w.id=d.work_item_id
      LEFT JOIN report_fact_current p ON p.org_unit_id=d.org_unit_id AND p.metric=d.metric
        AND p.period_start=d.period_start AND p.period_end=d.period_end
      LEFT JOIN report_fact_snapshots cur ON cur.id=p.snapshot_id
      WHERE d.org_unit_id=$1 AND d.metric=ANY($2::text[]) AND NOT $3::boolean
      ORDER BY d.created_at DESC LIMIT 200`,[orgUnitId,grant.metrics,peerOnly&&!ownBranch])).rows;

    const deviations=await Promise.all(hist.map(async (r:any)=>{
      // Статус текущего значения считается по порогам, действующим на конец
      // периода отклонения, а не по порогам выбранного в фильтре периода.
      const th=await resolveThresholds(c,r.period_end);
      const t=thresholdFor(th,r.metric,orgUnitId);
      const planNow=(await c.query(`SELECT s.value::text value FROM report_fact_current p
        JOIN report_fact_snapshots s ON s.id=p.snapshot_id WHERE p.org_unit_id=$1 AND p.metric='plan'
          AND p.period_start=$2 AND p.period_end=$3`,[orgUnitId,r.period_start,r.period_end])).rows[0];
      const current=r.cur_snapshot_id?{snapshot_id:r.cur_snapshot_id,value:Number(r.cur_value),
        revision:r.cur_revision,rag:evaluateRag(t,Number(r.cur_value),planNow?Number(planNow.value):null).rag}:null;
      const outcome=verifyOutcome({rag_at_creation:r.rag,observed_value:Number(r.observed_value),
        direction:r.direction,current,snapshot_id:r.snapshot_id,status:r.status});
      return {id:r.id,work_item_id:r.work_item_id,metric:r.metric,
        metric_name:(METRIC_NAMES as Record<string,string>)[r.metric]??r.metric,
        period_start:r.period_start,period_end:r.period_end,rag_at_creation:r.rag,
        observed_value:Number(r.observed_value),basis:r.basis,basis_value:Number(r.basis_value),
        unit:r.cur_unit??null,reason:r.reason,created_at:r.created_at,
        task:{title:r.title,status:r.status,assignee_user_id:r.assignee_user_id,due_at:r.due_at},
        current_value:current?current.value:null,current_revision:current?current.revision:null,
        ...outcome};
    }));

    return {mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:from,period_end:on,
      requested_end:q.end,data_is_stale:!!period?.stale,
      branch:{org_unit_id:unit.id,code:unit.code,display_name:unit.display_name,lifecycle_state:unit.lifecycle_state},
      metrics,metrics_without_threshold:metrics.filter(m=>!m.threshold_id).map(m=>m.metric),
      deviations,metric_names:METRIC_NAMES,thresholds_configured:thresholds.length>0,
      derived,latest,
      stock_snapshot:stockSnapshot?{...stockSnapshot,source:stockSource}:null,
      buyback45:buyback,
      repricing:{window_days:REPRICING_WINDOW_DAYS,snapshots,
        vehicles:repricing?.vehicles??null,events:repricing?.events??null},
      score:{configured:model!==null,value:score.score,rag:score.rag,
        components:score.components,reasons:score.reasons,model_id:model?.id??null},
      read_only:!!peer,own_branch:ownBranch,
      aggregation:'NONE',freshness:'NOT_EVALUATED'};
  });
}

/** Список переоценок вверх филиала: автомобиль, ссылка в CRM, сумма, дата. */
export async function branchRepricing(auth:AuthedUser,orgUnitId:string,query:any) {
  const q=query??{};
  if(Object.keys(q).some(k=>k!=='on'))throw invalid('Фильтры не принимаются.');
  if(typeof orgUnitId!=='string'||!uuid.test(orgUnitId))throw invalid('Филиал указан неверно.');
  if(!validDate(q.on))throw invalid('Укажите дату.');
  return withTransaction(async c=>{
    // Та же область, что у реестра VIN: филиалы допуска и свой филиал РФ.
    const grants=await factAccess(c,auth,'READ');
    const peer=await peerAccess(c,auth);
    const allowed=new Set([...grants.map(g=>g.org_unit_id),...(peer?.own_org_unit_ids??[])]);
    if(!allowed.has(orgUnitId))throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const days=await repricingWindow(c);
    const items=await upwardRepricingEvents(c,orgUnitId,q.on,days);
    return {window_days:days,on:q.on,items};
  });
}
