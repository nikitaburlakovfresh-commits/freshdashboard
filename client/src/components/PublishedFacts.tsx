import React,{useEffect,useRef,useState} from 'react';
import { readFacts,type FactRow } from '../api/reportFacts';
import { METRIC_NAMES,REPORT_NAMES } from '../imports/reportModel';
import '../styles/report-facts.css';
export function FactRows({rows,preview=false}:{rows:FactRow[];preview?:boolean}) {
  return <div className="fact-list">{rows.map((r,i)=><article className="fact-row" key={r.id??`${r.org_unit_id}:${r.metric}:${i}`}>
    <div><h3>{METRIC_NAMES[r.metric]}</h3><span>{r.branch??r.display_name}</span><small>{r.period_start} → {r.period_end} · v{r.revision}
      {!preview&&r.is_current===false?' · архивная версия':''}</small></div>
    <div className="fact-value"><strong>{Number(r.value).toLocaleString('ru-RU',{maximumFractionDigits:2})}</strong><span>{r.unit==='RUB'?'руб.':'шт.'}</span>
      {preview&&r.previous_id&&<small>Заменит: {Number(r.previous_value).toLocaleString('ru-RU')}</small>}</div>
    <details><summary>Источник и методика</summary><p>{REPORT_NAMES[r.provenance.report_kind]} · {r.provenance.sheet}!{r.provenance.address}</p>
      <p>Точное значение: {r.value} {r.unit}. Версия снимка: {r.id??'будет создана после подтверждения'}.</p>
      <p>Извлечение: {r.provenance.extraction}. {r.provenance.methodology}</p><p>Основание периода: {r.provenance.period_basis}</p>
      <p>Выбор источника: {r.provenance.source_selection_reason}</p>
      <p className="fact-hash">SHA-256: {r.provenance.file_hash}</p></details>
  </article>)}</div>;
}
export default function PublishedFacts({org}:{org?:string}) {
  const [start,setStart]=useState(''),[end,setEnd]=useState(''),[history,setHistory]=useState(false);
  const [rows,setRows]=useState<FactRow[]|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const request=useRef(0);
  useEffect(()=>{request.current++;setRows(null);setError('');setBusy(false);return()=>{request.current++;};},[org]);
  function clear(){request.current++;setRows(null);setError('');setBusy(false);}
  async function load(e:React.FormEvent) {
    e.preventDefault();const ticket=++request.current;setBusy(true);setError('');setRows(null);
    try{const data=await readFacts(start,end,org,history);if(ticket===request.current)setRows(data.items);}
    catch(e:any){if(ticket===request.current)setError(e.message);}finally{if(ticket===request.current)setBusy(false);}
  }
  return <section className="portal-panel report-facts">
    <div className="portal-section-head"><h2>Опубликованные показатели источника</h2><span className="portal-chip">Серверное хранение</span></div>
    <p>Только явно утверждённые агрегаты отчётов. Это не расчёт прибыли, доли рынка или полного KPI. Доступ к задачам не открывает финансовые показатели.</p>
    <form className="beta-filters" onSubmit={load}>
      <label>Показатели: с<input required aria-label="Показатели: с" type="date" value={start} onChange={e=>{clear();setStart(e.target.value);}}/></label>
      <label>Показатели: по<input required aria-label="Показатели: по" type="date" min={start} value={end} onChange={e=>{clear();setEnd(e.target.value);}}/></label>
      <label className="fact-check"><input type="checkbox" checked={history} onChange={e=>{clear();setHistory(e.target.checked);}}/> Включить прежние версии</label>
      <button className="btn" disabled={busy}>{busy?'Читаю…':'Показать срез'}</button>
    </form>
    <p className="portal-muted">Период должен совпадать точно. Для склада выберите одну дату в обоих полях. Разные периоды и филиалы не суммируются; отсутствие данных не равно нулю. Актуальность источника по SLA пока не оценивается.</p>
    {error&&<p role="alert">{error}</p>}
    {rows===null&&!error&&!busy&&<p>Выберите период. Дата ежедневника не подставляется в финансовый срез.</p>}
    {rows?.length===0&&<p role="status">За этот точный период нет опубликованных значений в вашей области доступа.</p>}
    {rows&&rows.length>0&&<FactRows rows={rows}/>}
  </section>;
}
