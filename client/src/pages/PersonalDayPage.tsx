import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { listWorkItems } from '../api/endpoints';
import type { WorkItem } from '../api/types';
import StatusBadge from '../components/StatusBadge';
import { orgUnitLabel } from '../constants/orgUnits';
import '../styles/task-fields.css';

export default function PersonalDayPage() {
  const { me } = useAuth();
  const roles = [...new Set((me?.grants ?? []).filter(g => g.org_unit_id && !['REGIONAL_MANAGER','SUPER_ADMIN'].includes(g.role)).map(g => g.role))].sort();
  const [role, setRole] = useState(roles[0] ?? '');
  const [items, setItems] = useState<WorkItem[]>([]);
  const [day, setDay] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dateChanged, setDateChanged] = useState(false);
  const requestVersion = useRef(0);
  async function load(next?: string) {
    const version = ++requestVersion.current;
    setBusy(true); setError('');
    try {
      const data = await listWorkItems({ mine:true, role:role || undefined, limit:50, cursor:next });
      if (version !== requestVersion.current) return;
      setItems(old => next ? [...old,...data.items.filter(row => !old.some(item => item.id === row.id))] : data.items);
      setCursor(data.next_cursor); setDay(data.current_business_date); setDateChanged(false);
    } catch (err: any) {
      if (version === requestVersion.current) setError(err.message ?? 'Не удалось загрузить задачи.');
    } finally { if (version === requestVersion.current) setBusy(false); }
  }
  useEffect(() => { setItems([]); setCursor(null); load(); return () => { requestVersion.current++; }; }, [role]);
  useEffect(() => {
    if (!day) return;
    const timer = window.setInterval(() => {
      const current = new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      if (current !== day) setDateChanged(true);
    }, 30000);
    return () => window.clearInterval(timer);
  }, [day]);
  return <div className="portal-dashboard">
    <header className="portal-heading"><div><span className="portal-eyebrow">ЛИЧНАЯ РАБОТА · BETA</span><h1>Задачи моей роли</h1>
      <p>Незавершённые задачи остаются здесь до принятия или отмены. Номер, исходный срок и история сохраняются.</p></div></header>
    <section className="portal-panel">
      <h2>Личный список, не общая форма филиала</h2>
      <p>Здесь только задачи, назначенные лично вам в выбранной роли. Задача на проверке ещё не считается выполненной.</p>
      <p className="task-fields-note">Это первый рабочий сценарий раздела «Ежедневник», не полный дневной отчёт. Записи за business date, окна заполнения, регулярная генерация и связь результата с дневным отчётом ещё в разработке. Дата ниже обозначает текущий день, а не дату отчёта каждой задачи.</p>
      <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
        <label>Моя роль <select aria-label="Моя роль" value={role} onChange={e => setRole(e.target.value)} style={{minHeight:44,marginLeft:8}}>
          {roles.length ? roles.map(r => <option value={r} key={r}>{r}</option>) : <option value="">Нет роли исполнителя</option>}
        </select></label>
        <button disabled={busy} onClick={() => load()} style={{minHeight:44}}>Обновить список</button>
        {day && <span className="task-fields-note">Текущий день: {day} · Москва</span>}
      </div>
      {dateChanged && <p role="status" className="task-fields-notice">Дата в Москве изменилась. Список не перезагружен автоматически; нажмите «Обновить список», когда удобно.</p>}
      {!roles.length && <p>Нет действующего назначения роли исполнителя. Руководитель проверяет задачи через <Link to="/tasks">общий список в своей области доступа</Link>.</p>}
    </section>
    {error && <div role="alert" className="portal-panel">{error} Попробуйте обновить список.</div>}
    <div className="personal-task-list" aria-busy={busy}>
      {items.map(item => <Link className="personal-task" to={`/tasks/${item.id}`} key={item.id}>
        <div><strong>{item.title}</strong>
          <small>{orgUnitLabel(item.org_unit_id)} · {item.owner_role} · {item.template_display_name}<br/>
            Срок: {new Date(item.due_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК
            {new Date(item.due_at).getTime() < Date.now() && ['ASSIGNED','IN_PROGRESS'].includes(item.status) ? ' · Срок истёк' : ''}
            {item.rework_count > 0 ? ` · Доработок: ${item.rework_count}` : ''}</small>
        </div><StatusBadge status={item.status}/>
      </Link>)}
      {!busy && !error && !items.length && <section className="portal-panel"><h2>Открытых задач этой роли нет</h2><p>Это не означает, что ежедневник заполнен или все показатели выполнены. Завершённые и отменённые задачи доступны в <Link to="/tasks">истории задач</Link>.</p></section>}
      {busy && <p role="status">Загрузка задач…</p>}
    </div>
    {cursor && !error && <button disabled={busy} onClick={() => load(cursor)} style={{minHeight:44,marginTop:16}}>Загрузить ещё</button>}
  </div>;
}
