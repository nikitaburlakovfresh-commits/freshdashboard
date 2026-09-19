import React,{useCallback,useEffect,useState} from 'react';
import { readPortalSettings,savePortalSetting,readNotificationPolicies,saveNotificationPolicy,
  type PortalSetting,type PortalSettingChange,type NotificationPolicy,type NotificationPolicyRow,
  type NotificationPolicyChange } from '../api/metrics';
import { POLICY_LABELS,eventLabel,settingHint,settingValueValid,reasonValid }
  from '../components/portalSettingsModel';
import '../styles/branch-grid.css';

/**
 * Настройки уведомлений и сроков. Политика рассылки по каждому событию и
 * числовые параметры управленческого цикла меняются здесь, без правки кода.
 * Каждое изменение требует основания, попадает в аудит и в историю, которая не
 * перезаписывается.
 */
export default function NotificationSettingsPage() {
  const [settings,setSettings]=useState<PortalSetting[]|null>(null);
  const [settingHistory,setSettingHistory]=useState<PortalSettingChange[]>([]);
  const [policies,setPolicies]=useState<NotificationPolicyRow[]|null>(null);
  const [policyHistory,setPolicyHistory]=useState<NotificationPolicyChange[]>([]);
  const [values,setValues]=useState<Record<string,string>>({});
  const [reasons,setReasons]=useState<Record<string,string>>({});
  const [drafts,setDrafts]=useState<Record<string,NotificationPolicy>>({});
  const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState('');

  const load=useCallback(async()=>{
    setError('');
    try{
      const s=await readPortalSettings();
      setSettings(s.items);setSettingHistory(s.history);
      setValues(Object.fromEntries(s.items.map(i=>[i.key,String(i.value_number)])));
      const p=await readNotificationPolicies();
      setPolicies(p.items);setPolicyHistory(p.history);
      setDrafts(Object.fromEntries(p.items.map(i=>[i.event_type,i.notification_policy])));
    }catch(e:any){setSettings(null);setPolicies(null);setError(e.message);}
  },[]);
  useEffect(()=>{load();},[load]);

  async function submitSetting(s:PortalSetting) {
    setBusy(s.key);setError('');setNotice('');
    try{
      const r=await savePortalSetting(s.key,Number(values[s.key]),reasons[s.key]??'');
      setNotice(r.changed
        ?`Настройка «${s.title}» изменена с ${r.value_before} на ${r.value_number}. Применяется к последующим расчётам.`
        :'Значение не изменилось, запись в историю не создана.');
      setReasons(v=>({...v,[s.key]:''}));
      await load();
    }catch(e:any){setError(e.message);}finally{setBusy('');}
  }

  async function submitPolicy(row:NotificationPolicyRow) {
    setBusy(row.event_type);setError('');setNotice('');
    try{
      const r=await saveNotificationPolicy(row.event_type,drafts[row.event_type],reasons[row.event_type]??'');
      setNotice(r.changed
        ?`Политика события «${eventLabel(row.event_type)}»: ${POLICY_LABELS[r.notification_policy]}. `+
          'Уже созданные уведомления не изменяются.'
        :'Политика не изменилась, запись в историю не создана.');
      setReasons(v=>({...v,[row.event_type]:''}));
      await load();
    }catch(e:any){setError(e.message);}finally{setBusy('');}
  }

  if(error&&!settings&&!policies)return <div className="portal-page">
    <h1>Уведомления и сроки</h1>
    <p className="portal-error">{error}</p>
    <p className="portal-muted">Настройка доступна только с правом администрирования параметров портала.</p>
  </div>;

  return <div className="portal-page">
    <h1>Уведомления и сроки</h1>
    <p className="portal-muted">Политика рассылки и числовые параметры управленческого цикла настраиваются
      здесь, без изменения кода. Изменение требует основания и сохраняется в истории.</p>
    {error&&<p className="portal-error">{error}</p>}
    {notice&&<p className="portal-notice">{notice}</p>}

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Параметры сроков</h2></div>
      {settings===null?<p className="portal-muted">Загрузка…</p>:settings.length===0
        ?<p className="portal-muted">Реестр настроек пуст.</p>
        :<div className="local-table-wrap"><table className="local-table">
          <thead><tr><th>Параметр</th><th>Значение</th><th>Основание изменения</th><th /></tr></thead>
          <tbody>{settings.map(s=>{
            const ok=settingValueValid(values[s.key]??'',s)&&reasonValid(reasons[s.key]??'');
            return <tr key={s.key}>
              <td>{s.title}<div className="portal-muted">{settingHint(s)}</div></td>
              <td><input inputMode="numeric" value={values[s.key]??''} aria-label={s.title}
                onChange={e=>setValues(v=>({...v,[s.key]:e.target.value}))} /></td>
              <td><input value={reasons[s.key]??''} placeholder="Не короче 16 символов"
                aria-label={`Основание: ${s.title}`}
                onChange={e=>setReasons(v=>({...v,[s.key]:e.target.value}))} /></td>
              <td><button type="button" disabled={!ok||busy===s.key} onClick={()=>submitSetting(s)}>
                {busy===s.key?'Сохранение…':'Сохранить'}</button></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>Политика рассылки по событиям</h2></div>
      <p className="portal-muted">Задача, поставленная по отклонению показателя, уведомляет ответственного
        событием назначения задачи. Значения показателя в уведомление не попадают: цифры доступны только
        на экранах с допуском к показателю.</p>
      {policies===null?<p className="portal-muted">Загрузка…</p>
        :<div className="local-table-wrap"><table className="local-table">
          <thead><tr><th>Событие</th><th>Кому рассылать</th><th>Основание изменения</th><th /></tr></thead>
          <tbody>{policies.map(row=>{
            const changed=drafts[row.event_type]!==row.notification_policy;
            const ok=changed&&reasonValid(reasons[row.event_type]??'');
            return <tr key={row.event_type}>
              <td>{eventLabel(row.event_type)}<div className="portal-muted">{row.event_type}</div></td>
              <td><select value={drafts[row.event_type]??row.notification_policy}
                aria-label={`Политика: ${row.event_type}`}
                onChange={e=>setDrafts(d=>({...d,[row.event_type]:e.target.value as NotificationPolicy}))}>
                {Object.entries(POLICY_LABELS).map(([k,v])=><option key={k} value={k}>{v}</option>)}
              </select></td>
              <td><input value={reasons[row.event_type]??''} placeholder="Не короче 16 символов"
                disabled={!changed} aria-label={`Основание: ${row.event_type}`}
                onChange={e=>setReasons(v=>({...v,[row.event_type]:e.target.value}))} /></td>
              <td><button type="button" disabled={!ok||busy===row.event_type}
                onClick={()=>submitPolicy(row)}>
                {busy===row.event_type?'Сохранение…':'Сохранить'}</button></td>
            </tr>;
          })}</tbody>
        </table></div>}
    </section>

    <section className="portal-panel">
      <div className="portal-section-head"><h2>История изменений</h2></div>
      {settingHistory.length===0&&policyHistory.length===0
        ?<p className="portal-muted">Изменений пока не было.</p>
        :<div className="local-table-wrap"><table className="local-table">
          <thead><tr><th>Дата</th><th>Что изменено</th><th>Было</th><th>Стало</th><th>Кто</th><th>Основание</th></tr></thead>
          <tbody>
            {settingHistory.map((h,i)=><tr key={`s${i}`}>
              <td>{new Date(h.created_at).toLocaleString('ru-RU')}</td>
              <td>{settings?.find(s=>s.key===h.key)?.title??h.key}</td>
              <td>{h.value_before}</td><td>{h.value_after}</td>
              <td>{h.changed_by_login}</td><td>{h.reason}</td>
            </tr>)}
            {policyHistory.map((h,i)=><tr key={`p${i}`}>
              <td>{new Date(h.created_at).toLocaleString('ru-RU')}</td>
              <td>{eventLabel(h.event_type)}</td>
              <td>{POLICY_LABELS[h.policy_before]}</td><td>{POLICY_LABELS[h.policy_after]}</td>
              <td>{h.changed_by_login}</td><td>{h.reason}</td>
            </tr>)}
          </tbody>
        </table></div>}
    </section>
  </div>;
}
