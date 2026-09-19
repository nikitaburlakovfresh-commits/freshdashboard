import React,{useEffect,useState} from 'react';
import { Link,useParams,useSearchParams } from 'react-router-dom';
import { readBranchCard,type BranchCardData } from '../api/metrics';
import { formatValue,ragReason,RAG_LABELS } from '../components/metricThresholdModel';
import { OUTCOME_LABELS,outcomeTone,deltaLabel } from '../components/deviationOutcomeModel';
import RagBadge,{ RagDot } from '../components/RagBadge';
import '../styles/branch-grid.css';

/**
 * Карточка филиала ТЗ v2.12: опубликованные показатели периода, история
 * отклонений с поставленными задачами и проверка результата по факту новой
 * публикации. Клиент ничего не досчитывает и не подставляет нули.
 */
export default function BranchCardPage() {
  const {id=''}=useParams();
  const [params]=useSearchParams();
  const [start,setStart]=useState(params.get('start')??'');
  const [end,setEnd]=useState(params.get('end')??'');
  const [data,setData]=useState<BranchCardData|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);

  async function load(e?:React.FormEvent) {
    e?.preventDefault();
    if(!start||!end)return;
    setBusy(true);setError('');setData(null);
    try{setData(await readBranchCard(id,start,end));}
    catch(err:any){setError(err?.message??'Не удалось прочитать карточку филиала.');}
    finally{setBusy(false);}
  }
  useEffect(()=>{if(start&&end)void load();},[id]);

  return <section className="portal-panel">
    <div className="portal-section-head">
      <h1>{data?.branch.display_name??'Карточка филиала'}</h1>
      {data&&<RagBadge status={data.metrics.some(m=>m.rag==='RED')?'RED'
        :data.metrics.some(m=>m.rag==='AMBER')?'AMBER'
          :data.metrics.some(m=>m.rag==='GREEN')?'GREEN':'NONE'}/>}
    </div>
    {data&&<p className="portal-muted">Код {data.branch.code} · состояние {data.branch.lifecycle_state} ·
      период {data.period_start} — {data.period_end}</p>}
    <form className="beta-filters" onSubmit={load}>
      <label>Период: с<input required aria-label="Период: с" type="date" value={start}
        onChange={e=>{setData(null);setStart(e.target.value);}}/></label>
      <label>Период: по<input required aria-label="Период: по" type="date" min={start} value={end}
        onChange={e=>{setData(null);setEnd(e.target.value);}}/></label>
      <button className="btn" disabled={busy}>{busy?'Читаю…':'Показать карточку'}</button>
      <Link className="btn btn-ghost" to="/operational">К сетке филиалов</Link>
    </form>
    {error&&<p role="alert">{error}</p>}
    {!data&&!error&&!busy&&<p>Выберите точный период опубликованного среза.</p>}
    {data&&<>
      {!data.thresholds_configured&&<p role="status" className="branch-grid-warning">
        Пороги не настроены: значения показываются без статуса.</p>}
      <h2>Показатели периода</h2>
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
      {data.metrics_without_threshold.length>0&&<p className="portal-muted">Без настроенного порога:{' '}
        {data.metrics_without_threshold.map(m=>data.metric_names[m]??m).join(', ')}</p>}

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
