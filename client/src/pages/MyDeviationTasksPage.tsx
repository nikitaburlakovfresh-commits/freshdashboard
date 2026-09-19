import React,{useEffect,useState} from 'react';
import { Link } from 'react-router-dom';
import { readMyDeviationTasks,type MyDeviationTasks } from '../api/metrics';
import { RAG_LABELS } from '../components/metricThresholdModel';
import { DUE_LABELS,dueTone,basisLabel } from '../components/myDeviationTasksModel';
import { RagDot } from '../components/RagBadge';
import '../styles/branch-grid.css';

/**
 * «Мои задачи по отклонениям» ТЗ v2.12: рабочий экран ответственного. Показывает
 * только задачи, где пользователь является ответственным, с основанием
 * отклонения и фактическим сроком. Цифры показателя раскрываются лишь при
 * наличии отдельного допуска — иначе видно основание без значений.
 */
export default function MyDeviationTasksPage() {
  const [state,setState]=useState<'OPEN'|'ALL'>('OPEN');
  const [data,setData]=useState<MyDeviationTasks|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);

  async function load(next:'OPEN'|'ALL'=state) {
    setBusy(true);setError('');
    try{setData(await readMyDeviationTasks(next));}
    catch(err:any){setError(err?.message??'Не удалось прочитать перечень задач.');setData(null);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void load(state);},[state]);

  return <section className="portal-panel">
    <div className="portal-section-head"><h1>Мои задачи по отклонениям</h1></div>
    <p className="portal-muted">Задачи, где ответственный — вы. Основание фиксируется на момент постановки и
      не меняется при последующих публикациях показателя.</p>
    <div className="beta-filters" role="group" aria-label="Состояние задач">
      <button className={`btn${state==='OPEN'?'':' btn-ghost'}`} aria-pressed={state==='OPEN'}
        onClick={()=>setState('OPEN')}>В работе</button>
      <button className={`btn${state==='ALL'?'':' btn-ghost'}`} aria-pressed={state==='ALL'}
        onClick={()=>setState('ALL')}>Все, включая закрытые</button>
      <button className="btn btn-ghost" disabled={busy} onClick={()=>void load()}>Обновить</button>
      <Link className="btn btn-ghost" to="/">К сетке филиалов</Link>
    </div>
    {error&&<p role="alert">{error}</p>}
    {busy&&!data&&<p>Читаю перечень…</p>}
    {data&&<>
      <p role="status" className="portal-muted">Всего {data.counts.total} ·
        срок истёк {data.counts.overdue} · срок близко {data.counts.due_soon} ·
        приостановлено {data.counts.blocked}</p>
      <p className="portal-muted">Срок считается близким за {data.due_soon_hours} ч до срока задачи.
        Значение настраивается в разделе «Уведомления и сроки».</p>
      {data.items.length===0&&<p role="status">{state==='OPEN'
        ?'Задач по отклонениям в работе нет.'
        :'Задачи по отклонениям на вас не ставились.'}</p>}
      {data.items.length>0&&<div className="local-table-wrap" role="region"
        aria-label="Мои задачи по отклонениям" tabIndex={0}>
        <table className="local-table">
          <thead><tr><th>Срок</th><th>Задача</th><th>Филиал</th><th>Показатель</th><th>Период</th>
            <th>Основание</th><th>Состояние</th></tr></thead>
          <tbody>{data.items.map(t=><tr key={t.id}>
            <td data-tone={dueTone(t.due_state)}>{DUE_LABELS[t.due_state]}
              <br/><small className="portal-muted">{t.due_at.slice(0,10)}</small></td>
            <td><Link to={`/tasks/${t.work_item_id}`}>{t.title}</Link></td>
            <td><Link to={`/branch-card/${t.org_unit_id}?start=${t.period_start}&end=${t.period_end}`}>
              {t.branch_name}</Link></td>
            <td><RagDot status={t.rag}/>{t.metric_name}
              <br/><small className="portal-muted">{RAG_LABELS[t.rag]} на момент постановки</small></td>
            <td>{t.period_start} — {t.period_end}</td>
            <td>{basisLabel(t)}<br/><small className="portal-muted">{t.reason}</small></td>
            <td>{t.status}{t.is_blocked&&<><br/><small data-tone="warn">Приостановлена:
              {' '}{t.blocked_reason}</small></>}</td>
          </tr>)}</tbody>
        </table>
      </div>}
    </>}
  </section>;
}
