import React,{useEffect,useState} from 'react';
import { Link,useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { getDay,openDay,getNote,openNote,moscowToday,LINE_ROLES,LINE_ROLE_NAMES,
  type PersonalDay,type PersonalNoteDay } from '../api/dailyLogs';
import { getOrganizationTree,type DirectoryUnit } from '../api/organization';
import { listWorkItems } from '../api/endpoints';
import type { WorkItem } from '../api/types';
import StatusBadge from '../components/StatusBadge';
import { ROLE_RU } from '../domain/taskTitle';
import '../styles/beta-workspace.css';
export default function PersonalDayPage() {
  const {me}=useAuth(),navigate=useNavigate();
  // Линейные должности заводят личную запись дня — она тоже открывается с этой
  // страницы. Раньше страница пускала только РФ, РОП и РОО, и сотрудник МОП или
  // ЭО не мог попасть к своей записи вообще, хотя сервер её создавал.
  const DIARY_ROLES=['RF','ROP','ROO'];
  const scopes=(me?.grants??[]).filter(g=>g.org_unit_id&&
    (DIARY_ROLES.includes(g.role)||(LINE_ROLES as readonly string[]).includes(g.role)));
  const [scope,setScope]=useState(scopes[0]?`${scopes[0].org_unit_id}:${scopes[0].role}`:'');
  const [org,role]=scope.split(':');
  const isLine=(LINE_ROLES as readonly string[]).includes(role);
  const [date,setDate]=useState(moscowToday),[day,setDay]=useState<PersonalDay|null>(null);
  const [note,setNote]=useState<PersonalNoteDay|null>(null);
  const [units,setUnits]=useState<DirectoryUnit[]>([]),[items,setItems]=useState<WorkItem[]>([]);
  const [busy,setBusy]=useState(false),[opening,setOpening]=useState(false),[error,setError]=useState(''),[revision,reload]=useState(0);
  const [cursor,setCursor]=useState<string|null>(null),[changed,setChanged]=useState(false);
  useEffect(()=>{
    let live=true;setDay(null);setNote(null);setItems([]);setCursor(null);setError('');
    if(!scope)return;
    setBusy(true);
    Promise.all([isLine?getNote(org,role,date):getDay(org,role,date),
      listWorkItems({org_unit_id:org,mine:true,role,limit:100}),getOrganizationTree(date)])
      .then(([d,t,u])=>{if(live){
        if(isLine)setNote(d as PersonalNoteDay);else setDay(d as PersonalDay);
        setItems(t.items.filter(t=>!t.template_code.startsWith('personal_daily_')&&!t.template_code.startsWith('personal_note_')));
        setCursor(t.next_cursor);setUnits(u.items);setChanged(false);}})
      .catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});
    return()=>{live=false;};
  },[scope,date,revision]);
  const current=day?.current_business_date??note?.current_business_date??null;
  useEffect(()=>{if(!current)return;const id=window.setInterval(()=>{if(moscowToday()!==current)setChanged(true);},30000);return()=>window.clearInterval(id);},[current]);
  async function open() {
    setOpening(true);setError('');
    try{const r=isLine?await openNote(org,role,date):await openDay(org,role,date);
      navigate(`/tasks/${r.id}`);}catch(e:any){setError(e.message);}finally{setOpening(false);}
  }
  return <div className="portal-dashboard beta-workspace">
    <header className="portal-heading"><div><h1>AI-Трекер задач</h1></div></header>
    {!scopes.length?<section className="portal-panel"><h2>Нет назначения на филиал</h2><p>Руководитель проверяет записи в <Link to="/">обзоре сети</Link> или в карточке доступного филиала. Общего логина для заполнения нет.</p></section>:<>
      <section className="portal-panel beta-filters">
        <label>Филиал и моя роль<select aria-label="Филиал и моя роль" value={scope} onChange={e=>setScope(e.target.value)}>
          {scopes.map(s=><option key={s.id} value={`${s.org_unit_id}:${s.role}`}>{units.find(u=>u.id===s.org_unit_id)?.display_name??s.org_unit_id} · {LINE_ROLE_NAMES[s.role]??s.role}</option>)}</select></label>
        <label>Дата<input aria-label="Дата" type="date" value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);}}/></label>
        <button className="btn" disabled={busy} onClick={()=>reload(n=>n+1)}>Обновить</button>
      </section>
      {changed&&<p role="status" className="beta-notice">В Москве наступил новый день. Текущая запись не переключена. <button className="btn" onClick={()=>setDate(moscowToday())}>Перейти на сегодня</button></p>}
      {error&&<p role="alert" className="portal-panel">{error}</p>}{busy&&<p role="status">Загружаю…</p>}
      {note&&<section className="portal-panel"><div className="portal-section-head">
        <div><h2>AI-Трекер задач · {LINE_ROLE_NAMES[role]??role}</h2>
          <p className="portal-muted">{date.slice(8,10)}.{date.slice(5,7)}.{date.slice(0,4)}</p></div>
        <button className="portal-primary" disabled={opening} onClick={open}>
          {opening?'Открываю…':note.record?'Открыть':'Начать день'}</button></div>
        {note.record&&<p>Состояние: <StatusBadge status={note.record.status as any}/></p>}
      </section>}
      {note&&<section className="portal-panel"><h2>Задачи от руководителя</h2>
        <p className="portal-muted">Поставлены вам на этот день и ранее. Просроченные остаются в списке.</p>
        {note.assigned_tasks.length?<div className="personal-task-list">{note.assigned_tasks.map(t=>{
          const overdue=!!t.due_at_local&&t.due_at_local.slice(0,10)<date;
          return <Link className="personal-task" to={`/tasks/${t.id}`} key={t.id} data-overdue={overdue?'1':undefined}>
            <div><strong>{t.title}</strong><small>{t.created_by_name&&<>поставил {t.created_by_name} · </>}
              {t.due_at_local?<>срок {t.due_at_local.slice(8,10)}.{t.due_at_local.slice(5,7)}.{t.due_at_local.slice(0,4)} {t.due_at_local.slice(11)} МСК</>:<>срок не задан</>}</small></div>
            <StatusBadge status={t.status as any}/></Link>;})}</div>
          :<p>Задач от руководителя на этот день нет.</p>}
      </section>}
      {day&&<section className="portal-panel"><div className="portal-section-head"><div><h2>AI-Трекер задач · {ROLE_RU[role]??role}</h2><p className="portal-muted">{date.slice(8,10)}.{date.slice(5,7)}.{date.slice(0,4)}</p></div>
        <button className="portal-primary" disabled={opening||(!day.record&&!day.policy)} onClick={open}>{opening?'Открываю…':day.record?'Открыть':'Начать день'}</button></div>
        {day.record?<><p>Состояние: <StatusBadge status={day.record.status as any}/></p>
          {!day.record.can_fill&&<p className="portal-muted">День закрыт для изменений.</p>}</>:
          <p>{day.policy?''
            :<>Окно заполнения для этой роли не настроено, и создать ежедневник нельзя.{' '}
              <Link to={`/branches/${org}`}>Настроить окно на странице филиала →</Link></>}</p>}
      </section>}
      {day&&<section className="portal-panel"><h2>Задачи от руководителя</h2>
        <p className="portal-muted">Со сроком на этот день и просроченные — обязательны к выполнению. С более
          поздним сроком — необязательны, указана контрольная дата, когда станут обязательными.</p>
        {day.assigned_tasks.length?<div className="personal-task-list">{day.assigned_tasks.map(t=>{
          // Просрочка определяется по рабочей дате ежедневника, а не по «сейчас»:
          // открыв вчерашний день, руководитель должен видеть его картину.
          const overdue=!!t.due_at_local&&t.due_at_local.slice(0,10)<date;
          return <Link className="personal-task" to={`/tasks/${t.id}`} key={t.id} data-overdue={overdue?'1':undefined}>
            <div><strong>{t.title}</strong>
              <small>{t.template_name}
                {t.created_by_name&&<> · поставил {t.created_by_name}</>}
                {t.mandatory?<> · <b>обязательна</b>{t.due_at_local&&<> · срок {t.due_at_local.slice(8,10)}.{t.due_at_local.slice(5,7)}.{t.due_at_local.slice(0,4)} {t.due_at_local.slice(11)} МСК</>}</>
                  :t.due_at_local?<> · необязательна · станет обязательной {t.due_at_local.slice(8,10)}.{t.due_at_local.slice(5,7)}, срок сдачи {t.due_at_local.slice(11)} МСК</>
                  :<> · необязательна · срок не задан</>}
                {overdue&&<> · просрочена</>}
                {t.in_daily_log&&<> · уже в трекере</>}</small></div>
            <StatusBadge status={t.status as any}/></Link>;})}</div>
          :<p>Задач от руководителя на этот день нет.</p>}
      </section>}
      {day&&<section className="portal-panel"><h2>Результаты задач за выбранный день</h2>
        {day.links.length?day.links.map(l=><article className="beta-result" key={l.submission_id}><Link to={`/tasks/${l.work_item_id}`}>{l.title}</Link><p>{l.completion_summary}</p></article>):<p className="portal-muted">Пока нет.</p>}</section>}
      <section className="portal-panel"><h2>Незавершённые задачи моей роли</h2>
        {items.map(t=><Link className="portal-task-row" to={`/tasks/${t.id}`} key={t.id}><div><strong>{t.title}</strong><span>Срок: {new Date(t.due_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</span></div><StatusBadge status={t.status}/></Link>)}
        {!busy&&!error&&!items.length&&<p>Открытых задач нет. Это не означает, что дневной отчёт принят.</p>}
        {cursor&&<Link to="/tasks">Есть ещё записи. Открыть полный список задач →</Link>}
      </section>
    </>}
  </div>;
}
