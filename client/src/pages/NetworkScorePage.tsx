import React,{useCallback,useEffect,useState} from 'react';
import { Link } from 'react-router-dom';
import { useReportDate } from '../state/reportDate';
import { readOverview,readDivisionSummary,COMPONENT_MISSING_LABELS,EVALUATION_LABELS,
  RULE_ROLE_LABELS,RAG_LABELS,type Overview,type BranchCard,
  type DivisionSummary,type RunRateTile } from '../api/metrics';
import RagBadge,{ RagDot } from '../components/RagBadge';
import Icon from '../components/Icon';
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
  // Сервер уже отдаёт проценты (fact*коэффициент/plan*100). Повторное
  // умножение на 100 давало «7236%» вместо «82%» — именно это увидел владелец.
  if(t.format==='PCT') return `${Math.round(t.value)}%`;
  if(t.format==='RATIO') return `${t.value.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})}×`;
  if(t.format==='RUB') return t.value>=1000
    ? `${Math.round(t.value/1000).toLocaleString('ru-RU')} тыс ₽`
    : `${Math.round(t.value).toLocaleString('ru-RU')} ₽`;
  return Math.round(t.value).toLocaleString('ru-RU');
}
const RU_DATE=(iso:string)=>iso.split('-').reverse().join('.');
/**
 * Причина отсутствия факта на языке руководителя: технические коды сервера
 * («FACT_NOT_PUBLISHED:sales») на экран не выводятся.
 */
function basisLabel(basis:string|null):string {
  if(!basis) return 'нет опубликованных данных за срез';
  const [code,metric]=basis.split(':');
  const MAP:Record<string,string>={
    FACT_NOT_PUBLISHED:'факт ещё не опубликован',
    PLAN_NOT_PUBLISHED:'план ещё не опубликован',
    STOCK_START_NOT_PUBLISHED:'нет склада на начало периода',
    SUPPLIES_NOT_PUBLISHED:'поставки ещё не опубликованы',
    NOT_MAPPED_TO_PUBLISHED_METRIC:'соответствие показателю не объявлено',
    NO_ACCESS:'нет допуска к показателю',
  };
  const human=MAP[code];
  if(!human) return basis;
  return metric?`${human} (${metric})`:human;
}
/**
 * Подпись под значением run-rate. Боевой портал показывает «2 220 / 2 703 шт» —
 * прогноз месяца к плану, а не факт к плану: сравнивать неполный месяц с
 * месячным планом бессмысленно. Прогноз = факт × (дней в месяце / прошедших),
 * тот же коэффициент, что в расчёте самого run-rate на сервере.
 */
function runRateHint(t:RunRateTile):string {
  if(t.format!=='PCT'||t.value===null||t.fact===null||t.plan===null||!(t.plan>0)) return t.hint;
  const forecast=Math.round(t.plan*t.value/100);
  return `${forecast.toLocaleString('ru-RU')} / ${t.plan.toLocaleString('ru-RU')}`;
}
/** Иконка плитки run-rate по её смыслу. */
const RUNRATE_ICONS:Record<string,'target'|'stock'|'wallet'|'layers'|'chart'>={
  sales_runrate:'target',stock_turnover:'stock',margin_runrate:'wallet',
  supplies_runrate:'layers',avg_sale_price:'chart',
};
const MONTHS=['январь','февраль','март','апрель','май','июнь','июль','август','сентябрь','октябрь',
  'ноябрь','декабрь'];
/** «2026-09-01» → «сентябрь 2026 г.» */
function focusMonthLabel(month:string):string {
  const [y,m]=month.split('-').map(Number);
  return m>=1&&m<=12?`${MONTHS[m-1]} ${y} г.`:month;
}
/**
 * Среднего балла филиалов зоны здесь больше нет. Рядом с фамилией стоит рейтинг
 * регионала, который считает сервер по своей формуле: среднее из баллов
 * филиалов — другая величина, и она уравнивала большой филиал с маленьким.
 */
