import React, { useCallback, useEffect, useState } from 'react';
import { Link,useNavigate, useParams } from 'react-router-dom';
import { moscowToday } from '../api/dailyLogs';
import {
  getWorkItem,
  getWorkItemHistory,
  startWorkItem,
  patchWorkItemFields,
  submitWorkItem,
  acceptWorkItem,
  reworkWorkItem,
  cancelWorkItem,
  reopenWorkItem,
  assignWorkItem,
} from '../api/endpoints';
import type { WorkItem, HistoryEntry } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { apiFetch } from '../api/client';
import TaskFields from '../components/TaskFields';
import { hasUnsavedFields, mergeSavedFields, requiredFieldsPresent } from '../domain/taskForm';
import type { FieldDrafts } from '../domain/taskForm';

const EVENT_LABELS: Record<string, string> = {
  'work_item.created': 'Задача создана',
  'work_item.assigned': 'Назначен исполнитель',
  'work_item.started': 'Работа начата',
  'work_item.fields_patched': 'Изменён результат',
  'work_item.submitted': 'Сдано на проверку',
  'work_item.accepted': 'Принято',
  'work_item.rework_requested': 'Возвращено на доработку',
  'work_item.cancelled': 'Отменено',
  'work_item.reopened': 'Возобновлено',
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [item, setItem] = useState<WorkItem | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [drafts, setDrafts] = useState<FieldDrafts>({});
  const [showReasonFor, setShowReasonFor] = useState<null | 'cancel' | 'rework' | 'reopen'>(null);
  const [reason, setReason] = useState('');
  const [addToDaily,setAddToDaily]=useState(true);
  const [dailyDate,setDailyDate]=useState(moscowToday);
  const [assigneeId, setAssigneeId] = useState('');
  const [assignees, setAssignees] = useState<Array<{id: string; full_name: string; login: string}>>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [wi, hist] = await Promise.all([getWorkItem(id), getWorkItemHistory(id, { limit: 100 })]);
      setItem(wi);
      setDailyDate(wi.current_business_date??moscowToday());
      setHistory(hist.items);
      setDrafts(mergeSavedFields({}, wi.fields));
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить задачу.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const grants = me?.grants ?? [];
  const isRm = item ? grants.some((g) => g.role === 'REGIONAL_MANAGER' && g.org_unit_id === item.org_unit_id) : false;
  // Any non-REGIONAL_MANAGER operational role held at this org unit --
  // not hardcoded to 'RF' (generalized 2026-09-18 to match the server's
  // role-agnostic authorization; a ROP/ROO assignee's own item hid its
  // fields/actions before this fix, even though the server already
  // permitted them). The server remains authoritative on the exact
  // required role per action; this only decides whether to render the
  // executor controls at all.
  const isOwnExecutor = item
    ? grants.some((g) => g.role === item.owner_role && g.org_unit_id === item.org_unit_id)
      && item.assignee_user_id === me?.user.id
    : false;
  const dirty = hasUnsavedFields(drafts);
  // Personal diary autosaves one independently versioned field at a time.
  // Empty required text remains visibly unsaved instead of generating failures.
  useEffect(()=>{
    if(!item?.daily_log?.can_fill||!isOwnExecutor||!['ASSIGNED','IN_PROGRESS'].includes(item.status)||actionBusy||error)return;
    const entry=Object.entries(drafts).find(([,d])=>d.value!==d.baseValue&&d.value.trim().length>0);
    if(!entry)return;
    const [path,draft]=entry;
    const timer=window.setTimeout(()=>{runAction(()=>patchWorkItemFields(item.id,{changes:[{field_path:path,expected_version:draft.version,new_value:draft.value}]}),path);},700);
    return()=>window.clearTimeout(timer);
  },[drafts,item?.id,item?.daily_log?.can_fill,item?.status,isOwnExecutor,actionBusy,error]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const navigation = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('a[href]') && !window.confirm('Есть несохранённые поля. Покинуть карточку без сохранения?')) {
        e.preventDefault(); e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigation, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigation, true); };
  }, [dirty]);
  useEffect(() => {
    if (!item || !isRm || item.status !== 'DRAFT') return;
    let live = true;
    apiFetch<{items: Array<{id: string; full_name: string; login: string}>}>(`/work-items/${item.id}/eligible-assignees`)
      .then(data => { if (live) setAssignees(data.items); })
      .catch(err => { if (live) setError(err.message ?? 'Не удалось загрузить исполнителей.'); });
    return () => { live = false; };
  }, [item?.id, item?.status, isRm]);

  async function runAction(fn: () => Promise<WorkItem>, savedPath?: string) {
    if (dirty && !savedPath) { setError('Сначала сохраните изменённые поля.'); return; }
    setActionBusy(true);
    setError(null);
    try {
      const updated = await fn();
      setItem(updated);
      setDrafts(current => mergeSavedFields(current, updated.fields, savedPath));
      const hist = await getWorkItemHistory(updated.id, { limit: 100 });
      setHistory(hist.items);
    } catch (err: any) {
      setError(err?.message ?? 'Действие не удалось выполнить.');
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) return <div style={{ color: 'var(--fresh-text-muted)' }}>Загрузка…</div>;
  if (error && !item) return <div role="alert" style={{ color: 'var(--fresh-danger)' }}>{error}</div>;
  if (!item) return null;

  return (
    <div className="task-detail-page" style={{ maxWidth: 900 }}>
      <button onClick={() => { if (!dirty || window.confirm('Покинуть карточку без сохранения полей?')) navigate('/tasks'); }} style={backBtn}>
        ← К списку задач
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 20, margin: 0, color: 'var(--fresh-dark)' }}>{item.title}</h1>
          <div style={{ fontSize: 13, color: 'var(--fresh-text-muted)', marginTop: 6 }}>
            Срок: {new Date(item.due_at).toLocaleString('ru-RU', {timeZone: 'Europe/Moscow'})} МСК · Версия: {item.entity_version}
            {item.rework_count > 0 && ` · Доработок: ${item.rework_count}`}
          </div>
        </div>
        <StatusBadge status={item.status} />
      </div>

      {item.is_blocked && item.blocked_reason && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--fresh-warning-bg)', color: 'var(--fresh-warning)', borderRadius: 8, fontSize: 13 }}>
          Заблокировано: {item.blocked_reason}
        </div>
      )}

      {error && <div role="alert" style={{ color: 'var(--fresh-danger)', marginTop: 14, fontSize: 13 }}>{error}
        <p>Введённые поля остаются в этой карточке. При конфликте скопируйте свой текст перед загрузкой актуальной версии.</p>
        <button disabled={actionBusy} onClick={() => { if (!dirty || window.confirm('Загрузить серверную версию и отбросить несохранённые поля?')) load(); }}>Загрузить актуальную версию</button>
      </div>}

      {item.daily_log&&<section style={card}><h2 style={cardTitle}>Личная дневная запись · {item.daily_log.business_date}</h2>
        <p>Роль {item.daily_log.role_code}. Основное хранилище: PostgreSQL. Синхронизация с Диском не требуется.</p>
        <p>Окно заполнения: {new Date(item.daily_log.window_open).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} — {new Date(item.daily_log.window_close).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК.</p>
        {!item.daily_log.can_fill&&<p>Окно закрыто: запись доступна для чтения, отправка и сохранение запрещены.</p>}
        <Link to="/diary">Вернуться к ежедневникам →</Link>
        {item.daily_links?.map(l=><article key={l.submission_id}><h3><Link to={`/tasks/${l.work_item_id}`}>{l.title}</Link> · сдача v{l.revision}</h3><p style={{whiteSpace:'pre-wrap'}}>{l.completion_summary}</p><small>Текущий статус задачи: {l.current_task_status}. Текст снимка неизменен.</small></article>)}
      </section>}

      <section style={card}>
        <h2 style={cardTitle}>Результат выполнения</h2>
        <TaskFields item={item} drafts={drafts} editable={isOwnExecutor && ['ASSIGNED','IN_PROGRESS'].includes(item.status) && item.daily_log?.can_fill!==false}
          busy={actionBusy}
          onChange={(path,value) => {setError(null);setDrafts(current => ({...current,[path]:{...current[path],value}}));}}
          onSave={path => {
            const draft = drafts[path];
            if (!draft) return;
            runAction(() => patchWorkItemFields(item.id, {changes:[{field_path:path,expected_version:draft.version,new_value:draft.value}]}), path);
          }}/>
        {dirty && <p role="status" style={{color:'var(--fresh-warning)',fontSize:13}}>Есть несохранённые поля. Сдача и смена статуса доступны после сохранения.</p>}
        {item.daily_log&&<p style={{fontSize:13,color:'var(--fresh-text-muted)'}}>Непустые поля автоматически сохраняются через 0,7 секунды после ввода. При ошибке текст остаётся в форме: повторите сохранение или загрузите актуальную версию.</p>}
      </section>

      <section style={card}>
        <h2 style={cardTitle}>Действия</h2>
        {isOwnExecutor&&!item.daily_log&&['RF','ROP','ROO'].includes(item.owner_role??'')&&['ASSIGNED','IN_PROGRESS'].includes(item.status)&&<div style={{marginBottom:16}}>
          <label style={{display:'block',padding:'12px 0'}}><input type="checkbox" checked={addToDaily} onChange={e=>setAddToDaily(e.target.checked)}/> Добавить в мой ежедневник</label>
          {addToDaily&&<label>Дата результата <input aria-label="Дата результата" type="date" value={dailyDate} onChange={e=>setDailyDate(e.target.value)}/></label>}
          <p style={{fontSize:13,color:'var(--fresh-text-muted)'}}>Снимок отправленной версии, не отметка о приёмке. Если окно не настроено или ежедневник закрыт, сервер не выполнит отправку частично.</p>
        </div>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isRm && item.status === 'DRAFT' && (
            <>
              <select
                aria-label="Исполнитель"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                style={{ padding: '9px 12px', minHeight: 44, borderRadius: 8, border: '1px solid var(--fresh-border)', fontSize: 13, width: '100%', maxWidth: 360 }}
              >
                <option value="">Выберите исполнителя</option>
                {assignees.map(a => <option key={a.id} value={a.id}>{a.full_name} ({a.login})</option>)}
              </select>
              <button
                disabled={actionBusy || !assigneeId.trim()}
                onClick={() => runAction(() => assignWorkItem(item.id, { expected_entity_version: item.entity_version, assignee_user_id: assigneeId.trim() }))}
                style={primaryBtn(actionBusy)}
              >
                Назначить
              </button>
            </>
          )}

          {isOwnExecutor && item.status === 'ASSIGNED' && (
            <button disabled={actionBusy || dirty || item.daily_log?.can_fill===false} onClick={() => runAction(() => startWorkItem(item.id, { expected_entity_version: item.entity_version }))} style={primaryBtn(actionBusy)}>
              Начать работу
            </button>
          )}

          {isOwnExecutor && ['ASSIGNED', 'IN_PROGRESS'].includes(item.status) && !item.is_blocked && (
            <button
              disabled={actionBusy || dirty || item.daily_log?.can_fill===false || !requiredFieldsPresent(item.field_schema, item.fields)}
              onClick={() => runAction(() => submitWorkItem(item.id, { expected_entity_version: item.entity_version,
                ...(!item.daily_log&&['RF','ROP','ROO'].includes(item.owner_role??'')?{add_to_daily_log:addToDaily,business_date:dailyDate}:{}) }))}
              style={primaryBtn(actionBusy)}
              title={dirty ? 'Сначала сохраните изменения' : 'Сервер проверит все обязательные поля'}
            >
              Сдать на проверку
            </button>
          )}

          {isRm && !isOwnExecutor && item.status === 'SUBMITTED' && item.current_submission && (
            <>
              <button
                disabled={actionBusy}
                onClick={() =>
                  runAction(() =>
                    acceptWorkItem(item.id, {
                      expected_entity_version: item.entity_version,
                      submission_id: item.current_submission!.id,
                      submission_revision: item.current_submission!.revision,
                    }),
                  )
                }
                style={primaryBtn(actionBusy)}
              >
                Принять
              </button>
              <button disabled={actionBusy} onClick={() => setShowReasonFor('rework')} style={secondaryBtn}>
                Вернуть на доработку
              </button>
            </>
          )}

          {isRm && item.status === 'COMPLETED' && (
            <button disabled={actionBusy} onClick={() => setShowReasonFor('reopen')} style={secondaryBtn}>
              Возобновить
            </button>
          )}

          {isRm && ['DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED'].includes(item.status) && (
            <button disabled={actionBusy} onClick={() => setShowReasonFor('cancel')} style={dangerBtn}>
              Отменить задачу
            </button>
          )}

          {!isRm && !isOwnExecutor && (
            <span style={{ color: 'var(--fresh-text-muted)', fontSize: 13 }}>Нет доступных действий для вашей роли по этой задаче.</span>
          )}
        </div>
      </section>

      {showReasonFor && (
        <ReasonModal
          title={
            showReasonFor === 'cancel' ? 'Отменить задачу' : showReasonFor === 'rework' ? 'Вернуть на доработку' : 'Возобновить задачу'
          }
          reason={reason}
          setReason={setReason}
          busy={actionBusy}
          onClose={() => {
            setShowReasonFor(null);
            setReason('');
          }}
          onConfirm={async () => {
            const r = reason.trim();
            if (!r) return;
            if (showReasonFor === 'cancel') {
              await runAction(() => cancelWorkItem(item.id, { expected_entity_version: item.entity_version, reason: r }));
            } else if (showReasonFor === 'rework' && item.current_submission) {
              await runAction(() =>
                reworkWorkItem(item.id, {
                  expected_entity_version: item.entity_version,
                  submission_id: item.current_submission!.id,
                  submission_revision: item.current_submission!.revision,
                  reason: r,
                }),
              );
            } else if (showReasonFor === 'reopen') {
              await runAction(() => reopenWorkItem(item.id, { expected_entity_version: item.entity_version, reason: r }));
            }
            setShowReasonFor(null);
            setReason('');
          }}
        />
      )}

      <section style={card}>
        <h2 style={cardTitle}>История</h2>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {history.length === 0 && <span style={{ color: 'var(--fresh-text-muted)', fontSize: 13 }}>Событий пока нет.</span>}
          {history.map((h) => (
            <div key={h.event_id} style={{ borderLeft: '2px solid var(--fresh-border)', paddingLeft: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fresh-dark)' }}>{EVENT_LABELS[h.event_type] ?? h.event_type}</div>
              <div style={{ fontSize: 12, color: 'var(--fresh-text-muted)', marginTop: 2 }}>{new Date(h.occurred_at).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'})} МСК</div>
              {h.reason && <div style={{ fontSize: 12, color: 'var(--fresh-dark)', marginTop: 4, overflowWrap: 'anywhere' }}>Причина: {h.reason}</div>}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function ReasonModal({
  title,
  reason,
  setReason,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40, padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '100%', background: 'var(--fresh-surface)', border: '1px solid var(--fresh-border)', borderRadius: 16, padding: 26 }}>
        <h3 style={{ marginTop: 0, fontSize: 20, color: 'var(--fresh-dark)' }}>{title}</h3>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Укажите причину…"
          aria-label="Причина" autoFocus
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--fresh-border)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={secondaryBtn}>
            Отмена
          </button>
          <button disabled={busy || !reason.trim()} onClick={onConfirm} style={primaryBtn(busy)}>
            Подтвердить
          </button>
        </div>
      </div>
    </div>
  );
}

const backBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--fresh-link)', fontSize: 13, fontWeight: 500, cursor: 'pointer', padding: 0, minHeight: 44 };
const card: React.CSSProperties = { background: 'var(--fresh-surface)', border: '1px solid var(--fresh-border)', borderRadius: 12, padding: 20, marginTop: 18 };
const cardTitle: React.CSSProperties = { fontSize: 20, margin: 0, marginBottom: 14, color: 'var(--fresh-dark)' };
function primaryBtn(disabled: boolean): React.CSSProperties {
  return { minHeight: 44, padding: '9px 16px', borderRadius: 16, border: 'none', background: '#003DFF', color: '#fff', fontWeight: 500, fontSize: 13, cursor: disabled ? 'default' : 'pointer' };
}
const secondaryBtn: React.CSSProperties = { minHeight: 44, padding: '9px 16px', borderRadius: 16, border: '1px solid var(--fresh-border)', background: 'var(--fresh-surface)', color: 'var(--fresh-dark)', fontWeight: 500, fontSize: 13, cursor: 'pointer' };
const dangerBtn: React.CSSProperties = { minHeight: 44, padding: '9px 16px', borderRadius: 16, border: '1px solid var(--fresh-border)', background: 'var(--fresh-surface)', color: 'var(--fresh-danger)', fontWeight: 500, fontSize: 13, cursor: 'pointer' };
