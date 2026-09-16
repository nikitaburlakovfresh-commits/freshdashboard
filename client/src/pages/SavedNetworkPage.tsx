import React,{useEffect,useState} from 'react';
import { Link,Navigate,useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { listStagingBatches, type StagingBatch } from '../api/reportBatches';
import { getSavedOverview,getSavedBranch,type SavedOverview,type SavedBranch } from '../api/reportReview';
import { REPORT_NAMES,METRIC_NAMES,sourceAddress,type MetricKey,type Report,type ReportRow,type ReportKind } from '../imports/reportModel';
import { draftPeriodLabel,mappingLabel,metricUnit,reportNumber } from '../components/savedReportModel';
import '../styles/report-staging.css';
import '../styles/saved-network.css';

// Never put private previews in persistent browser storage. Revalidate on focus.
function useSaved<T>(key:string,load:()=>Promise<T>) {
  const {me}=useAuth();
  const [data,setData]=useState<T|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(true),[revision,reload]=useState(0);
  useEffect(()=>{
    let alive=true,sequence=0;
    const refresh=()=>{
      const token=++sequence;setBusy(true);setData(null);
      load().then(r=>{if(alive&&token===sequence){setData(r);setError('');}})
        .catch(e=>{if(alive&&token===sequence){setData(null);setError(e.message ?? 'Не удалось прочитать сохранённый пакет.');}})
        .finally(()=>{if(alive&&token===sequence)setBusy(false);});
    };
    refresh();window.addEventListener('focus',refresh);
    return()=>{alive=false;window.removeEventListener('focus',refresh);};
  },[key,me?.user.id,revision]);
  return {data,error,busy,reload:()=>reload(n=>n+1)};
}
function State({error,busy,reload}:{error:string;busy:boolean;reload:()=>void}) {
  return <div className="saved-state" aria-live="polite">{busy?<p role="status">Читаю сохранённый пакет…</p>:error?
    <><p role="alert">{error}</p><p>Для закрытого предпросмотра нужно действующее право подготовки отчётов. Чужие пакеты недоступны.</p><button className="btn" onClick={reload}>Проверить снова</button></>:null}</div>;
}
export function MetricCards({report,row,keys}:{report:Report|SavedBranch['report'];row:ReportRow;keys:MetricKey[]}) {
  return <div className="saved-metrics">{keys.map(key=><article className="saved-metric" key={key}>
    <span>{METRIC_NAMES[key]}</span><strong>{reportNumber(row.values[key])} {row.values[key]!=null&&<small>{metricUnit(key)}</small>}</strong>
    <small>{report.columns[key]?`${report.sheet}!${report.columns[key]}${row.row}`:'Нет в этом источнике'}</small>
  </article>)}</div>;
}
function PreviewNotice() {
  return <div className="saved-notice"><strong>PREVIEW · не рабочие показатели</strong><span>Закрытый предпросмотр сохранённого источника.
    Период и привязки — на согласовании. Исходники в карантине: AV NOT_SCANNED. Публикация и скачивание закрыты.</span></div>;
}
function Provenance({files,hash,parser}:{files:SavedOverview['files'];hash:string;parser?:string}) {
  return <details className="saved-provenance"><summary>Происхождение и контроль целостности</summary>
    <p>SHA-256 проверки: <code>{hash}</code>{parser&&` · парсер ${parser}`}</p>
    {files.map(f=><p key={f.id}><strong>{f.display_name}</strong><br/>{reportNumber(f.byte_size)} байт · SHA-256 <code>{f.content_hash}</code></p>)}
    <p>Оригиналы не доступны для скачивания. Ни черновик, ни карточки не снимают карантин.</p></details>;
}
export default function SavedNetworkPage() {
  const {id}=useParams();
  return id?<Network key={id} id={id}/>:<SavedIndex/>;
}
function SavedIndex() {
  const state=useSaved<{items:StagingBatch[]}>('saved-index',listStagingBatches);
  const ready=state.data?.items.filter(b=>b.status==='NEEDS_MAPPING'&&b.storage_state==='READY');
  if(ready?.length)return <Navigate replace to={`/saved-network/${ready[0].id}`}/>;
  return <div className="portal-dashboard saved-network"><header className="portal-heading"><div><div className="portal-eyebrow">СОХРАНЁННЫЕ ИСТОЧНИКИ</div><h1>Обзор сети</h1></div><span className="portal-chip">PREVIEW</span></header>
    <State {...state}/>{state.data&&<section className="portal-panel"><h2>Пока нет подготовленного пакета</h2><p>Сначала сохраните два агрегатных отчёта и выполните серверную проверку.</p>
      <Link className="btn" to="/prepared-reports">Подготовить отчёты</Link></section>}</div>;
}
function Network({id}:{id:string}) {
  const state=useSaved<SavedOverview>(id,()=>getSavedOverview(id));
  const [kind,setKind]=useState<ReportKind>('summary'),[query,setQuery]=useState(''),[filter,setFilter]=useState('all');
  const data=state.data,report=data?.reports.find(r=>r.kind===kind) ?? data?.reports[0];
  const rows=report?.branches.filter(r=>r.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')) &&
    (filter==='all'||data?.rows.find(m=>m.report_kind===report.kind&&m.source_row===r.row)?.status===filter)) ?? [];
  const mappings=data?.rows.filter(r=>r.report_kind===report?.kind) ?? [];
  const controls=data?.controls.find(c=>c.kind===report?.kind)?.items ?? [];
  return <div className="portal-dashboard saved-network">
    <header className="portal-heading"><div><div className="portal-eyebrow">СОХРАНЁННЫЙ ПАКЕТ · {id.slice(0,8)}</div><h1>Обзор сети</h1>
      <p>{data?draftPeriodLabel(data.review.current.period):'Закрытый предпросмотр'}{report?.stockDate?` · склад на ${report.stockDate}`:''}</p></div>
      <div className="saved-actions"><Link className="btn" to="/prepared-reports">Пакеты отчётов</Link><Link className="btn reports-primary" to={`/prepared-reports/${id}/review`}>Период и привязки</Link></div></header>
    <State {...state}/>{data&&report&&<>
      <PreviewNotice/>
      <div className="saved-summary">
        <article><span>Источники в пакете</span><strong>{data.reports.length}</strong><small>Итоги не складываются</small></article>
        <article><span>Строки филиалов</span><strong>{report.branches.length}</strong><small>В выбранном источнике</small></article>
        <article><span>Предложено привязок</span><strong>{mappings.filter(m=>m.status==='PROPOSED').length} <em>/ {mappings.length}</em></strong><small>Не подтверждено владельцем</small></article>
        <article><span>Сохранённый черновик</span><strong>v{data.review.current.version}</strong><small>{data.review.current.version?'На сервере · не опубликован':'Пока без изменений'}</small></article>
      </div>
      <div className="saved-source-tabs" aria-label="Источник показателей">{data.reports.map(r=><button key={r.kind} aria-pressed={report.kind===r.kind}
        onClick={()=>{setKind(r.kind);setQuery('');setFilter('all');}}>{REPORT_NAMES[r.kind]}</button>)}</div>
      <section aria-label="Итог сети из источника"><div className="saved-section-title"><h2>Итог сети из отчёта</h2><span>{report.sheet} · строка 2</span></div>
        <MetricCards report={report} row={report.total} keys={report.kind==='summary'?['sales','stock','margin','revenue']:['sales','plan','margin','revenue']}/></section>
      <div className="saved-focus"><strong>Что нужно проверить перед рабочим срезом</strong><div>
        <p><b>Период и состав сети</b><span>{data.review.current.period?'Даты предложены, но ещё не являются подтверждением.':'Период продаж неизвестен. Дата склада его не заменяет.'} Названия не создают OrgUnit и назначений РМ.</span></p>
        <p><b>Сверка источника</b><span>{controls.filter(c=>!c.matches).length} из {controls.length} контрольных сумм требуют проверки. Разница и пропуски видны в сверке ниже.</span></p>
        <p><b>Без неподтверждённых оценок</b><span>Run-rate, светофор, рейтинг, фокусы и задачи не рассчитываются без утверждённых правил и покрытия.</span></p>
      </div></div>
      <section><div className="saved-section-title"><h2>Филиалы в источнике</h2><span>{rows.length} из {report.branches.length} строк</span></div>
        <div className="saved-filters"><label>Поиск по названию<input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Найти филиал в отчёте"/></label>
          <label>Привязка<select value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">Все строки</option>
            <option value="UNRESOLVED">Нет привязки</option><option value="PROPOSED">Предложена</option><option value="STALE">Устарела</option></select></label></div>
        <div className="saved-branches">{rows.map(row=>{
          const mapping=mappings.find(m=>m.source_row===row.row)!;
          return <Link className="saved-branch-card" key={mapping.item_id} to={`/saved-network/${id}/branches/${mapping.item_id}`}>
            <div><h3>{row.name}</h3><span aria-hidden="true">↗</span></div><small>{mappingLabel(mapping)} · строка {row.row}</small>
            <dl>{(['sales',report.kind==='summary'?'stock':'plan','margin'] as MetricKey[]).map(k=><div key={k}><dt>{METRIC_NAMES[k]}</dt>
              <dd>{reportNumber(row.values[k])}{row.values[k]!=null&&` ${metricUnit(k)}`}</dd></div>)}</dl><span className="saved-card-link">Детализация источника →</span>
          </Link>;
        })}</div>{!rows.length&&<p className="saved-state">Нет строк по выбранным условиям. Измените поиск или фильтр.</p>}
        <p className="saved-caption">Это строки выбранного отчёта, не подтверждённый реестр филиалов. Совпадающие названия из разных файлов не объединены автоматически.</p>
      </section>
      <details className="saved-provenance"><summary>Контрольные суммы и расхождения между отчётами</summary>
        <div className="reports-table-wrap" tabIndex={0} role="region" aria-label="Контрольные суммы"><table><thead><tr><th>Показатель</th><th>Итог источника</th><th>Сумма строк</th><th>Разница</th><th>Ячейка</th></tr></thead>
          <tbody>{controls.map(c=><tr key={c.metric}><th>{METRIC_NAMES[c.metric as MetricKey]}</th><td>{reportNumber(c.official)}</td><td>{reportNumber(c.sum)}</td>
            <td>{reportNumber(c.delta)}</td><td>{sourceAddress(report,report.total,c.metric as MetricKey)}</td></tr>)}</tbody></table></div>
        <ul>{data.comparison.map((text,i)=><li key={i}>{text}</li>)}</ul><p>Карточки показывают выбранный источник независимо. Межотчётная сверка по названию — диагностика, не OrgUnit mapping.</p></details>
      <Provenance files={data.files} hash={data.preview_hash} parser={data.parser_version}/>
    </>}
  </div>;
}
export function SavedBranchPage() {
  const {id='',itemId=''}=useParams();
  const state=useSaved<SavedBranch>(`${id}:${itemId}`,()=>getSavedBranch(id,itemId));
  const d=state.data;
  return <div className="portal-dashboard saved-network">
    <Link className="saved-back" to={`/saved-network/${id}`}>← Обзор сети из пакета</Link>
    <State {...state}/>{d&&<>
      <header className="portal-heading"><div><div className="portal-eyebrow">КАРТОЧКА СТРОКИ ИСТОЧНИКА · PREVIEW</div><h1>{d.row.name}</h1>
        <p>{draftPeriodLabel(d.period)}{d.report.stockDate?` · склад на ${d.report.stockDate}`:''}</p></div>
        <Link className="btn" to={`/prepared-reports/${id}/review`}>Проверить привязку</Link></header>
      <PreviewNotice/>
      <div className="saved-focus"><strong>{mappingLabel(d.mapping)}</strong><p>{d.mapping.org_unit_id?`Предложенный OrgUnit: ${d.mapping.org_unit_id}. `:'OrgUnit ещё не выбран. '}
        Это не подтверждение филиала, его бизнес-модели или ответственного РМ. Версия черновика: {d.review_version}.</p></div>
      <section><div className="saved-section-title"><h2>Показатели из отчёта</h2><span>{REPORT_NAMES[d.report.kind]}</span></div>
        <MetricCards report={d.report} row={d.row} keys={(['sales','stock','aged','margin','revenue','baseMargin','kso','plan'] as MetricKey[]).filter(k=>d.report.columns[k])}/></section>
      <section className="saved-provenance"><h2>Основание каждого значения</h2><p>{d.report.file} · лист {d.report.sheet} · строка {d.row.row}</p>
        <p>Ячейка указана на каждой карточке. Пустая ячейка показана как «Нет данных», не как ноль. Значения не суммируются с другим отчётом.</p>
        <p>Динамика, нормы, run-rate, фокусы и задачи филиала не включены: в этом пакете нет согласованных оснований для них.</p></section>
      <Provenance files={d.files} hash={d.preview_hash}/>
    </>}
  </div>;
}
