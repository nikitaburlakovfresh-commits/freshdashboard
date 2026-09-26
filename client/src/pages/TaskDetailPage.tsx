import React, { useCallback, useEffect, useState } from 'react';
import { Link,useNavigate, useParams } from 'react-router-dom';
import { moscowToday } from '../api/dailyLogs';
import {
  getWorkItem,
  getWorkItemHistory,
  startWorkItem,
  patchWorkItemFields,
  submitWorkItem,
  acceptWorkItem,
  reworkWorkItem,
  cancelWorkItem,
  reopenWorkItem,
  assignWorkItem,
} from '../api/endpoints';
import type { WorkItem, HistoryEntry } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import StatusBadge from '../components/StatusBadge';
import { apiFetch } from '../api/client';
import TaskFields, { type MeetingTaskRequest } from '../components/TaskFields';
import DelegateDialog, { type DelegateSource } from '../components/DelegateDialog';
import { diaryDelegations, diaryReference, delegationTargets, createDelegation, type DiaryDelegation, type DiaryHint, type StalePrices, type ColorRule, type DelegationTarget, type RoleRef } from '../api/dailyLogs';
import { hasUnsavedFields, mergeSavedFields, requiredFieldsPresent } from '../domain/taskForm';
import { saveLocalDraft, restoreLocalDraft, clearLocalDraft } from '../domain/draftStorage';
import type { FieldDrafts } from '../domain/taskForm';
import { displayTitle, trackerDate, ruDate, ROLE_RU, TRACKER } from '../domain/taskTitle';

