import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
  const [summaryDraft, setSummaryDraft] = useState('');
  const [showReasonFor, setShowReasonFor] = useState<null | 'cancel' | 'rework' | 'reopen'>(null);
  const [reason, setReason] = useState('');
  const [assigneeId, setAssigneeId] = useState('');
  const [assignees, setAssignees] = useState<Array<{id: string; full_name: string; login: string}>>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [wi, hist] = await Promise.all([getWorkItem(id), getWorkItemHistory(id, { limit: 100 })]);
      setItem(wi);
      setHistory(hist.items);
      setSummaryDraft(wi.fields[0]?.value ?? '');
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
  const isOwnRf = item ? grants.some((g) => g.role === 'RF' && g.org_unit_id === item.org_unit_id) && item.assignee_user_id === me?.user.id : false;
  const dirty = summaryDraft !== (item?.fields[0]?.value ?? '');
  useEffect(() => {
    if (!item || !isRm || item.status !== 'DRAFT') return;
    let live = true;
    apiFetch<{items: Array<{id: string; full_name: string; login: string}>}>(`/work-items/${item.id}/eligible-assignees`)
      .then(data => { if (live) setAssignees(data.items); })
      .catch(err => { if (live) setError(err.message ?? 'Не удалось загрузить исполнителей.'); });
    return () => { live = false; };
  }, [item?.id, item?.status, isRm]);

  async function runAction(fn: () => Promise<WorkItem>) {
    setActionBusy(true);
    setError(null);
    try {
      const updated = await fn();
      setItem(updated);
      setSummaryDraft(updated.fields[0]?.value ?? '');
      const hist = await getWorkItemHistory(updated.id, { limit: 100 });
      setHistory(hist.items);
    } catch (err: any) {
      setError(err?.message ?? 'Действие не удалось выполнить.');
    } finally {
      setActionBusy(false);
    }
  }

  if (loading) return <div style={{ color: '#6b7280' }}>Загрузка…</div>;
  if (error && !item) return <div style={{ color: '#D92D20' }}>{error}</div>;
  if (!item) return null;

  return (
    <div style={{ maxWidth: 760 }}>
      <button onClick={() => navigate('/tasks')} style={backBtn}>
        ← К списку задач
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginTop: 12 }}>
        <div>
          <h1 style={{ fontSize: 20, margin: 0, color: '#292D34' }}>{item.title}</h1>
          <div style={{ fontSize: 13, color: '#6b7280', marginTop: 6 }}>
            Срок: {new Date(item.due_at).toLocaleString('ru-RU', {timeZone: 'UTC'})} UTC · Версия: {item.entity_version}
            {item.rework_count > 0 && ` · Доработок: ${item.rework_count}`}
          </div>
        </div>
        <StatusBadge status={item.status} />
      </div>

      {item.is_blocked && item.blocked_reason && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: '#FEF0C7', color: '#B54708', borderRadius: 8, fontSize: 13 }}>
          Заблокировано: {item.blocked_reason}
        </div>
      )}

      {error && <div style={{ color: '#D92D20', marginTop: 14, fontSize: 13 }}>{error}</div>}

      <section style={card}>
        <h2 style={cardTitle}>Результат выполнения</h2>
        {isOwnRf && ['ASSIGNED', 'IN_PROGRESS'].includes(item.status) ? (
          <>
            <textarea
              value={summaryDraft}
              onChange={(e) => setSummaryDraft(e.target.value)}
              rows={5}
              style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #E2E4E9', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
              placeholder="Опишите, что сделано…"
            />
            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <button
                disabled={actionBusy || !summaryDraft.trim() || Array.from(summaryDraft).length > 4000 || !dirty}
                onClick={() =>
                  runAction(() =>
                    patchWorkItemFields(item.id, {
                      changes: [{ field_path: 'completion_summary', expected_version: item.fields[0].field_version, new_value: summaryDraft }],
                    }),
                  )
                }
                style={primaryBtn(actionBusy)}
              >
                Сохранить результат
              </button>
            </div>
            <p style={{fontSize:12,color:dirty?'#964219':'#52616b'}} aria-live="polite">
              {actionBusy ? 'Сохранение…' : dirty ? 'Есть несохранённые изменения' : item.fields[0]?.value ? 'Результат сохранён' : 'Заполните результат перед сдачей'}
              {' · '}{Array.from(summaryDraft).length}/4000
            </p>
          </>
        ) : (
          <p style={{ fontSize: 14, color: item.fields[0]?.value ? '#292D34' : '#9CA3AF', whiteSpace: 'pre-wrap' }}>
            {item.fields[0]?.value ?? 'Результат ещё не заполнен.'}
          </p>
        )}
      </section>

      <section style={card}>
        <h2 style={cardTitle}>Действия</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isRm && item.status === 'DRAFT' && (
            <>
              <select
                aria-label="Исполнитель"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                style={{ padding: '9px 12px', borderRadius: 8, border: '1px solid #E2E4E9', fontSize: 13, width: '100%', maxWidth: 360 }}
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

          {isOwnRf && item.status === 'ASSIGNED' && (
            <button disabled={actionBusy} onClick={() => runAction(() => startWorkItem(item.id, { expected_entity_version: item.entity_version }))} style={primaryBtn(actionBusy)}>
              Начать работу
            </button>
          )}

          {isOwnRf && ['ASSIGNED', 'IN_PROGRESS'].includes(item.status) && !item.is_blocked && (
            <button
              disabled={actionBusy || dirty || !item.fields[0]?.value?.trim()}
              onClick={() => runAction(() => submitWorkItem(item.id, { expected_entity_version: item.entity_version }))}
              style={primaryBtn(actionBusy)}
              title={dirty ? 'Сначала сохраните изменения' : !item.fields[0]?.value ? 'Заполните результат перед сдачей' : undefined}
            >
              Сдать на проверку
            </button>
          )}

          {isRm && !isOwnRf && item.status === 'SUBMITTED' && item.current_submission && (
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

          {!isRm && !isOwnRf && (
            <span style={{ color: '#6b7280', fontSize: 13 }}>Нет доступных действий для вашей роли по этой задаче.</span>
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
          {history.length === 0 && <span style={{ color: '#6b7280', fontSize: 13 }}>Событий пока нет.</span>}
          {history.map((h) => (
            <div key={h.event_id} style={{ borderLeft: '2px solid #E2E4E9', paddingLeft: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#292D34' }}>{EVENT_LABELS[h.event_type] ?? h.event_type}</div>
              <div style={{ fontSize: 12, color: '#6b7280', marginTop: 2 }}>{new Date(h.occurred_at).toLocaleString('ru-RU', {timeZone:'UTC'})} UTC</div>
              {h.reason && <div style={{ fontSize: 12, color: '#292D34', marginTop: 4 }}>Причина: {h.reason}</div>}
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
      <div onClick={(e) => e.stopPropagation()} style={{ width: 420, background: '#fff', borderRadius: 16, padding: 26 }}>
        <h3 style={{ marginTop: 0, fontSize: 16, color: '#292D34' }}>{title}</h3>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Укажите причину…"
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid #E2E4E9', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
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

const backBtn: React.CSSProperties = { background: 'none', border: 'none', color: '#003DFF', fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: 0 };
const card: React.CSSProperties = { background: '#fff', border: '1px solid #E2E4E9', borderRadius: 12, padding: 20, marginTop: 18 };
const cardTitle: React.CSSProperties = { fontSize: 14, margin: 0, marginBottom: 14, color: '#292D34' };
function primaryBtn(disabled: boolean): React.CSSProperties {
  return { padding: '9px 16px', borderRadius: 8, border: 'none', background: disabled ? '#A9B8FF' : '#003DFF', color: '#fff', fontWeight: 600, fontSize: 13, cursor: disabled ? 'default' : 'pointer' };
}
const secondaryBtn: React.CSSProperties = { padding: '9px 16px', borderRadius: 8, border: '1px solid #E2E4E9', background: '#fff', color: '#292D34', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
const dangerBtn: React.CSSProperties = { padding: '9px 16px', borderRadius: 8, border: '1px solid #FEE4E2', background: '#fff', color: '#D92D20', fontWeight: 600, fontSize: 13, cursor: 'pointer' };
