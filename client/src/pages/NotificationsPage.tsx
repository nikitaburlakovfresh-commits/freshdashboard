import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { listNotifications, readNotification } from '../api/endpoints';
import type { Notification } from '../api/types';

export default function NotificationsPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<Notification[]>([]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);

  const load = useCallback(
    async (nextCursor?: string) => {
      setLoading(true);
      setError(null);
      try {
        const page = await listNotifications({ unread_only: unreadOnly, cursor: nextCursor, limit: 50 });
        setItems((prev) => (nextCursor ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
      } catch (err: any) {
        setError(err?.message ?? 'Не удалось загрузить уведомления.');
      } finally {
        setLoading(false);
      }
    },
    [unreadOnly],
  );

  useEffect(() => {
    load();
  }, [load]);

  async function markRead(n: Notification) {
    try {
      const updated = await readNotification(n.id, { expected_entity_version: n.entity_version });
      setItems((prev) => unreadOnly ? prev.filter(it => it.id !== n.id) : prev.map((it) => (it.id === n.id ? updated : it)));
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось отметить уведомление. Повторите попытку.');
    }
  }

  return (
    <div style={{ maxWidth: 700 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h1 style={{ fontSize: 22, margin: 0, color: '#292D34' }}>Уведомления</h1>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: '#292D34' }}>
          <input type="checkbox" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />
          Только непрочитанные
        </label>
      </div>

      {error && <div style={{ color: '#D92D20', marginBottom: 12 }}>{error}</div>}

      {loading && items.length === 0 ? (
        <div style={{ color: '#6b7280' }}>Загрузка…</div>
      ) : items.length === 0 ? (
        <div style={{ color: '#6b7280', padding: '40px 0', textAlign: 'center' }}>Уведомлений нет.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {items.map((n) => (
            <div
              key={n.id}
              style={{
                background: n.read_at ? '#fff' : '#F5F8FF',
                border: '1px solid #E2E4E9',
                borderRadius: 12,
                padding: '14px 18px',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 12,
              }}
            >
              <div style={{ minWidth: 0, cursor: 'pointer' }} onClick={() => navigate(`/tasks/${n.work_item_id}`)}>
                <div style={{ fontWeight: n.read_at ? 500 : 700, fontSize: 14, color: '#292D34' }}>{n.message}</div>
                <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>{new Date(n.created_at).toLocaleString('ru-RU', {timeZone:'UTC'})} UTC</div>
              </div>
              {!n.read_at && (
                <button onClick={() => markRead(n)} style={markBtn}>
                  Прочитано
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {cursor && (
        <button onClick={() => load(cursor)} disabled={loading} style={{ ...markBtn, marginTop: 16 }}>
          {loading ? 'Загрузка…' : 'Показать ещё'}
        </button>
      )}
    </div>
  );
}

const markBtn: React.CSSProperties = {
  padding: '7px 14px',
  borderRadius: 8,
  border: '1px solid #E2E4E9',
  background: '#fff',
  color: '#003DFF',
  fontWeight: 600,
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};