const EVENT_LABELS: Record<string, string> = {
  'work_item.created': 'Задача создана',
  'work_item.assigned': 'Назначен исполнитель',
  'work_item.started': 'Работа начата',
  'work_item.fields_patched': 'Изменён результат',
  'work_item.submitted': 'Сдано на проверку',
  'work_item.accepted': 'Принято',
  'work_item.rework_requested': 'Возвращено на доработку',
  'work_item.cancelled': 'Отменено',
  'work_item.reopened': 'Возобновлено',
};

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { me } = useAuth();
  const [item, setItem] = useState<WorkItem | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [drafts, setDrafts] = useState<FieldDrafts>({});
  const [showReasonFor, setShowReasonFor] = useState<null | 'cancel' | 'rework' | 'reopen'>(null);
  const [reason, setReason] = useState('');
  const [addToDaily,setAddToDaily]=useState(true);
  const [dailyDate,setDailyDate]=useState(moscowToday);
  const [assigneeId, setAssigneeId] = useState('');
  const [assignees, setAssignees] = useState<Array<{id: string; full_name: string; login: string}>>([]);
  // Конфликт версии поля: значение с сервера рядом с набранным. Молча выбирать
  // одно из двух нельзя — портал не знает, какое из них верное.
  const [conflicts, setConflicts] = useState<Array<{field_path:string;current_value:string|null;current_version:number}>>([]);
  // Связь и незавершённая отправка. «Не сохранено» должно быть видно словами, а
  // не выглядеть как сохранённое.
  const [offline, setOffline] = useState(!navigator.onLine);
  const [retryAt, setRetryAt] = useState<number|null>(null);
  const [restoredPaths, setRestoredPaths] = useState<string[]>([]);
  // Превышен лимит частоты: пауза до указанного сервером времени, затем
  // автосохранение продолжается само. Ошибкой это человеку не показывается.
  const [pauseUntil, setPauseUntil] = useState(0);
  const [hints, setHints] = useState<DiaryHint[]>([]);
  const [delegations, setDelegations] = useState<DiaryDelegation[]>([]);
  const [delegateFrom, setDelegateFrom] = useState<DelegateSource | null>(null);
  const [delegateBatch, setDelegateBatch] = useState<DelegateSource[] | undefined>();
  const [stale, setStale] = useState<StalePrices | null>(null);
  const [colorRules, setColorRules] = useState<ColorRule[]>([]);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [wi, hist] = await Promise.all([getWorkItem(id), getWorkItemHistory(id, { limit: 100 })]);
      setItem(wi);
      setDailyDate(wi.current_business_date??moscowToday());
      setHistory(hist.items);
      // Черновик этого браузера восстанавливается поверх серверных значений:
      // набранный, но не отправленный текст не должен пропадать после
      // перезагрузки страницы или обрыва связи.
      const fresh = mergeSavedFields({}, wi.fields);
      const restored = me?.user.id ? restoreLocalDraft(wi.id, me.user.id, fresh) : { drafts: fresh, restored: [] };
      setDrafts(restored.drafts);
      setRestoredPaths(restored.restored);
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось загрузить задачу.');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const grants = me?.grants ?? [];
  const isRm = item ? grants.some((g) => g.role === 'REGIONAL_MANAGER' && g.org_unit_id === item.org_unit_id) : false;
  // Any non-REGIONAL_MANAGER operational role held at this org unit --
  // not hardcoded to 'RF' (generalized 2026-09-18 to match the server's
  // role-agnostic authorization; a ROP/ROO assignee's own item hid its
  // fields/actions before this fix, even though the server already
  // permitted them). The server remains authoritative on the exact
  // required role per action; this only decides whether to render the
  // executor controls at all.
  const isOwnExecutor = item
    ? grants.some((g) => g.role === item.owner_role && g.org_unit_id === item.org_unit_id)
      && item.assignee_user_id === me?.user.id
    : false;
  const dirty = hasUnsavedFields(drafts);
  // Обязательные задачи от руководителя, по которым ещё нет сдачи: день не сдаётся.
  const mandatoryOpen = (item?.daily_log ? item.assigned_tasks ?? [] : [])
    .filter(t => t.mandatory && ['ASSIGNED', 'IN_PROGRESS'].includes(t.status));
  // Черновик пишется в браузер на каждое изменение: между вводом и отправкой на
  // сервер есть окно, в котором раньше терялось всё набранное.
  useEffect(()=>{
    if(!item?.id||!me?.user.id)return;
    saveLocalDraft(item.id,me.user.id,drafts);
  },[drafts,item?.id,me?.user.id]);
  // Состояние связи: при обрыве отправка не выполняется, но и текст не теряется.
  useEffect(()=>{
    const on=()=>{setOffline(false);setRetryAt(Date.now());};
    const off=()=>setOffline(true);
    window.addEventListener('online',on);window.addEventListener('offline',off);
    return()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off);};
  },[]);
  // Personal diary autosaves one independently versioned field at a time.
  // Empty required text remains visibly unsaved instead of generating failures.
  useEffect(()=>{
    // Раньше любая ошибка выключала автосохранение до перезагрузки страницы:
    // пропал интернет на минуту — и дальше человек печатал в пустоту. Теперь
    // отправка останавливается только на время обрыва связи и на неразрешённом
    // конфликте версий, а после возврата связи возобновляется сама.
    if(!item?.daily_log?.can_fill||!isOwnExecutor||!['ASSIGNED','IN_PROGRESS'].includes(item.status)
      ||actionBusy||offline||conflicts.length)return;
    // Число уходит на сервер только целым: «78.» или «78.9» ждут выхода из поля,
    // где округляются, — иначе сервер отклонял недописанное значение.
    const isNum=(p:string)=>item.field_schema.find(f=>f.field_path===p)?.type==='number';
    const entry=Object.entries(drafts).find(([p,d])=>d.value!==d.baseValue&&d.value.trim().length>0
      &&(!isNum(p)||/^-?\d+$/.test(d.value.trim())));
    if(!entry)return;
    const [path,draft]=entry;
    const delay=Math.max(700,pauseUntil-Date.now());
    const timer=window.setTimeout(()=>{runAction(()=>patchWorkItemFields(item.id,{changes:[{field_path:path,expected_version:draft.version,new_value:draft.value}]}),path);},delay);
    return()=>window.clearTimeout(timer);
  },[drafts,item?.id,item?.daily_log?.can_fill,item?.status,isOwnExecutor,actionBusy,offline,conflicts.length,retryAt,pauseUntil]);
  // Подсказки из данных портала и поручения из этого ежедневника.
  const canDelegate=!!item?.daily_log&&['RF','ROP','ROO'].includes(item.daily_log.role_code)&&(isOwnExecutor||isRm);
  const loadDelegations=useCallback(()=>{
    if(!item?.id||!canDelegate)return;
    diaryDelegations(item.id).then(setDelegations).catch(()=>setDelegations([]));
  },[item?.id,canDelegate]);
  useEffect(()=>{
    if(!item?.id||!canDelegate)return;
    loadDelegations();
    diaryReference(item.id).then(r=>{setHints(r.hints);setStale(r.stale_prices??null);setColorRules(r.color_rules??[]);}).catch(()=>setHints([]));
    delegationTargets(item.id).then(r=>setPeople({targets:r.targets,roles:r.roles??[]})).catch(()=>setPeople(null));
  },[item?.id,canDelegate,loadDelegations]);
  // Задачи ответственным по итогам встречи (разделы 27 и 9): каждому сотруднику
  // выбранных ролей — задача на срок исполнения и, если указана раньше срока,
  // отдельная задача на промежуточную точку.
  const [people,setPeople]=useState<{targets:DelegationTarget[];roles:RoleRef[]}|null>(null);
  const [meetingMsg,setMeetingMsg]=useState<string|null>(null);
  const meetingTasks=async(m:MeetingTaskRequest)=>{
    if(!item||!people)return;
    const today=moscowToday();
    if(m.due<today){setMeetingMsg('Срок исполнения уже прошёл — укажите будущую дату.');return;}
    const who=people.targets.filter(t=>m.owners.includes(t.role_name));
    if(!who.length){setMeetingMsg('В выбранных ролях нет сотрудников филиала.');return;}
    const topic=(m.goal||m.section_title).trim();
    const brief=[m.goal&&`Цель: ${m.goal}`,m.summary&&`Резюме: ${m.summary}`,`Срок исполнения: ${m.due.split('-').reverse().join('.')}`].filter(Boolean).join('\n');
    const plan:{due:string;title:string}[]=[{due:m.due,title:`Встреча: ${topic}`}];
    if(m.next&&m.next>=today&&m.next<m.due)plan.unshift({due:m.next,title:`Промежуточная точка: ${topic}`});
    setActionBusy(true);setMeetingMsg(null);
    try{
      let n=0;
      for(const t of who)for(const p of plan){
        await createDelegation(item.id,{assignee_user_id:t.user_id,role_code:t.role_code,due_date:p.due,title:p.title.slice(0,200),
          brief,section_num:m.section_num,field_path:m.field_path,row_index:m.row_index,link:null,vin:null});n++;}
      setMeetingMsg(`Поставлено задач: ${n}.`);loadDelegations();
    }catch(e:any){setMeetingMsg(e?.message??'Не удалось поставить задачи.');loadDelegations();}
    finally{setActionBusy(false);}
  };
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    const navigation = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('a[href]') && !window.confirm('Есть несохранённые поля. Покинуть карточку без сохранения?')) {
        e.preventDefault(); e.stopPropagation();
      }
    };
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigation, true);
    return () => { window.removeEventListener('beforeunload', unload); document.removeEventListener('click', navigation, true); };
  }, [dirty]);
  useEffect(() => {
    if (!item || !isRm || item.status !== 'DRAFT') return;
    let live = true;
    apiFetch<{items: Array<{id: string; full_name: string; login: string}>}>(`/work-items/${item.id}/eligible-assignees`)
      .then(data => { if (live) setAssignees(data.items); })
      .catch(err => { if (live) setError(err.message ?? 'Не удалось загрузить исполнителей.'); });
    return () => { live = false; };
  }, [item?.id, item?.status, isRm]);

  async function runAction(fn: () => Promise<WorkItem>, savedPath?: string) {
    if (dirty && !savedPath) { setError('Сначала сохраните изменённые поля.'); return; }
    setActionBusy(true);
    setError(null);
    try {
      const updated = await fn();
      setItem(updated);
      // Сданную или закрытую задачу черновик в браузере переживать не должен:
      // иначе при следующем открытии подставится текст уже закрытого дня.
      if(me?.user.id&&['SUBMITTED','COMPLETED','CANCELLED'].includes(updated.status))
        clearLocalDraft(updated.id,me.user.id);
      setDrafts(current => mergeSavedFields(current, updated.fields, savedPath));
      const hist = await getWorkItemHistory(updated.id, { limit: 100 });
      setHistory(hist.items);
    } catch (err: any) {
      // Конфликт версии поля — не ошибка сети и не повод терять набранное:
      // показываем оба значения и даём выбрать человеку.
      const raw=err?.details?.conflicts;
      if (err?.code==='RATE_LIMITED' && savedPath) {
        const secs=Number(err?.details?.retry_after_seconds)||10;
        setPauseUntil(Date.now()+secs*1000);
      } else if (err?.code==='FIELD_VERSION_CONFLICT' && Array.isArray(raw)) {
        setConflicts(raw as Array<{field_path:string;current_value:string|null;current_version:number}>);
        setError('Поле изменилось на сервере. Сравните значения и выберите, какое оставить.');
      } else if (!navigator.onLine) {
        setOffline(true);
        setError('Нет связи с сервером. Введённое сохранено в этом браузере и будет отправлено, когда связь вернётся.');
      } else {
        setError(err?.message ?? 'Действие не удалось выполнить.');
      }
    } finally {
      setActionBusy(false);
    }
  }

  /** Разрешение конфликта: оставить своё значение или взять серверное. */
  async function resolveConflict(path:string, keepMine:boolean) {
    const conflict=conflicts.find(c=>c.field_path===path);
    if(!conflict||!item)return;
    if(!keepMine){
      const value=conflict.current_value??'';
      setDrafts(cur=>({...cur,[path]:{value,baseValue:value,version:conflict.current_version}}));
      setConflicts(cur=>cur.filter(c=>c.field_path!==path));
      setError(null);
      return;
    }
    // Своё значение отправляется с версией, которую сервер только что назвал:
    // это осознанная перезапись, а не молчаливая потеря чужой правки.
    const mine=drafts[path];
    if(!mine)return;
    setConflicts(cur=>cur.filter(c=>c.field_path!==path));
    setDrafts(cur=>({...cur,[path]:{...cur[path],version:conflict.current_version}}));
    await runAction(()=>patchWorkItemFields(item.id,
      {changes:[{field_path:path,expected_version:conflict.current_version,new_value:mine.value}]}),path);
  }

  if (loading) return <div style={{ color: 'var(--fresh-text-muted)' }}>Загрузка…</div>;
  if (error && !item) return <div role="alert" style={{ color: 'var(--fresh-danger)' }}>{error}</div>;
  if (!item) return null;

  return (
    <div className="task-detail-page" style={{ maxWidth: 900 }}>
      <button onClick={() => { if (!dirty || window.confirm('Покинуть карточку без сохранения полей?')) navigate('/tasks'); }} style={backBtn}>
        ← К списку задач
      </button>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        <div style={{ minWidth: 0 }}>
          {/* Трекер: название роли и дата один раз, без служебных сведений. */}
          {trackerDate(item.title) ? <>
            <h1 style={{ fontSize: 20, margin: 0, color: 'var(--fresh-dark)' }}>{TRACKER}
              {(item.daily_log?.role_code ?? item.owner_role) && ` · ${ROLE_RU[(item.daily_log?.role_code ?? item.owner_role)!] ?? ''}`}</h1>
            <div style={{ fontSize: 13, color: 'var(--fresh-text-muted)', marginTop: 6 }}>{ruDate(trackerDate(item.title)!)}
              {item.daily_log && !item.daily_log.can_fill && ' · день закрыт для изменений'}</div>
          </> : <>
          <h1 style={{ fontSize: 20, margin: 0, color: 'var(--fresh-dark)' }}>{displayTitle(item.title, item.owner_role)}</h1>
          <div style={{ fontSize: 13, color: 'var(--fresh-text-muted)', marginTop: 6 }}>
            Срок: {new Date(item.due_at).toLocaleString('ru-RU', {timeZone: 'Europe/Moscow', day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit'})} МСК
            {item.rework_count > 0 && ` · Доработок: ${item.rework_count}`}
          </div></>}
        </div>
        <StatusBadge status={item.status} />
      </div>

      {item.is_blocked && item.blocked_reason && (
        <div style={{ marginTop: 14, padding: '10px 14px', background: 'var(--fresh-warning-bg)', color: 'var(--fresh-warning)', borderRadius: 8, fontSize: 13 }}>
          Заблокировано: {item.blocked_reason}
        </div>
      )}

      {error && <div role="alert" style={{ color: 'var(--fresh-danger)', marginTop: 14, fontSize: 13 }}>{error}
        <p>Введённые поля остаются в этой карточке. При конфликте скопируйте свой текст перед загрузкой актуальной версии.</p>
        <button disabled={actionBusy} onClick={() => { if (!dirty || window.confirm('Загрузить серверную версию и отбросить несохранённые поля?')) load(); }}>Загрузить актуальную версию</button>
      </div>}

      {item.brief!=null||item.source_ref?<section style={card}>
        <h2 style={cardTitle}>Суть поручения</h2>
        {item.brief&&<p style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{item.brief}</p>}
        {item.source_ref?.link&&<p style={{overflowWrap:'anywhere'}}><a href={item.source_ref.link} target="_blank" rel="noreferrer">{item.source_ref.link}</a></p>}
        {item.source_ref?.diary_date&&<p style={{fontSize:13,color:'var(--fresh-text-muted)'}}>Из ежедневника {item.source_ref.diary_role} за {item.source_ref.diary_date}
          {item.parent_work_item_id&&<> · <Link to={`/tasks/${item.parent_work_item_id}`}>открыть ежедневник</Link></>}</p>}
      </section>:null}

      {delegateFrom&&item.daily_log&&<DelegateDialog diaryId={item.id} source={delegateFrom} batch={delegateBatch}
        onClose={()=>setDelegateFrom(null)} onCreated={()=>{setDelegateFrom(null);loadDelegations();}}/>}

      {item.daily_log&&(()=>{
        // Прогресс дня вместо служебной «личной дневной записи» (решение
        // владельца 26.09.2026): сколько задач сделано и сколько обязательных осталось.
        const marks=item.field_schema.filter(f=>/_done$/.test(f.field_path));
        const val=(p:string)=>drafts[p]?.value??item.fields.find(f=>f.field_path===p)?.value??'';
        const must=marks.filter(f=>!(f as any).optional), opt=marks.filter(f=>(f as any).optional);
        const mustDone=must.filter(f=>val(f.field_path)==='Выполнено').length;
        const optDone=opt.filter(f=>val(f.field_path)==='Выполнено').length;
        const bossLeft=mandatoryOpen.length;
        // Шкала дня (решение владельца 26.09.2026): весь трекер — 100 %.
        // Доля обязательных и необязательных — по числу задач (у РФ 6 и 4 →
        // 60 % и 40 %). Сдать можно, когда отмечены все обязательные.
        const total=must.length+opt.length;
        const wMust=total?Math.round(must.length/total*100):0, wOpt=100-wMust;
        const gotMust=must.length?Math.round(mustDone/must.length*wMust):0;
        const gotOpt=opt.length?Math.round(optDone/opt.length*wOpt):0;
        const pct=gotMust+gotOpt;
        const unmarked=must.filter(f=>!val(f.field_path)).length;
        const summaryEmpty=!String(val('completion_summary')).trim();
        const canSubmit=unmarked===0&&!summaryEmpty&&bossLeft===0;
        return <section style={card} aria-label="Прогресс дня">
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',gap:12,flexWrap:'wrap'}}>
            <h2 style={{...cardTitle,margin:0}}>Прогресс дня</h2>
            <strong style={{fontSize:22}}>{pct}%</strong>
          </div>
          <div className="day-scale" role="img" aria-label={`Выполнено ${pct}% дня`}>
            <div className="day-scale-part" style={{flexBasis:`${wMust}%`}} data-kind="must">
              <div style={{width:must.length?`${mustDone/must.length*100}%`:'0'}}/></div>
            {wOpt>0&&<div className="day-scale-part" style={{flexBasis:`${wOpt}%`}} data-kind="opt">
              <div style={{width:opt.length?`${optDone/opt.length*100}%`:'0'}}/></div>}
          </div>
          <div className="day-scale-legend">
            <span data-kind="must">Обязательные: <b>{gotMust}% из {wMust}%</b> · {mustDone} из {must.length}</span>
            {wOpt>0&&<span data-kind="opt">Необязательные: <b>{gotOpt}% из {wOpt}%</b> · {optDone} из {opt.length}</span>}
          </div>
          <p style={{margin:'10px 0 0',fontSize:14,fontWeight:600,color:canSubmit||!['ASSIGNED','IN_PROGRESS'].includes(item.status)?'var(--fresh-success, #1c8f4b)':'var(--fresh-danger, #c0392b)'}}>
            {!['ASSIGNED','IN_PROGRESS'].includes(item.status)?'День сдан':canSubmit?'Можно сдавать день':'Сдать пока нельзя: '+[
              unmarked?`нет отметки у обязательных задач — ${unmarked}`:'',
              summaryEmpty?'не заполнен итог дня':'',
              bossLeft?`не сданы задачи от руководителя — ${bossLeft}`:''].filter(Boolean).join(', ')}</p>
        </section>;
      })()}

      {(offline||restoredPaths.length>0)&&<section style={card} role="status">
        <h2 style={cardTitle}>{offline?'Нет связи с сервером':'Восстановлен черновик этого браузера'}</h2>
        {offline?<p style={{fontSize:13}}>Введённое сохраняется в этом браузере и уйдёт на сервер, когда связь
          вернётся. Пока этого не произошло, поля помечены как не сохранённые — считать их сданными нельзя.</p>
          :<p style={{fontSize:13}}>Значения, набранные раньше и не отправленные на сервер, подставлены обратно:
            {' '}{restoredPaths.length} {restoredPaths.length===1?'поле':'полей'}. Они ещё не сохранены на сервере.</p>}
      </section>}

      {conflicts.length>0&&<section style={card} role="alert">
        <h2 style={cardTitle}>Поле изменилось на сервере</h2>
        <p style={{fontSize:13}}>За время работы это поле сохранили ещё раз — возможно, с другого устройства.
          Портал не выбирает за вас: сравните значения и решите, какое верно.</p>
        {conflicts.map(c=>{
          const label=item.field_schema.find(f=>f.field_path===c.field_path)?.label??c.field_path;
          return <div key={c.field_path} style={{borderTop:'1px solid var(--fresh-border)',paddingTop:12,marginTop:12}}>
            <h3 style={{fontSize:14,margin:'0 0 8px'}}>{label}</h3>
            <p style={{fontSize:12,color:'var(--fresh-text-muted)',margin:'0 0 4px'}}>Ваше значение</p>
            <p style={{whiteSpace:'pre-wrap',margin:'0 0 10px'}}>{drafts[c.field_path]?.value||'Пусто'}</p>
            <p style={{fontSize:12,color:'var(--fresh-text-muted)',margin:'0 0 4px'}}>На сервере · версия {c.current_version}</p>
            <p style={{whiteSpace:'pre-wrap',margin:'0 0 10px'}}>{c.current_value||'Пусто'}</p>
            <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
              <button type="button" disabled={actionBusy} onClick={()=>resolveConflict(c.field_path,true)}>
                Оставить моё и перезаписать</button>
              <button type="button" disabled={actionBusy} onClick={()=>resolveConflict(c.field_path,false)}>
                Взять значение с сервера</button>
            </div>
          </div>;})}
      </section>}

      {item.daily_log&&(()=>{
        // Задачи от руководителя — часть ежедневника (решение владельца
        // 26.09.2026): со сроком сегодня и просроченные обязательны, остальные
        // видны заранее с контрольной датой.
        const list=item.assigned_tasks??[];
        const must=list.filter(t=>t.mandatory), later=list.filter(t=>!t.mandatory);
        const row=(t:typeof list[number])=><Link className="personal-task" to={`/tasks/${t.id}`} key={t.id}
          data-overdue={t.mandatory&&t.due_at_local&&t.due_at_local.slice(0,10)<item.daily_log!.business_date?'1':undefined}>
          <div><strong>{t.title}</strong>
            <small>{t.created_by_name&&<>Поставил {t.created_by_name}</>}
              {t.mandatory?t.due_at_local&&<> · срок {t.due_at_local.slice(8,10)}.{t.due_at_local.slice(5,7)}.{t.due_at_local.slice(0,4)} {t.due_at_local.slice(11)} МСК</>
                :t.due_at_local?<> · станет обязательной {t.due_at_local.slice(8,10)}.{t.due_at_local.slice(5,7)}, срок сдачи {t.due_at_local.slice(11)} МСК</>
                :<> · срок не задан</>}</small></div>
          <StatusBadge status={t.status as any}/></Link>;
        return <section style={card}>
          <h2 style={cardTitle}>Задачи от руководителя</h2>
          <h3 style={{fontSize:14,margin:'12px 0 8px'}}>Обязательно сегодня: {must.length}</h3>
          {mandatoryOpen.length>0&&<p role="alert" style={{fontSize:13,color:'var(--fresh-danger, #c0392b)',margin:'0 0 8px'}}>
            День нельзя сдать, пока не сданы эти задачи: {mandatoryOpen.length}. Если выполнить не удалось — сдайте задачу с описанием причины.</p>}
          {must.length?<div className="personal-task-list">{must.map(row)}</div>:<p style={{fontSize:13,color:'var(--fresh-text-muted)'}}>Обязательных задач на этот день нет.</p>}
          {later.length>0&&<details style={{marginTop:12}}><summary style={{cursor:'pointer',minHeight:44,display:'flex',alignItems:'center',fontSize:14}}>
            Необязательно сегодня: {later.length}</summary><div className="personal-task-list">{later.map(row)}</div></details>}
        </section>;
      })()}

      <section style={card}>
        <h2 style={cardTitle}>{item.daily_log?'Задачи дня':'Результат выполнения'}</h2>
        {meetingMsg&&<p role="status" style={{margin:'0 0 12px',fontSize:13,fontWeight:600}}>{meetingMsg}</p>}
        <TaskFields item={item} drafts={drafts} editable={isOwnExecutor && ['ASSIGNED','IN_PROGRESS'].includes(item.status) && item.daily_log?.can_fill!==false}
          busy={actionBusy}
          hints={hints} delegations={delegations}
          stale={stale} colorRules={colorRules} people={people} onMeetingTasks={canDelegate?meetingTasks:undefined}
          onDelegate={canDelegate ? (s,b)=>{setDelegateFrom(s);setDelegateBatch(b);} : undefined}
          onChange={(path,value) => {setError(null);setDrafts(current => ({...current,[path]:{...current[path],value}}));}}
          onSave={path => {
            const draft = drafts[path];
            if (!draft) return;
            runAction(() => patchWorkItemFields(item.id, {changes:[{field_path:path,expected_version:draft.version,new_value:draft.value}]}), path);
          }}/>
        {dirty && <p role="status" style={{color:'var(--fresh-warning)',fontSize:13}}>Есть несохранённые поля. Сдача и смена статуса доступны после сохранения.</p>}

      </section>

      <section style={card}>
        <h2 style={cardTitle}>Действия</h2>
        {isOwnExecutor&&!item.daily_log&&['RF','ROP','ROO'].includes(item.owner_role??'')&&['ASSIGNED','IN_PROGRESS'].includes(item.status)&&<div style={{marginBottom:16}}>
          <label style={{display:'block',padding:'12px 0'}}><input type="checkbox" checked={addToDaily} onChange={e=>setAddToDaily(e.target.checked)}/> Добавить в мой ежедневник</label>
          {addToDaily&&<label>Дата результата <input aria-label="Дата результата" type="date" value={dailyDate} onChange={e=>setDailyDate(e.target.value)}/></label>}
          <p style={{fontSize:13,color:'var(--fresh-text-muted)'}}>Снимок отправленной версии, не отметка о приёмке. Если окно не настроено или ежедневник закрыт, сервер не выполнит отправку частично.</p>
        </div>}
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {isRm && item.status === 'DRAFT' && (
            <>
              <select
                aria-label="Исполнитель"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                style={{ padding: '9px 12px', minHeight: 44, borderRadius: 8, border: '1px solid var(--fresh-border)', fontSize: 13, width: '100%', maxWidth: 360 }}
              >
                <option value="">Выберите исполнителя</option>
                {assignees.map(a => <option key={a.id} value={a.id}>{a.full_name} ({a.login})</option>)}
              </select>
              <button
                disabled={actionBusy || !assigneeId.trim()}
                onClick={() => runAction(() => assignWorkItem(item.id, { expected_entity_version: item.entity_version, assignee_user_id: assigneeId.trim() }))}
                style={primaryBtn(actionBusy)}
              >
                Назначить
              </button>
            </>
          )}

          {isOwnExecutor && item.status === 'ASSIGNED' && (
            <button disabled={actionBusy || dirty || item.daily_log?.can_fill===false} onClick={() => runAction(() => startWorkItem(item.id, { expected_entity_version: item.entity_version }))} style={primaryBtn(actionBusy)}>
              Начать работу
            </button>
          )}

          {isOwnExecutor && ['ASSIGNED', 'IN_PROGRESS'].includes(item.status) && !item.is_blocked && (
            <button
              disabled={actionBusy || dirty || item.daily_log?.can_fill===false || mandatoryOpen.length>0 || !requiredFieldsPresent(item.field_schema, item.fields)}
              onClick={() => {
                runAction(() => submitWorkItem(item.id, { expected_entity_version: item.entity_version,
                ...(!item.daily_log&&['RF','ROP','ROO'].includes(item.owner_role??'')?{add_to_daily_log:addToDaily,business_date:dailyDate}:{}) }));}}
              style={primaryBtn(actionBusy)}
              title={dirty ? 'Сначала сохраните изменения' : mandatoryOpen.length ? 'Сначала сдайте обязательные задачи от руководителя' : 'Сервер проверит все обязательные поля'}
            >
              Сдать на проверку
            </button>
          )}

          {(isRm || item.created_by === me?.user.id) && !isOwnExecutor && item.status === 'SUBMITTED' && item.current_submission && (
            <>
              <button
                disabled={actionBusy}
                onClick={() =>
                  runAction(() =>
                    acceptWorkItem(item.id, {
                      expected_entity_version: item.entity_version,
                      submission_id: item.current_submission!.id,
                      submission_revision: item.current_submission!.revision,
                    }),
                  )
                }
                style={primaryBtn(actionBusy)}
              >
                Принять
              </button>
              <button disabled={actionBusy} onClick={() => setShowReasonFor('rework')} style={secondaryBtn}>
                Вернуть на доработку
              </button>
            </>
          )}

          {isRm && item.status === 'COMPLETED' && (
            <button disabled={actionBusy} onClick={() => setShowReasonFor('reopen')} style={secondaryBtn}>
              Возобновить
            </button>
          )}

          {isRm && ['DRAFT', 'ASSIGNED', 'IN_PROGRESS', 'SUBMITTED'].includes(item.status) && (
            <button disabled={actionBusy} onClick={() => setShowReasonFor('cancel')} style={dangerBtn}>
              Отменить задачу
            </button>
          )}

          {!isRm && !isOwnExecutor && (
            <span style={{ color: 'var(--fresh-text-muted)', fontSize: 13 }}>Нет доступных действий для вашей роли по этой задаче.</span>
          )}
        </div>
      </section>

      {showReasonFor && (
        <ReasonModal
          title={
            showReasonFor === 'cancel' ? 'Отменить задачу' : showReasonFor === 'rework' ? 'Вернуть на доработку' : 'Возобновить задачу'
          }
          reason={reason}
          setReason={setReason}
          busy={actionBusy}
          onClose={() => {
            setShowReasonFor(null);
            setReason('');
          }}
          onConfirm={async () => {
            const r = reason.trim();
            if (!r) return;
            if (showReasonFor === 'cancel') {
              await runAction(() => cancelWorkItem(item.id, { expected_entity_version: item.entity_version, reason: r }));
            } else if (showReasonFor === 'rework' && item.current_submission) {
              await runAction(() =>
                reworkWorkItem(item.id, {
                  expected_entity_version: item.entity_version,
                  submission_id: item.current_submission!.id,
                  submission_revision: item.current_submission!.revision,
                  reason: r,
                }),
              );
            } else if (showReasonFor === 'reopen') {
              await runAction(() => reopenWorkItem(item.id, { expected_entity_version: item.entity_version, reason: r }));
            }
            setShowReasonFor(null);
            setReason('');
          }}
        />
      )}

      <details style={card}>
        {/* История свёрнута (решение владельца 26.09.2026): нужна редко. */}
        <summary style={{ ...cardTitle, cursor: 'pointer', minHeight: 44, display: 'flex', alignItems: 'center' }}>История · {history.length}</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {history.length === 0 && <span style={{ color: 'var(--fresh-text-muted)', fontSize: 13 }}>Событий пока нет.</span>}
          {history.map((h) => (
            <div key={h.event_id} style={{ borderLeft: '2px solid var(--fresh-border)', paddingLeft: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--fresh-dark)' }}>{EVENT_LABELS[h.event_type] ?? h.event_type}</div>
              <div style={{ fontSize: 12, color: 'var(--fresh-text-muted)', marginTop: 2 }}>{new Date(h.occurred_at).toLocaleString('ru-RU', {timeZone:'Europe/Moscow'})} МСК</div>
              {h.reason && <div style={{ fontSize: 12, color: 'var(--fresh-dark)', marginTop: 4, overflowWrap: 'anywhere' }}>Причина: {h.reason}</div>}
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

function ReasonModal({
  title,
  reason,
  setReason,
  busy,
  onClose,
  onConfirm,
}: {
  title: string;
  reason: string;
  setReason: (v: string) => void;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40, padding: 16 }}>
      <div role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()} style={{ width: 420, maxWidth: '100%', background: 'var(--fresh-surface)', border: '1px solid var(--fresh-border)', borderRadius: 16, padding: 26 }}>
        <h3 style={{ marginTop: 0, fontSize: 20, color: 'var(--fresh-dark)' }}>{title}</h3>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Укажите причину…"
          aria-label="Причина" autoFocus
          style={{ width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--fresh-border)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical' }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
          <button onClick={onClose} style={secondaryBtn}>
            Отмена
          </button>
          <button disabled={busy || !reason.trim()} onClick={onConfirm} style={primaryBtn(busy)}>
            Подтвердить
          </button>
        </div>
      </div>
    </div>
  );
}

const backBtn: React.CSSProperties = { background: 'none', border: 'none', color: 'var(--fresh-link)', fontSize: 13, fontWeight: 500, cursor: 'pointer', padding: 0, minHeight: 44 };
const card: React.CSSProperties = { background: 'var(--fresh-surface)', border: '1px solid var(--fresh-border)', borderRadius: 12, padding: 20, marginTop: 18 };
const cardTitle: React.CSSProperties = { fontSize: 20, margin: 0, marginBottom: 14, color: 'var(--fresh-dark)' };
function primaryBtn(disabled: boolean): React.CSSProperties {
  return { minHeight: 44, padding: '9px 16px', borderRadius: 16, border: 'none', background: '#003DFF', color: '#fff', fontWeight: 500, fontSize: 13, cursor: disabled ? 'default' : 'pointer' };
}
const secondaryBtn: React.CSSProperties = { minHeight: 44, padding: '9px 16px', borderRadius: 16, border: '1px solid var(--fresh-border)', background: 'var(--fresh-surface)', color: 'var(--fresh-dark)', fontWeight: 500, fontSize: 13, cursor: 'pointer' };
const dangerBtn: React.CSSProperties = { minHeight: 44, padding: '9px 16px', borderRadius: 16, border: '1px solid var(--fresh-border)', background: 'var(--fresh-surface)', color: 'var(--fresh-danger)', fontWeight: 500, fontSize: 13, cursor: 'pointer' };
