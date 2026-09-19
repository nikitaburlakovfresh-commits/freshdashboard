import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { factAccess } from '../reporting/factAccess';
import { METRIC_NAMES } from '../reporting/shared/reportModel';
import { uuid } from '../reporting/storage';
import { ApiError } from '../util/errors';
import { evaluateRag, resolveThresholds, thresholdFor, type Rag } from './thresholds';
import { settingNumber } from '../settings/portalSettings';

const invalid=(s:string)=>new ApiError('VALIDATION_ERROR',s);
const validDate=(v:unknown):v is string=>{
  if(typeof v!=='string'||!/^\d{4}-\d\d-\d\d$/.test(v))return false;
  const t=Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t)&&new Date(t).toISOString().slice(0,10)===v;
};
const OPEN=['DRAFT','ASSIGNED','IN_PROGRESS','SUBMITTED'];

type Cell={metric:string;rag:Rag;threshold_id:string|null;snapshot_id:string};
type BranchAgg={
  org_unit_id:string; display_name:string; division_id:string|null; division_name:string|null;
  regional_manager_user_id:string|null; regional_manager_name:string|null;
  metrics_accessible:number; metrics_published:string[]; metrics_missing:string[];
  metrics_without_threshold:string[]; red:string[]; amber:string[]; rag:Rag;
  deviations_with_task:number; deviations_without_task:number;
  tasks_open:number; tasks_overdue:number; tasks_due_soon:number;
};

const worstOf=(cells:Cell[]):Rag=>cells.some(c=>c.rag==='RED')?'RED'
  :cells.some(c=>c.rag==='AMBER')?'AMBER'
    :cells.some(c=>c.rag==='GREEN')?'GREEN':'NONE';

/**
 * Сводка отклонений по дивизиону ТЗ v2.12. Показывает руководителю верхнего
 * уровня, где именно в его области находятся красные и жёлтые показатели, по
 * каким отклонениям задача ещё не поставлена и какие задачи вышли за срок.
 *
 * Принципиальные ограничения:
 * — в сводку попадают только филиалы и показатели, к которым у пользователя есть
 *   допуск; агрегат не обходит разграничение доступа;
 * — отсутствие опубликованного значения показывается отдельным признаком и
 *   никогда не считается нулём и не считается выполнением;
 * — филиал относится к дивизиону по привязке, действующей на дату конца периода,
 *   поэтому смена подчинённости не искажает историческую сводку;
 * — региональный менеджер определяется действующим назначением на филиал;
 *   незакрытая вакансия показывается явно, а не переносится на дивизион; при
 *   нескольких действующих назначениях берётся самое раннее по дате вступления
 *   в силу, чтобы сводка не зависела от порядка выдачи прав.
 */