export default function NetworkScorePage() {
  // Период факта задаётся глобальным срезом из топбара: от начала месяца
  // выбранной даты до самой даты. Локального дубля выбора даты на экране нет.
  const {reportDate,periodStart}=useReportDate();
  const start=periodStart,end=reportDate;
  const [data,setData]=useState<Overview|null>(null);
  const [managers,setManagers]=useState<DivisionSummary|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[open,setOpen]=useState<string[]>([]);
  const [openGroups,setOpenGroups]=useState<string[]>([]);
  // Фильтр по статусу светофора. Как на старом портале: нажатие на плитку
  // оставляет в списке только филиалы этого статуса. Повторное нажатие снимает.
  const [ragFilter,setRagFilter]=useState<'GREEN'|'AMBER'|'RED'|null>(null);

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
  const tiles:{label:string;value:string;hint:string;rag?:'GREEN'|'AMBER'|'RED';
    icon:'chart'|'check'|'info'|'shield'}[]=[
    {icon:'chart',label:'Средний балл сети',value:net?num(net.average_score):'—',hint:`По ${net?.branches_with_score??0} филиалам с определённым баллом`},
    {icon:'check',label:'Зелёные филиалы',value:String(net?.green??0),hint:'Все условия зелёного статуса выполнены',rag:'GREEN' as const},
    {icon:'info',label:'Жёлтые филиалы',value:String(net?.amber??0),hint:'Есть отклонения без красных правил',rag:'AMBER' as const},
    {icon:'shield',label:'Красные филиалы',value:String(net?.red??0),hint:'Сработало правило красного статуса',rag:'RED' as const},
  ];
  // Фильтр применяется к филиалам до группировки: у РМ остаются только филиалы
  // выбранного статуса, а РМ без таких филиалов из списка уходит целиком.
  const visibleBranches=(data?.branches??[])
    .filter(b=>ragFilter===null||b.score_rag===ragFilter);
  const branchesByManager=groupByManager(visibleBranches,data?.manager_rating?.managers??[]);

  if(data?.peer_view) return <PeerNetwork data={data}/>;
  return <div className="portal-page network-kpi">
    <header className="overview-head">
      <div>
        <h1>Обзор сети</h1>
        {/* Дата данных, а не выбранная дата. Если отчёты за выбранное число ещё
            не загружены, экран показывает предыдущий срез и говорит об этом
            прямо: выдавать вчерашние данные за сегодняшние нельзя. */}
        <p className="overview-subline">Срез на {RU_DATE(data?data.period_end:end)} ·
          {' '}{data?data.branches.length:'…'} филиалов
          {net&&net.without_score>0&&<> · без балла {net.without_score}</>}</p>
        {data?.data_is_stale&&<p className="overview-stale" role="status">
          Выбрано {RU_DATE(data.requested_end)}, но отчёты за эту дату ещё не загружены.
          Показаны последние опубликованные данные — на {RU_DATE(data.period_end)}.</p>}
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

      <div className="score-tiles">{tiles.map(t=>{
        const active=t.rag!==undefined&&t.rag===ragFilter;
        const clickable=t.rag!==undefined;
        const Tag=clickable?'button':'article';
        return <Tag className="score-tile" key={t.label} data-rag={t.rag??'NEUTRAL'}
          data-active={active?'1':undefined} title={t.hint}
          {...(clickable?{type:'button' as const,'aria-pressed':active,
            onClick:()=>setRagFilter(prev=>prev===t.rag?null:(t.rag as 'GREEN'|'AMBER'|'RED'))}:{})}>
          <span className="tile-icon" data-rag={t.rag??'NEUTRAL'} aria-hidden="true"><Icon name={t.icon}/></span>
          <div><strong className="tabnum">{t.value}</strong><span>{t.label}</span>
            <small>{t.hint}</small></div>
        </Tag>;
      })}</div>
      {ragFilter&&<p className="rag-filter-note" role="status">
        Показаны только филиалы со статусом {RAG_LABELS[ragFilter]}: {visibleBranches.length}.{' '}
        <button type="button" className="rag-filter-reset" onClick={()=>setRagFilter(null)}>
          Показать все</button>
      </p>}

      <div className="runrate-tiles">{data.run_rates.map(t=><article className="runrate-tile" key={t.code}>
        <span className="runrate-icon" data-code={t.code} aria-hidden="true">
          <Icon name={RUNRATE_ICONS[t.code]??'chart'}/></span>
        <div><strong className="tabnum">{runRateValue(t)}</strong>
          <span>{t.label}</span>
          <small>{t.value===null?basisLabel(t.basis):runRateHint(t)}</small></div>
      </article>)}</div>

      <section className="focus-block">
        <div className="focus-block-head">
          <h2>Фокусы внимания — {focusMonthLabel(data.focus.month)}</h2>
          <Link className="focus-block-link" to="/settings/focus">Настроить фокусы</Link>
        </div>
        {!data.focus.configured&&<p role="status" className="portal-muted">Фокусы на этот месяц не настроены
          в портале.</p>}
        {data.focus.configured&&<div className="focus-row">{data.focus.slots.map(s=>
          <article className="focus-tile" key={s.slot} data-missing={s.fact===null?'1':undefined}>
            <span className="focus-tile-icon" aria-hidden="true"><Icon name="target"/></span>
            <div>
              <p className="focus-tile-value">
                <strong className="tabnum">{s.fact===null?'—'
                  :`${s.fact.toLocaleString('ru-RU')}${s.format==='PCT'?'%':''}`}</strong>
                <span className="tabnum"> / {s.plan===null?'план не задан'
                  :`план ${s.direction==='LOWER_IS_BETTER'?'≤':''}${s.plan.toLocaleString('ru-RU')}${
                    s.format==='PCT'?'%':` ${FOCUS_FORMATS[s.format]??''}`}`}</span>
              </p>
              <span className="focus-tile-label" title={s.label}>{s.label}</span>
              {s.fact===null&&<small className="focus-tile-note">{
                s.requires_vin_level?'появится после накопления базы по VIN'
                :s.requires_daily_logs?'появится после ведения ежедневников'
                :s.fact_basis==='NOT_MAPPED_TO_PUBLISHED_METRIC'
                  ?'соответствие показателю не объявлено'
                  :basisLabel(s.fact_basis)}</small>}
            </div>
          </article>)}</div>}
      </section>

      <section className="manager-list">
        {!data.branches.length&&<p role="status" className="portal-muted">За этот период в вашей области
          доступа нет опубликованных показателей.</p>}
        {branchesByManager.map(group=>{
          const expanded=openGroups.includes(group.key);
          return <div className="manager-block" key={group.key}>
            <div className="manager-row">
              <button type="button" className="manager-toggle" aria-expanded={expanded}
                onClick={()=>setOpenGroups(list=>list.includes(group.key)
                  ?list.filter(k=>k!==group.key):[...list,group.key])}>
                <span className="manager-chevron" data-open={expanded?'1':undefined} aria-hidden="true"/>
                <strong>{group.title}</strong>
                <span className="manager-score tabnum" data-rag={group.rating?.rag??'NONE'}
                  title={group.rating
                    ?`Рейтинг: ${group.rating.formula}`
                    :'Рейтинг зоны не рассчитан: нет опубликованных плана и факта'}>
                  {group.rating?.rating!=null?`${Math.round(group.rating.rating)}%`:'—'}</span>
                <span className="manager-count">· {group.branches.length} филиалов
                  {group.division&&<> · {group.division}</>}</span>
              </button>
              <button type="button" className="manager-open"
                onClick={()=>setOpenGroups(list=>list.includes(group.key)
                  ?list.filter(k=>k!==group.key):[...list,group.key])}>
                {expanded?'Свернуть':'Открыть'}</button>
            </div>
            {expanded&&<div className="branch-tiles">{group.branches.map(b=><BranchRow key={b.org_unit_id}
              branch={b} period={{start:data.period_start,end:data.period_end}}
              open={open.includes(b.org_unit_id)}
              onToggle={()=>setOpen(list=>list.includes(b.org_unit_id)
                ?list.filter(id=>id!==b.org_unit_id):[...list,b.org_unit_id])}/>)}</div>}
          </div>;})}
      </section>
    </>}
  </div>;
}

