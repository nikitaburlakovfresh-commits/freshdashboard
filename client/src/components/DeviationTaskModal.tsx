import React,{useEffect,useState} from 'react';
import { createDeviationTask,type MetricCell } from '../api/metrics';

/**
 * Основание отклонения, достаточное для постановки задачи. Одинаково подходит и
 * карточке филиала, и строке сводки по дивизиону: обязательна версия снимка,
 * потому что сервер заново проверяет отклонение именно по ней.
 */
export type DeviationCellView=Pick<MetricCell,'metric'|'metric_name'|'value'|'unit'|'rag'
  |'basis'|'basis_value'|'threshold_id'|'revision'|'snapshot_id'>;
import { listTaskTemplates } from '../api/endpoints';
import type { TaskTemplate } from '../api/types';
import { formatValue,ragReason,RAG_LABELS } from './metricThresholdModel';
import { defaultTitle,draftError,dueIso,type DeviationDraft } from './deviationTaskModel';

/**
 * Переход управленческого цикла ТЗ v2.12: отклонение показателя → задача
 * ответственному. Клиент передаёт версию снимка и статус, а сервер заново
 * проверяет отклонение по текущим данным и порогам.
 */
export default function DeviationTaskModal({branch,branchName,period,cell,onClose,onCreated}:{
  branch:string; branchName:string; period:{start:string;end:string}; cell:DeviationCellView;
  onClose:()=>void; onCreated:(workItemId:string)=>void;
}) {
  const [templates,setTemplates]=useState<TaskTemplate[]>([]);
  const [draft,setDraft]=useState<DeviationDraft>({template_code:'pilot_task_v1',
    title:defaultTitle(branchName,cell),due_date:'',
    reason:`Отклонение ${cell.metric_name} за период ${period.start} — ${period.end}: `});
  const [error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false);
  useEffect(()=>{let live=true;
    listTaskTemplates().then(d=>{if(live)setTemplates(d.items);})
      .catch(e=>{if(live)setError(e?.message??'Не удалось загрузить шаблоны задач.');});
    return()=>{live=false;};},[]);
  const set=(patch:Partial<DeviationDraft>)=>setDraft(d=>({...d,...patch}));

  async function submit(e:React.FormEvent) {
    e.preventDefault();
    const invalid=draftError(draft);
    if(invalid){setError(invalid);return;}
    setBusy(true);setError(null);
    try{
      const r=await createDeviationTask({org_unit_id:branch,metric:cell.metric,
        period_start:period.start,period_end:period.end,snapshot_id:cell.snapshot_id,
        expected_rag:cell.rag as 'RED'|'AMBER',template_code:draft.template_code,
        title:draft.title.trim(),due_at:dueIso(draft.due_date)!,reason:draft.reason.trim()});
      onCreated(r.work_item_id);
    }catch(err:any){setError(err?.message??'Не удалось поставить задачу.');}
    finally{setBusy(false);}
  }

  return <div className="portal-modal-backdrop" onClick={onClose} role="presentation">
    <form className="portal-modal" onClick={e=>e.stopPropagation()} onSubmit={submit}
      role="dialog" aria-modal="true" aria-label="Задача по отклонению показателя">
      <h3>Задача по отклонению</h3>
      <p className="portal-muted">{branchName} · {cell.metric_name} · {formatValue(cell.value,cell.unit)} ·{' '}
        {RAG_LABELS[cell.rag]} · версия v{cell.revision}</p>
      <p className="portal-muted">{ragReason(cell)}</p>
      <label>Шаблон задачи
        <select value={draft.template_code} onChange={e=>set({template_code:e.target.value})}>
          {templates.length===0&&<option value="pilot_task_v1">pilot_task_v1</option>}
          {templates.map(t=><option key={t.code} value={t.code}>{t.display_name??t.code}</option>)}
        </select>
      </label>
      <label>Название задачи
        <input value={draft.title} maxLength={200} onChange={e=>set({title:e.target.value})}/>
      </label>
      <label>Срок выполнения
        <input type="date" value={draft.due_date} onChange={e=>set({due_date:e.target.value})}/>
      </label>
      <label>Основание постановки
        <textarea value={draft.reason} rows={3} maxLength={500} onChange={e=>set({reason:e.target.value})}/>
      </label>
      <p className="portal-muted">Ответственный не назначается автоматически: назначьте его в карточке задачи,
        чтобы исполнитель соответствовал роли шаблона.</p>
      {error&&<p role="alert">{error}</p>}
      <div className="portal-modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
        <button className="btn" disabled={busy}>{busy?'Ставлю задачу…':'Поставить задачу'}</button>
      </div>
    </form>
  </div>;
}
