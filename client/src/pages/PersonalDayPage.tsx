import React,{useEffect,useState} from 'react';
import { Link,useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getDay,openDay,moscowToday,type PersonalDay } from '../api/dailyLogs';
import { getOrganizationTree,type DirectoryUnit } from '../api/organization';
import { listWorkItems } from '../api/endpoints';
import type { WorkItem } from '../api/types';
import StatusBadge from '../components/StatusBadge';
import '../styles/beta-workspace.css';
export default function PersonalDayPage() {
  const {me}=useAuth(),navigate=useNavigate();
  const scopes=(me?.grants??[]).filter(g=>g.org_unit_id&&['RF','ROP','ROO'].includes(g.role));
  const [scope,setScope]=useState(scopes[0]?`${scopes[0].org_unit_id}:${scopes[0].role}`:'');
  const [org,role]=scope.split(':');
  const [date,setDate]=useState(moscowToday),[day,setDay]=useState<PersonalDay|null>(null);
  const [units,setUnits]=useState<DirectoryUnit[]>([]),[items,setItems]=useState<WorkItem[]>([]);
  const [busy,setBusy]=useState(false),[opening,setOpening]=useState(false),[error,setError]=useState(''),[revision,reload]=useState(0);
  const [cursor,setCursor]=useState<string|null>(null),[changed,setChanged]=useState(false);
  useEffect(()=>{
    let live=true;setDay(null);setItems([]);setCursor(null);setError('');
    if(!scope)return;
    setBusy(true);
    Promise.all([getDay(org,role,date),listWorkItems({org_unit_id:org,mine:true,role,limit:100}),getOrganizationTree(date)])
      .then(([d,t,u])=>{if(live){setDay(d);setItems(t.items.filter(t=>!t.template_code.startsWith('personal_daily_')));setCursor(t.next_cursor);setUnits(u.items);setChanged(false);}})
      .catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});
    return()=>{live=false;};
  },[scope,date,revision]);
  useEffect(()=>{if(!day)return;const id=window.setInterval(()=>{if(moscowToday()!==day.current_business_date)setChanged(true);},30000);return()=>window.clearInterval(id);},[day]);
  async function open() {
    setOpening(true);setError('');
    try{const r=await openDay(org,role,date);navigate(`/tasks/${r.id}`);}catch(e:any){setError(e.message);}finally{setOpening(false);}
  }
  return <div className="portal-dashboard beta-workspace">
    <header className="portal-heading"><div><span className="portal-eyebrow">ЛИЧНАЯ РАБОТА · BETA</span><h1>Мой ежедневник</h1>
      <p>Отдельная запись сотрудника, роли, филиала и даты. Сохранение в PostgreSQL портала, без зависимости от Диска.</p></div></header>
    {!scopes.length?<section className="portal-panel"><h2>Нет назначения РФ, РОП или РОО</h2><p>Руководитель проверяет записи в <Link to="/">обзоре сети</Link> или в карточке доступного филиала. Общего логина для заполнения нет.</p></section>:<>
      <section className="portal-panel beta-filters">
        <label>Филиал и моя роль<select aria-label="Филиал и моя роль" value={scope} onChange={e=>setScope(e.target.value)}>
          {scopes.map(s=><option key={s.id} value={`${s.org_unit_id}:${s.role}`}>{units.find(u=>u.id===s.org_unit_id)?.display_name??s.org_unit_id} · {s.role}</option>)}</select></label>
        <label>Дата ежедневника<input aria-label="Дата ежедневника" type="date" value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);}}/></label>
        <button className="btn" disabled={busy} onClick={()=>reload(n=>n+1)}>Обновить</button>
      </section>
      {changed&&<p role="status" className="beta-notice">В Москве наступил новый день. Текущая запись не переключена. <button className="btn" onClick={()=>setDate(moscowToday())}>Перейти на сегодня</button></p>}
      {error&&<p role="alert" className="portal-panel">{error}</p>}{busy&&<p role="status">Читаю ежедневник и задачи…</p>}
      {day&&<section className="portal-panel"><div className="portal-section-head"><div><h2>Дневная запись · {date}</h2><p className="portal-muted">Роль {role} · Москва · {day.record?'Сохранена на сервере':'Ещё не создана'}</p></div>
        <button className="portal-primary" disabled={opening||(!day.record&&!day.policy)} onClick={open}>{opening?'Открываю…':day.record?'Открыть ежедневник':'Создать ежедневник за дату'}</button></div>
        {day.record?<><p>Состояние: <StatusBadge status={day.record.status as any}/></p><p>Окно: {new Date(day.record.window_open).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} — {new Date(day.record.window_close).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК.</p>
          {!day.record.can_fill&&<p>Окно закрыто. Сохранённую запись можно читать, редактирование заблокировано сервером.</p>}</>:
          <p>{day.policy?'Окно настроено руководителем. Создание разрешено только внутри него; повторное открытие не создаёт дубль.':'Сначала РМ должен настроить окно заполнения для этой роли в карточке филиала.'}</p>}
        <p className="portal-muted">Beta-форма: план действий, итог и риски. Это не замена полного отраслевого каталога ежедневных показателей.</p>
        <Link to={`/branches/${org}`}>Карточка филиала →</Link>
      </section>}
      {day&&<section className="portal-panel"><h2>Результаты задач за выбранный день</h2><p className="portal-muted">Снимки отправленных версий. Отправлено на проверку не означает принято.</p>
        {day.links.length?day.links.map(l=><article className="beta-result" key={l.submission_id}><Link to={`/tasks/${l.work_item_id}`}>{l.title} · версия сдачи {l.revision}</Link><p>{l.completion_summary}</p><small>Текущий статус задачи: {l.current_task_status}. Снимок текста не перезаписывается.</small></article>):<p>Связанных результатов нет. При сдаче задачи выберите «Добавить в мой ежедневник» и дату.</p>}</section>}
      <section className="portal-panel"><h2>Незавершённые задачи моей роли</h2><p className="portal-muted">Актуальный список на сейчас, не исторический срез выбранной даты. Задачи сохраняют ID, исходный срок и историю между днями.</p>
        {items.map(t=><Link className="portal-task-row" to={`/tasks/${t.id}`} key={t.id}><div><strong>{t.title}</strong><span>Срок: {new Date(t.due_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</span></div><StatusBadge status={t.status}/></Link>)}
        {!busy&&!error&&!items.length&&<p>Открытых задач нет. Это не означает, что дневной отчёт принят.</p>}
        {cursor&&<Link to="/tasks">Есть ещё записи. Открыть полный список задач →</Link>}
      </section>
    </>}
  </div>;
}
