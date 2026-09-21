import React,{useEffect,useState} from 'react';
import { Link,useParams } from 'react-router-dom';
import { getOverview,savePolicy,moscowToday,type OperationalOverview,type BranchSummary,type DailyPolicy,type DiaryCompletion} from '../api/dailyLogs';
import StatusBadge from '../components/StatusBadge';
import LocalBusinessData from '../components/LocalBusinessData';
import PublishedFacts from '../components/PublishedFacts';
import BranchGrid from '../components/BranchGrid';
import '../styles/portal.css';
import '../styles/beta-workspace.css';
const fields=[['open_tasks','Открытые задачи'],['overdue_tasks','Срок исполнения истёк'],['awaiting_review','На проверке'],['completed_tasks','Принятые задачи']] as const;
export default function OperationalPage() {
  const {orgId}=useParams();
  const [date,setDate]=useState(moscowToday),[data,setData]=useState<OperationalOverview|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(true),[revision,reload]=useState(0);
  useEffect(()=>{
    let live=true;setBusy(true);setData(null);setError('');
    getOverview(date,orgId).then(d=>{if(live)setData(d);}).catch(e=>{if(live)setError(e.message);}).finally(()=>{if(live)setBusy(false);});
    return()=>{live=false;};
  },[date,orgId,revision]);
  const totals=fields.map(([key,label])=>({label,count:data?.branches.reduce((s,b)=>s+b[key],0)??0}));
  const branch=orgId?data?.branches[0]:null;
  return <div className="portal-dashboard beta-workspace">
    {orgId&&<Link to="/">← Обзор доступной сети</Link>}
    <header className="portal-heading"><div><span className="portal-eyebrow">ОПЕРАЦИОННЫЙ КОНТУР · BETA</span>
      <h1>{orgId?(branch?.display_name??'Карточка филиала'):'Обзор сети'}</h1><p>Личные ежедневники, задачи и проверка результатов в вашей области доступа.</p></div>
      <Link className="btn" to="/diary">Мой ежедневник</Link></header>
    <section className="portal-panel beta-filters"><label>Дата ежедневников и структуры<input aria-label="Дата ежедневников и структуры" type="date" value={date} onChange={e=>{if(e.target.value)setDate(e.target.value);}}/></label>
      <button className="btn" disabled={busy} onClick={()=>reload(n=>n+1)}>Обновить</button><span className="portal-muted">Задачи: текущие состояния, все сроки. Это не исторический срез KPI.</span></section>
    {busy&&<p role="status">Загружаю серверный срез…</p>}{error&&<section className="portal-panel" role="alert">{error}</section>}
    {data&&<>
      {branch&&<section className="portal-panel"><div className="portal-section-head"><h2>Паспорт филиала</h2><span className="portal-chip">{branch.is_demo?'Синтетический тест':'Канонический филиал'}</span></div>
        <div className="beta-passport"><p>Код: <strong>{branch.code}</strong></p><p>Статус на дату: <strong>{branch.lifecycle_state}</strong></p>
          <p>Бизнес-модель: <strong>{branch.business_model??'Не указана'}</strong></p><p>Тип: <strong>{branch.type_code??'Не указан'}</strong></p></div>
        <p>Область просмотра: {branch.visibility==='BRANCH'?'все доступные задачи и дневные записи филиала':'только ваши задачи и дневные записи, не итоги всего филиала'}.</p>
        <Link to="/organization">История структуры и назначений →</Link></section>}
      <div className="beta-counters">{totals.map(t=><article className="portal-panel" key={t.label}><span>{t.label}</span><strong>{t.count}</strong><small>По вашей области доступа</small></article>)}</div>
      <BranchGrid org={orgId}/>
      <PublishedFacts org={orgId}/>
      <section className="portal-panel"><div className="portal-section-head"><div><h2>{orgId?'Ежедневники филиала':'Филиалы и ежедневники'} · {date}</h2><p className="portal-muted">Считаются только созданные записи. Процент дисциплины не рассчитывается без утверждённого расписания.</p></div></div>
        {!data.branches.length&&<p>Нет доступных филиалов на выбранную дату. Административный доступ к справочнику сам по себе не даёт доступа к бизнес-данным.</p>}
        <div className="beta-branches">{data.branches.map(b=><Branch key={b.id} branch={b} detailed={Boolean(orgId)}/>)}</div>
      </section>
      <section className="portal-panel"><div className="portal-section-head"><h2>Ближайшие действия</h2><Link to="/tasks">Все задачи →</Link></div>
        <p className="portal-muted">До 10 открытых задач по возрастанию срока. Счётчики выше не ограничены этим списком.</p>
        {data.attention.map(t=><Link className="portal-task-row" key={t.id} to={`/tasks/${t.id}`}><div><strong>{t.title}</strong>
          <span>{data.branches.find(b=>b.id===t.org_unit_id)?.display_name} · {new Date(t.due_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</span></div><StatusBadge status={t.status as any}/></Link>)}
        {!data.attention.length&&<p>Открытых задач в вашей области доступа нет.</p>}</section>
      {branch?.can_manage&&<PolicyEditor key={`${orgId}:${revision}`} org={orgId!} policies={data.policies} onSaved={()=>reload(n=>n+1)}/>}
      <p className="portal-muted">Серверный срез: {new Date(data.server_time).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК. Источник операционных данных: PostgreSQL нового портала.</p>
    </>}
    {!orgId&&<details className="portal-panel" open={new URLSearchParams(window.location.search).has('import')}><summary>Локальный просмотр QLIK · отдельно от рабочих показателей</summary><LocalBusinessData/></details>}
  </div>;
}
function Branch({branch:b,detailed}:{branch:BranchSummary;detailed:boolean}) {
  return <article className="beta-branch"><div className="portal-section-head"><h3>{detailed?b.display_name:<Link to={`/branches/${b.id}`}>{b.display_name} →</Link>}</h3>
    <span className="portal-chip">{b.is_demo?'Тестовые данные':b.code}</span></div>
    <p className="portal-muted">{b.visibility==='PERSONAL'?'Только ваши записи':'Доступные записи филиала'}</p>
    <dl><div><dt>Черновики</dt><dd>{b.diary_drafts}</dd></div><div><dt>На проверке</dt><dd>{b.diary_submitted}</dd></div><div><dt>Приняты</dt><dd>{b.diary_accepted}</dd></div></dl>
    <DiaryProgress c={b.diary_completion}/>
    {detailed&&b.diaries.map(d=>{
      const f=b.diary_completion?.by_role.find(r=>r.work_item_id===d.id);
      return <Link className="portal-task-row" key={d.id} to={`/tasks/${d.id}`}>
        <div><strong>{d.title}</strong>
          <span>Личная запись · {d.role}
            {f&&f.total>0&&<> · заполнено {f.filled} из {f.total} полей{f.fill_pct!==null&&<> ({Math.round(f.fill_pct)}%)</>}</>}</span></div>
        <StatusBadge status={d.status as any}/></Link>;})}
    {detailed&&!b.diaries.length&&<p>На эту дату записей нет.</p>}
  </article>;
}
/**
 * Прогресс заполнения ежедневников филиала.
 *
 * Проценты могут отсутствовать, и это не ноль: если окна заполнения по ролям не
 * настроены, обязанности сдавать ежедневник нет, и «0%» был бы неправдой.
 * Поэтому такой филиал прямо говорит, что окна не настроены.
 */
function DiaryProgress({c}:{c?:DiaryCompletion}) {
  if(!c)return null;
  if(!c.expected_roles)return <p className="portal-muted diary-progress-note">
    Окна заполнения ежедневников не настроены: обязанности сдавать запись нет, процент не считается.</p>;
  const rag=(v:number|null)=>v===null?undefined:v>=90?'green':v>=80?'amber':'red';
  return <div className="diary-progress">
    <div className="diary-progress-row" data-rag={rag(c.submitted_pct)}>
      <span>Сдано ролями</span>
      <strong>{c.submitted} из {c.expected_roles}{c.submitted_pct!==null&&<> · {Math.round(c.submitted_pct)}%</>}</strong>
    </div>
    <div className="diary-progress-row" data-rag={rag(c.fill_pct)}>
      <span>Заполнение полей</span>
      <strong>{c.fill_pct===null?'нет созданных записей'
        :<>{Math.round(c.fill_pct)}% · {c.fields_filled} из {c.fields_total}</>}</strong>
    </div>
    {c.required_fill_pct!==null&&<div className="diary-progress-row" data-rag={rag(c.required_fill_pct)}>
      <span>Обязательные поля</span><strong>{Math.round(c.required_fill_pct)}%</strong></div>}
  </div>;
}

function PolicyEditor({org,policies,onSaved}:{org:string;policies:DailyPolicy[];onSaved:()=>void}) {
  const [role,setRole]=useState('RF'),[date,setDate]=useState(moscowToday),[open,setOpen]=useState(''),[close,setClose]=useState('');
  const [early,setEarly]=useState(''),[late,setLate]=useState(''),[reason,setReason]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const previous=policies.find(p=>p.role_code===role);
  useEffect(()=>{setOpen(previous?.base_open_time.slice(0,5)??'');setClose(previous?.base_close_time.slice(0,5)??'');
    setEarly(previous?String(previous.early_open_hours):'');setLate(previous?String(previous.late_close_hours):'');},[role]);
  async function save(e:React.FormEvent) {
    e.preventDefault();
    if(!window.confirm(`Применить окно для ${role} с ${date}? Ранее созданные ежедневники сохранят прежнее окно.`))return;
    setBusy(true);setError('');
    try{await savePolicy(org,{role,effective_from:date,base_open_time:open,base_close_time:close,early_open_hours:Number(early),late_close_hours:Number(late),expected_version:previous?.version??0,reason});onSaved();}
    catch(e:any){setError(e.message);}finally{setBusy(false);}
  }
  return <details className="portal-panel"><summary>Настроить окно заполнения · только РМ этого филиала</summary>
    <p>Версионные настройки, без изменения ранее созданных записей. Часы не предзаполнены неподтверждёнными правилами.</p>
    {policies.map(p=><p key={p.id}>{p.role_code}: v{p.version} с {p.effective_from} · {p.base_open_time.slice(0,5)}–{p.base_close_time.slice(0,5)} МСК, раньше на {p.early_open_hours} ч., позже на {p.late_close_hours} ч. Основание: {p.reason}</p>)}
    <form onSubmit={save}><div className="beta-filters">
      <label>Роль окна<select aria-label="Роль окна" value={role} onChange={e=>setRole(e.target.value)}>{['RF','ROP','ROO'].map(r=><option key={r}>{r}</option>)}</select></label>
      <label>Действует с<input aria-label="Действует с" required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
      <label>Базовое открытие<input aria-label="Базовое открытие" required type="time" value={open} onChange={e=>setOpen(e.target.value)}/></label>
      <label>Базовое закрытие<input aria-label="Базовое закрытие" required type="time" value={close} onChange={e=>setClose(e.target.value)}/></label>
      <label>Раньше, часов<input aria-label="Раньше, часов" required type="number" min="0" max="24" value={early} onChange={e=>setEarly(e.target.value)}/></label>
      <label>Позже, часов<input aria-label="Позже, часов" required type="number" min="0" max="48" value={late} onChange={e=>setLate(e.target.value)}/></label>
      <label>Основание изменения<input aria-label="Основание изменения" required minLength={5} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>
    </div>{error&&<p role="alert">{error}</p>}<button className="btn" disabled={busy}>{busy?'Сохраняю…':'Сохранить новую версию окна'}</button></form>
  </details>;
}
