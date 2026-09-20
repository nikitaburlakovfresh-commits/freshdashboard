import React,{useCallback,useEffect,useState} from 'react';
import { Link } from 'react-router-dom';
import { useReportDate } from '../state/reportDate';
import { readOverview,readDivisionSummary,COMPONENT_MISSING_LABELS,EVALUATION_LABELS,
  RULE_ROLE_LABELS,RAG_LABELS,type Overview,type BranchCard,
  type DivisionSummary,type RunRateTile } from '../api/metrics';
import RagBadge,{ RagDot } from '../components/RagBadge';
import '../styles/branch-grid.css';
import '../styles/network-score.css';

/**
 * «Обзор сети»: средний балл сети, светофор филиалов, run-rate ключевых
 * показателей и фокусы внимания месяца. Балл, статус и основания приходят
 * с сервера по модели, настроенной внутри портала. Клиент ничего не
 * досчитывает и не подставляет нули: отсутствие данных — отдельный статус.
 */
const num=(v:number|null,digits=1)=>v===null?'—':v.toLocaleString('ru-RU',
  {minimumFractionDigits:digits,maximumFractionDigits:digits});
const FOCUS_FORMATS:Record<string,string>={COUNT:'шт.',PCT:'%',RUB:'руб.',RUB_MLN:'млн руб.'};
/** Значение плитки run-rate. Null — «нет данных», а не ноль. */
function runRateValue(t:RunRateTile):string {
  if(t.value===null) return '—';
  if(t.format==='PCT') return `${Math.round(t.value*100)}%`;
  if(t.format==='RATIO') return `${t.value.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})}×`;
  if(t.format==='RUB') return t.value>=1000
    ? `${Math.round(t.value/1000).toLocaleString('ru-RU')} тыс ₽`
    : `${Math.round(t.value).toLocaleString('ru-RU')} ₽`;
  return Math.round(t.value).toLocaleString('ru-RU');
}
const RU_DATE=(iso:string)=>iso.split('-').reverse().join('.');

