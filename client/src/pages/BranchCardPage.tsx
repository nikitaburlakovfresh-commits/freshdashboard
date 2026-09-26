import React,{useEffect,useMemo,useState} from 'react';
import { Link,useParams } from 'react-router-dom';
import { readBranchCard,readBranchRepricing,type BranchCardData,type RepricingEvent } from '../api/metrics';
import { useReportDate } from '../state/reportDate';
import { formatValue,ragReason,RAG_LABELS } from '../components/metricThresholdModel';
import { OUTCOME_LABELS,outcomeTone,deltaLabel } from '../components/deviationOutcomeModel';
import RagBadge,{ RagDot } from '../components/RagBadge';
import '../styles/branch-grid.css';
import '../styles/branch-card.css';

/**
 * Карточка филиала: сначала плитки ежедневного контроля, затем разбивка балла
 * по показателям и полный перечень — по кнопке. Порядок повторяет рабочий
 * портал: руководителю нужны несколько чисел сразу, а не таблица из сорока
 * строк. Клиент ничего не досчитывает и не подставляет нули: отсутствующий
 * показатель показывается прочерком.
 */

const RUB=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:0});
const pct=(v:number|null|undefined)=>v===null||v===undefined?'—':`${(v*100).toFixed(1).replace('.',',')}%`;
const ru=(d:string)=>d.split('-').reverse().join('.');
const rub=(v:number|null|undefined)=>v===null||v===undefined?'—':`${RUB.format(Math.round(v))} ₽`;

/** Показатели ежедневного контроля — как в блоке старого портала. */
const FOCUS_TILES:{metric:string;label:string;kind:'PCT'|'RUB'|'COUNT'|'STOCK'}[]=[
  {metric:'funnelTrafficToDeal',label:'Конверсия трафик → сделка',kind:'PCT'},
  {metric:'turnoverCommission',label:'Оборачиваемость комиссии',kind:'PCT'},
  {metric:'turnoverBuyout',label:'Оборачиваемость выкупа',kind:'PCT'},
  {metric:'mdProfitability',label:'Рентабельность MD',kind:'PCT'},
  // Склад: факт в штуках против плана на конец месяца. В отчёте источника
  // заголовок плана подписан датой начала месяца, но это план на его конец.
  {metric:'stock',label:'Склад, шт',kind:'STOCK'},
  {metric:'creditShareFact',label:'Доля кредитных сделок',kind:'PCT'},
  {metric:'incomeShareFact',label:'Доход с кредита',kind:'PCT'},
  {metric:'incomePerCreditFact',label:'Доход на кредит',kind:'RUB'},
];

