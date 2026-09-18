import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { getStagingCapabilities,listStagingBatches,getStagingBatch,uploadStagingBatch,probeStagingBatch,
  type StagingCapabilities,type StagingBatch } from '../api/reportBatches';
import { METRIC_NAMES,REPORT_NAMES,sourceAddress,type ImportPeriod,type ReportKind } from '../imports/reportModel';
import { periodMetadata,checkStagingFiles,stagingStatus,periodLabel,blockerLabel } from '../components/reportStagingModel';
import Icon from '../components/Icon';
import ReportIntakeNotice, { useReportIntakeEnabled } from '../components/ReportIntakeNotice';
import '../styles/organization.css';
import '../styles/report-staging.css';

const number=(v:number|null|undefined)=>v==null?'Нет данных':v.toLocaleString('ru-RU',{maximumFractionDigits:2});
export default function PreparedReportsPage() {
  const {me}=useAuth();
  const intake=useReportIntakeEnabled();
  const [cap,setCap]=useState<StagingCapabilities|null>(null),[batches,setBatches]=useState<StagingBatch[]>([]);
  const [selected,setSelected]=useState<StagingBatch|null>(null),[network,setNetwork]=useState('');
  const [files,setFiles]=useState<File[]>([]),[confirmed,setConfirmed]=useState(false);
  const [period,setPeriod]=useState<ImportPeriod>({start:'',end:'',planStart:'',planEnd:''}),[confirmation,setConfirmation]=useState('');
  const [busy,setBusy]=useState(true),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const input=useRef<HTMLInputElement>(null),request=useRef(0),alive=useRef(true);
  const fail=(e:unknown)=>{
    if(!alive.current)return;
    if(e instanceof ApiError && [401,403].includes(e.status)){setCap(null);setSelected(null);setBatches([]);setFiles([]);}
    setError(e instanceof Error?e.message:'Сервер недоступен. Обновите список перед повторной загрузкой.');
  };
  useEffect(()=>{
    alive.current=true;let current=true;
    setSelected(null);setBatches([]);setBusy(true);
    Promise.all([getStagingCapabilities(),listStagingBatches()]).then(([c,b])=>{
      if(current){setCap(c);setBatches(b.items);setNetwork(c.roots.length===1?c.roots[0].id:'');setError('');}
    }).catch(e=>{if(current)fail(e);}).finally(()=>{if(current)setBusy(false);});
    return ()=>{current=false;alive.current=false;request.current++;};
  },[me?.user.id]);
  async function refresh() {
    setBusy(true);setError('');setSelected(null);request.current++;
    try {const [c,b]=await Promise.all([getStagingCapabilities(),listStagingBatches()]);if(alive.current){setCap(c);setBatches(b.items);}}
    catch(e){fail(e);} finally {if(alive.current)setBusy(false);}
  }
  async function open(id:string) {
    const token=++request.current;setBusy(true);setError('');setNotice('');setSelected(null);
    try {const batch=await getStagingBatch(id);if(alive.current && token===request.current)setSelected(batch);}
    catch(e){if(token===request.current)fail(e);} finally {if(alive.current && token===request.current)setBusy(false);}
  }
  async function upload(e:React.FormEvent) {
    e.preventDefault();setError('');setNotice('');setSelected(null);setBusy(true);request.current++;
    try {
      checkStagingFiles(files);
      if(!network)throw new Error('Сначала выберите существующую корневую сеть.');
      const meta=periodMetadata(confirmed,period,confirmation);
      const saved=await uploadStagingBatch(network,meta,files);
      if(!alive.current)return;
      setSelected(saved);setFiles([]);if(input.current)input.current.value='';
      setNotice('Исходники сохранены в закрытом карантине. Проверяю на сервере…');
      const result=await probeStagingBatch(saved);
      const list=await listStagingBatches();
      if(alive.current){setSelected(result);setBatches(list.items);setNotice(saved.reused?'Найден ранее сохранённый пакет: повторной записи нет.':'Пакет сохранён на сервере. Рабочие показатели не изменены.');}
    } catch(e){fail(e);} finally {if(alive.current)setBusy(false);}
  }
  async function probe() {
    if(!selected)return;
    setBusy(true);setError('');setNotice('');
    try {const result=await probeStagingBatch(selected);const list=await listStagingBatches();if(alive.current){setSelected(result);setBatches(list.items);}}
    catch(e){fail(e);} finally {if(alive.current)setBusy(false);}
  }
  const preview=selected?.preview;
  return <div className="portal-dashboard org-page reports-page">
    <header className="portal-heading"><div><div className="portal-eyebrow">ИСТОЧНИКИ · ЗАКРЫТАЯ ПОДГОТОВКА</div>
      <h1>Подготовленные отчёты</h1><p>Исходники и проверка сохраняются на сервере. Это ещё не импорт в рабочие показатели.</p></div>
      <span className="portal-chip"><Icon name="upload"/> Серверный режим</span></header>
    <section className="org-scope"><Icon name="shield"/><div><strong>Карантин → проверка → согласование</strong>
      <p>Только два агрегатных формата QLIK. Без VIN, сотрудников и детализации. Антивирусная проверка ещё не подключена:
        исходники не доступны для скачивания. Предпросмотр не снимает карантин.</p>
      <p><Link to="/saved-network">Открыть серверный обзор сети · PREVIEW</Link> — карточки из сохранённого пакета.
        <Link to="/"> Локальный дашборд</Link> остаётся отдельным; его цифры не перезаписываются.</p>
      <p>Ручная загрузка — тестовый и резервный канал. Облачная доставка QLIK по расписанию будет подключена отдельно.</p></div></section>
    <ReportIntakeNotice/>
    <div className="reports-feedback" aria-live="polite">{error && <p className="org-error" role="alert">{error}</p>}{notice && <p>{notice}</p>}
      {busy && <p role="status">Выполняется запрос к серверу…</p>}</div>
    <div className="org-editor-actions"><button className="btn" onClick={refresh} disabled={busy}>Обновить доступ и список</button></div>
    {!cap && !busy && <section className="portal-panel"><h2>Закрытый этап администратора</h2><p>Требуется отдельно выданное право data_source.probe.
      Оно не выдаётся при входе и не открывает финансовые задачи. Проверьте доступ кнопкой выше.</p></section>}
    {cap && <>
      <section className="portal-panel reports-upload"><div className="portal-eyebrow">01 / ОРИГИНАЛЫ</div><h2>Подготовить новый пакет</h2>
        {!cap.roots.length && <p className="org-error">Подтверждённой реальной сети пока нет. <Link to="/organization">Создание сети — в редакторе структуры</Link>; загрузка не создаёт её автоматически.</p>}
        <form onSubmit={upload}><fieldset className="org-editor-fields" disabled={busy}>
          <label>Корневая сеть<select value={network} onChange={e=>setNetwork(e.target.value)} required>
            <option value="">Выберите сеть</option>{cap.roots.map(r=><option value={r.id} key={r.id}>{r.display_name} · {r.code}</option>)}</select></label>
          <label>Агрегатные XLSX · до 2 файлов, до 8 МиБ каждый<input ref={input} type="file" accept=".xlsx" multiple
            onChange={e=>setFiles(Array.from(e.target.files ?? []))}/></label>
          <label className="org-editor-wide">Период продаж<select value={confirmed?'confirmed':'unknown'} onChange={e=>setConfirmed(e.target.value==='confirmed')}>
            <option value="unknown">Не подтверждён — сохранить только для проверки</option><option value="confirmed">Подтверждаю период вручную</option></select></label>
          {confirmed && <>
            {([['start','Продажи: с'],['end','Продажи: по'],['planStart','План: с (необязательно)'],['planEnd','План: по (необязательно)']] as const)
              .map(([key,label])=><label key={key}>{label}<input type="date" required={key==='start'||key==='end'} value={period[key]} onChange={e=>setPeriod(p=>({...p,[key]:e.target.value}))}/></label>)}
            <label className="org-editor-wide">Основание подтверждения периода<textarea maxLength={500} minLength={10} required value={confirmation} onChange={e=>setConfirmation(e.target.value)} /></label>
          </>}
        </fieldset><p className="org-small">Период не выводится из имени файла, даты загрузки или даты склада. Филиалы не привязываются автоматически.</p>
        <button className="btn reports-primary" disabled={!intake || busy || !network || !files.length} type="submit">Сохранить и проверить на сервере</button></form>
      </section>
      <section className="portal-panel"><div className="portal-eyebrow">02 / СОХРАНЁННЫЕ ПАКЕТЫ</div><h2>Последние пакеты <span className="reports-count">{batches.length}</span></h2>
        {!batches.length?<p className="org-empty">Здесь появятся закрытые пакеты после загрузки. Они сохранятся после обновления страницы.</p>:
          <ul className="reports-batches">{batches.map(b=><li key={b.id}><button disabled={busy} aria-pressed={selected?.id===b.id} onClick={()=>open(b.id)}>
            <strong>{stagingStatus(b)}</strong><span>{periodLabel(b.period)}</span><small>{new Date(b.created_at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК · {b.id.slice(0,8)}</small>
          </button></li>)}</ul>}
      </section>
      {selected && <section className="portal-panel reports-detail"><div className="portal-eyebrow">03 / ПРОВЕРКА ПАКЕТА</div><h2>{stagingStatus(selected)}</h2>
        <p>{periodLabel(selected.period)} · рабочие показатели не изменены</p>
        {selected.preview?.valid_structure&&<div className="org-editor-actions"><Link className="btn" to={`/prepared-reports/${selected.id}/review`}>Проверить период и привязки</Link>
          <Link className="btn reports-primary" to={`/saved-network/${selected.id}`}>Открыть обзор сети · PREVIEW →</Link></div>}
        <dl className="org-facts"><div><dt>Идентификатор / версия</dt><dd>{selected.id} / {selected.version}</dd></div>
          <div><dt>Парсер / mapping</dt><dd>{selected.parser_version} / {selected.mapping_version}</dd></div>
          <div><dt>SHA-256 предпросмотра</dt><dd>{selected.preview_hash ?? 'Проверка ещё не сохранена'}</dd></div>
        </dl>
        <h3>Происхождение</h3><ul className="reports-provenance">{selected.files?.map(f=><li key={f.id}><strong>{f.display_name}</strong>
          <span>{number(f.byte_size)} байт · SHA-256 {f.content_hash}</span><small>Закрытый оригинал · скачивание заблокировано до антивирусной проверки</small></li>)}</ul>
        {selected.status==='QUARANTINE' && <button className="btn" disabled={!intake || busy} onClick={probe}>Проверить сохранённые оригиналы</button>}
        {preview && <>
          <div className="reports-blockers"><strong>Почему пакет ещё не опубликован</strong><ul>{preview.blockers.map(code=><li key={code}>{blockerLabel(code)}</li>)}</ul>
            {preview.error && <p className="org-error">{preview.error}</p>}</div>
          {preview.reports?.map(report=><div key={report.kind} className="reports-source">
            <h3>{REPORT_NAMES[report.kind]}</h3><p className="org-small">{report.branches.length} филиалов · {report.sheet}
              {report.stockDate?` · склад на ${report.stockDate} (не период продаж)`:''}</p>
            <div className="reports-table-wrap" tabIndex={0} role="region" aria-label={`Контрольные итоги: ${REPORT_NAMES[report.kind]}`}>
              <table><thead><tr><th>Показатель</th><th>Итог источника</th><th>Сумма филиалов</th><th>Разница</th><th>Ячейка</th></tr></thead><tbody>
                {preview.controls?.find(c=>c.kind===report.kind)?.items.map(c=><tr key={c.metric}>
                  <th>{METRIC_NAMES[c.metric]}</th><td>{number(c.official)}</td><td>{number(c.sum)}</td>
                  <td className={!c.matches?'reports-mismatch':''}>{number(c.delta)}</td><td>{sourceAddress(report,report.total,c.metric)}</td>
                </tr>)}</tbody></table></div>
          </div>)}
          {!!preview.comparison?.length && <div className="reports-source"><h3>Сверка между отчётами</h3><ul>{preview.comparison.map((text,i)=><li key={i}>{text}</li>)}</ul></div>}
          {!!preview.mappings?.length && <div className="reports-source"><h3>Филиалы: привязка не подтверждена</h3>
            <p className="org-small">Исходные названия сохранены для сверки. Они не стали филиалами портала и не дают никому доступ.</p>
            <div className="reports-table-wrap" tabIndex={0} role="region" aria-label="Филиалы для сопоставления"><table><thead><tr><th>Филиал в источнике</th><th>Отчёт / строка</th><th>OrgUnit</th></tr></thead>
              <tbody>{preview.mappings.map((m,i)=><tr key={i}><th>{m.source_name}</th><td>{REPORT_NAMES[m.report_kind as ReportKind]} / {m.source_row}</td><td>Не сопоставлен</td></tr>)}</tbody>
            </table></div></div>}
        </>}
      </section>}
    </>}
  </div>;
}
