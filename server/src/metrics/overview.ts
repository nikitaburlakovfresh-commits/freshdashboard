import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { factAccess } from '../reporting/factAccess';
import { METRIC_NAMES } from '../reporting/shared/reportModel';
import { ApiError } from '../util/errors';
import { uuid } from '../reporting/storage';
import { evaluateRag, resolveThresholds, thresholdFor, type Rag } from './thresholds';
import { computeBranchScore, monthProgress, resolveScoringModel } from './scoring';
import { funnelConversions, buyback45Shares, stockTurnover } from './derived';
import { resolveRmRatingModel, computeRmRating } from './rmRating';
import { resolveEffectivePeriod } from './effectivePeriod';
import { resolveFocusConfiguration } from './focus';
import { branchAffiliations } from './orgHierarchy';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const validDate=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v))return false;
  const t=Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;
};


/**
 * Сетевые плитки run-rate по канону старого портала: a = дней в месяце /
 * прошедших дней. Считаются только по опубликованным показателям в области
 * доступа пользователя. Отсутствие источника даёт null с явным основанием —
 * ноль и выполнение плана не подставляются.
 */
export type RunRateCode='sales_runrate'|'stock_turnover'|'margin_runrate'|'supplies_runrate'|'avg_sale_price';
export interface RunRateTile {
  code:RunRateCode; label:string; hint:string; value:number|null;
  format:'PCT'|'COUNT'|'RUB'|'RATIO'; fact:number|null; plan:number|null; basis:string|null;
}
function runRateTiles(totals:Map<string,number>,on:string):RunRateTile[] {
  const [y,m,d]=on.split('-').map(Number);
  const days=new Date(Date.UTC(y,m,0)).getUTCDate();
  const a=d>0?days/d:null;
  const get=(metric:string)=>totals.has(metric)?totals.get(metric)!:null;
  const runRate=(factMetric:string,planMetric:string):{value:number|null;basis:string|null} => {
    const fact=get(factMetric),plan=get(planMetric);
    if(fact===null)return {value:null,basis:`FACT_NOT_PUBLISHED:${factMetric}`};
    if(plan===null)return {value:null,basis:`PLAN_NOT_PUBLISHED:${planMetric}`};
    if(!(plan>0)||a===null)return {value:null,basis:'PLAN_NOT_POSITIVE'};
    return {value:fact*a/plan*100,basis:null};
  };
  const sales=runRate('sales','plan'),margin=runRate('margin','planMargin');
  const supplies=runRate('suppliesFact','suppliesPlan');
  const revenue=get('revenue'),salesFact=get('sales');
  // Оборачиваемость склада по сети считается от сложенных величин, а не как
  // среднее оборачиваемостей филиалов: среднее из отношений не равно отношению
  // сумм и завышает вклад маленьких складов.
  const forecastTotal=get('forecast'),stockStartTotal=get('stockStart');
  const turnover=forecastTotal!==null&&stockStartTotal!==null&&stockStartTotal>0
    ?forecastTotal/stockStartTotal:null;
  const turnoverBasis=forecastTotal===null?'FACT_NOT_PUBLISHED:forecast'
    :stockStartTotal===null?'FACT_NOT_PUBLISHED:stockStart'
      :stockStartTotal>0?null:'STOCK_START_NOT_POSITIVE';
  return [
    {code:'sales_runrate',label:'Run-rate продажи',hint:'факт / план шт',format:'PCT',
      value:sales.value,fact:salesFact,plan:get('plan'),basis:sales.basis},
    {code:'stock_turnover',label:'Оборачиваемость склада',hint:'прогноз продаж / склад на 1 число',format:'RATIO',
      value:turnover,fact:get('forecast'),plan:get('stockStart'),basis:turnoverBasis},
    {code:'margin_runrate',label:'Run-rate маржа',hint:'к плану маржи',format:'PCT',
      value:margin.value,fact:get('margin'),plan:get('planMargin'),basis:margin.basis},
    {code:'supplies_runrate',label:'Run-rate поставки',hint:'к плану поставок',format:'PCT',
      value:supplies.value,fact:get('suppliesFact'),plan:get('suppliesPlan'),basis:supplies.basis},
    {code:'avg_sale_price',label:'Средняя цена продажи',hint:'выручка на 1 авто',format:'RUB',
      value:revenue!==null&&salesFact!==null&&salesFact>0?revenue/salesFact:null,
      fact:revenue,plan:null,
      basis:revenue===null?'FACT_NOT_PUBLISHED:revenue'
        :salesFact===null?'FACT_NOT_PUBLISHED:sales':salesFact>0?null:'SALES_NOT_POSITIVE'},
  ];
}