export default function BranchCardPage() {
  const {id=''}=useParams();
  // Период карточки — от начала месяца до даты в верхней панели: одна дата на
  // весь портал, отдельного выбора периода нет (решение владельца 26.09.2026).
  const {reportDate,periodStart}=useReportDate();
  const start=periodStart,end=reportDate;
  const [data,setData]=useState<BranchCardData|null>(null);
  const [repricing,setRepricing]=useState<{window_days:number;items:RepricingEvent[]}|null>(null);
  const [showRepricing,setShowRepricing]=useState(false);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [showAll,setShowAll]=useState(false);
  const [picked,setPicked]=useState<string[]>([]);

  useEffect(()=>{
    if(!start||!end)return;
    let alive=true;
    setBusy(true);setError('');setRepricing(null);
    readBranchCard(id,start,end).then(d=>{
      if(!alive)return;
      setData(d);
      if(!d.read_only||d.own_branch)
        readBranchRepricing(id,d.period_end).then(r=>{if(alive)setRepricing(r);}).catch(()=>{});
    }).catch((err:any)=>{if(alive){setData(null);setError(err?.message??'Не удалось прочитать карточку филиала.');}})
      .finally(()=>{if(alive)setBusy(false);});
    return()=>{alive=false;};
  },[id,start,end]);

  // Значения показателей и расчётных величин в одном справочнике: плитки и
  // разбивка берут их отсюда, не пересчитывая ничего заново.
  const byMetric=useMemo(()=>{
    const map=new Map<string,{value:number;unit:string;computed:boolean;name:string}>();
    for(const m of data?.metrics??[])map.set(m.metric,{value:m.value,unit:m.unit,computed:false,name:m.metric_name});
    for(const d of data?.derived??[])map.set(d.metric,{value:d.value,unit:d.unit,computed:true,name:d.metric_name});
    return map;
  },[data]);
  // Последняя публикация того же месяца для показателей, которых нет в срезе.
  const latestBy=useMemo(()=>{
    const map=new Map<string,{value:number;unit:string;as_of:string}>();
    for(const m of data?.latest??[])map.set(m.metric,m);
    return map;
  },[data]);

  const components=data?.score.components??[];
  const shown=picked.length?components.filter(c=>picked.includes(c.metric)):components;

  const canVin=!!data&&(!data.read_only||!!data.own_branch);
  return <section className="portal-panel">
    <div className="card-head">
      <Link className="card-back" to="/" aria-label="Назад к сетке филиалов">
        <span className="card-back-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </span>
        <span className="card-back-text">К сетке филиалов</span>
      </Link>
      <div className="card-head-title">
        <h1>{data?.branch.display_name??'Карточка филиала'}</h1>
        {data&&<p className="portal-muted">Данные на {ru(data.period_end)}
          {data.score.value!==null&&<> · балл <strong>{Math.round(data.score.value)}</strong></>}</p>}
      </div>
      <div className="card-head-side">
        {data&&<RagBadge status={data.score.rag}/>}
        {canVin&&<Link className="card-vin-btn" to={`/branch-card/${id}/vin?observed_on=${data!.stock_snapshot?.observed_on??data!.period_end}`}>
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M5 11l1.5-4.5A2 2 0 018.4 5h7.2a2 2 0 011.9 1.5L19 11m-14 0h14m-14 0v6h2v-2h10v2h2v-6M7.5 13.5h.01M16.5 13.5h.01" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
          <span>Реестр авто по VIN{data!.stock_snapshot?.stock!=null&&<small>{Math.round(data!.stock_snapshot.stock)} авто</small>}</span>
        </Link>}
      </div>
    </div>
    {error&&<p role="alert">{error}</p>}
    {busy&&!data&&<p className="portal-muted">Загрузка…</p>}
    {data&&<>
      {!data.score.configured&&<p role="status" className="branch-grid-warning">
        Модель балла не настроена: балл и разбивка не считаются.</p>}

      <h2>Ежедневный контроль</h2>
      <div className="card-tiles">
        {FOCUS_TILES.map(tile=>{
          const cell=byMetric.get(tile.metric);
          if(tile.kind==='STOCK') {
            // Факт склада — из точечного среза на дату, план на конец месяца —
            // показатель периода. Отсутствующую часть не подменяем.
            const snap=data.stock_snapshot;
            const fact=snap?.stock??null;
            const plan=byMetric.get('stockPlanMonthEnd');
            const cost=snap?.stock_cost??null;
            return <article key={tile.metric} className="card-tile">
              <h3>{tile.label}</h3>
              <p className="card-tile-value">{fact===null?'—':Math.round(fact)}
                {plan&&<span className="card-tile-plan"> / {Math.round(plan.value)}</span>}</p>
              <p className="card-tile-note">{fact===null
                ?(plan?<>план на конец месяца {Math.round(plan.value)} шт · факт склада не опубликован</>
                  :'склад не опубликован')
                :<>{plan?<>{pct(fact/plan.value)} плана на конец месяца</>:'план не опубликован'}
                  {cost!==null&&<> · себестоимость {rub(cost)}</>}
                  {snap&&<> · срез {snap.observed_on}</>}</>}</p>
            </article>;
          }
          const late=!cell?latestBy.get(tile.metric):undefined;
          const v=cell??late;
          return <article key={tile.metric} className="card-tile">
            <h3>{tile.label}</h3>
            <p className="card-tile-value">{!v?'—'
              :tile.kind==='PCT'?pct(v.value)
                :tile.kind==='RUB'?rub(v.value):formatValue(v.value,v.unit)}</p>
            <p className="card-tile-note">{late?`по данным на ${ru(late.as_of)}`
              :!cell?(tile.metric.startsWith('funnel')?'отчёт «Воронка» не загружен':'отчёт с этим показателем не загружен')
              :cell.computed?'расчёт портала':`на ${ru(data.period_end)}`}</p>
          </article>;
        })}

        <article className="card-tile">
          <h3>Доля 45+ в выкупе</h3>
          <p className="card-tile-value">{data.buyback45?pct(data.buyback45.share):'—'}</p>
          <p className="card-tile-note">{data.buyback45
            ? <>{rub(data.buyback45.aged_cost)} из {rub(data.buyback45.total_cost)}
              {' '}({data.buyback45.aged}/{data.buyback45.total} авто) · срез {data.buyback45.observed_on}</>
            : 'реестр авто на эту дату не опубликован'}</p>
        </article>

        {(()=>{const n=repricing?repricing.items.length:null;
          const cars=repricing?new Set(repricing.items.map(x=>x.vehicle_key)).size:null;
          const sum=repricing?repricing.items.reduce((a,x)=>a+x.increase_rub,0):null;
          return repricing?<button type="button" className="card-tile card-tile-action" onClick={()=>setShowRepricing(true)}
            disabled={!n} aria-haspopup="dialog">
          <h3>Переоценки вверх ({repricing.window_days} дн)</h3>
          <p className="card-tile-value">{cars}</p>
          <p className="card-tile-note">{n?<>{n} повышений цены на {rub(sum)} · <span className="card-tile-link">открыть список →</span></>
            :'повышений цены за этот срок нет'}</p>
        </button>:null;})()}
        {!repricing&&<article className="card-tile">
          <h3>Переоценки вверх ({data.repricing.window_days} дн)</h3>
          <p className="card-tile-value">{data.repricing.snapshots<2?'—'
            :data.repricing.vehicles===null?'0':String(data.repricing.vehicles)}</p>
          <p className="card-tile-note">{data.repricing.snapshots<2
            ? `срезов реестра за период: ${data.repricing.snapshots} — переоценку определяет сравнение двух срезов`
            : `${data.repricing.events??0} изменений цены вверх`}</p>
        </article>}
      </div>

      {showRepricing&&repricing&&<RepricingDialog items={repricing.items} days={repricing.window_days}
        onClose={()=>setShowRepricing(false)}/>}

      <h2>Разбивка по метрикам (балл)</h2>
      {!components.length&&<p role="status">Ни один показатель модели балла не опубликован за этот период.</p>}
      {components.length>0&&<>
        <fieldset className="card-metric-pick">
          <legend>Показать выбранные</legend>
          {components.map(c=><label key={c.metric}>
            <input type="checkbox" checked={picked.includes(c.metric)}
              onChange={e=>setPicked(prev=>e.target.checked?[...prev,c.metric]:prev.filter(m=>m!==c.metric))}/>
            {c.metric_name??data.metric_names[c.metric]??c.metric}</label>)}
          {picked.length>0&&<button type="button" className="btn btn-ghost" onClick={()=>setPicked([])}>
            Показать все</button>}
        </fieldset>
        <ul className="card-bars">
          {shown.map(c=><li key={c.metric}>
            <span className="card-bar-label">{c.metric_name??data.metric_names[c.metric]??c.metric}</span>
            {/* Неопубликованный показатель не имеет балла: пустая полоса и
                прочерк, а не ноль. Отсутствие данных не равно нулю. */}
            <span className="card-bar-track">
              {c.score!==null&&<span className="card-bar-fill"
                style={{width:`${Math.max(2,Math.min(100,c.score/1.2))}%`}}/>}
            </span>
            <span className="card-bar-score tabnum">{c.score===null?'—':Math.round(c.score)}</span>
            <span className="card-bar-weight portal-muted">{c.score===null
              ?'нет значения':`вес ${c.weight}`}</span>
          </li>)}
        </ul>
        {data.score.reasons.length>0&&<p className="portal-muted">{data.score.reasons.join(' · ')}</p>}
      </>}

      {!data.thresholds_configured&&<p role="status" className="branch-grid-warning">
        Пороги не настроены: значения показываются без статуса.</p>}
      <details className="card-full" open={showAll} onToggle={e=>setShowAll((e.target as HTMLDetailsElement).open)}>
        <summary>Все опубликованные показатели периода ({data.metrics.length})</summary>
        {data.metrics.length===0&&<p role="status">За этот период нет опубликованных показателей в вашей области доступа.</p>}
        {data.metrics.length>0&&<table className="local-table">
          <thead><tr><th>Показатель</th><th>Значение</th><th>Статус</th><th>Основание</th><th>Версия</th></tr></thead>
          <tbody>{data.metrics.map(m=><tr key={m.metric}>
            <td><RagDot status={m.rag}/>{m.metric_name}</td>
            <td className="tabnum">{formatValue(m.value,m.unit)}</td>
            <td>{RAG_LABELS[m.rag]}</td>
            <td className="portal-muted">{ragReason(m)}</td>
            <td className="tabnum">v{m.revision}</td>
          </tr>)}</tbody>
        </table>}
        {data.derived.length>0&&<>
          <h3>Расчётные показатели</h3>
          <p className="portal-muted">Значения без ячейки в источнике: портал считает их из опубликованного
            и не публикует как факт.</p>
          <table className="local-table">
            <thead><tr><th>Показатель</th><th>Значение</th><th>Формула</th></tr></thead>
            <tbody>{data.derived.map(d=><tr key={d.metric}>
              <td>{d.metric_name}</td>
              <td className="tabnum">{pct(d.value)}</td>
              <td className="portal-muted">{d.formula??'—'}</td>
            </tr>)}</tbody>
          </table>
        </>}
        {data.metrics_without_threshold.length>0&&<p className="portal-muted">Без настроенного порога:{' '}
          {data.metrics_without_threshold.map(m=>data.metric_names[m]??m).join(', ')}</p>}
      </details>

{(!data.read_only||data.own_branch)&&<>
      <h2>История отклонений и результат</h2>
      <p className="portal-muted">Результат подтверждается только новой публикацией показателя за тот же период.
        Закрытие задачи само по себе не является влиянием на показатель.</p>
      {data.deviations.length===0&&<p role="status">По этому филиалу задачи по отклонениям не ставились.</p>}
      {data.deviations.length>0&&<table className="local-table">
        <thead><tr><th>Период</th><th>Показатель</th><th>Было</th><th>Стало</th><th>Изменение</th>
          <th>Результат</th><th>Задача</th></tr></thead>
        <tbody>{data.deviations.map(d=><tr key={d.id}>
          <td>{d.period_start} — {d.period_end}</td>
          <td><RagDot status={d.rag_at_creation}/>{d.metric_name}</td>
          <td className="tabnum">{formatValue(d.observed_value,d.unit??'COUNT')}</td>
          <td className="tabnum">{d.current_value===null?'—'
            :`${formatValue(d.current_value,d.unit??'COUNT')} (v${d.current_revision})`}</td>
          <td className="tabnum" data-tone={outcomeTone(d.outcome)}>{deltaLabel(d.delta,d.unit)}</td>
          <td data-tone={outcomeTone(d.outcome)}>{OUTCOME_LABELS[d.outcome]}
            {d.rag_now&&<> · сейчас {RAG_LABELS[d.rag_now]}</>}</td>
          <td><Link to={`/tasks/${d.work_item_id}`}>{d.task.title}</Link>
            <br/><small className="portal-muted">{d.task.status}
              {d.task.assignee_user_id?'':' · ответственный не назначен'}</small></td>
        </tr>)}</tbody>
      </table>}
      </>}
    </>}
  </section>;
}