export async function divisionDeviationSummary(auth:AuthedUser,query:any) {
  const q=query??{};
  if(Object.keys(q).some(k=>!['start','end','division'].includes(k)))
    throw invalid('Фильтры сводки не принимаются.');
  if(!validDate(q.start)||!validDate(q.end)||q.start>q.end)
    throw invalid('Укажите точный период опубликованного среза.');
  if(q.division!==undefined&&(typeof q.division!=='string'||!uuid.test(q.division)))
    throw invalid('Дивизион указан неверно.');

  return withTransaction(async c=>{
    const grants=await factAccess(c,auth,'READ');
    if(!grants.length)
      throw new ApiError('FORBIDDEN','Нет отдельного доступа к опубликованным бизнес-показателям.');
    const accessible=new Map<string,string[]>();
    for(const g of grants)if(g.org_unit_id)
      accessible.set(g.org_unit_id,[...new Set([...(accessible.get(g.org_unit_id)??[]),...g.metrics])]);
    const orgIds=[...accessible.keys()];
    const dueSoonHours=await settingNumber(c,'deviation_task_due_soon_hours');

    // Филиал, его название и дивизион на дату конца периода: подчинённость берётся
    // из истории привязок, а не из текущего состояния структуры.
    const units=(await c.query(`WITH RECURSIVE aff AS (
        SELECT u.id, n.display_name, a.parent_id
        FROM org_directory_units u
        JOIN org_directory_name_history n ON n.org_unit_id=u.id
          AND $2::date >= n.effective_from AND (n.effective_to IS NULL OR $2::date < n.effective_to)
        LEFT JOIN org_directory_affiliation_history a ON a.org_unit_id=u.id
          AND $2::date >= a.effective_from AND (a.effective_to IS NULL OR $2::date < a.effective_to)
        WHERE u.id = ANY($1::uuid[])
      ), chain AS (
        SELECT f.id AS leaf, f.parent_id AS node, 1 AS depth FROM aff f
        UNION ALL
        SELECT ch.leaf, a.parent_id, ch.depth+1
        FROM chain ch
        JOIN org_directory_affiliation_history a ON a.org_unit_id=ch.node
          AND $2::date >= a.effective_from AND (a.effective_to IS NULL OR $2::date < a.effective_to)
        WHERE ch.node IS NOT NULL AND ch.depth < 10
      )
      SELECT f.id org_unit_id, f.display_name,
        d.id division_id, dn.display_name division_name
      FROM aff f
      LEFT JOIN chain ch ON ch.leaf=f.id
      LEFT JOIN org_directory_units d ON d.id=ch.node AND d.kind='DIVISION'
      LEFT JOIN org_directory_name_history dn ON dn.org_unit_id=d.id
        AND $2::date >= dn.effective_from AND (dn.effective_to IS NULL OR $2::date < dn.effective_to)
      WHERE d.id IS NOT NULL OR ch.node IS NULL OR ch.depth=1`,
    [orgIds,q.end])).rows as {org_unit_id:string;display_name:string;
      division_id:string|null;division_name:string|null}[];

    const branches=new Map<string,BranchAgg>();
    for(const u of units) {
      const prev=branches.get(u.org_unit_id);
      if(prev&&prev.division_id)continue;
      branches.set(u.org_unit_id,{org_unit_id:u.org_unit_id,display_name:u.display_name,
        division_id:u.division_id,division_name:u.division_name,
        regional_manager_user_id:null,regional_manager_name:null,
        metrics_accessible:(accessible.get(u.org_unit_id)??[]).length,
        metrics_published:[],metrics_missing:[],metrics_without_threshold:[],
        red:[],amber:[],rag:'NONE',deviations_with_task:0,deviations_without_task:0,
        tasks_open:0,tasks_overdue:0,tasks_due_soon:0});
    }
    const filtered=[...branches.values()]
      .filter(b=>!q.division||b.division_id===q.division);
    if(q.division&&!filtered.length)throw new ApiError('NOT_FOUND','Дивизион недоступен.');
    const scope=new Set(filtered.map(b=>b.org_unit_id));

    // Действующий региональный менеджер филиала. Вакансия остаётся вакансией.
    const rms=(await c.query(`SELECT g.org_unit_id,u.id user_id,u.full_name
      FROM role_grants g JOIN app_users u ON u.id=g.user_id
      WHERE g.role_code='REGIONAL_MANAGER' AND g.scope_kind='ORG_UNIT'
        AND g.org_unit_id = ANY($1::uuid[]) AND g.revoked_at IS NULL
        AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
        AND u.is_active
      ORDER BY g.org_unit_id,g.valid_from`,[[...scope]])).rows;
    for(const r of rms) {
      const b=branches.get(r.org_unit_id);
      if(b&&!b.regional_manager_user_id) {
        b.regional_manager_user_id=r.user_id; b.regional_manager_name=r.full_name;
      }
    }

    const pairs=filtered.flatMap(b=>(accessible.get(b.org_unit_id)??[])
      .map(metric=>({org:b.org_unit_id,metric})));
    const facts=pairs.length?(await c.query(`SELECT s.id snapshot_id,s.org_unit_id,s.metric,
        s.value::text value,d.id deviation_task_id,w.status task_status,w.due_at
      FROM report_fact_snapshots s
      JOIN report_fact_current p ON p.snapshot_id=s.id
      LEFT JOIN metric_deviation_tasks d ON d.snapshot_id=s.id
      LEFT JOIN work_items w ON w.id=d.work_item_id
      WHERE s.period_start=$1 AND s.period_end=$2
        AND EXISTS(SELECT 1 FROM jsonb_to_recordset($3::jsonb) a(org uuid,metric text)
          WHERE a.org=s.org_unit_id AND a.metric=s.metric)`,
    [q.start,q.end,JSON.stringify(pairs)])).rows:[];

    const thresholds=await resolveThresholds(c,q.end);
    const planFor=new Map<string,number>();
    for(const r of facts)if(r.metric==='plan')planFor.set(r.org_unit_id,Number(r.value));
    const now=Date.now(),soon=dueSoonHours*3600*1000;
    const cells=new Map<string,Cell[]>();

    for(const r of facts) {
      const b=branches.get(r.org_unit_id); if(!b)continue;
      const t=thresholdFor(thresholds,r.metric,r.org_unit_id);
      const {rag}=evaluateRag(t,Number(r.value),planFor.get(r.org_unit_id)??null);
      b.metrics_published.push(r.metric);
      if(!t)b.metrics_without_threshold.push(r.metric);
      cells.set(r.org_unit_id,[...(cells.get(r.org_unit_id)??[]),
        {metric:r.metric,rag,threshold_id:t?.id??null,snapshot_id:r.snapshot_id}]);
      if(rag==='RED')b.red.push(r.metric);
      if(rag==='AMBER')b.amber.push(r.metric);
      if(rag==='RED'||rag==='AMBER') {
        if(r.deviation_task_id)b.deviations_with_task+=1; else b.deviations_without_task+=1;
      }
      if(r.deviation_task_id&&OPEN.includes(r.task_status)) {
        b.tasks_open+=1;
        const due=Date.parse(r.due_at);
        if(Number.isFinite(due)) {
          if(due<now)b.tasks_overdue+=1; else if(due-now<=soon)b.tasks_due_soon+=1;
        }
      }
    }
    for(const b of filtered) {
      b.rag=worstOf(cells.get(b.org_unit_id)??[]);
      b.metrics_missing=(accessible.get(b.org_unit_id)??[])
        .filter(m=>!b.metrics_published.includes(m));
    }

    const divisions=new Map<string,any>();
    for(const b of filtered) {
      const key=b.division_id??'UNASSIGNED';
      const d=divisions.get(key)??{division_id:b.division_id,
        division_name:b.division_name??'Без привязки к дивизиону',
        branches_total:0,branches_with_data:0,branches_without_data:0,
        red:0,amber:0,green:0,unknown:0,
        deviations_total:0,deviations_without_task:0,
        tasks_open:0,tasks_overdue:0,tasks_due_soon:0,
        metrics_without_threshold:[] as string[],
        by_metric:{} as Record<string,{red:number;amber:number;without_task:number}>,
        managers:[] as any[],branches:[] as BranchAgg[]};
      d.branches_total+=1;
      if(b.metrics_published.length)d.branches_with_data+=1; else d.branches_without_data+=1;
      if(b.rag==='RED')d.red+=1; else if(b.rag==='AMBER')d.amber+=1;
      else if(b.rag==='GREEN')d.green+=1; else d.unknown+=1;
      d.deviations_total+=b.red.length+b.amber.length;
      d.deviations_without_task+=b.deviations_without_task;
      d.tasks_open+=b.tasks_open; d.tasks_overdue+=b.tasks_overdue; d.tasks_due_soon+=b.tasks_due_soon;
      d.metrics_without_threshold=[...new Set([...d.metrics_without_threshold,...b.metrics_without_threshold])];
      for(const m of b.red) {
        const e=d.by_metric[m]??{red:0,amber:0,without_task:0}; e.red+=1; d.by_metric[m]=e;
      }
      for(const m of b.amber) {
        const e=d.by_metric[m]??{red:0,amber:0,without_task:0}; e.amber+=1; d.by_metric[m]=e;
      }
      d.branches.push(b);
      divisions.set(key,d);
    }
    // Разрез по региональным менеджерам внутри дивизиона: фокус руководителя
    // адресуется человеку, а не абстрактной территории.
    for(const d of divisions.values()) {
      const byRm=new Map<string,any>();
      for(const b of d.branches as BranchAgg[]) {
        const key=b.regional_manager_user_id??'VACANT';
        const m=byRm.get(key)??{user_id:b.regional_manager_user_id,
          full_name:b.regional_manager_name,is_vacant:!b.regional_manager_user_id,
          branches_total:0,red:0,amber:0,deviations_without_task:0,
          tasks_open:0,tasks_overdue:0,branch_ids:[] as string[]};
        m.branches_total+=1;
        if(b.rag==='RED')m.red+=1; else if(b.rag==='AMBER')m.amber+=1;
        m.deviations_without_task+=b.deviations_without_task;
        m.tasks_open+=b.tasks_open; m.tasks_overdue+=b.tasks_overdue;
        m.branch_ids.push(b.org_unit_id);
        byRm.set(key,m);
      }
      d.managers=[...byRm.values()].sort((a,b)=>b.red-a.red||b.amber-a.amber
        ||(a.full_name??'я').localeCompare(b.full_name??'я','ru'));
      const order:Record<Rag,number>={RED:0,AMBER:1,NONE:2,GREEN:3};
      (d.branches as BranchAgg[]).sort((a,b)=>order[a.rag]-order[b.rag]
        ||b.deviations_without_task-a.deviations_without_task
        ||a.display_name.localeCompare(b.display_name,'ru'));
    }

    const list=[...divisions.values()].sort((a,b)=>b.red-a.red||b.amber-a.amber
      ||a.division_name.localeCompare(b.division_name,'ru'));
    return {
      mode:'PUBLISHED_SOURCE_AGGREGATES',period_start:q.start,period_end:q.end,
      metric_names:METRIC_NAMES,due_soon_hours:dueSoonHours,
      thresholds_configured:thresholds.length>0,
      totals:{
        divisions:list.length,
        branches:filtered.length,
        branches_without_data:list.reduce((s,d)=>s+d.branches_without_data,0),
        red:list.reduce((s,d)=>s+d.red,0),
        amber:list.reduce((s,d)=>s+d.amber,0),
        deviations_without_task:list.reduce((s,d)=>s+d.deviations_without_task,0),
        tasks_open:list.reduce((s,d)=>s+d.tasks_open,0),
        tasks_overdue:list.reduce((s,d)=>s+d.tasks_overdue,0),
        tasks_due_soon:list.reduce((s,d)=>s+d.tasks_due_soon,0),
      },
      divisions:list,
    };
  });
}