/**
 * Сетка филиалов ТЗ v2.12: только опубликованные показатели в пределах допусков
 * пользователя. Статус светофора берётся из настроенных порогов; при отсутствии
 * данных или порога статус NONE — это не ноль и не выполнение.
 */
export async function branchOverview(auth:AuthedUser,query:any) {
  const q=query??{};
  if(Object.keys(q).some(k=>!['start','end','org'].includes(k)))throw invalid('Фильтры сетки не принимаются.');
  if(!validDate(q.start)||!validDate(q.end)||q.start>q.end)throw invalid('Укажите точный период опубликованного среза.');
  if(q.org!==undefined&&(typeof q.org!=='string'||!uuid.test(q.org)))throw invalid('Филиал указан неверно.');
  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    if(!grants.length)throw new ApiError('FORBIDDEN','Нет отдельного доступа к опубликованным бизнес-показателям.');
    if(q.org&&!grants.some(g=>g.org_unit_id===q.org))throw new ApiError('NOT_FOUND','Филиал недоступен.');
    const allowed=grants.filter(g=>!q.org||g.org_unit_id===q.org)
      .flatMap(g=>g.metrics.map(metric=>({org:g.org_unit_id,metric})));
    // Срез разрешается по последнему опубликованному периоду не позже выбранной
    // даты. Иначе выбор сегодняшнего числа обнуляет экран, пока отчёты за него
    // не загружены, хотя вчерашние опубликованы.
    const period=await resolveEffectivePeriod(c,q.start,q.end,
      [...new Set(grants.filter(g=>!q.org||g.org_unit_id===q.org)
        .map(g=>g.org_unit_id).filter((id):id is string=>!!id))]);
    const on=period?.end??q.end;
    const from=period?.start??q.start;
    if(!allowed.length)return {mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:q.start,period_end:q.end,
      requested_end:q.end,data_is_stale:false,
      metric_names:METRIC_NAMES,branches:[],thresholds_configured:false,
      manager_rating:{configured:false,model_id:null,green_from:null,amber_from:null,note:null,managers:[]},
      scoring:{configured:false,model_id:null,month_progress:null,
        green_score_from:null,amber_score_from:null},
      network:{branches_with_score:0,average_score:null,green:0,amber:0,red:0,without_score:0},
      run_rates:runRateTiles(new Map(),q.end),
      focus:{month:`${on.slice(0,7)}-01`,configured:false,slots:[]}};
    const rows=(await c.query(`SELECT s.id snapshot_id,s.org_unit_id,s.metric,s.value::text value,s.unit,
      s.revision,s.created_at,n.display_name,d.id deviation_task_id,d.work_item_id,w.status task_status,
      w.title task_title,w.assignee_user_id task_assignee_id,
      (SELECT du.lifecycle_state FROM org_directory_units du WHERE du.id=s.org_unit_id) lifecycle_state
      FROM report_fact_snapshots s
      JOIN report_fact_current p ON p.snapshot_id=s.id
      LEFT JOIN metric_deviation_tasks d ON d.snapshot_id=s.id
      LEFT JOIN work_items w ON w.id=d.work_item_id
      JOIN org_directory_name_history n ON n.org_unit_id=s.org_unit_id AND n.effective_to IS NULL
        AND n.effective_from<=(now() AT TIME ZONE 'Europe/Moscow')::date
      WHERE s.period_start=$1 AND s.period_end=$2
        AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) a(org uuid,metric text)
          WHERE a.org=s.org_unit_id AND a.metric=s.metric)
        -- Закрытые филиалы на рабочих экранах не показываются. Их опубликованные
        -- значения остаются в базе и в исторической отчётности: филиал был
        -- в отчётах за свои периоды, и скрывать его задним числом из истории нельзя.
        AND NOT EXISTS(SELECT 1 FROM org_directory_units d
          WHERE d.id=s.org_unit_id AND d.lifecycle_state='CLOSED')
      ORDER BY n.display_name,s.metric LIMIT 2001`,[from,on,JSON.stringify(allowed)])).rows;
    if(rows.length>2000)throw invalid('Слишком много строк: выберите один филиал.');
    const thresholds=await resolveThresholds(c,on);
    type MetricCell={metric:string;metric_name:string;value:number;unit:string;rag:Rag;basis:string|null;
      basis_value:number|null;threshold_id:string|null;revision:number;published_at:string;snapshot_id:string;
      deviation_task:{id:string;work_item_id:string;status:string;title:string;assignee_user_id:string|null}|null};
    const byOrg=new Map<string,{org_unit_id:string;display_name:string;lifecycle_state:string;metrics:MetricCell[]}>();
    const planFor=new Map<string,number>();
    for(const r of rows)if(r.metric==='plan')planFor.set(r.org_unit_id,Number(r.value));
    for(const r of rows) {
      const entry=byOrg.get(r.org_unit_id)??{org_unit_id:r.org_unit_id,display_name:r.display_name,
        lifecycle_state:r.lifecycle_state,metrics:[] as MetricCell[]};
      const t=thresholdFor(thresholds,r.metric,r.org_unit_id);
      const {rag,basis_value}=evaluateRag(t,Number(r.value),planFor.get(r.org_unit_id)??null);
      entry.metrics.push({metric:r.metric,metric_name:(METRIC_NAMES as Record<string,string>)[r.metric]??r.metric,
        value:Number(r.value),unit:r.unit,rag,basis:t?.basis??null,basis_value,
        threshold_id:t?.id??null,revision:r.revision,published_at:r.created_at,snapshot_id:r.snapshot_id,
        deviation_task:r.deviation_task_id?{id:r.deviation_task_id,work_item_id:r.work_item_id,
          status:r.task_status,title:r.task_title,assignee_user_id:r.task_assignee_id}:null});
      byOrg.set(r.org_unit_id,entry);
    }
    // Модель балла и фокусы месяца берутся из настроек портала на дату среза.
    const model=await resolveScoringModel(c,on);
    const focus=await resolveFocusConfiguration(c,on);
    const affiliations=await branchAffiliations(c,[...byOrg.keys()],on);
    // Производные показатели: у них нет ячейки источника, поэтому они не
    // публикуются как факты, а считаются из опубликованного и из реестра VIN.
    const buyback45=await buyback45Shares(c,[...byOrg.keys()],on);
    const branches=[...byOrg.values()].map(b=>{
      const worst:Rag=b.metrics.some(m=>m.rag==='RED')?'RED'
        :b.metrics.some(m=>m.rag==='AMBER')?'AMBER'
          :b.metrics.some(m=>m.rag==='GREEN')?'GREEN':'NONE';
      const values=new Map<string,number>(b.metrics.map(m=>[m.metric,m.value]));
      for(const [k,v] of funnelConversions(values))values.set(k,v);
      const turnover=stockTurnover(values);
      if(turnover!==null)values.set('stockTurnover',turnover);
      const bb=buyback45.get(b.org_unit_id);
      if(bb)values.set('buyback45Share',bb.share);
      const score=computeBranchScore(model,values,on);
      const aff=affiliations.get(b.org_unit_id);
      return {...b,rag:worst,
        cluster_id:aff?.cluster_id??null,cluster_name:aff?.cluster_name??null,
        division_id:aff?.division_id??null,division_name:aff?.division_name??null,
        manager_user_id:aff?.manager_user_id??null,manager_name:aff?.manager_name??null,
        group_key:aff?.group_key??'none',group_label:aff?.group_label??'Филиал без зоны РМ',metrics_without_threshold:b.metrics.filter(m=>!m.threshold_id).map(m=>m.metric),
        score:score.score,score_rag:score.rag,score_components:score.components,score_reasons:score.reasons,
        buyback45:bb?{share:bb.share,aged:bb.aged,total:bb.total,observed_on:bb.observed_on}:null};
    });
    // Сетевые суммы для плиток run-rate: только по показателям, доступным
    // пользователю; отсутствующий показатель остаётся отсутствующим.
    const totals=new Map<string,number>();
    for(const b of branches)for(const m of b.metrics)
      totals.set(m.metric,(totals.get(m.metric)??0)+m.value);
    // Рейтинг регионального менеджера считается по зоне целиком: величины его
    // филиалов складываются, и выполнение считается от сложенного. Средним
    // баллом филиалов его заменять нельзя — это другая величина.
    const rmModel=await resolveRmRatingModel(c,on);
    const zoneSums=new Map<string,Map<string,number>>();
    // Решение владельца: филиал не в состоянии «действующий» в рейтинг не идёт.
    // Закрытый, ещё не открытый и запускающийся филиал не отвечает за план,
    // и его недовыполнение нельзя вешать на регионала.
    for(const b of branches.filter(b=>b.lifecycle_state==='ACTIVE')) {
      const key=b.group_key??'none';
      const bucket=zoneSums.get(key)??new Map<string,number>();
      for(const m of b.metrics)bucket.set(m.metric,(bucket.get(m.metric)??0)+m.value);
      zoneSums.set(key,bucket);
    }
    const managerRatings=rmModel?[...zoneSums.entries()].map(([key,sums])=>{
      const zone=branches.filter(b=>(b.group_key??'none')===key&&b.lifecycle_state==='ACTIVE');
      return {group_key:key,group_label:zone[0]?.group_label??'Филиал без зоны РМ',
        division_name:zone[0]?.division_name??null,branches:zone.length,
        ...computeRmRating(rmModel,sums,on)};
    }).sort((x,y)=>(y.rating??-1)-(x.rating??-1)||x.group_label.localeCompare(y.group_label,'ru')):[];
    const scored=branches.filter(b=>b.score!==null);
    const count=(rag:Rag)=>scored.filter(b=>b.score_rag===rag).length;
    return {mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:from,period_end:on,
      // Выбранная дата и дата данных называются раздельно: показать данные за
      // 20-е под подписью «на 21-е» значит соврать о их свежести.
      requested_end:q.end,data_is_stale:!!period?.stale,
      metric_names:METRIC_NAMES,branches,thresholds_configured:thresholds.length>0,
      scoring:{configured:!!model,model_id:model?.id??null,
        month_progress:model?monthProgress(on):null,
        // Границы цвета публикуются вместе с баллом: список руководителей
        // окрашивается по тому же правилу, что и филиал, без второй копии
        // порогов в клиенте.
        green_score_from:model?.green_score_from??null,
        amber_score_from:model?.amber_score_from??null},
      // Средний балл сети считается только по филиалам с определённым баллом.
      network:{branches_with_score:scored.length,
        average_score:scored.length?scored.reduce((s,b)=>s+(b.score as number),0)/scored.length:null,
        green:count('GREEN'),amber:count('AMBER'),red:count('RED'),
        without_score:branches.length-scored.length},
      run_rates:runRateTiles(totals,on),
      manager_rating:{configured:!!rmModel,model_id:rmModel?.id??null,
        green_from:rmModel?.green_from??null,amber_from:rmModel?.amber_from??null,
        note:rmModel?.note??null,managers:managerRatings},
      focus:{month:`${on.slice(0,7)}-01`,configured:!!focus,
        configuration_id:focus?.id??null,
        // Факт фокуса не выводится из агрегатов до объявления соответствия
        // кода фокуса опубликованному показателю: подмена источника недопустима.
        slots:(focus?.slots??[]).map(s=>({...s,fact:null,
          fact_basis:'NOT_MAPPED_TO_PUBLISHED_METRIC' as const}))},
      aggregation:'NONE',freshness:'NOT_EVALUATED'};
  });
}

