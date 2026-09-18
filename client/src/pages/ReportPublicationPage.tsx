import React,{useEffect,useRef,useState} from 'react';
import { Link,useParams } from 'react-router-dom';
import { getPublication,scanPublication,previewFacts,publishFacts,type PublicationState,type FactPreview,type FactChoice } from '../api/reportFacts';
import { METRIC_NAMES,REPORT_NAMES,type MetricKey,type ReportKind } from '../imports/reportModel';
import { FactRows } from '../components/PublishedFacts';
import '../styles/portal.css';
import '../styles/beta-workspace.css';
import '../styles/report-facts.css';

export default function ReportPublicationPage() {
  const {id=''}=useParams();
  return <PublicationForm key={id} id={id}/>;
}
function PublicationForm({id}:{id:string}) {
  const [state,setState]=useState<PublicationState|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [choices,setChoices]=useState<Partial<Record<MetricKey,{source:ReportKind;methodology:string}>>>({});
  const [reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[preview,setPreview]=useState<FactPreview|null>(null),[receipt,setReceipt]=useState('');
  const active=useRef(true),guard=useRef(false);
  useEffect(()=>{active.current=true;getPublication(id).then(x=>{if(active.current)setState(x);}).catch(e=>{if(active.current)setError(e.message);});
    return()=>{active.current=false;};},[id]);
  useEffect(()=>{
    const check=()=>getPublication(id).then(x=>{if(active.current){setState(x);setPreview(null);setConfirmed(false);}}).catch(e=>{
      if(active.current){setState(null);setPreview(null);setError(e.message);}
    });
    window.addEventListener('focus',check);return()=>window.removeEventListener('focus',check);
  },[id]);
  function edit(){setPreview(null);setReceipt('');}
  async function action(fn:()=>Promise<void>) {
    if(guard.current)return;guard.current=true;setBusy(true);setError('');setReceipt('');
    try{await fn();}catch(e:any){if(active.current){setError(e.message);if([401,403,404].includes(e.status)){setState(null);setPreview(null);}}}
    finally{guard.current=false;if(active.current)setBusy(false);}
  }
  async function verify(e:React.FormEvent) {
    e.preventDefault();setPreview(null);
    await action(async()=>{
      const result=await previewFacts(id,{review_version:state!.review.current.version,
        choices:Object.entries(choices).map(([metric,x])=>({metric,...x})) as FactChoice[],reason,confirm_source_aggregates:true});
      if(active.current)setPreview(result);
    });
  }
  async function publish() {
    if(!preview?.can_commit||!window.confirm(`Опубликовать ${preview.rows.length} значений в новый портал? Строки с прежними значениями получат новую версию. Это не меняет ежедневники и старый портал.`))return;
    await action(async()=>{
      const r=await publishFacts(id,preview);
      if(active.current){setReceipt(`Опубликовано ${r.count} значений. Публикация ${r.publication_id}.`);setPreview(null);}
      const s=await getPublication(id);if(active.current)setState(s);
    });
  }
  return <div className="portal-dashboard beta-workspace report-facts">
    <header className="portal-heading"><div><span className="portal-eyebrow">ПУБЛИКАЦИЯ · BETA</span><h1>Из проверки в рабочие данные</h1>
      <p>Отдельное подтверждение периода, филиалов и источника каждой метрики. Сохранённый черновик сам по себе ничего не публикует.</p></div></header>
    <nav className="beta-filters"><Link className="btn" to={`/prepared-reports/${id}/review`}>← Период и привязки</Link><Link className="btn" to="/">Обзор сети</Link></nav>
    {error&&<p className="portal-panel" role="alert">{error}</p>}{receipt&&<p className="portal-panel" role="status">{receipt}</p>}
    {!state&&!error&&<p role="status">Проверяю доступ…</p>}
    {state&&<>
      <section className="portal-panel"><h2>Готовность источников</h2>
        <p>{state.can_publish?'Отдельное право публикации активно.':'Публикация закрыта: нужен отдельный допуск с перечнем метрик. Административный доступ не расширяется автоматически.'}</p>
        {state.files.map(f=><p key={f.id}>{f.name}: <strong>{f.result==='CLEAN'&&f.current?'Антивирус: чисто, проверка действует':f.result==='INFECTED'?'Антивирус: опасный файл':'Нужна антивирусная проверка'}</strong></p>)}
        <button className="btn" disabled={busy||!state.can_publish} onClick={()=>{edit();void action(async()=>{
          await scanPublication(id);const s=await getPublication(id);if(active.current)setState(s);
        });}}>Проверить оригиналы антивирусом</button>
        <p className="portal-muted">Без чистой проверки не старше 24 часов публикация блокируется. Ошибка нового сканирования не продлевает прежний результат. Файлы не уходят во внешний сервис и не открываются для скачивания.</p>
      </section>
      <section className="portal-panel"><h2>Подтверждаемый черновик · v{state.review.current.version}</h2>
        <p>{state.review.current.period?`Продажи: ${state.review.current.period.start} → ${state.review.current.period.end}. Основание: ${state.review.current.period.basis}`:'Период не установлен. Вернитесь к подготовке.'}</p>
        <p>Сопоставлены {state.review.rows.filter(r=>r.status==='PROPOSED').length} из {state.review.rows.length} строк. Историческая принадлежность каждого филиала дополнительно проверяется сервером.</p>
      </section>
      <form onSubmit={verify}><fieldset className="portal-panel fact-fieldset" disabled={busy||!state.can_publish}>
        <h2>Источник и методика каждой метрики</h2><p>Источники не предвыбраны. Подтверждаются значения ячеек, а не неизвестная формула расчёта внутри QLIK.</p>
        {(Object.keys(METRIC_NAMES) as MetricKey[]).filter(k=>state.allowed_metrics.includes(k)).map(metric=><div className="fact-choice" key={metric}>
          <label>{METRIC_NAMES[metric]}<select aria-label={`Источник: ${METRIC_NAMES[metric]}`} value={choices[metric]?.source??''} onChange={e=>{
            edit();const source=e.target.value as ReportKind;setChoices(c=>{const next={...c};if(!source)delete next[metric];else next[metric]={source,methodology:c[metric]?.methodology??''};return next;});
          }}><option value="">Не публиковать</option>{state.reports.filter(r=>r.columns[metric]&&!(metric==='revenue'&&r.kind==='summary')).map(r=>
            <option value={r.kind} key={r.kind}>{REPORT_NAMES[r.kind]} · колонка {r.columns[metric]}{['stock','aged'].includes(metric)?` · ${r.stockDate}`:''}</option>)}</select></label>
          {choices[metric]&&<label>Утверждённая методика / состав источника<textarea aria-label={`Методика: ${METRIC_NAMES[metric]}`} required minLength={20} maxLength={1000}
            placeholder="Основание, состав, включения и исключения, единицы и границы периода. Не придумывайте неизвестные правила."
            value={choices[metric]!.methodology} onChange={e=>{edit();setChoices(c=>({...c,[metric]:{...c[metric]!,methodology:e.target.value}}));}}/></label>}
        </div>)}
        <label className="fact-block">Основание публикации и выбора источников<textarea aria-label="Основание публикации" required minLength={16} maxLength={500} value={reason} onChange={e=>{edit();setReason(e.target.value);}}/></label>
        <label className="fact-check"><input type="checkbox" required checked={confirmed} onChange={e=>{edit();setConfirmed(e.target.checked);}}/>
          Подтверждаю период, UUID-привязки, единицы и выбранные источники. Это агрегаты отчёта, не полный расчёт KPI.</label>
        <button className="btn" disabled={!Object.keys(choices).length||!confirmed}>Проверить состав публикации</button>
      </fieldset></form>
      {preview&&<section className="portal-panel"><h2>{preview.can_commit?'Проверьте значения перед публикацией':'Публикация заблокирована'}</h2>
        {preview.blockers.length>0&&<ul role="alert">{preview.blockers.map((b,i)=><li key={i}>{b}</li>)}</ul>}
        {preview.can_commit&&<p>Проверка действует до {new Date(preview.expires_at!).toLocaleTimeString('ru-RU',{timeZone:'Europe/Moscow'})} МСК. Перед записью сервер повторит все проверки.</p>}
        <FactRows rows={preview.rows} preview/>
        <button className="btn btn-primary" disabled={busy||!preview.can_commit} onClick={publish}>Подтвердить публикацию</button>
      </section>}
      <section className="portal-panel"><h2>История публикаций пакета</h2>{!state.publications.length&&<p>Этот пакет ещё не публиковался.</p>}
        {state.publications.map(p=><p key={p.id}>{new Date(p.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК · черновик v{p.review_version} · {p.id}</p>)}
        <p className="portal-muted">Старые значения сохраняются. Для исправления создаётся новая проверка и новая публикация, без переписывания истории.</p></section>
    </>}
  </div>;
}
