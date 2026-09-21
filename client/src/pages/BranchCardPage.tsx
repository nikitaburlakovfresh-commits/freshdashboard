import React,{useEffect,useMemo,useState} from 'react';
import { Link,useParams,useSearchParams } from 'react-router-dom';
import { readBranchCard,type BranchCardData } from '../api/metrics';
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
  const [params]=useSearchParams();
  const [start,setStart]=useState(params.get('start')??'');
  const [end,setEnd]=useState(params.get('end')??'');
  const [data,setData]=useState<BranchCardData|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [showAll,setShowAll]=useState(false);
  const [picked,setPicked]=useState<string[]>([]);

  async function load(e?:React.FormEvent) {
    e?.preventDefault();
    if(!start||!end)return;
    setBusy(true);setError('');setData(null);
    try{setData(await readBranchCard(id,start,end));}
    catch(err:any){setError(err?.message??'Не удалось прочитать карточку филиала.');}
    finally{setBusy(false);}
  }
  useEffect(()=>{if(start&&end)void load();},[id]);

  // Значения показателей и расчётных величин в одном справочнике: плитки и
  // разбивка берут их отсюда, не пересчитывая ничего заново.
  const byMetric=useMemo(()=>{
    const map=new Map<string,{value:number;unit:string;computed:boolean;name:string}>();
    for(const m of data?.metrics??[])map.set(m.metric,{value:m.value,unit:m.unit,computed:false,name:m.metric_name});
    for(const d of data?.derived??[])map.set(d.metric,{value:d.value,unit:d.unit,computed:true,name:d.metric_name});
    return map;
  },[data]);

  const components=data?.score.components??[];
  const shown=picked.length?components.filter(c=>picked.includes(c.metric)):components;

  return <section className="portal-panel">
    <div className="portal-section-head">
      <h1>{data?.branch.display_name??'Карточка филиала'}</h1>
      {data&&<RagBadge status={data.score.rag}/>}
    </div>
    {data&&<p className="portal-muted">Код {data.branch.code} · состояние {data.branch.lifecycle_state} ·
      период {data.period_start} — {data.period_end}
      {data.score.value!==null&&<> · балл <strong>{Math.round(data.score.value)}</strong></>}</p>}
    <form className="beta-filters" onSubmit={load}>
      <label>Период: с<input required aria-label="Период: с" type="date" value={start}
        onChange={e=>{setData(null);setStart(e.target.value);}}/></label>
      <label>Период: по<input required aria-label="Период: по" type="date" min={start} value={end}
        onChange={e=>{setData(null);setEnd(e.target.value);}}/></label>
      <button className="btn" disabled={busy}>{busy?'Читаю…':'Показать карточку'}</button>
      <Link className="btn btn-ghost" to="/">К сетке филиалов</Link>
      {data&&<Link className="btn btn-ghost" to={`/branch-card/${id}/vin?observed_on=${data.period_end}`}>
        Реестр авто (VIN)</Link>}
    </form>
    {error&&<p role="alert">{error}</p>}
    {!data&&!error&&!busy&&<p>Выберите точный период опубликованного среза.</p>}
    {data&&<>
      {!data.score.configured&&<p role="status" className="branch-grid-warning">
        Модель балла не настроена: балл и разбивка не считаются.</p>}

      <h2>Ежедневный контроль</h2>
      <div className="card-tiles">
        {FOCUS_TILES.map(tile=>{
          const cell=byMetric.get(tile.metric);
          if(tile.kind==='STOCK') {
            // План на конец месяца — отдельный показатель. Если его нет,
            // выполнение не выдумывается: показывается только факт.
            const plan=byMetric.get('stockPlanMonthEnd');
            const cost=byMetric.get('stockCost');
            return <article key={tile.metric} className="card-tile">
              <h3>{tile.label}</h3>
              <p className="card-tile-value">{!cell?'—':`${Math.round(cell.value)}`}
                {plan&&<span className="card-tile-plan"> / {Math.round(plan.value)}</span>}</p>
              <p className="card-tile-note">{!cell?'склад не опубликован'
                :plan?<>план на конец месяца {Math.round(plan.value)} шт ·
                  {' '}{pct(cell.value/plan.value)} плана
                  {cost&&<> · себестоимость {rub(cost.value)}</>}</>
                  :<>план на конец месяца не опубликован
                    {cost&&<> · себестоимость {rub(cost.value)}</>}</>}</p>
            </article>;
          }
          return <article key={tile.metric} className="card-tile">
            <h3>{tile.label}</h3>
            <p className="card-tile-value">{!cell?'—'
              :tile.kind==='PCT'?pct(cell.value)
                :tile.kind==='RUB'?rub(cell.value):formatValue(cell.value,cell.unit)}</p>
            <p className="card-tile-note">{!cell?'нет опубликованного значения'
              :cell.computed?'расчёт портала из опубликованного':'опубликованный показатель'}</p>
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

        <article className="card-tile">
          <h3>Переоценки вверх ({data.repricing.window_days} дн)</h3>
          <p className="card-tile-value">{data.repricing.snapshots<2?'—'
            :data.repricing.vehicles===null?'0':String(data.repricing.vehicles)}</p>
          <p className="card-tile-note">{data.repricing.snapshots<2
            ? `срезов реестра за период: ${data.repricing.snapshots} — переоценку определяет сравнение двух срезов`
            : `${data.repricing.events??0} изменений цены вверх · срезов ${data.repricing.snapshots}`}</p>
        </article>
      </div>

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
  </section>;
}
