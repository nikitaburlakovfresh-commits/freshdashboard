import React, { useEffect, useMemo, useState } from 'react';
import {
  getRoleMatrix, saveRolePermissions,
  type PermissionInfo, type RoleInfo, type RoleChange,
} from '../api/adminSettings';

/**
 * Настройка наборов прав галочками.
 *
 * Зачем экран: стратегическая цель — не править код при обычном изменении
 * полномочий. Здесь владелец платформы сам решает, что роль может делать.
 *
 * Чего экран НЕ делает: не меняет область видимости. Набор отвечает «что можно
 * делать», грант роли — «где». Если у роли нет ни одного гранта, права ничего
 * не откроют, и экран честно это показывает числом закреплений.
 */

// Группировка по смысловому префиксу права: список из 38 галочек без
// разделов читать невозможно.
const GROUPS: { prefix: string; label: string }[] = [
  { prefix: 'work_item.', label: 'Задачи' },
  { prefix: 'metric.', label: 'Показатели и правила расчёта' },
  { prefix: 'report', label: 'Отчёты и данные' },
  { prefix: 'data_source.', label: 'Приём данных' },
  { prefix: 'daily_log.', label: 'Ежедневник' },
  { prefix: 'org_unit.', label: 'Филиалы' },
  { prefix: 'organization.', label: 'Оргструктура' },
  { prefix: 'access.', label: 'Доступы' },
  { prefix: 'user.', label: 'Пользователи' },
  { prefix: 'notification.', label: 'Уведомления' },
  { prefix: 'portal.', label: 'Настройки портала' },
  { prefix: 'service_intake.', label: 'Служебный приём' },
];

function groupOf(code: string): string {
  return GROUPS.find(g => code.startsWith(g.prefix))?.label ?? 'Прочее';
}

export default function RolePermissionsPage() {
  const [permissions, setPermissions] = useState<PermissionInfo[]>([]);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [history, setHistory] = useState<RoleChange[]>([]);
  const [roleCode, setRoleCode] = useState('');
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const res = await getRoleMatrix();
      setPermissions(res.permissions);
      setRoles(res.roles);
      setHistory(res.history);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось прочитать наборы прав.');
    }
  };
  useEffect(() => { void load(); }, []);

  const role = roles.find(r => r.code === roleCode) ?? null;
  useEffect(() => {
    setChecked(new Set(role?.permissions ?? []));
    setDone(null);
  }, [roleCode, roles]);

  const grouped = useMemo(() => {
    const map = new Map<string, PermissionInfo[]>();
    for (const p of permissions) {
      const g = groupOf(p.code);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(p);
    }
    return [...map.entries()];
  }, [permissions]);

  const original = useMemo(() => new Set(role?.permissions ?? []), [role]);
  const added = [...checked].filter(c => !original.has(c));
  const removed = [...original].filter(c => !checked.has(c));
  const dirty = added.length > 0 || removed.length > 0;

  const toggle = (code: string) => setChecked(prev => {
    const next = new Set(prev);
    if (next.has(code)) next.delete(code); else next.add(code);
    return next;
  });

  const save = async () => {
    if (!role || !dirty) return;
    setBusy(true); setError(null); setDone(null);
    try {
      const res = await saveRolePermissions(role.code, [...checked], reason);
      setDone(`Сохранено. Добавлено прав: ${res.granted.length}, снято: ${res.revoked.length}.`);
      setReason('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось сохранить набор прав.');
    } finally { setBusy(false); }
  };

  const roleHistory = history.filter(h => h.role_code === roleCode);

  return <div className="portal-page">
    <header className="overview-head">
      <div>
        <h1>Роли и права</h1>
        <p className="overview-subline">
          Что роль может делать в портале. Где именно — задаётся закреплением роли за
          филиалом или сетью, а не этим экраном.
        </p>
      </div>
    </header>

    {error && <p className="role-view-error">{error}</p>}
    {done && <p className="org-small">{done}</p>}

    <section className="portal-panel">
      <label className="role-view-field">
        <span>Роль</span>
        <select value={roleCode} onChange={e => setRoleCode(e.target.value)}>
          <option value="">— выберите роль —</option>
          {roles.map(r => <option key={r.code} value={r.code}>
            {r.display_name} · прав {r.permissions.length} · закреплений {r.grants}
          </option>)}
        </select>
      </label>

      {role && role.code === 'SUPER_ADMIN' && <p className="org-small">
        Набор владельца платформы через этот экран не меняется: иначе одним снятием
        галочки можно лишить портал единственного администратора.
      </p>}

      {role && role.grants === 0 && <p className="org-small">
        У этой роли нет ни одного закрепления за филиалом. Права можно настроить сейчас,
        но до закрепления сотрудник не увидит ни одного показателя.
      </p>}
    </section>

    {role && role.code !== 'SUPER_ADMIN' && <>
      {grouped.map(([label, items]) => <section className="portal-panel" key={label}>
        <h2>{label}</h2>
        <div className="role-perm-grid">
          {items.map(p => {
            const on = checked.has(p.code);
            const changed = on !== original.has(p.code);
            return <label key={p.code} className={`role-perm-item${changed ? ' role-perm-changed' : ''}`}>
              <input type="checkbox" checked={on} onChange={() => toggle(p.code)} />
              <span>
                <strong>{p.code}</strong>
                {p.description && <em>{p.description}</em>}
              </span>
            </label>;
          })}
        </div>
      </section>)}

      <section className="portal-panel">
        <h2>Сохранение</h2>
        {!dirty && <p className="org-small">Изменений нет.</p>}
        {dirty && <p className="org-small">
          Будет добавлено: {added.length ? added.join(', ') : '—'}. Будет снято: {removed.length ? removed.join(', ') : '—'}.
        </p>}
        <label className="role-view-field">
          <span>Основание (необязательно, попадёт в историю)</span>
          <input type="text" maxLength={500} value={reason} onChange={e => setReason(e.target.value)} />
        </label>
        <div className="role-view-actions">
          <button type="button" className="btn role-view-primary" onClick={save} disabled={!dirty || busy}>
            Сохранить набор прав
          </button>
        </div>
        <p className="org-small">
          После сохранения сотрудники с этой ролью получат новые полномочия без повторного
          входа. Каждое изменение пишется в историю с автором и временем.
        </p>
      </section>

      {roleHistory.length > 0 && <section className="portal-panel">
        <h2>История изменений роли</h2>
        <table className="portal-table">
          <thead><tr><th>Когда</th><th>Право</th><th>Действие</th><th>Кто</th><th>Основание</th></tr></thead>
          <tbody>{roleHistory.map((h, i) => <tr key={i}>
            <td>{h.created_at}</td><td>{h.permission_code}</td>
            <td>{h.action === 'GRANTED' ? 'добавлено' : 'снято'}</td>
            <td>{h.actor_login}</td><td>{h.reason ?? '—'}</td>
          </tr>)}</tbody>
        </table>
      </section>}
    </>}
  </div>;
}
