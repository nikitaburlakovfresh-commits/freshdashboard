import React,{useEffect,useRef,useState} from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { accessPermissions } from '../components/accessChangeModel';
import { MetricDirectory,MetricPreview,metricDirectory,metricPreview,metricApply } from '../api/metricAccess';
import '../styles/organization.css';
import '../styles/access.css';
import '../styles/report-facts.css';
import '../styles/metric-access.css';

const date=(s:string|null)=>s==='NOW'?'В момент применения':s?new Date(s).toLocaleString('ru-RU'):'Без окончания';
export default function MetricAccessPage() {
 const {me}=useAuth(),permissions=accessPermissions(me?.grants??[]);
 const allowed=permissions.has('access.directory.read')&&permissions.has('report.fact_access.manage');
 const [data,setData]=useState<MetricDirectory|null>(null),[preview,setPreview]=useState<MetricPreview|null>(null);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [operation,setOperation]=useState<'GRANT'|'REVOKE'>('GRANT'),[cap,setCap]=useState<'READ'|'PUBLISH'>('READ');
 const [grant,setGrant]=useState(''),[metrics,setMetrics]=useState<string[]>([]),[reason,setReason]=useState('');
 const [start,setStart]=useState(''),[end,setEnd]=useState(''),[now,setNow]=useState(Date.now());
 const [confirmed,setConfirmed]=useState(false);
 const lock=useRef(false),alive=useRef(true),generation=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
 const clearPreview=()=>{setPreview(null);setConfirmed(false);};
 async function run(fn:()=>Promise<void>) {
   if(lock.current)return;lock.current=true;setBusy(true);setError('');setNotice('');
   try{await fn();}catch(e){
     if(!alive.current)return;
     setError(e instanceof Error?e.message:'Запрос не выполнен.');
     if(e instanceof ApiError&&[401,403].includes(e.status)){setData(null);clearPreview();}
     if(e instanceof ApiError&&[409,422].includes(e.status))clearPreview();
   }finally{lock.current=false;if(alive.current)setBusy(false);}
 }
 async function refresh(){const version=generation.current;const d=await metricDirectory();if(alive.current&&version===generation.current)setData(d);}
 useEffect(()=>{
   setData(null);clearPreview();generation.current++;
   if(allowed)void run(refresh);
 },[allowed,me?.user.id]);
 useEffect(()=>{
   const t=setInterval(()=>setNow(Date.now()),1000);
   const focus=()=>{if(!lock.current){clearPreview();if(allowed)void run(refresh);}};
   window.addEventListener('focus',focus);
   return()=>{clearInterval(t);window.removeEventListener('focus',focus);};
 },[allowed]);
 function changed(){generation.current++;clearPreview();}
 async function check(){
   const version=generation.current;
   const common={grant_id:grant,capability:cap,reason};
   const p=await metricPreview(operation==='REVOKE'?{...common,operation}:
     {...common,operation,metrics,valid_from:start?new Date(start).toISOString():'NOW',valid_until:end?new Date(end).toISOString():null});
   if(alive.current&&version===generation.current){setPreview(p);setConfirmed(false);}
 }
 const canApply=allowed&&preview?.valid&&preview.id&&confirmed&&Date.parse(preview.expires_at??'')>now;
 const choices=data?.grants.filter(g=>g.user_id!==me?.user.id&&
   (operation==='REVOKE'?data.access.some(a=>a.grant_id===g.id&&a.capability===cap&&!a.revoked_at):
     g.is_active&&!g.revoked_at&&(!g.valid_until||Date.parse(g.valid_until)>now)&&
     (cap==='READ'?g.scope_kind==='ORG_UNIT'&&g.readable_branch:g.scope_kind==='NETWORK'&&g.role_code==='SUPER_ADMIN')))??[];
 const names=new Map(data?.grants.map(g=>[g.id,`${g.full_name} · ${g.role_code} · ${g.branch_code??'Сеть'}`])??[]);
 const title=(m:string)=>data?.metrics[m]??m;
 return <div className="org-page metric-access report-facts">
   <header className="portal-heading"><div><span className="portal-eyebrow">Администрирование · метрики</span>
     <h1>Допуски к показателям</h1><p>Конкретный сотрудник, назначение и набор метрик. Без автоматического расширения прав.</p>
     <Link to="/access">К пользователям и назначениям</Link></div></header>
   {!allowed?<section className="portal-panel"><h2>Нет отдельного административного допуска</h2>
     <p>Нужно явно согласованное право report.fact_access.manage. Роль администратора сама по себе его не выдаёт.</p></section>:<>
   {error&&<p className="portal-panel org-error" role="alert">{error}</p>}
   {notice&&<p className="portal-panel" role="status">{notice}</p>}
   {busy&&<p role="status">Проверка сервера…</p>}
   <section className="portal-panel"><div className="org-section-heading"><h2>Изменить допуск</h2>
     <button className="btn" disabled={busy} onClick={()=>{changed();void run(refresh);}}>Обновить</button></div>
     <p>Чтение: только один активный реальный филиал. Публикация: отдельный защищённый допуск.
       Собственные права здесь не изменяются. Для замены состава метрик сначала подтвердите отзыв, затем новую выдачу.</p>
     <form onSubmit={e=>{e.preventDefault();void run(check);}}>
       <fieldset className="org-editor-fields" disabled={busy||!data}>
         <label>Действие<select aria-label="Действие" value={operation} onChange={e=>{changed();setGrant('');setOperation(e.target.value as typeof operation);}}>
           <option value="GRANT">Выдать допуск</option><option value="REVOKE">Отозвать допуск</option></select></label>
         <label>Тип допуска<select aria-label="Тип допуска" value={cap} onChange={e=>{changed();setGrant('');setCap(e.target.value as typeof cap);}}>
           <option value="READ">Чтение показателей филиала</option><option value="PUBLISH">Публикация показателей</option></select></label>
         <label className="org-editor-wide">Назначение сотрудника<select required value={grant} onChange={e=>{changed();setGrant(e.target.value);}}>
           <option value="">Выберите назначение</option>{choices.map(g=><option value={g.id} key={g.id}>{names.get(g.id)}</option>)}</select></label>
         {operation==='GRANT'&&<>
           <div className="org-editor-wide"><h3>Разрешённые метрики</h3><div className="metric-checks">
             {Object.entries(data?.metrics??{}).map(([key,name])=><label className="fact-check" key={key}>
               <input type="checkbox" checked={metrics.includes(key)} onChange={e=>{changed();setMetrics(v=>e.target.checked?[...v,key]:v.filter(m=>m!==key));}}/>{name}</label>)}
           </div></div>
           <label>Начало · местное время<input type="datetime-local" value={start} onChange={e=>{changed();setStart(e.target.value);}}/><small>Пусто: в момент подтверждения</small></label>
           <label>Окончание · местное время<input type="datetime-local" value={end} onChange={e=>{changed();setEnd(e.target.value);}}/><small>Не позже окончания назначения</small></label>
         </>}
         <label className="org-editor-wide">Основание изменения<textarea required minLength={16} maxLength={500} value={reason}
           onChange={e=>{changed();setReason(e.target.value);}} rows={3}/></label>
       </fieldset>
       {data&&!choices.length&&<p>Подходящих назначений нет. Новые роли и сетевые полномочия на этой странице не создаются.</p>}
       <button className="btn" disabled={busy||!grant||reason.trim().length<16||(operation==='GRANT'&&!metrics.length)}>Проверить изменение</button>
     </form>
   </section>
   {preview&&<section className="portal-panel metric-preview" aria-label="Проверка изменения">
     <h2>{preview.valid?'Проверено: требуется подтверждение':'Изменение заблокировано'}</h2>
     <p>{preview.user?.full_name} · {preview.role} · {preview.branch?.code??'Сеть'}</p>
     <p>{preview.operation==='GRANT'?'Выдать':'Отозвать'}: {preview.capability==='READ'?'чтение':'публикация'}.
       Метрики: {preview.metrics.map(title).join(', ')}.</p>
     {preview.operation==='GRANT'&&<p>{date(preview.valid_from)} → {date(preview.valid_until)}</p>}
     <p>Основание: {preview.reason}</p><p>{preview.warning}</p>
     <ul>{preview.issues.map(i=><li className="org-error" key={i}>{i}</li>)}</ul>
     {preview.valid&&<>
       <p>{Date.parse(preview.expires_at??'')>now?`Проверка действует до ${date(preview.expires_at)}`:'Проверка истекла. Повторите её.'}</p>
       <label className="fact-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>
         Подтверждаю сотрудника, метрики, срок и основание</label>
       <div className="org-editor-actions"><button className="btn" disabled={busy} onClick={clearPreview}>Отмена</button>
         <button className="btn btn-primary" disabled={busy||!canApply} onClick={()=>void run(async()=>{
           if(!preview.id||!canApply)return;
           await metricApply(preview.id);if(!alive.current)return;
           clearPreview();setGrant('');setNotice('Изменение сохранено. Допуск и история обновлены.');await refresh();
         })}>Подтвердить изменение допуска</button></div>
     </>}
   </section>}
   <section className="portal-panel"><h2>Зарегистрированные допуски</h2>
     {!data?.access.length?<p>Допусков пока нет или данные ещё не загружены.</p>:<div className="metric-cards">{data.access.map(a=><article key={`${a.grant_id}:${a.capability}`}>
       <h3>{names.get(a.grant_id)??a.grant_id}</h3><p>{a.capability==='READ'?'Чтение':'Публикация'} · {a.metrics.map(title).join(', ')}</p>
       <p>{a.revoked_at?`Отозван ${date(a.revoked_at)}`:Date.parse(a.valid_from)>now?'Запланирован':
         a.valid_until&&Date.parse(a.valid_until)<=now?'Срок завершён':'В пределах срока допуска'}</p>
       <p>{date(a.valid_from)} → {date(a.valid_until)}</p><small>Действует только при активной учётной записи и назначении.</small>
     </article>)}</div>}
   </section>
   <section className="portal-panel"><h2>История · последние {data?.history_limit??100} изменений</h2>
     {!data?.history.length?<p>Изменений пока нет.</p>:<ol className="metric-history">{data.history.map(h=><li key={h.id}>
       <strong>{date(h.occurred_at)} · {h.actor_name??'Авторизованный оператор'}</strong>
       <p>{h.after_state.user?.full_name??names.get(h.after_state.grant_id??'')??'Первичная настройка'} · {h.after_state.branch?.code??''} · {h.after_state.operation==='REVOKE'?'Отзыв':'Выдача'}</p>
       <p>{h.after_state.metrics?.map(title).join(', ')} · {h.reason}</p>
       <p>{h.after_state.capability==='PUBLISH'?'Публикация':'Чтение'}
         {h.after_state.operation!=='REVOKE'&&h.after_state.valid_from?
           ` · ${date(h.after_state.valid_from==='NOW'?h.occurred_at:h.after_state.valid_from)} → ${date(h.after_state.valid_until??null)}`:''}</p>
       <details><summary>Предыдущее состояние</summary><p>{h.before_state?
         `${h.before_state.capability} · ${h.before_state.metrics.map(title).join(', ')} · ${date(h.before_state.valid_from)} → ${date(h.before_state.valid_until)}${h.before_state.revoked_at?' · отозван':''}`:'Ранее допуска не было'}</p></details>
     </li>)}</ol>}
   </section></>}
 </div>;
}
