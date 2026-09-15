import React,{useEffect,useRef,useState} from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import type { DirectoryUnit } from '../api/organization';
import { applyOrgProposal,createOrgProposal,editOrgProposal,getOrgProposal,listOrgProposals,previewOrgProposal,
  type OrgChange,type OrgProposal } from '../api/orgChanges';
import { canApplyOrgProposal } from './orgChangeModel';

const labels={ORG_UNIT_CREATE:'Создание единицы',ORG_UNIT_RENAME:'Переименование',ORG_UNIT_MOVE_TO_CLUSTER:'Перенос к другому родителю'};
const statuses={DRAFT:'Черновик',PREVIEW:'Проверен',APPLIED:'Применён'};
const empty=():OrgChange=>({operation:'ORG_UNIT_CREATE',kind:'NETWORK',code:'',display_name:'',parent_id:null,
  type_code:null,business_model:null,effective_from:new Date().toISOString().slice(0,10),reason:''});
export default function OrganizationEditor({units,onApplied}:{units:DirectoryUnit[];onApplied:()=>void}) {
  const {me}=useAuth();
  const permissions=new Set(me?.grants.filter(g=>g.scope_kind==='NETWORK' && g.org_unit_id===null).flatMap(g=>g.permissions));
  const [items,setItems]=useState<OrgProposal[]>([]);
  const [p,setP]=useState<OrgProposal|null>(null);
  const [change,setChange]=useState<OrgChange>(empty);
  const [dirty,setDirty]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [now,setNow]=useState(Date.now());
  const dialog=useRef<HTMLDialogElement>(null);
  const actor=me?.user.id ?? '';
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{ let live=true;listOrgProposals().then(r=>{if(live)setItems(r.items);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[actor]);
  const permission={ORG_UNIT_CREATE:'org_unit.create',ORG_UNIT_RENAME:'org_unit.rename',ORG_UNIT_MOVE_TO_CLUSTER:'org_unit.move'}[change.operation];
  const writable=permissions.has(permission) && p?.status!=='APPLIED';
  const applyAllowed=canApplyOrgProposal(p,dirty,actor,permissions.has('organization.change.apply') && permissions.has(permission),now);
  function update(values:Partial<OrgChange>) {setChange(c=>({...c,...values}));setDirty(true);setNotice('');}
  async function run(fn:()=>Promise<OrgProposal>,message:string,applied=false) {
    setBusy(true);setError('');setNotice('');
    try {
      const result=await fn();setP(result);setChange(result.change);setDirty(false);setNotice(message);
      setItems((await listOrgProposals()).items);
      if(applied)onApplied();
    } catch(e) {
      setError(e instanceof ApiError ? `${e.message} (${e.code})` : 'Не удалось выполнить запрос. Повторите: ключ команды сохранён.');
      if(e instanceof ApiError && e.status===409) setDirty(true);
    } finally {setBusy(false);}
  }
  function newOperation(operation:OrgChange['operation']) {
    setChange(operation==='ORG_UNIT_CREATE'?empty():{operation,target_id:'',effective_from:new Date().toISOString().slice(0,10),reason:'',
      ...(operation==='ORG_UNIT_RENAME'?{display_name:''}:{parent_id:null})});
    setDirty(true);
  }
  const eligible=units.filter(u=>!u.is_demo && !u.demo_locked && u.lifecycle_state==='PRE_LAUNCH');
  return <section className="portal-panel org-editor" aria-label="Редактор оргструктуры">
    <div className="org-section-heading"><div><div className="portal-eyebrow">АДМИНИСТРАТОР · NETWORK</div><h2>Изменения оргструктуры</h2></div>
      <span className="portal-chip">Черновик → проверка → применение</span></div>
    <p className="portal-muted">Создание, переименование и перенос единиц справочника до запуска. A/B защищены. Роли, задачи, финансы, активация и импорт не меняются.</p>
    <div className="org-editor-grid">
      <aside aria-label="Сохранённые предложения">
        <button className="btn" data-testid="new-org-proposal" disabled={busy} onClick={()=>{setP(null);setChange(empty());setDirty(false);setError('');setNotice('');}}>Новое предложение</button>
        <h3>Сохранённые предложения</h3>
        <p className="org-small portal-muted">Последние 100. Черновики хранятся на сервере; применённые записи неизменны.</p>
        {!items.length && <p className="portal-muted">Предложений пока нет. Заполните данные и создайте первый черновик. Корень сети автоматически не создаётся.</p>}
        <ul className="org-proposal-list">{items.map(row=><li key={row.id}>
          <button disabled={busy} aria-pressed={p?.id===row.id} onClick={()=>run(()=>getOrgProposal(row.id),'Открыта сохранённая версия.')}
            data-testid={`open-org-proposal-${row.id}`}>
            <strong>{row.change.display_name || row.change.code || labels[row.change.operation]}</strong>
            <span>{statuses[row.status]} · v{row.version}</span>
          </button></li>)}</ul>
      </aside>
      <div className="org-editor-content">
        <div className="org-status-row"><strong>{p?`${statuses[p.status]} · версия ${p.version}`:'Новое предложение'}</strong>{dirty && <span>Есть несохранённые изменения</span>}</div>
        {p && <p className="org-small org-id">Стабильный OrgUnit UUID: {p.target_id}</p>}
        <fieldset disabled={busy || !writable} className="org-editor-fields">
          <label>Операция<select data-testid="org-operation" value={change.operation} disabled={!!p} onChange={e=>newOperation(e.target.value as OrgChange['operation'])}>
            {Object.entries(labels).map(([key,value])=><option key={key} value={key}>{value}</option>)}</select></label>
          {change.operation==='ORG_UNIT_CREATE'?<>
            <label>Уровень<select data-testid="org-kind" value={change.kind} onChange={e=>update({kind:e.target.value,parent_id:null,type_code:null})}>
              <option value="NETWORK">Сеть · NETWORK</option><option value="DIVISION">Дивизион · DIVISION</option>
              <option value="CLUSTER">Кластер · CLUSTER</option><option value="ORG_UNIT">Филиал · ORG_UNIT</option></select></label>
            <label>Постоянный код<input data-testid="org-code" value={change.code} maxLength={100} placeholder="Латиница, цифры, _ или -" onChange={e=>update({code:e.target.value})}/></label>
          </>:<label>Единица до запуска<select data-testid="org-target" value={change.target_id} disabled={!!p} onChange={e=>update({target_id:e.target.value})}>
            <option value="">Выберите единицу</option>{eligible.map(u=><option key={u.id} value={u.id}>{u.display_name} · {u.code}</option>)}</select></label>}
          {change.operation!=='ORG_UNIT_MOVE_TO_CLUSTER' && <label>Название<input data-testid="org-name" value={change.display_name ?? ''} maxLength={200} onChange={e=>update({display_name:e.target.value})}/></label>}
          {change.operation!=='ORG_UNIT_RENAME' && !(change.operation==='ORG_UNIT_CREATE' && change.kind==='NETWORK') &&
            <label>Подтверждённый родитель<select data-testid="org-parent" value={change.parent_id ?? ''} onChange={e=>update({parent_id:e.target.value || null})}>
              <option value="">Выберите родителя</option>{units.filter(u=>!u.is_demo && u.id!==change.target_id && u.kind!=='ORG_UNIT').map(u=><option key={u.id} value={u.id}>{u.display_name} · {u.kind}</option>)}</select></label>}
          {change.operation==='ORG_UNIT_CREATE' && <>
            {change.kind==='ORG_UNIT' && <label>Тип филиала<select data-testid="org-type" value={change.type_code ?? ''} onChange={e=>update({type_code:e.target.value || null})}>
              <option value="">Не подтверждён</option>{['CITY_FLAG','EXPRESS','FULL_SERVICE','PICKUP_POINT','OUTLET'].map(v=><option key={v}>{v}</option>)}</select></label>}
            <label>Бизнес-модель<select data-testid="org-business-model" value={change.business_model ?? ''} onChange={e=>update({business_model:e.target.value || null})}>
              <option value="">Не подтверждена · не угадывать</option><option value="FRANCHISE">Франшиза</option><option value="OWN_OPERATION">Собственная операция</option><option value="UC">Управляющая компания</option></select></label>
          </>}
          <label>Дата вступления в силу (UTC)<input data-testid="org-effective-date" type="date" value={change.effective_from} min={new Date().toISOString().slice(0,10)} max="9999-12-31" onChange={e=>update({effective_from:e.target.value})}/></label>
          <label className="org-editor-wide">Основание<textarea data-testid="org-reason" value={change.reason} maxLength={500} rows={2} onChange={e=>update({reason:e.target.value})}/></label>
        </fieldset>
        <p className="org-small portal-muted">Новые единицы: только «До запуска». Тип и бизнес-модель можно оставить неподтверждёнными. Для смены имени/родителя дата должна быть позже начала последнего интервала. Будущие единицы появятся в срезе на дату вступления в силу.</p>
        <div className="org-editor-actions">
          <button className="btn" data-testid="save-org-draft" disabled={busy || !writable || (!!p && !dirty)}
            onClick={()=>run(()=>p?editOrgProposal(p,change):createOrgProposal(change),'Черновик сохранён на сервере. Структура не изменена.')}>{p?'Сохранить черновик':'Создать черновик'}</button>
          <button className="btn" data-testid="preview-org-draft" disabled={busy || !p || dirty || !writable || !permissions.has('organization.change.preview')}
            onClick={()=>p && run(()=>previewOrgProposal(p),'Проверка завершена. Применение — отдельное действие.')}>Проверить</button>
          <button className="btn org-apply" data-testid="apply-org-draft" disabled={busy || !applyAllowed} onClick={()=>dialog.current?.showModal()}>Применить</button>
        </div>
        {busy && <p role="status">Выполняем запрос…</p>}
        {error && <p className="org-error" role="alert">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        {dirty && p?.status==='PREVIEW' && <p role="status">Проверка недействительна для новых правок. Сохраните черновик и проверьте заново.</p>}
        {p?.preview_summary && <section className="org-preview-summary" aria-label="Результат проверки">
          <h3>{p.preview_summary.valid?'Проверка пройдена':'Нужно исправить'}</h3>
          {p.preview_summary.issues.map((issue,i)=><p className="org-error" key={i}>{issue.path}: {issue.issue}</p>)}
          {p.preview_summary.before && <p>Было: {p.preview_summary.before.names.at(-1)?.display_name} · родитель {p.preview_summary.before.affiliations.at(-1)?.parent_id ?? 'без родителя'}</p>}
          <p>Станет: {p.change.display_name ?? 'Название сохранится'} · {p.change.parent_id ? `родитель ${p.change.parent_id}` : p.change.kind==='NETWORK'?'корень сети':'родитель без изменения'} · с {p.change.effective_from}</p>
          <p>История имён: +{p.preview_summary.affected.name_history}; история принадлежности: +{p.preview_summary.affected.affiliation_history}; новые единицы: {p.preview_summary.affected.directory_units}; потомков в истории: {p.preview_summary.affected.descendant_units}.</p>
          <p>Затронуто задач: 0 · назначений: 0 · архивных прав: 0 · финансовых записей: 0.</p>
          <p>{p.preview_summary.warning}</p>
          {p.status==='PREVIEW' && <p>Проверил: {p.preview_actor===actor?me?.user.full_name:p.preview_actor}. Действует до {new Date(p.preview_expires_at!).toLocaleString('ru-RU')}. Любая новая правка структуры потребует повторной проверки.</p>}
        </section>}
        {p?.status==='APPLIED' && <p role="status">Применено {new Date(p.applied_at!).toLocaleString('ru-RU')}. Исполнитель: {p.applied_by===actor?me?.user.full_name:p.applied_by}. Запись неизменна.</p>}
        {!!p?.history?.length && <details className="org-change-history"><summary>История предложения · {p.history.length}</summary>
          <ol>{p.history.map(h=><li key={h.aggregate_version}>v{h.aggregate_version} · {h.action} · {new Date(h.occurred_at).toLocaleString('ru-RU')} · {h.actor_user_id===actor?me?.user.full_name:h.actor_user_id}</li>)}</ol></details>}
      </div>
    </div>
    <dialog ref={dialog} className="org-apply-dialog" aria-labelledby="org-apply-title">
      <h2 id="org-apply-title">Применить проверенную версию?</h2>
      <p>{p && labels[p.change.operation]} · {p?.change.display_name || p?.target_id} · с {p?.change.effective_from}</p>
      <p>Это изменит серверный справочник и добавит историю от вашего имени. Роли и задачи не меняются. Отменить применённую запись нельзя.</p>
      <div className="org-editor-actions"><button className="btn" onClick={()=>dialog.current?.close()}>Вернуться</button>
        <button className="btn org-apply" data-testid="confirm-org-apply" disabled={!applyAllowed || busy} onClick={()=>{dialog.current?.close();if(p && applyAllowed)void run(()=>applyOrgProposal(p),'Изменение применено. История сохранена.',true);}}>Подтверждаю применение</button></div>
    </dialog>
  </section>;
}
