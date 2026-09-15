import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listWorkItems } from '../api/endpoints';
import type { WorkItem, WorkItemStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import StatusBadge from '../components/StatusBadge';
import CreateTaskModal from './CreateTaskModal';
import { orgUnitLabel } from '../constants/orgUnits';

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
  const { me } = useAuth();
  const navigate = useNavigate();
  const [items, setItems] = useState<WorkItem[]>([]);
  const [status, setStatus] = useState<WorkItemStatus | ''>('');
  const [orgFilter, setOrgFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);

  const grants = me?.grants ?? [];
  const canCreate = grants.some((g) => g.role === 'REGIONAL_MANAGER');
  const orgOptions = Array.from(new Set(grants.map((g) => g.org_unit_id)));

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
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <h1 style={{ fontSize: 22, margin: 0, color: '#292D34' }}>Задачи</h1>
        {canCreate && (
          <button onClick={() => setShowCreate(true)} style={createBtn}>
            + Новая задача
          </button>
        )}
      </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as WorkItemStatus | '')} style={filterStyle}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {orgOptions.length > 1 && (
          <select value={orgFilter} onChange={(e) => setOrgFilter(e.target.value)} style={filterStyle}>
            <option value="">Все доступные филиалы</option>
            {orgOptions.map((org) => (
              <option key={org} value={org}>
                {orgUnitLabel(org)}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && <div style={{ color: '#D92D20', marginBottom: 12 }}>{error}</div>}

      {loading && items.length === 0 ? (
        <div style={{ color: '#6b7280' }}>Загрузка…</div>
      ) : items.length === 0 ? (
        <div style={{ color: '#6b7280', padding: '40px 0', textAlign: 'center' }}>Нет задач по выбранным фильтрам.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => navigate(`/tasks/${item.id}`)}
              style={{
                background: '#fff',
                border: '1px solid #E2E4E9',
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
                <div style={{ fontWeight: 600, fontSize: 14, color: '#292D34', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.title}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>
                  Срок: {new Date(item.due_at).toLocaleString('ru-RU', {timeZone:'UTC'})} UTC
                  {item.rework_count > 0 && ` · доработок: ${item.rework_count}`}
                </div>
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

      {showCreate && (
        <CreateTaskModal grants={grants} onClose={() => setShowCreate(false)} onCreated={() => load()} />
      )}
    </div>
  );
}

const createBtn: React.CSSProperties = {
  padding: '10px 16px',
  borderRadius: 8,
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
  border: '1px solid #E2E4E9',
  fontSize: 13,
  background: '#fff',
  color: '#292D34',
};
