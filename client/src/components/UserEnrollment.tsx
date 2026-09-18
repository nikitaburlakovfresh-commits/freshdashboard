import React,{useEffect,useRef,useState} from 'react';
import { AccessDirectory,createPersonalUser,manageEnrollment } from '../api/access';

export default function UserEnrollment({data,permissions,onChange}:{data:AccessDirectory;permissions:Set<string>;onChange:()=>Promise<void>}) {
  const [login,setLogin]=useState(''),[name,setName]=useState(''),[email,setEmail]=useState(''),[reason,setReason]=useState('');
  const [target,setTarget]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [link,setLink]=useState(''),[expires,setExpires]=useState(''),[action,setAction]=useState<'create'|'issue'|'revoke'>('create');
  const dialog=useRef<HTMLDialogElement>(null);
  const create=permissions.has('user.create'),manage=permissions.has('user.enrollment.manage');
  const pending=data.users.filter(u=>u.enrollment&&!u.enrollment.completed_at&&!u.is_active&&u.personal);
  const selected=pending.find(u=>u.id===target);
  useEffect(()=>{if(!manage)setLink('');},[manage]);
  function confirm(next:typeof action) {setAction(next);setError('');dialog.current?.showModal();}
  async function apply() {
    dialog.current?.close();setBusy(true);setError('');setNotice('');setLink('');
    try {
      if(action==='create') {
        const u=await createPersonalUser({login,full_name:name,primary_email:email,reason});
        setTarget(u.id);setLogin('');setName('');setEmail('');
        setNotice(`Создана неактивная учётная запись ${u.login}. Теперь выпустите приглашение. Права не выданы.`);
      } else if(selected?.enrollment) {
        const r=await manageEnrollment(selected.id,action,selected.enrollment.version,reason);
        if(r.token) {setLink(`${window.location.origin}/activate-account#${r.token}`);setExpires(r.enrollment.expires_at??'');}
        setNotice(action==='issue'?`Приглашение для ${selected.login} выпущено, но НЕ отправлено. Прежняя ссылка недействительна.`:'Приглашение отозвано. Учётная запись остаётся неактивной.');
      }
      try {await onChange();} catch {setError('Операция выполнена, но обновление справочника не удалось. Обновите страницу после сохранения ссылки.');}
    } catch(e) {
      setError(e instanceof Error?e.message:'Операция не выполнена.');
      // A lost response must refresh the version before explicit reissue.
      try {await onChange();} catch {/* keep the original diagnostic */}
    } finally {setBusy(false);}
  }
  if(!create&&!manage)return <section className="portal-panel"><h2>Заведение сотрудников</h2>
    <p>Создание личных пользователей доступно после отдельного включения прав user.create и user.enrollment.manage. Права назначения ролей этого не разрешают.</p></section>;
  return <section className="portal-panel enrollment-admin">
    <div className="org-section-heading"><h2>Завести сотрудника</h2><span className="portal-chip">Личный первый вход</span></div>
    <p>Создание → приглашение → личный пароль → назначение роли. Общие логины и пароли старого портала не переносятся.</p>
    {error&&<p role="alert" className="org-error">{error}</p>}{notice&&<p role="status" className="access-notice">{notice}</p>}
    {link&&<div className="enrollment-receipt">
      <h3>Ссылка показывается только сейчас</h3>
      <p>Передайте её лично нужному сотруднику по утверждённому защищённому каналу. Действует до {new Date(expires).toLocaleString('ru-RU')}. Это секрет, не помещайте его в общие чаты.</p>
      <label>Одноразовое приглашение<textarea readOnly rows={3} value={link} spellCheck={false}/></label>
      <button className="btn" type="button" onClick={()=>setLink('')}>Скрыть ссылку</button>
      <p>После закрытия или перезагрузки повторно показать ссылку нельзя. Выпуск новой отменит прежнюю.</p>
    </div>}
    <label className="enrollment-reason">Основание действия<textarea value={reason} onChange={e=>setReason(e.target.value)} minLength={10} maxLength={500} rows={2} disabled={busy}
      placeholder="Кем согласовано заведение сотрудника или выпуск приглашения"/></label>
    <div className="enrollment-grid">
      <form onSubmit={e=>{e.preventDefault();confirm('create');}}>
        <h3>Новая личная учётная запись</h3>
        <fieldset disabled={busy||!create}>
          <label>ФИО<input required minLength={2} maxLength={200} value={name} onChange={e=>setName(e.target.value)} autoComplete="off"/></label>
          <label>Логин сотрудника<input required pattern="[a-z][a-z0-9._-]{2,79}" value={login} onChange={e=>setLogin(e.target.value)} autoComplete="off"/>
            <small>Строчные латинские буквы, цифры, точка, дефис, подчёркивание</small></label>
          <label>Персональная рабочая почта<input required type="email" maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} autoComplete="off"/></label>
          <button className="btn" disabled={reason.trim().length<10}>Проверить создание…</button>
        </fieldset>
      </form>
      <div><h3>Первое приглашение</h3>
        <fieldset disabled={busy||!manage}>
          <label>Ожидает первого входа<select value={target} onChange={e=>{setTarget(e.target.value);setLink('');}}>
            <option value="">Выберите сотрудника</option>{pending.map(u=><option key={u.id} value={u.id}>{u.full_name} · {u.login}</option>)}
          </select></label>
          {selected&&<p>{selected.primary_email}<br/>{selected.enrollment?.has_invitation?
            `Ссылка выпущена до ${new Date(selected.enrollment.expires_at!).toLocaleString('ru-RU')}`:'Действующего приглашения нет'}</p>}
          <p>Повторный выпуск немедленно отменяет предыдущую ссылку. Здесь нельзя сбросить пароль действующего пользователя.</p>
          <button className="btn" disabled={!selected||reason.trim().length<10} onClick={()=>confirm('issue')}>Выпустить приглашение…</button>
          <button className="btn" disabled={!selected?.enrollment?.has_invitation||reason.trim().length<10} onClick={()=>confirm('revoke')}>Отозвать приглашение…</button>
        </fieldset>
      </div>
    </div>
    <dialog ref={dialog} className="org-apply-dialog" aria-labelledby="enrollment-confirm">
      <h2 id="enrollment-confirm">{action==='create'?'Создать личную учётную запись?':action==='issue'?'Выпустить одноразовое приглашение?':'Отозвать приглашение?'}</h2>
      <p>{action==='create'?`${name} · ${login} · ${email}`:`${selected?.full_name} · ${selected?.login} · ${selected?.primary_email}`}</p>
      <p>{reason}</p><p>Права на филиалы не выдаются. Приглашение не отправляется автоматически.</p>
      <div className="org-editor-actions"><button className="btn" onClick={()=>dialog.current?.close()}>Отмена</button>
        <button className="btn" disabled={busy||(action==='create'?!create:!manage)||reason.trim().length<10} onClick={apply}>Подтверждаю</button></div>
    </dialog>
  </section>;
}
