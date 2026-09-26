import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { listWorkItems } from '../api/endpoints';
import type { WorkItem, WorkItemStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import StatusBadge from '../components/StatusBadge';
import CreateTaskModal from './CreateTaskModal';
import { displayTitle } from '../domain/taskTitle';
import { useOrgNames } from '../state/orgNames';
import DirectTaskDialog from '../components/DirectTaskDialog';
import { getAssignOptions, type AssignScope } from '../api/directTasks';
import '../styles/task-fields.css';

const METRIC_RU: Record<string,string> = { sales:'продажи', margin:'маржа', kso:'КСО', revenue:'выручка',
  suppliesFact:'поставки', stock:'склад', stockTurnover:'оборачиваемость', buyback45Share:'45+', creditShareFact:'доля кредита' };
const RAG_RU: Record<string,string> = { RED:'красная зона', AMBER:'жёлтая зона', GREEN:'зелёная зона' };

const STATUS_OPTIONS: { value: WorkItemStatus | ''; label: string }[] = [
  { value: '', label: 'Все статусы' },
  { value: 'DRAFT', label: 'Черновик' },
  { value: 'ASSIGNED', label: 'Назначена' },
  { value: 'IN_PROGRESS', label: 'В работе' },
  { value: 'SUBMITTED', label: 'На проверке' },
  { value: 'COMPLETED', label: 'Выполнена' },
  { value: 'CANCELLED', label: 'Отменена' },
];

export default function TaskListPage() {
  const orgUnitLabel = useOrgNames();
  const { me } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [params,setParams]=useSearchParams();
  const rawStatus=params.get('status')??'';
  const status:WorkItemStatus|''=STATUS_OPTIONS.some(x=>x.value===rawStatus)?rawStatus as WorkItemStatus|'':'';
  const setStatus=(value:WorkItemStatus|'')=>setParams(value?{status:value}:{});
  const [orgFilter, setOrgFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [scopes, setScopes] = useState<AssignScope[]>([]);
  const [showDirect, setShowDirect] = useState(false);
  useEffect(() => { getAssignOptions().then(r => setScopes(r.scopes)).catch(() => setScopes([])); }, []);
  const canDirect = scopes.some(s => s.people.length > 0 || s.uk_request);

  const grants = me?.grants ?? [];
  const canCreate = grants.some((g) => g.role === 'REGIONAL_MANAGER');
  const orgOptions = Array.from(new Set(grants.map((g) => g.org_unit_id).filter((id):id is string=>id!==null)));

  const load = useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listWorkItems({
          status: status || undefined,
          org_unit_id: orgFilter || undefined,
          cursor: nextCursor,
          limit: 50,
        });
        setItems((prev) => (nextCursor ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (err: any) {
        setError(err?.message ?? 'Не удалось загрузить список задач.');
      } finally {
        setLoading(false);
      }
    },
    [status, orgFilter],
  );

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="task-list-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0, color: 'var(--fresh-dark)' }}>Задачи</h1>
        <div style={{ display:'flex', gap:8, flexWrap:'wrap' }}>
        {canDirect && <button onClick={() => setShowDirect(true)} style={createBtn}>+ Поставить задачу</button>}
        {canCreate && (
          <button onClick={() => setShowCreate(true)} style={createBtn}>
            + Новая задача
          </button>
        )}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <select aria-label="Статус задачи" value={status} onChange={(e) => setStatus(e.target.value as WorkItemStatus | '')} style={filterStyle}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {orgOptions.length > 1 && (
          <select aria-label="Контур задач" value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)} style={filterStyle}>
            <option value="">Все доступные филиалы</option>
            {orgOptions.map((org) => (
              <option key={org} value={org}>
                {orgUnitLabel(org)}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <div role="alert" style={{ color: 'var(--fresh-danger)', marginBottom: 12 }}>{error}</div>}

      {loading && items.length === 0 ? (
        <div style={{ color: 'var(--fresh-text-muted)' }}>Загрузка…</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--fresh-text-muted)', padding: '40px 0', textAlign: 'center' }}>Нет задач по выбранным фильтрам.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => (
            <div
              key={item.id}
              className="task-list-row" role="link" tabIndex={0}
              onKeyDown={e => { if (e.key === 'Enter') navigate(`/tasks/${item.id}`); }}
              onClick={() => navigate(`/tasks/${item.id}`)}
              style={{
                background: 'var(--fresh-surface)',
                border: '1px solid var(--fresh-border)',
                borderRadius: 12,
                padding: '14px 18px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 500, fontSize: 14, color: 'var(--fresh-dark)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{displayTitle(item.title, item.owner_role)}</div>
                <div style={{ fontSize: 12, color: 'var(--fresh-text-muted)', marginTop: 4 }}>
                  Срок: {new Date(item.due_at).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'})} МСК
                  {item.rework_count > 0 && ` · доработок: ${item.rework_count}`}
                </div>
                {(()=>{const l=(item as any).labels; if(!l) return null;
                  const chips=[
                    l.deviation&&<span key="d" className="task-label" data-kind="deviation" data-rag={l.deviation.rag}>
                      Отклонение · {METRIC_RU[l.deviation.metric]??l.deviation.metric}{RAG_RU[l.deviation.rag]?`, ${RAG_RU[l.deviation.rag]}`:''}</span>,
                    l.mbo&&<span key="m" className="task-label" data-kind="mbo">МБО</span>,
                    l.uk_request&&<span key="u" className="task-label" data-kind="uk">Запрос в УК</span>,
                    l.created_by_me&&<span key="c" className="task-label" data-kind="mine">Поставлена мной</span>,
                  ].filter(Boolean);
                  return chips.length?<div className="task-labels">{chips}</div>:null;})()}
              </div>
              <StatusBadge status={item.status} />
            </div>
          ))}
        </div>
      )}

      {cursor && (
        <button onClick={() => load(cursor)} style={{ ...filterStyle, marginTop: 16, cursor: 'pointer' }} disabled={loading}>
          {loading ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}

      {showDirect && <DirectTaskDialog scopes={scopes} onClose={() => setShowDirect(false)}
        onCreated={(id) => { setShowDirect(false); navigate(`/tasks/${id}`); }}/>}
      {showCreate && (
        <CreateTaskModal grants={grants} onClose={() => setShowCreate(false)} onCreated={() => load()} />
      )}
    </div>
  );
}

const createBtn: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 16,
  border: 'none',
  background: '#003DFF',
  color: '#fff',
  fontWeight: 600,
  fontSize: 14,
  cursor: 'pointer',
};

const filterStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid var(--fresh-border)',
  fontSize: 13,
  background: 'var(--fresh-surface)',
  color: 'var(--fresh-dark)',
};