interface Group {key:string;title:string;division:string|null;branches:BranchCard[];
  rating:RmRating|null}
type RmRating=Overview['manager_rating']['managers'][number];
/**
 * Группировка филиалов по зоне регионального менеджера. Привязка приходит с
 * сервера из истории справочника на дату среза; филиал без привязки попадает в
 * отдельную явную группу и не приписывается чужому РМ.
 */
function groupByManager(branches:BranchCard[],ratings:RmRating[]):Group[] {
  const groups=new Map<string,Group>();
  for(const b of branches) {
    const key=b.group_key??'none';
    const g=groups.get(key)??{key,title:b.group_label??'Филиал без зоны РМ',
      division:b.division_name??null,branches:[],
      rating:ratings.find(r=>r.group_key===key)??null};
    g.branches.push(b);groups.set(key,g);
  }
  // Порядок — от лучшего рейтинга к худшему: руководителю нужен результат, а не
  // алфавит. Зона без рассчитанного рейтинга уходит в конец: отсутствие данных
  // не равно худшему результату.
  return [...groups.values()].sort((a,b)=>{
    const pa=a.rating?.rating??null,pb=b.rating?.rating??null;
    if(pa===null&&pb===null) return a.title.localeCompare(b.title,'ru');
    if(pa===null) return 1;
    if(pb===null) return -1;
    return pb-pa||a.title.localeCompare(b.title,'ru');
  });
}

