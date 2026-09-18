import React,{useEffect,useRef,useState} from 'react';
import { Link,useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { getReportReview,saveReportReview,type ReviewView,type DraftPeriod } from '../api/reportReview';
import { REPORT_NAMES } from '../imports/reportModel';
import { reviewCommand,mappingLabel } from '../components/savedReportModel';
import ReportIntakeNotice, { useReportIntakeEnabled } from '../components/ReportIntakeNotice';
import '../styles/organization.css';
import '../styles/report-staging.css';
import '../styles/saved-network.css';

export default function ReportReviewPage() {
  const {id=''}=useParams(),{me}=useAuth();
  const [view,setView]=useState<ReviewView|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[reload,setReload]=useState(0);
  useEffect(()=>{
    let active=true;setView(null);setError('');setBusy(true);
    getReportReview(id).then(v=>{if(active)setView(v);}).catch(e=>{if(active)setError(e.message);}).finally(()=>{if(active)setBusy(false);});
    return()=>{active=false;};
  },[id,me?.user.id,reload]);
  return <div className="portal-dashboard reports-page saved-network">
    <header className="portal-heading"><div><div className="portal-eyebrow">ПОДГОТОВКА · ПАКЕТ {id.slice(0,8)}</div><h1>Период и привязки</h1>
      <p>Сохраняется только черновик проверки. Исходники, оргструктура и рабочие показатели не изменяются.</p></div><span className="portal-chip">DRAFT</span></header>
    {busy&&<p role="status">Читаю сохранённый черновик…</p>}
    {error&&<p className="org-error" role="alert">{error}</p>}
    {!view&&!busy&&<button className="btn" onClick={()=>setReload(n=>n+1)}>Проверить доступ снова</button>}
    {view&&<ReviewForm key={`${id}:${view.current.version}`} view={view}
      reopen={()=>setReload(n=>n+1)} deny={()=>{setView(null);setError('Доступ к подготовке отчётов больше не действует.');}}/>}
  </div>;
}
function ReviewForm({view,reopen,deny}:{view:ReviewView;reopen:()=>void;deny:()=>void}) {
  const intake=useReportIntakeEnabled();
  const [periodEnabled,setPeriodEnabled]=useState(!!view.current.period);
  const [period,setPeriod]=useState<DraftPeriod>(view.current.period ?? {start:'',end:'',planStart:'',planEnd:'',basis:''});
  const [selected,setSelected]=useState<Record<string,string>>(()=>Object.fromEntries(view.rows.map(r=>[r.item_id,r.org_unit_id??''])));
  const [reason,setReason]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false);
  const [query,setQuery]=useState(''),[kind,setKind]=useState('all'),[onlyUnresolved,setOnlyUnresolved]=useState(false);
  const active=useRef(true),busyRef=useRef(false);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  // A focus check never replaces an unsaved draft; a denial clears the form.
  useEffect(()=>{
    const check=()=>getReportReview(view.batch_id).catch(e=>{if(active.current&&e instanceof ApiError&&[401,403,404].includes(e.status))deny();});
    window.addEventListener('focus',check);
    return()=>window.removeEventListener('focus',check);
  },[view.batch_id]);
  useEffect(()=>{
    if(!dirty&&!busy)return;
    const unload=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue='';};
    const nav=(e:MouseEvent)=>{
      if((e.target as HTMLElement)?.closest('a[href]') && !window.confirm('Изменения ещё не сохранены на сервере. Покинуть черновик?')){e.preventDefault();e.stopPropagation();}
    };
    window.addEventListener('beforeunload',unload);document.addEventListener('click',nav,true);
    return()=>{window.removeEventListener('beforeunload',unload);document.removeEventListener('click',nav,true);};
  },[dirty,busy]);
  const change=()=>{setDirty(true);setNotice('');};
  async function save(e:React.FormEvent) {
    e.preventDefault();if(busyRef.current)return;
    setError('');setNotice('');setBusy(true);busyRef.current=true;
    try {
      const command=reviewCommand(view,periodEnabled?period:null,selected,reason);
      const receipt=await saveReportReview(view.batch_id,command);
      if(active.current){setDirty(false);setNotice(`Версия ${receipt.version} сохранена на сервере. Не опубликовано.`);reopen();}
    } catch(e) {
      if(!active.current)return;
      if(e instanceof ApiError&&[401,403,404].includes(e.status)){deny();return;}
      setError(e instanceof Error?e.message:'Не удалось сохранить. Не закрывайте страницу; повторите тот же запрос.');
    } finally {busyRef.current=false;if(active.current)setBusy(false);}
  }
  const rows=view.rows.filter(r=>(kind==='all'||r.report_kind===kind)&&r.source_name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru'))&&(!onlyUnresolved||!selected[r.item_id]));
  return <>
    <div className="saved-notice"><strong>Проверка ≠ согласование владельца</strong><span>Здесь можно предложить даты и существующие OrgUnit. Публикация агрегатов выполняется отдельным шагом с собственными правами и проверками.
      Оригиналы остаются в закрытом хранилище.</span></div>
    <nav className="saved-actions" aria-label="Сценарий подготовки"><Link className="btn" to="/prepared-reports">1. Исходники</Link>
      <span className="portal-chip">2. Черновик · v{view.current.version}</span><Link className="btn" to={`/saved-network/${view.batch_id}`}>3. Сохранённый обзор сети →</Link>
      <Link className="btn" to={`/prepared-reports/${view.batch_id}/publish`}>4. Публикация агрегатов →</Link></nav>
    <form onSubmit={save}>
      <section className="portal-panel"><h2>Период отчёта</h2><p>Не определяется по дате загрузки, скриншоту или дате склада. Сохранённые исходные метаданные не перезаписываются.</p>
        <fieldset disabled={busy} className="org-editor-fields">
          <label className="org-editor-wide">Состояние периода<select aria-label="Состояние периода" value={periodEnabled?'proposed':'unknown'} onChange={e=>{setPeriodEnabled(e.target.value==='proposed');change();}}>
            <option value="unknown">Не установлен — оставить на согласовании</option><option value="proposed">Предложить даты для проверки</option></select></label>
          {periodEnabled&&<>
            {([['start','Продажи: с'],['end','Продажи: по (включительно)'],['planStart','План: с (необязательно)'],['planEnd','План: по (включительно)']] as const).map(([k,label])=>
              <label key={k}>{label}<input aria-label={label} type="date" value={period[k]} required={k==='start'||k==='end'} onChange={e=>{setPeriod(p=>({...p,[k]:e.target.value}));change();}}/></label>)}
            <label className="org-editor-wide">Основание предложенных дат<textarea aria-label="Основание предложенных дат" required minLength={10} maxLength={500} value={period.basis} onChange={e=>{setPeriod(p=>({...p,basis:e.target.value}));change();}}/></label>
          </>}
        </fieldset>
      </section>
      <section className="portal-panel"><h2>Привязки строк к филиалам</h2><p>Сопоставление по стабильным UUID, без автоматических слияний по названию.
        Одну строку каждого формата можно предложить одному OrgUnit. Принадлежность за период проверяется отдельно перед возможной публикацией.</p>
        {!view.candidates.length&&<div className="saved-focus"><strong>В этой сети пока нет доступных филиалов справочника</strong>
          <p>Строки источников сохранены. Реальные филиалы должны быть отдельно согласованы и созданы; загрузка или этот черновик не создают их автоматически.</p></div>}
        <div className="saved-filters"><label>Поиск строки<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Название в источнике"/></label>
          <label>Формат<select value={kind} onChange={e=>setKind(e.target.value)}><option value="all">Оба формата</option>
            <option value="summary">{REPORT_NAMES.summary}</option><option value="sales">{REPORT_NAMES.sales}</option></select></label>
          <label className="saved-checkbox"><input type="checkbox" checked={onlyUnresolved} onChange={e=>setOnlyUnresolved(e.target.checked)}/> Только без предложений</label></div>
        <p className="saved-caption">Показано {rows.length} из {view.rows.length} строк источников. Это не количество уникальных филиалов.</p>
        <div className="saved-mapping-list">{rows.map(row=><div className="saved-mapping-row" key={row.item_id}>
          <div><strong>{row.source_name}</strong><small>{REPORT_NAMES[row.report_kind]} · строка {row.source_row}</small>
            <small>{mappingLabel(row)}{(selected[row.item_id]||null)!==row.org_unit_id?' · есть несохранённое изменение':''}</small></div>
          <label>Предложенный OrgUnit<select aria-label={`OrgUnit: ${row.source_name} · ${row.report_kind}`} disabled={busy} value={selected[row.item_id]??''}
            onChange={e=>{setSelected(s=>({...s,[row.item_id]:e.target.value}));change();}}>
            <option value="">Не сопоставлен</option>
            {row.org_unit_id&&!view.candidates.some(c=>c.id===row.org_unit_id)&&<option value={row.org_unit_id}>Устаревший UUID · снимите привязку</option>}
            {view.candidates.map(c=><option value={c.id} key={c.id}>{c.display_name} · {c.code} · {c.lifecycle_state}</option>)}
          </select></label>
          <Link to={`/saved-network/${view.batch_id}/branches/${row.item_id}`}>Источник →</Link>
        </div>)}</div>{!rows.length&&<p>Нет строк по выбранному фильтру.</p>}
      </section>
      <section className="portal-panel"><h2>Сохранение и история</h2>
        <label className="saved-reason">Основание изменения черновика<textarea aria-label="Основание изменения черновика" required minLength={10} maxLength={500} disabled={busy} value={reason}
          placeholder="Что проверено и что предлагается уточнить" onChange={e=>{setReason(e.target.value);change();}}/></label>
        <div aria-live="polite">{error&&<p className="org-error" role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
          <p>{busy?'Сохранение на сервере…':dirty?'Есть несохранённые изменения. Обзор использует только последнюю серверную версию.':view.current.version?`Серверная версия ${view.current.version} · DRAFT · не опубликована`:'Черновик ещё не сохранён.'}</p></div>
        <ReportIntakeNotice/>
        <div className="saved-actions"><button className="btn reports-primary" disabled={!intake||busy||!dirty} type="submit">Сохранить черновик на сервере</button>
          <button className="btn" type="button" disabled={busy} onClick={()=>{if(!dirty||window.confirm('Отбросить несохранённые изменения и открыть серверную версию?'))reopen();}}>Открыть сохранённую версию</button></div>
        <details className="saved-provenance"><summary>История черновика · последние {view.history.length} версий</summary>
          {!view.history.length?<p>Изменений пока нет.</p>:view.history.map(h=><p key={h.version}><strong>v{h.version}</strong> · {new Date(h.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК<br/>
            {h.reason}<br/><code>{h.revision_hash}</code></p>)}<p>Hash исходной проверки: <code>{view.preview_hash}</code></p></details>
      </section>
    </form>
  </>;
}
