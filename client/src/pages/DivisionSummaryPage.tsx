import React,{useEffect,useState} from 'react';
import { Link } from 'react-router-dom';
import { readDivisionSummary,type DivisionSummary } from '../api/metrics';
import { managerLabel,missingLabel } from '../components/divisionSummaryModel';
import { RagDot } from '../components/RagBadge';
import '../styles/branch-grid.css';

const monthStart=()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;};
const today=()=>new Date().toISOString().slice(0,10);

/**
 * Сводка отклонений по дивизиону ТЗ v2.12: экран руководителя верхнего уровня.
 * Показывает, где в его области красные и жёлтые показатели, по каким
 * отклонениям задача ещё не поставлена и какие задачи вышли за срок.
 * Отсутствие опубликованных данных показывается отдельно и не считается нулём.
 */
export default function DivisionSummaryPage() {
  const [start,setStart]=useState(monthStart());
  const [end,setEnd]=useState(today());
  const [division,setDivision]=useState('');
  const [data,setData]=useState<DivisionSummary|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [open,setOpen]=useState<string|null>(null);

  async function load() {
    setBusy(true);setError('');
    try{setData(await readDivisionSummary(start,end,division||undefined));}
    catch(err:any){setError(err?.message??'Не удалось прочитать сводку.');setData(null);}
    finally{setBusy(false);}
  }
  useEffect(()=>{void load();},[]);

  const names=data?.metric_names??{};

  return <section className="portal-panel">
    <div className="portal-section-head"><h1>Сводка отклонений по дивизиону</h1></div>
    <p className="portal-muted">Только опубликованные показатели в пределах ваших допусков. Филиал отнесён
      к дивизиону по подчинённости, действующей на дату конца периода, поэтому смена структуры не искажает
      историческую сводку.</p>

    <div className="beta-filters" role="group" aria-label="Период сводки">
      <label>Начало периода
        <input type="date" value={start} onChange={e=>setStart(e.target.value)} /></label>
      <label>Конец периода
        <input type="date" value={end} onChange={e=>setEnd(e.target.value)} /></label>
      <label>Дивизион (необязательно)
        <select value={division} onChange={e=>setDivision(e.target.value)}>
          <option value="">Все доступные</option>
          {(data?.divisions??[]).filter(d=>d.division_id)
            .map(d=><option key={d.division_id!} value={d.division_id!}>{d.division_name}</option>)}
        </select></label>
      <button className="btn" disabled={busy} onClick={()=>void load()}>Показать</button>
      <Link className="btn btn-ghost" to="/">К сетке филиалов</Link>
    </div>

    {error&&<p role="alert">{error}</p>}
    {busy&&!data&&<p>Читаю сводку…</p>}

    {data&&<>
      <p role="status" className="portal-muted">Дивизионов {data.totals.divisions} ·
        филиалов {data.totals.branches} · красных {data.totals.red} · жёлтых {data.totals.amber} ·
        отклонений без задачи {data.totals.deviations_without_task} ·
        задач в работе {data.totals.tasks_open}, из них просрочено {data.totals.tasks_overdue},
        срок близко {data.totals.tasks_due_soon}</p>
      <p className="portal-muted">Филиалов без опубликованных данных за период: {data.totals.branches_without_data}.
        Отсутствие публикации не считается нулём и не считается выполнением плана.
        {!data.thresholds_configured&&' Пороги не настроены: статусы не рассчитаны.'}</p>

      {data.divisions.length===0&&<p role="status">За выбранный период доступных данных нет.</p>}

      {data.divisions.map(d=>{
        const key=d.division_id??'UNASSIGNED';
        const expanded=open===key;
        return <section key={key} className="portal-panel">
          <div className="portal-section-head">
            <h2>{d.division_name}</h2>
            <button className="btn btn-ghost" aria-expanded={expanded}
              onClick={()=>setOpen(expanded?null:key)}>
              {expanded?'Свернуть филиалы':'Показать филиалы'}</button>
          </div>
          <p className="portal-muted">Филиалов {d.branches_total} · с данными {d.branches_with_data} ·
            без данных {d.branches_without_data} · красных {d.red} · жёлтых {d.amber} ·
            зелёных {d.green} · статус не определён {d.unknown}</p>
          <p className="portal-muted">Отклонений {d.deviations_total}, из них без поставленной
            задачи {d.deviations_without_task}. Задач в работе {d.tasks_open}:
            просрочено {d.tasks_overdue}, срок близко {d.tasks_due_soon}
            {' '}(близким считается срок в пределах {data.due_soon_hours} ч).</p>
          {d.metrics_without_threshold.length>0&&<p className="portal-muted" data-tone="warn">
            Порог не настроен: {d.metrics_without_threshold.map(m=>names[m]??m).join(', ')}.
            Статус по этим показателям не рассчитывается.</p>}

          {Object.keys(d.by_metric).length>0&&<div className="local-table-wrap">
            <table className="local-table">
              <thead><tr><th>Показатель</th><th>Красных филиалов</th><th>Жёлтых филиалов</th></tr></thead>
              <tbody>{Object.entries(d.by_metric)
                .sort((a,b)=>b[1].red-a[1].red||b[1].amber-a[1].amber)
                .map(([metric,v])=><tr key={metric}>
                  <td>{names[metric]??metric}</td><td>{v.red}</td><td>{v.amber}</td>
                </tr>)}</tbody>
            </table>
          </div>}

          <h3>Региональные менеджеры</h3>
          <div className="local-table-wrap">
            <table className="local-table">
              <thead><tr><th>Ответственный</th><th>Филиалов</th><th>Красных</th><th>Жёлтых</th>
                <th>Без задачи</th><th>Задач в работе</th><th>Просрочено</th></tr></thead>
              <tbody>{d.managers.map((m,i)=><tr key={m.user_id??`vacant-${i}`}>
                <td>{managerLabel(m)}{m.is_vacant&&<><br/><small className="portal-muted">
                  Назначение не закреплено: ответственность за территорию не определена</small></>}</td>
                <td>{m.branches_total}</td><td>{m.red}</td><td>{m.amber}</td>
                <td>{m.deviations_without_task}</td><td>{m.tasks_open}</td><td>{m.tasks_overdue}</td>
              </tr>)}</tbody>
            </table>
          </div>

          {expanded&&<div className="local-table-wrap" role="region"
            aria-label={`Филиалы: ${d.division_name}`} tabIndex={0}>
            <table className="local-table">
              <thead><tr><th>Статус</th><th>Филиал</th><th>Региональный менеджер</th>
                <th>Красные показатели</th><th>Жёлтые показатели</th><th>Без задачи</th>
                <th>Задачи</th><th>Данные</th></tr></thead>
              <tbody>{d.branches.map(b=><tr key={b.org_unit_id}>
                <td><RagDot status={b.rag}/></td>
                <td><Link to={`/branch-card/${b.org_unit_id}?start=${data.period_start}&end=${data.period_end}`}>
                  {b.display_name}</Link></td>
                <td>{managerLabel({full_name:b.regional_manager_name,
                  is_vacant:!b.regional_manager_user_id})}</td>
                <td>{b.red.map(m=>names[m]??m).join(', ')||'—'}</td>
                <td>{b.amber.map(m=>names[m]??m).join(', ')||'—'}</td>
                <td>{b.deviations_without_task}</td>
                <td>в работе {b.tasks_open} · просрочено {b.tasks_overdue} ·
                  срок близко {b.tasks_due_soon}</td>
                <td>{b.metrics_published.length} из {b.metrics_accessible}
                  {b.metrics_missing.length>0&&<><br/><small className="portal-muted">
                    {missingLabel(b.metrics_missing,names)}</small></>}</td>
              </tr>)}</tbody>
            </table>
          </div>}
        </section>;
      })}
    </>}
  </section>;
}