function BranchRow({branch:b,period,open,onToggle}:{branch:BranchCard;
  period:{start:string;end:string};open:boolean;onToggle:()=>void}) {
  return <article className="branch-tile score-row" data-rag={b.score_rag} data-open={open?'1':undefined}>
    <div className="branch-tile-head">
      <button type="button" className="branch-tile-toggle" aria-expanded={open} onClick={onToggle}>
        <span className="branch-tile-name"><RagDot status={b.score_rag}/>{b.display_name}</span>
        <strong className="branch-tile-score tabnum">{b.score===null?'—':`${Math.round(b.score)}%`}</strong>
      </button>
      <div className="branch-tile-foot">
        <RagBadge status={b.score_rag}/>
        <Link className="score-row-link"
          to={`/branch-card/${b.org_unit_id}?start=${period.start}&end=${period.end}`}>Карточка →</Link>
      </div>
    </div>
    {open&&<div className="score-row-body">
      {/* Сжатое окно филиала. Задача — дать руководителю понять состояние за
          несколько секунд, не открывая полную карточку: ключевые показатели
          плитками «факт / план», затем причины статуса, и только потом полный
          разбор. Кнопка открытия карточки стоит первой, чтобы до неё не нужно
          было прокручивать таблицу. */}
      <div className="branch-mini-actions">
        <Link className="btn branch-mini-open"
          to={`/branch-card/${b.org_unit_id}?start=${period.start}&end=${period.end}`}>
          Открыть филиал</Link>
        <span className="branch-mini-score">
          Балл {b.score===null?'—':`${Math.round(b.score)}%`} · {RAG_LABELS[b.score_rag]}</span>
      </div>

      {b.score_components.length>0&&<div className="branch-mini-grid">
        {b.score_components.slice(0,8).map(c=>{
          const pct=c.fact!==null&&c.plan!==null&&c.plan>0?Math.round(c.fact/c.plan*100):null;
          return <article className="branch-mini-tile" key={c.metric}>
            <span className="branch-mini-label" title={c.metric_name}>{c.metric_name}</span>
            <strong className="tabnum">{c.fact===null
              ?<span className="portal-muted">{COMPONENT_MISSING_LABELS[c.missing??'']??'нет данных'}</span>
              :c.fact.toLocaleString('ru-RU')}</strong>
            <small className="tabnum">{c.plan===null?'план не задан'
              :`план ${c.plan.toLocaleString('ru-RU')}${pct===null?'':` · ${pct}%`}`}</small>
          </article>;
        })}
      </div>}

      {b.score_reasons.length>0&&<ul className="score-reasons">
        {b.score_reasons.map(r=><li key={r}>{r}</li>)}</ul>}
      {b.score_components.length===0&&<p className="portal-muted">Модель балла не настроена: вклад
        показателей не рассчитывается.</p>}

      {b.score_components.length>0&&<details className="branch-mini-details">
        <summary>Полный разбор балла</summary>
        <table className="score-table">
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
        </table>
      </details>}
      <p className="portal-muted">Статус по показателям с порогами: {RAG_LABELS[b.rag]}.
        Показатели без настроенного порога: {b.metrics_without_threshold.length||'нет'}.</p>
    </div>}
  </article>;
}

