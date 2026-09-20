import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { factAccess } from '../reporting/factAccess';
import { METRIC_NAMES } from '../reporting/shared/reportModel';
import { ApiError } from '../util/errors';
import { uuid } from '../reporting/storage';
import { evaluateRag, resolveThresholds, thresholdFor, type Rag } from './thresholds';
import { computeBranchScore, monthProgress, resolveScoringModel } from './scoring';
import { resolveFocusConfiguration } from './focus';

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
  const revenue=get('revenue'),salesFact=get('sales');
  return [
    {code:'sales_runrate',label:'Run-rate продажи',hint:'факт / план шт',format:'PCT',
      value:sales.value,fact:salesFact,plan:get('plan'),basis:sales.basis},
    {code:'stock_turnover',label:'Оборачиваемость склада',hint:'в темпе продаж',format:'RATIO',
      value:null,fact:salesFact,plan:null,basis:'STOCK_START_NOT_PUBLISHED'},
    {code:'margin_runrate',label:'Run-rate маржа',hint:'к плану маржи',format:'PCT',
      value:margin.value,fact:get('margin'),plan:get('planMargin'),basis:margin.basis},
    {code:'supplies_runrate',label:'Run-rate поставки',hint:'к плану поставок',format:'PCT',
      value:null,fact:null,plan:null,basis:'SUPPLIES_NOT_PUBLISHED'},
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
    if(!allowed.length)return {mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:q.start,period_end:q.end,
      metric_names:METRIC_NAMES,branches:[],thresholds_configured:false,
      scoring:{configured:false,model_id:null,month_progress:null},
      network:{branches_with_score:0,average_score:null,green:0,amber:0,red:0,without_score:0},
      run_rates:runRateTiles(new Map(),q.end),
      focus:{month:`${q.end.slice(0,7)}-01`,configured:false,slots:[]}};
    const rows=(await c.query(`SELECT s.id snapshot_id,s.org_unit_id,s.metric,s.value::text value,s.unit,
      s.revision,s.created_at,n.display_name,d.id deviation_task_id,d.work_item_id,w.status task_status,
      w.title task_title,w.assignee_user_id task_assignee_id
      FROM report_fact_snapshots s
      JOIN report_fact_current p ON p.snapshot_id=s.id
      LEFT JOIN metric_deviation_tasks d ON d.snapshot_id=s.id
      LEFT JOIN work_items w ON w.id=d.work_item_id
      JOIN org_directory_name_history n ON n.org_unit_id=s.org_unit_id AND n.effective_to IS NULL
        AND n.effective_from<=(now() AT TIME ZONE 'Europe/Moscow')::date
      WHERE s.period_start=$1 AND s.period_end=$2
        AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) a(org uuid,metric text)
          WHERE a.org=s.org_unit_id AND a.metric=s.metric)
      ORDER BY n.display_name,s.metric LIMIT 2001`,[q.start,q.end,JSON.stringify(allowed)])).rows;
    if(rows.length>2000)throw invalid('Слишком много строк: выберите один филиал.');
    const thresholds=await resolveThresholds(c,q.end);
    type MetricCell={metric:string;metric_name:string;value:number;unit:string;rag:Rag;basis:string|null;
      basis_value:number|null;threshold_id:string|null;revision:number;published_at:string;snapshot_id:string;
      deviation_task:{id:string;work_item_id:string;status:string;title:string;assignee_user_id:string|null}|null};
    const byOrg=new Map<string,{org_unit_id:string;display_name:string;metrics:MetricCell[]}>();
    const planFor=new Map<string,number>();
    for(const r of rows)if(r.metric==='plan')planFor.set(r.org_unit_id,Number(r.value));
    for(const r of rows) {
      const entry=byOrg.get(r.org_unit_id)??{org_unit_id:r.org_unit_id,display_name:r.display_name,metrics:[] as MetricCell[]};
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
    const model=await resolveScoringModel(c,q.end);
    const focus=await resolveFocusConfiguration(c,q.end);
    const branches=[...byOrg.values()].map(b=>{
      const worst:Rag=b.metrics.some(m=>m.rag==='RED')?'RED'
        :b.metrics.some(m=>m.rag==='AMBER')?'AMBER'
          :b.metrics.some(m=>m.rag==='GREEN')?'GREEN':'NONE';
      const values=new Map<string,number>(b.metrics.map(m=>[m.metric,m.value]));
      const score=computeBranchScore(model,values,q.end);
      return {...b,rag:worst,metrics_without_threshold:b.metrics.filter(m=>!m.threshold_id).map(m=>m.metric),
        score:score.score,score_rag:score.rag,score_components:score.components,score_reasons:score.reasons};
    });
    // Сетевые суммы для плиток run-rate: только по показателям, доступным
    // пользователю; отсутствующий показатель остаётся отсутствующим.
    const totals=new Map<string,number>();
    for(const b of branches)for(const m of b.metrics)
      totals.set(m.metric,(totals.get(m.metric)??0)+m.value);
    const scored=branches.filter(b=>b.score!==null);
    const count=(rag:Rag)=>scored.filter(b=>b.score_rag===rag).length;
    return {mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:q.start,period_end:q.end,
      metric_names:METRIC_NAMES,branches,thresholds_configured:thresholds.length>0,
      scoring:{configured:!!model,model_id:model?.id??null,
        month_progress:model?monthProgress(q.end):null},
      // Средний балл сети считается только по филиалам с определённым баллом.
      network:{branches_with_score:scored.length,
        average_score:scored.length?scored.reduce((s,b)=>s+(b.score as number),0)/scored.length:null,
        green:count('GREEN'),amber:count('AMBER'),red:count('RED'),
        without_score:branches.length-scored.length},
      run_rates:runRateTiles(totals,q.end),
      focus:{month:`${q.end.slice(0,7)}-01`,configured:!!focus,
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
    const rows=(await c.query(`SELECT period_start,period_end,count(DISTINCT org_unit_id)::int branches
      FROM report_fact_current WHERE org_unit_id=ANY($1::uuid[])
      GROUP BY period_start,period_end ORDER BY period_end DESC,period_start DESC LIMIT 60`,[orgs])).rows;
    return {periods:rows.map((r:any)=>({period_start:String(r.period_start).slice(0,10),
      period_end:String(r.period_end).slice(0,10),branches:r.branches}))};
  });
}