/**
 * Перечень опубликованных срезов в пределах допусков пользователя. Нужен, чтобы
 * выбор даты отчёта указывал на фактически опубликованный период, а не на
 * произвольный день: отсутствие среза не подменяется нулями.
 */
export async function publishedPeriods(auth:AuthedUser) {
  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    if(!grants.length)return {periods:[]};
    const orgs=grants.map(g=>g.org_unit_id).filter((v):v is string=>!!v);
    if(!orgs.length)return {periods:[]};
    // Даты форматирует база. Драйвер разбирает тип date в объект Date, и
    // String(…).slice(0,10) давал не «2026-09-30», а «Wed Sep 30». Такое
    // значение поле выбора даты отвергало, срез выглядел пустым, а
    // обзор сети показывал ноль филиалов при опубликованных данных.
    const rows=(await c.query(`SELECT to_char(period_start,'YYYY-MM-DD') period_start,
        to_char(period_end,'YYYY-MM-DD') period_end,count(DISTINCT org_unit_id)::int branches
      FROM report_fact_current WHERE org_unit_id=ANY($1::uuid[])
      GROUP BY period_start,period_end ORDER BY period_end DESC,period_start DESC LIMIT 60`,[orgs])).rows;
    return {periods:rows.map((r:any)=>({period_start:r.period_start,
      period_end:r.period_end,branches:r.branches}))};
  });
}
