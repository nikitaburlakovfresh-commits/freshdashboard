import React,{useEffect,useRef,useState} from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { AccessDirectory,AccessProposal,AccessChange,getAccessDirectory,listAccessChanges,getAccessChange,
  createAccessChange,previewAccessChange,applyAccessChange } from '../api/access';
import { accessPermissions,canApplyAccess } from '../components/accessChangeModel';
import '../styles/organization.css';
import '../styles/access.css';

const date=(s:string|null)=>s?new Date(s).toLocaleString('ru-RU'):'Без окончания';
const status={DRAFT:'Черновик',PREVIEW:'Проверено',APPLIED:'Применено'};
export default function AccessPage() {
  const {me}=useAuth();
  const permissions=accessPermissions(me?.grants??[]);
  const read=permissions.has('access.directory.read');
  const allowed=(phase:string)=>permissions.has('user.assign_role')&&permissions.has(`access.change.${phase}`);
  const [data,setData]=useState<AccessDirectory|null>(null),[items,setItems]=useState<AccessProposal[]>([]);
  const [p,setP]=useState<AccessProposal|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [notice,setNotice]=useState(''),[now,setNow]=useState(Date.now()),[query,setQuery]=useState('');
  const [operation,setOperation]=useState<'GRANT_ROLE'|'REVOKE_ROLE'>('GRANT_ROLE');
  const [user,setUser]=useState(''),[role,setRole]=useState(''),[branch,setBranch]=useState(''),[grant,setGrant]=useState('');
  const [start,setStart]=useState(''),[end,setEnd]=useState(''),[reason,setReason]=useState('');
  const confirm=useRef<HTMLDialogElement>(null);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  async function refresh() {const [d,l]=await Promise.all([getAccessDirectory(),listAccessChanges()]);setData(d);setItems(l.items);}
  useEffect(()=>{
    let alive=true;setData(null);setItems([]);setP(null);setError('');
    if(read) {setBusy(true);Promise.all([getAccessDirectory(),listAccessChanges()])
      .then(([d,l])=>{if(alive){setData(d);setItems(l.items);}})
      .catch(e=>{if(alive)setError(e.message);}).finally(()=>{if(alive)setBusy(false);});}
    return()=>{alive=false;};
  },[read,me?.user.id]);
  async function run(fn:()=>Promise<void>) {
    setBusy(true);setError('');setNotice('');
    try {await fn();} catch(e) {
      setError(e instanceof Error?e.message:'Не удалось выполнить запрос.');
      if(e instanceof ApiError&&e.status===409) setP(current=>current?{...current,preview_token:null}:null);
      if(e instanceof ApiError&&[401,403].includes(e.status)){setData(null);setItems([]);setP(null);}
    } finally {setBusy(false);}
  }
  async function save() {
    if(start&&!Number.isFinite(Date.parse(start))||end&&!Number.isFinite(Date.parse(end))) throw new Error('Проверьте даты.');
    const c:AccessChange=operation==='GRANT_ROLE'
      ?{operation,user_id:user,role_code:role,org_unit_id:branch,valid_from:start?new Date(start).toISOString():'NOW',
        valid_until:end?new Date(end).toISOString():null,reason}
      :{operation,grant_id:grant,reason};
    const created=await createAccessChange(c);setP(created);await refresh();setNotice('Черновик сохранён. Права ещё не изменены.');
  }
  const selectedUser=data?.users.find(u=>u.id===user);
  const canApply=canApplyAccess(p,me?.user.id??'',allowed('apply'),now);
  const branches=new Map(data?.branches.map(b=>[b.id,b.code])??[]);
  const names=new Map(data?.users.map(u=>[u.id,u.full_name])??[]);
  const visibleUsers=data?.users.filter(u=>`${u.full_name} ${u.login}`.toLowerCase().includes(query.toLowerCase()))??[];
  const eligibleUsers=data?.users.filter(u=>u.is_active&&u.personal&&u.id!==me?.user.id&&
    !data.grants.some(g=>g.user_id===u.id&&g.scope_kind==='NETWORK'))??[];
  const revocable=data?.grants.filter(g=>g.scope_kind==='ORG_UNIT'&&g.org_unit_id&&branches.has(g.org_unit_id)&&!g.revoked_at&&
    (!g.valid_until||Date.parse(g.valid_until)>now)&&g.user_id!==me?.user.id&&
    !data.grants.some(x=>x.user_id===g.user_id&&x.scope_kind==='NETWORK'))??[];
  return <div className="org-page access-page">
    <header className="portal-heading"><div><span className="portal-eyebrow">Администрирование · точечный доступ</span>
      <h1>Пользователи и назначения</h1><p>Личные учётные записи, права на филиал и история изменений.</p></div></header>
    <section className="org-scope"><div><strong>Один филиал. Явное подтверждение.</strong>
      <p>Черновик → проверка последствий → применение. Здесь не создаются пользователи, не активируются филиалы и не выдаются сетевые права.
        Назначения на дивизион, замещение и SUPPORTING пока не поддерживаются.</p></div></section>
    {!read?<section className="portal-panel"><h2>Нет права управления доступом</h2><p>Название роли администратора само по себе не даёт это право. Нужна отдельная одобренная настройка.</p></section>:<>
      {error&&<div className="portal-panel org-error" role="alert">{error}</div>}
      {notice&&<p role="status" className="access-notice">{notice}</p>}
      {busy&&<p role="status">Выполняется проверка сервера…</p>}
      {!data?<button className="btn" disabled={busy} onClick={()=>run(refresh)}>Повторить загрузку</button>:<>
        <section className="portal-panel access-directory">
          <div className="org-section-heading"><h2>Сотрудники · {data.users.length}</h2>
            <button className="btn" disabled={busy} onClick={()=>run(refresh)}>Обновить справочник</button></div>
          <div className="org-toolbar"><label className="org-search">Поиск сотрудника<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="ФИО или логин"/></label></div>
          <div className="access-users">{visibleUsers.map(u=><article key={u.id}>
            <div><strong>{u.full_name}</strong><small>{u.login} · {u.is_active?'Активен':'Неактивен'}{!u.personal?' · Не личный доступ':''}</small></div>
            <ul>{data.grants.filter(g=>g.user_id===u.id).map(g=><li key={g.id}>
              <span>{g.role_code} · {g.scope_kind==='NETWORK'?'Вся сеть':branches.get(g.org_unit_id??'')??'Пилот / защищённый филиал'}</span>
              <small>{g.revoked_at?`Отозвано ${date(g.revoked_at)}`:
                `${Date.parse(g.valid_from)>now?'Запланировано':g.valid_until&&Date.parse(g.valid_until)<=now?'Завершено':'Действует'} · ${date(g.valid_from)} → ${date(g.valid_until)}`}</small>
            </li>)}</ul>
          </article>)}</div>
          {!visibleUsers.length&&<p>Сотрудники не найдены.</p>}
        </section>
        <section className="portal-panel org-editor">
          <div className="org-section-heading"><h2>Изменение назначения</h2>
            <button className="btn" disabled={busy||!allowed('draft')} onClick={()=>{setP(null);setReason('');setError('');setNotice('');}}>Новый черновик</button></div>
          <div className="org-editor-grid"><aside><h3>Последние 100 предложений</h3>
            <ul className="org-proposal-list">{items.map(i=><li key={i.id}><button disabled={busy} aria-pressed={p?.id===i.id}
              onClick={()=>run(async()=>{setP(await getAccessChange(i.id));})}>
              <strong>{i.change.operation==='GRANT_ROLE'?'Выдать роль':'Отозвать роль'} · {status[i.status]}</strong>
              <span>{date(i.updated_at)} · v{i.version}</span><span>{i.change.reason}</span>
            </button></li>)}</ul>{!items.length&&<p>Сохранённых предложений пока нет.</p>}</aside>
            <div className="org-editor-content">
              {!p?<form onSubmit={e=>{e.preventDefault();run(save);}}>
                <fieldset className="org-editor-fields" disabled={busy||!allowed('draft')}>
                  <label className="org-editor-wide">Операция<select aria-label="Операция" value={operation} onChange={e=>setOperation(e.target.value as typeof operation)}>
                    <option value="GRANT_ROLE">Выдать роль в филиале</option><option value="REVOKE_ROLE">Отозвать назначение</option></select></label>
                  {operation==='GRANT_ROLE'?<>
                    <label>Сотрудник<select aria-label="Сотрудник" required value={user} onChange={e=>setUser(e.target.value)}><option value="">Выберите сотрудника</option>
                      {eligibleUsers.map(u=><option key={u.id} value={u.id}>{u.full_name} · {u.login}</option>)}</select></label>
                    <label>Роль<select aria-label="Роль" required value={role} onChange={e=>setRole(e.target.value)}><option value="">Выберите роль</option>
                      {data.roles.map(r=><option key={r.code} value={r.code}>{r.display_name}</option>)}</select></label>
                    <label className="org-editor-wide">Филиал<select aria-label="Филиал" required value={branch} onChange={e=>setBranch(e.target.value)}><option value="">Выберите активный филиал</option>
                      {data.branches.filter(b=>b.lifecycle_state==='ACTIVE').map(b=><option key={b.id} value={b.id}>{b.code}</option>)}</select></label>
                    <label>Начало · местное время<input aria-label="Начало · местное время" type="datetime-local" value={start} onChange={e=>setStart(e.target.value)}/><small>Пусто: в момент применения</small></label>
                    <label>Окончание · местное время<input aria-label="Окончание · местное время" type="datetime-local" value={end} onChange={e=>setEnd(e.target.value)}/><small>Пусто: без окончания</small></label>
                  </>:<label className="org-editor-wide">Назначение<select aria-label="Назначение" required value={grant} onChange={e=>setGrant(e.target.value)}><option value="">Выберите назначение</option>
                    {revocable.map(g=><option key={g.id} value={g.id}>{names.get(g.user_id)} · {g.role_code} · {branches.get(g.org_unit_id!)}</option>)}</select></label>}
                  <label className="org-editor-wide">Основание<textarea required minLength={10} maxLength={500} rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Кем и для какой задачи согласовано назначение"/></label>
                </fieldset>
                {operation==='GRANT_ROLE'&&!data.branches.some(b=>b.lifecycle_state==='ACTIVE')&&<p className="access-notice">Активных реальных филиалов нет. Сначала согласуйте оргструктуру и отдельный этап ввода филиалов в эксплуатацию.</p>}
                {selectedUser&&<p>Выбран: {selectedUser.full_name}. Права других филиалов не меняются.</p>}
                <button className="btn" disabled={busy||!allowed('draft')}>Сохранить черновик</button>
              </form>:<>
                <span className="portal-chip">{status[p.status]} · версия {p.version}</span>
                <h3>{p.change.operation==='GRANT_ROLE'?'Выдать роль на один филиал':'Отозвать назначение'}</h3>
                <p>{p.change.reason}</p>
                <dl className="org-facts">
                  {p.change.operation==='GRANT_ROLE'?<>
                    <div><dt>Сотрудник</dt><dd>{names.get(p.change.user_id)??p.change.user_id}</dd></div>
                    <div><dt>Роль и филиал</dt><dd>{p.change.role_code} · {branches.get(p.change.org_unit_id)??p.change.org_unit_id}</dd></div>
                    <div><dt>Интервал</dt><dd>{p.change.valid_from==='NOW'?'С момента применения':date(p.change.valid_from)} → {date(p.change.valid_until)}</dd></div>
                  </>:<div><dt>ID назначения</dt><dd>{p.change.grant_id}</dd></div>}
                  <div><dt>Предложение</dt><dd>{p.id}</dd></div>
                </dl>
                {p.preview_summary&&<div className="org-preview-summary">
                  <h3>{p.preview_summary.valid?'Последствия проверены':'Проверка не пройдена'}</h3>
                  {p.preview_summary.user&&<p>{p.preview_summary.user.full_name} · {p.preview_summary.user.login}</p>}
                  <p>{p.preview_summary.role?.display_name} · {p.preview_summary.branch?.code}</p>
                  <ul>{p.preview_summary.issues.map(issue=><li className="org-error" key={issue}>{issue}</li>)}</ul>
                  <p>Незавершённых задач: {p.preview_summary.affected.active_tasks}. Изменяемых задач: 0. Изменяемых финансовых записей: 0.</p>
                  <h3>Права роли</h3><ul className="access-permissions">{p.preview_summary.role?.permissions.map(v=><li key={v}><code>{v}</code></li>)}</ul>
                  <p>{p.preview_summary.warning}</p>
                  {p.status==='PREVIEW'&&<p>{Date.parse(p.preview_expires_at??'')>now?`Проверка действительна до ${date(p.preview_expires_at)}`:'Срок проверки истёк. Проверьте заново.'}</p>}
                  {p.preview_summary.after_grant&&<p>Записано: {p.preview_summary.after_grant.revoked_at?`отзыв ${date(p.preview_summary.after_grant.revoked_at)}`:`начало ${date(p.preview_summary.after_grant.valid_from)}`}</p>}
                </div>}
                <div className="org-editor-actions">
                  <button className="btn" disabled={busy||p.status==='APPLIED'||!allowed('preview')} onClick={()=>run(async()=>{setP(await previewAccessChange(p));await refresh();})}>Проверить последствия</button>
                  <button className="btn org-apply" disabled={busy||!canApply} onClick={()=>confirm.current?.showModal()}>Применить…</button>
                </div>
                <div className="org-change-history"><h3>История предложения</h3>
                  <button className="btn" disabled={busy} onClick={()=>run(async()=>{setP(await getAccessChange(p.id));})}>Обновить историю</button>
                  <ol>{p.history?.map(h=><li key={h.aggregate_version}>{date(h.occurred_at)} · {h.action} · {names.get(h.actor_user_id)??h.actor_user_id}</li>)}</ol></div>
              </>}
            </div>
          </div>
        </section>
      </>}
    </>}
    <dialog ref={confirm} className="org-apply-dialog" aria-labelledby="access-confirm-title">
      <h2 id="access-confirm-title">Подтвердить изменение доступа?</h2>
      <p>{p?.preview_summary?.user?.full_name} · {p?.preview_summary?.role?.display_name} · {p?.preview_summary?.branch?.code}</p>
      <p>{p?.change.operation==='REVOKE_ROLE'?'Назначение будет отозвано сразу.':`Начало: ${p?.change.operation==='GRANT_ROLE'&&p.change.valid_from!=='NOW'?date(p.change.valid_from):'в момент применения'}.`}</p>
      <p>Это изменит реальные права в текущей базе. История сохранится; исправление потребует нового предложения.</p>
      <div className="org-editor-actions"><button className="btn" onClick={()=>confirm.current?.close()}>Отмена</button>
        <button className="btn" disabled={busy||!canApply} onClick={()=>{confirm.current?.close();if(p)run(async()=>{
          const result=await applyAccessChange(p);setP(result);setNotice('Назначение применено. История сохранена.');await refresh();
        });}}>Подтверждаю изменение</button></div>
    </dialog>
  </div>;
}