/**
 * Стартовый экран РФ (решение владельца 26.09.2026): свой филиал большой
 * плиткой в шапке, ниже все филиалы сети плитками с баллом. Без фамилий
 * региональных менеджеров, без задач и настроек — только просмотр карточки.
 */
function PeerNetwork({data}:{data:Overview}) {
  const own=data.peer_view!.own_org_unit_ids;
  const q=`?start=${data.period_start}&end=${data.period_end}`;
  const ranked=[...data.branches].sort((a,b)=>(b.score??-1)-(a.score??-1)||a.display_name.localeCompare(b.display_name,'ru'));
  const scored=ranked.filter(b=>b.score!==null);
  const mine=ranked.filter(b=>own.includes(b.org_unit_id));
  const net=data.network;
  return <div className="portal-page network-kpi peer-network">
    <header className="overview-head"><div>
      <h1>Сеть FRESH</h1>
      <p className="overview-subline">Срез на {RU_DATE(data.period_end)} · {data.branches.length} филиалов
        {net.average_score!==null&&<> · средний балл сети {Math.round(net.average_score)}%</>}</p>
      {data.data_is_stale&&<p className="overview-stale" role="status">
        Отчёты за {RU_DATE(data.requested_end)} ещё не загружены — показаны данные на {RU_DATE(data.period_end)}.</p>}
    </div></header>
    {mine.map(b=>{
      const place=b.score===null?null:scored.findIndex(x=>x.org_unit_id===b.org_unit_id)+1;
      return <Link key={b.org_unit_id} to={`/branch-card/${b.org_unit_id}${q}`} className="peer-own" data-rag={b.score_rag}>
        <div className="peer-own-head">
          <div><span className="peer-own-eyebrow">Мой филиал</span>
            <h2><RagDot status={b.score_rag}/>{b.display_name}</h2>
            <p>{place?`${place} место из ${scored.length} в сети`:'балл не рассчитан'} · <RagBadge status={b.score_rag}/></p></div>
          <strong className="peer-own-score tabnum">{b.score===null?'—':`${Math.round(b.score)}%`}</strong>
        </div>
        {b.score_components.length>0&&<div className="peer-own-grid">{b.score_components.slice(0,6).map(c=>{
          const pct=c.fact!==null&&c.plan!==null&&c.plan>0?Math.round(c.fact/c.plan*100):null;
          return <div key={c.metric}><span>{c.metric_name}</span>
            <strong className="tabnum">{c.fact===null?'—':Math.round(c.fact).toLocaleString('ru-RU')}</strong>
            <small className="tabnum">{c.plan===null?'план не задан':`план ${Math.round(c.plan).toLocaleString('ru-RU')}${pct===null?'':` · ${pct}%`}`}</small></div>;
        })}</div>}
        <span className="peer-own-open">Открыть карточку →</span>
      </Link>;
    })}
    <h2 className="peer-title">Все филиалы сети</h2>
    <div className="peer-grid">{ranked.map((b,i)=><Link key={b.org_unit_id} to={`/branch-card/${b.org_unit_id}${q}`}
      className="peer-tile" data-rag={b.score_rag} data-own={own.includes(b.org_unit_id)?'1':undefined}>
      <span className="peer-tile-place tabnum">{b.score===null?'—':i+1}</span>
      <span className="peer-tile-name"><RagDot status={b.score_rag}/>{b.display_name}</span>
      <strong className="peer-tile-score tabnum">{b.score===null?'—':`${Math.round(b.score)}%`}</strong>
    </Link>)}</div>
  </div>;
}