export default function NetworkScorePage() {
  // Период факта задаётся глобальным срезом из топбара: от начала месяца
  // выбранной даты до самой даты. Локального дубля выбора даты на экране нет.
  const {reportDate,periodStart}=useReportDate();
  const start=periodStart,end=reportDate;
  const [data,setData]=useState<Overview|null>(null);
  const [managers,setManagers]=useState<DivisionSummary|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState<string[]>([]);

  const load=useCallback(async(from:string,to:string)=>{
    setBusy(true);setError('');setData(null);setManagers(null);
    try{
      const r=await readOverview(from,to);
      setData(r);
      // Группировка по региональным менеджерам берётся из сводки дивизионов:
      // отдельного источника оргструктуры для обзора не заводим.
      try{setManagers(await readDivisionSummary(from,to));}catch{setManagers(null);}
    }catch(e:any){setError(e.message);}finally{setBusy(false);}
  },[]);
  useEffect(()=>{void load(start,end);},[load,start,end]);

  const net=data?.network;
  const tiles=[
    {label:'Средний балл сети',value:net?num(net.average_score):'—',hint:`По ${net?.branches_with_score??0} филиалам с определённым баллом`},
    {label:'Зелёные филиалы',value:String(net?.green??0),hint:'Все условия зелёного статуса выполнены',rag:'GREEN' as const},
    {label:'Жёлтые филиалы',value:String(net?.amber??0),hint:'Есть отклонения без красных правил',rag:'AMBER' as const},
    {label:'Красные филиалы',value:String(net?.red??0),hint:'Сработало правило красного статуса',rag:'RED' as const},
  ];
  const branchesByManager=groupByManager(data?.branches??[],managers);

  return <div className="portal-page network-score">
    <header className="overview-head">
      <div>
        <h1>Обзор сети</h1>
        <p className="overview-subline">Срез на {RU_DATE(end)} · {data?data.branches.length:'…'} филиалов
          {net&&net.without_score>0&&<> · без балла {net.without_score}</>}</p>
      </div>
      <div className="overview-head-actions">
        <Link className="btn" to="/division-summary">Сводка по задачам</Link>
        <Link className="btn" to="/settings/scoring">Модель балла</Link>
      </div>
    </header>

    {error&&<section className="portal-panel" role="alert">{error}</section>}
    {busy&&<p role="status">Загружаю серверный срез…</p>}

    {data&&<>
      {!data.scoring.configured&&<p role="status" className="branch-grid-warning">
        Модель балла не настроена в портале: балл и светофор по баллу не рассчитываются.{' '}
        <Link to="/settings/scoring">Настроить модель балла</Link>.</p>}

      <div className="score-tiles">{tiles.map(t=><article className="score-tile" key={t.label}
        data-rag={t.rag??'NEUTRAL'}>
        <span>{t.label}</span><strong className="tabnum">{t.value}</strong><small>{t.hint}</small>
      </article>)}</div>

      <div className="runrate-tiles">{data.run_rates.map(t=><article className="runrate-tile" key={t.code}>
        <span className="runrate-icon" data-code={t.code} aria-hidden="true"/>
        <div><strong className="tabnum">{runRateValue(t)}</strong>
          <span>{t.label}</span>
          <small>{t.value===null?(t.basis??'нет данных за срез'):t.hint}</small></div>
      </article>)}</div>

      <section className="portal-panel">
        <div className="portal-section-head"><div><h2>Фокусы внимания · {data.focus.month}</h2>
          <p className="portal-muted">Пять фокусов месяца настраиваются внутри портала. План задаётся
            вручную функциональным руководителем.</p></div>
          <Link className="btn" to="/settings/focus">Настроить фокусы</Link></div>
        {!data.focus.configured&&<p role="status">Фокусы на этот месяц не настроены.</p>}
        {data.focus.configured&&<div className="focus-grid">{data.focus.slots.map(s=>
          <article className="focus-card" key={s.slot}>
            <header><span className="focus-slot">Фокус {s.slot}</span>
              <span className="portal-chip">{s.direction==='HIGHER_IS_BETTER'?'Больше — лучше':'Меньше — лучше'}</span>
            </header>
            <h3>{s.label}</h3>
            <dl>
              <div><dt>План</dt><dd className="tabnum">{s.plan===null?'не задан':
                `${s.plan.toLocaleString('ru-RU')} ${FOCUS_FORMATS[s.format]??''}`}</dd></div>
              <div><dt>Факт</dt><dd className="tabnum">{s.fact===null?'не публикуется':
                s.fact.toLocaleString('ru-RU')}</dd></div>
            </dl>
            {s.fact===null&&<small className="portal-muted">
              {s.fact_basis==='NOT_MAPPED_TO_PUBLISHED_METRIC'
                ?'Соответствие кода фокуса опубликованному показателю не объявлено — факт не подставляется.'
                :s.fact_basis}</small>}
            {(s.requires_vin_level||s.requires_daily_logs)&&<small className="portal-muted">
              Требуется источник: {[s.requires_vin_level&&'VIN-уровень',
                s.requires_daily_logs&&'ежедневники'].filter(Boolean).join(', ')}.</small>}
          </article>)}</div>}
      </section>

      <section className="portal-panel">
        <div className="portal-section-head"><div><h2>Филиалы по региональным менеджерам</h2>
          <p className="portal-muted">Балл, статус и основания статуса. Раскройте филиал, чтобы увидеть
            вклад каждого показателя.</p></div>
          <span className="portal-chip">{data.branches.length} филиалов в области доступа</span></div>
        {!data.branches.length&&<p role="status">За этот период в вашей области доступа нет опубликованных
          показателей.</p>}
        {branchesByManager.map(group=><div className="score-group" key={group.key}>
          <h3>{group.title} <span className="portal-muted">· {group.branches.length}</span></h3>
          <div className="score-rows">{group.branches.map(b=><BranchRow key={b.org_unit_id} branch={b}
            period={{start:data.period_start,end:data.period_end}}
            open={open.includes(b.org_unit_id)}
            onToggle={()=>setOpen(list=>list.includes(b.org_unit_id)
              ?list.filter(id=>id!==b.org_unit_id):[...list,b.org_unit_id])}/>)}</div>
        </div>)}
      </section>
    </>}
  </div>;
}

