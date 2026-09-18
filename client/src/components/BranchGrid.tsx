import React,{useEffect,useRef,useState} from 'react';
import { readOverview,type Overview } from '../api/metrics';
import { formatValue,ragReason,RAG_LABELS } from './metricThresholdModel';
import RagBadge,{ RagDot } from './RagBadge';
import '../styles/branch-grid.css';

/**
 * Сетка филиалов ТЗ v2.12: карточки филиалов со светофором по опубликованным
 * показателям. Пороги приходят с сервера из настроек портала; клиент ничего
 * не досчитывает и не подставляет нули.
 */
export default function BranchGrid({org}:{org?:string}) {
  const [start,setStart]=useState(''),[end,setEnd]=useState('');
  const [data,setData]=useState<Overview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const request=useRef(0);
  useEffect(()=>{request.current++;setData(null);setError('');setBusy(false);return()=>{request.current++;};},[org]);
  function clear(){request.current++;setData(null);setError('');setBusy(false);}
  async function load(e:React.FormEvent) {
    e.preventDefault();const ticket=++request.current;setBusy(true);setError('');setData(null);
    try{const r=await readOverview(start,end,org);if(ticket===request.current)setData(r);}
    catch(e:any){if(ticket===request.current)setError(e.message);}
    finally{if(ticket===request.current)setBusy(false);}
  }
  return <section className="portal-panel branch-grid-panel">
    <div className="portal-section-head">
      <h2>Сетка филиалов</h2>
      <span className="portal-chip">Опубликованные показатели</span>
    </div>
    <p className="portal-muted">Статус светофора рассчитывается по порогам, заданным в настройках портала.
      Отсутствие данных или порога — статус «Нет данных», это не ноль и не выполнение.</p>
    <form className="beta-filters" onSubmit={load}>
      <label>Период: с<input required aria-label="Период: с" type="date" value={start}
        onChange={e=>{clear();setStart(e.target.value);}}/></label>
      <label>Период: по<input required aria-label="Период: по" type="date" min={start} value={end}
        onChange={e=>{clear();setEnd(e.target.value);}}/></label>
      <button className="btn" disabled={busy}>{busy?'Читаю…':'Показать сетку'}</button>
    </form>
    {error&&<p role="alert">{error}</p>}
    {!data&&!error&&!busy&&<p>Выберите точный период опубликованного среза.</p>}
    {data&&!data.thresholds_configured&&<p role="status" className="branch-grid-warning">
      Пороги ещё не настроены. Значения показываются без статуса до настройки порогов в разделе «Пороги показателей».</p>}
    {data?.branches.length===0&&<p role="status">За этот период в вашей области доступа нет опубликованных показателей.</p>}
    {data&&data.branches.length>0&&<div className="branch-grid">
      {data.branches.map(b=><article className="branch-card" key={b.org_unit_id} data-rag={b.rag}>
        <header>
          <h3>{b.display_name}</h3>
          <RagBadge status={b.rag}/>
        </header>
        <dl>
          {b.metrics.map(m=><div className="branch-metric" key={m.metric}>
            <dt><RagDot status={m.rag}/>{m.metric_name}</dt>
            <dd className="tabnum">{formatValue(m.value,m.unit)}</dd>
            <small title={ragReason(m)}>{RAG_LABELS[m.rag]} · v{m.revision}</small>
          </div>)}
        </dl>
        {b.metrics_without_threshold.length>0&&<footer className="portal-muted">
          Без настроенного порога: {b.metrics_without_threshold.map(m=>data.metric_names[m]??m).join(', ')}
        </footer>}
      </article>)}
    </div>}
  </section>;
}