/** Список переоценок вверх: строка ведёт сразу в карточку автомобиля в CRM. */
function RepricingDialog({items,days,onClose}:{items:RepricingEvent[];days:number;onClose:()=>void}) {
  useEffect(()=>{const k=(e:KeyboardEvent)=>{if(e.key==='Escape')onClose();};
    window.addEventListener('keydown',k);return()=>window.removeEventListener('keydown',k);},[onClose]);
  return <div className="repricing-backdrop" role="dialog" aria-modal="true" aria-labelledby="repricing-title"
    onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
    <div className="repricing-dialog">
      <div className="repricing-head">
        <h2 id="repricing-title">Переоценки вверх за {days} дней</h2>
        <button type="button" className="repricing-close" onClick={onClose} aria-label="Закрыть">×</button>
      </div>
      <p className="portal-muted">Автомобиль остаётся в списке {days} дней с даты повышения цены. Нажмите на строку — откроется карточка в CRM.</p>
      <div className="repricing-scroll">
        <table className="local-table repricing-table">
          <thead><tr><th>Автомобиль</th><th>VIN</th><th className="tabnum">Повышение</th><th className="tabnum">Было → стало</th>
            <th>Дата изменения</th><th className="tabnum">На складе, дн</th></tr></thead>
          <tbody>{items.map((x,i)=>{
            const open=()=>{if(x.crm_url)window.open(x.crm_url,'_blank','noopener');};
            return <tr key={x.vehicle_key+x.changed_on+i} className={x.crm_url?'repricing-row':''}
              onClick={open} tabIndex={x.crm_url?0:-1} onKeyDown={e=>{if(e.key==='Enter')open();}}
              title={x.crm_url?'Открыть в CRM':'Ссылка на CRM не пришла в отчёте'}>
              <td>{[x.make,x.model,x.production_year].filter(Boolean).join(' ')||'—'}
                {x.supply_type&&<small className="portal-muted"> · {x.supply_type}</small>}</td>
              <td>{x.crm_url?<a href={x.crm_url} target="_blank" rel="noopener noreferrer" onClick={e=>e.stopPropagation()}>{x.vehicle_key}</a>:x.vehicle_key}</td>
              <td className="tabnum repricing-up">+{RUB.format(Math.round(x.increase_rub))} ₽</td>
              <td className="tabnum">{RUB.format(Math.round(x.price_before))} → {RUB.format(Math.round(x.price_after))}</td>
              <td>{ru(x.changed_on)}</td>
              <td className="tabnum">{x.days_on_stock??'—'}</td>
            </tr>;})}</tbody>
        </table>
      </div>
    </div>
  </div>;
}