interface Group {key:string;title:string;branches:BranchCard[]}
/** Группировка филиалов по РМ. Неизвестная привязка не выдумывается. */
function groupByManager(branches:BranchCard[],summary:DivisionSummary|null):Group[] {
  if(!summary) return branches.length?[{key:'all',title:'Все доступные филиалы',branches}]:[];
  const owner=new Map<string,{key:string;title:string}>();
  for(const d of summary.divisions) for(const m of d.managers) {
    const title=m.is_vacant||!m.full_name?`${d.division_name} · РМ не назначен`:m.full_name;
    for(const id of m.branch_ids) owner.set(id,{key:m.user_id??`vacant:${d.division_id??d.division_name}`,title});
  }
  const groups=new Map<string,Group>();
  for(const b of branches) {
    const o=owner.get(b.org_unit_id)??{key:'unknown',title:'Региональный менеджер не определён'};
    const g=groups.get(o.key)??{key:o.key,title:o.title,branches:[]};
    g.branches.push(b);groups.set(o.key,g);
  }
  return [...groups.values()].sort((a,b)=>a.title.localeCompare(b.title,'ru'));
}

function BranchRow({branch:b,period,open,onToggle}:{branch:BranchCard;
  period:{start:string;end:string};open:boolean;onToggle:()=>void}) {
  return <article className="score-row" data-rag={b.score_rag}>
    <div className="score-row-head">
      <button type="button" className="score-row-toggle" aria-expanded={open} onClick={onToggle}>
        <RagDot status={b.score_rag}/>{b.display_name}</button>
      <span className="score-row-value tabnum">{b.score===null?'балл не рассчитан':num(b.score)}</span>
      <RagBadge status={b.score_rag}/>
      <Link className="score-row-link"
        to={`/branch-card/${b.org_unit_id}?start=${period.start}&end=${period.end}`}>Карточка →</Link>
    </div>
    {open&&<div className="score-row-body">
      {b.score_reasons.length>0&&<ul className="score-reasons">
        {b.score_reasons.map(r=><li key={r}>{r}</li>)}</ul>}
      {b.score_components.length===0&&<p className="portal-muted">Модель балла не настроена: вклад
        показателей не рассчитывается.</p>}
      {b.score_components.length>0&&<table className="score-table">
        <thead><tr><th>Показатель</th><th>Расчёт</th><th className="tabnum">Вес</th>
          <th className="tabnum">Факт</th><th className="tabnum">План</th><th className="tabnum">Балл</th>
          <th>Роль в правилах</th></tr></thead>
        <tbody>{b.score_components.map(c=><tr key={c.metric}>
          <td>{c.metric_name}</td>
          <td>{EVALUATION_LABELS[c.evaluation]}</td>
          <td className="tabnum">{c.weight}</td>
          <td className="tabnum">{c.fact===null?'—':c.fact.toLocaleString('ru-RU')}</td>
          <td className="tabnum">{c.plan===null?'—':c.plan.toLocaleString('ru-RU')}</td>
          <td className="tabnum">{c.score===null
            ?<span className="portal-muted">{COMPONENT_MISSING_LABELS[c.missing??'']??'нет данных'}</span>
            :num(c.score)}</td>
          <td>{RULE_ROLE_LABELS[c.rule_role]}</td>
        </tr>)}</tbody>
      </table>}
      <p className="portal-muted">Статус по показателям с порогами: {RAG_LABELS[b.rag]}.
        Показатели без настроенного порога: {b.metrics_without_threshold.length||'нет'}.</p>
    </div>}
  </article>;
}
