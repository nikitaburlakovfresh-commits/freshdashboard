import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import Icon from './Icon';
import {
  REPORT_NAMES, METRIC_NAMES, comparisonIssues, reconcile, selectRow, sourceAddress, validatePeriod,
  type ImportPeriod, type MetricKey, type Report, type ReportBatch,
} from '../imports/reportModel';
import '../styles/local-import.css';

const EMPTY_PERIOD: ImportPeriod = { start: '', end: '', planStart: '', planEnd: '' };
const KEYS = ['sales', 'margin', 'stock', 'aged'] as const;
const number = (value: number | null | undefined, money = false) => value == null ? 'Нет данных'
  : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: money ? 2 : 0, minimumFractionDigits: money ? 2 : 0 }).format(value);
const date = (iso: string) => iso.split('-').reverse().join('.');
const dateRange = (start: string, end: string) => `${date(start)} — ${date(end)}`;
const valueFor = (report: Report | undefined, branch: string, key: MetricKey) => selectRow(report, branch)?.values[key] ?? null;

export default function LocalBusinessData() {
  const [batch, setBatch] = useState<ReportBatch | null>(null);
  const [branch, setBranch] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [period, setPeriod] = useState<ImportPeriod>({ ...EMPTY_PERIOD });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const input = useRef<HTMLInputElement>(null);
  const details = useRef<HTMLDetailsElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const [params, setParams] = useSearchParams();
  const openImport = () => drawer.current?.showModal();
  useEffect(() => {
    if (params.get('import') === '1') {
      drawer.current?.showModal();
      const next = new URLSearchParams(params); next.delete('import');
      setParams(next, { replace: true });
    }
  }, [params, setParams]);
  const stop = () => { worker.current?.terminate(); worker.current = null; clearTimeout(timer.current); };
  useEffect(() => () => { worker.current?.terminate(); clearTimeout(timer.current); }, []);
  const clearFiles = () => { setFiles([]); if (input.current) input.current.value = ''; };
  const reset = () => {
    stop(); setBusy(false); setBatch(null); setBranch(''); clearFiles();
    setPeriod({ ...EMPTY_PERIOD }); setConfirmed(false); setError('');
    setStatus('Локальные данные удалены из этой страницы.');
    openImport();
  };
  const cancel = () => {
    stop(); setBusy(false); clearFiles(); setStatus('Проверка отменена. Текущие данные не изменены.');
  };
  const fail = (message: string) => {
    stop(); setBusy(false); clearFiles(); setStatus('');
    setError(`${message} Новый пакет не применён.${batch ? ' Предыдущие данные сохранены.' : ''}`);
  };
  function importFiles(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setStatus('');
    try {
      validatePeriod(period);
      if (!confirmed) throw new Error('Подтвердите период фактических продаж для всех выбранных отчётов.');
      if (!files.length || files.length > 9) throw new Error('Выберите от 1 до 9 файлов Excel.');
      if (files.reduce((s, f) => s + f.size, 0) > 40 * 1024 * 1024) throw new Error('Размер пакета превышает 40 МБ.');
      if (files.some(f => !/\.xlsx$/i.test(f.name) || !f.size || f.size > 15 * 1024 * 1024))
        throw new Error('Каждый файл должен быть непустым .xlsx размером до 15 МБ.');
      setBusy(true); setStatus('Проверяем пакет локально…');
      const instance = new Worker(new URL('../imports/report.worker.ts', import.meta.url), { type: 'module' });
      worker.current = instance;
      instance.onmessage = (e: MessageEvent) => {
        if (e.data.type === 'progress') setStatus(e.data.value);
        if (e.data.type === 'error') fail(e.data.message);
        if (e.data.type === 'complete') {
          const next: ReportBatch = e.data.batch;
          stop(); setBatch(next); setBranch(''); setBusy(false); clearFiles();
          setStatus(`Пакет применён: ${next.reports.length} отчёт(а), пропущено ${next.skipped.length}.`);
          drawer.current?.close();
        }
      };
      instance.onerror = () => fail('Не удалось обработать Excel. Проверьте формат и повторите выбор файлов.');
      timer.current = setTimeout(() => fail('Превышено время проверки (30 секунд). Выберите меньший пакет.'), 30000);
      instance.postMessage({ files, period });
    } catch (e) { fail(e instanceof Error ? e.message : 'Ошибка импорта.'); }
  }
  const summary = batch?.reports.find(r => r.kind === 'summary');
  const sales = batch?.reports.find(r => r.kind === 'sales');
  // Stable precedence: no addition or per-cell fallback between duplicate facts.
  const primary = summary ?? sales;
  const sourceFor = (key: MetricKey) => key === 'stock' || key === 'aged' ? summary : primary;
  const branches = [...new Map(batch?.reports.flatMap(r => r.branches.map(b => [b.key, b.name] as const)) ?? []).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  const selectedName = branch ? branches.find(b => b[0] === branch)?.[1] : 'Вся сеть · итог отчёта';
  const issues = batch ? comparisonIssues(batch.reports) : [];
  const hasMismatch = batch?.reports.some(r => reconcile(r).some(c => !c.matches));
  const openDetails = () => { if (details.current) { details.current.open = true; details.current.scrollIntoView({ block: 'start', behavior: 'auto' }); } };
  const changePeriod = (key: keyof ImportPeriod, value: string) => {
    setPeriod(p => ({ ...p, [key]: value })); setConfirmed(false);
  };
  const planKnown = !!batch?.period.planStart && !!batch?.period.planEnd;
  return <section className="local-business" aria-labelledby="metrics-title" aria-busy={busy}>
    <div className="local-data-bar">
      <div><Icon name="calendar" /><span>{batch ? `Продажи: ${dateRange(batch.period.start, batch.period.end)}` : 'Период не выбран'}</span><span className="portal-chip">{batch ? 'Локальный Excel' : 'Нет источника'}</span></div>
      <button className="local-secondary" onClick={openImport}><Icon name="upload" />{batch ? 'Заменить QLIK-отчёты' : 'Загрузить QLIK-отчёты'}</button>
    </div>
    <dialog className="local-import-drawer" ref={drawer} aria-labelledby="import-title"
      onClick={e => { if (e.target === e.currentTarget) drawer.current?.close(); }}>
    <div className="local-drawer-content">
    <div className="local-drawer-heading"><div><span className="portal-eyebrow">ИСТОЧНИК ДАННЫХ</span><h2 id="import-title">Загрузить QLIK-отчёты</h2></div>
      <button type="button" className="shell-icon-button" aria-label="Закрыть загрузку" onClick={() => drawer.current?.close()}><Icon name="close" /></button></div>
    <div className="local-privacy">
      <strong>Только в памяти этой страницы.</strong> Файлы и значения не отправляются на сервер и не сохраняются.
      При уходе со страницы, смене роли или перезагрузке импорт сбрасывается.
      Это просмотр вашего файла, не разграничение доступа к филиалам (не RBAC).
    </div>
    <div className="local-import-form">
      <p>Поддерживаются сводка продаж/склада и отчёт продаж с КСО и маржой. Можно выбрать все 9 файлов: остальные форматы будут пропущены, без детальных строк, VIN и персональных данных.</p>
      <form onSubmit={importFiles}>
        <div className="local-fields">
          <label className="local-file">Файлы .xlsx · до 9 файлов, 15 МБ каждый / 40 МБ всего
            <input ref={input} type="file" accept=".xlsx" multiple disabled={busy} aria-label="Файлы Excel"
              onChange={e => { setFiles(Array.from(e.target.files ?? [])); setError(''); setConfirmed(false); }} />
          </label>
          <label>Продажи: начало периода
            <input type="date" required aria-label="Начало периода продаж" value={period.start} disabled={busy} onChange={e => changePeriod('start', e.target.value)} />
          </label>
          <label>Продажи: конец периода
            <input type="date" required aria-label="Конец периода продаж" value={period.end} disabled={busy} onChange={e => changePeriod('end', e.target.value)} />
          </label>
        </div>
        <p className="portal-footnote">В отчёте продаж нет даты периода. Она не определяется по имени файла или текущему месяцу. Дата складского среза читается отдельно из заголовков источника.</p>
        <details className="local-plan-input">
          <summary>Период плана продаж · необязательно</summary>
          <p className="portal-muted">Заполните, только если знаете, на какой период утверждён план второго отчёта. Без этих дат план скрыт. При несовпадении периодов плана и факта процент выполнения не рассчитывается.</p>
          <div className="local-fields">
            <label>План: начало<input type="date" aria-label="Начало периода плана" value={period.planStart} disabled={busy} onChange={e => changePeriod('planStart', e.target.value)} /></label>
            <label>План: конец<input type="date" aria-label="Конец периода плана" value={period.planEnd} disabled={busy} onChange={e => changePeriod('planEnd', e.target.value)} /></label>
          </div>
        </details>
        <label className="local-confirm"><input type="checkbox" checked={confirmed} disabled={busy}
          onChange={e => setConfirmed(e.target.checked)} />Я подтверждаю, что фактические продажи во всех выбранных отчётах относятся к указанному периоду, а даты плана, если заполнены, проверены мной.</label>
        <div className="local-actions">
          <button className="portal-primary" type="submit" disabled={busy || !files.length || !confirmed}>{busy ? 'Проверяем…' : batch ? 'Проверить и заменить пакет' : 'Загрузить локально'}</button>
          {busy && <button type="button" className="local-secondary" onClick={cancel}>Отменить проверку</button>}
          <span className="portal-muted">Выбрано файлов: {files.length}. Новый пакет полностью заменит предыдущий — только после успешной проверки.</span>
        </div>
      </form>
    </div>
    {busy && <p role="status" className="local-status">{status}</p>}
    {error && <div role="alert" className="local-error">{error}</div>}
    </div>
    </dialog>
    <div className="network-score-row" aria-label="Оценка сети · расчёт не подключён">
      {[
        ['Средний балл сети', 'chart'], ['Зелёных филиалов', 'shield'],
        ['Жёлтых филиалов', 'info'], ['Красных филиалов', 'info'],
      ].map(([label, icon], i) => <article className="network-score" key={label}>
        <span className={`network-score-icon tone-${i}`}><Icon name={icon as 'chart' | 'shield' | 'info'} /></span>
        <div><strong aria-label="Нет данных">—</strong><span>{label}</span></div>
      </article>)}
    </div>
    <p className="network-score-note">Оценка сети не рассчитана: нужны сопоставление OrgUnit и утверждённые версии формул и порогов. Цвет обозначает категорию, не оценку филиала.</p>
    <div className="portal-section-head local-metrics-head"><h2 id="metrics-title">Продажи и склад</h2><span className="portal-muted">Факт из отчётов · без прогноза</span></div>
    <div role="status" aria-live="polite" className="local-status">{status}</div>
    {error && <div role="alert" className="local-error">{error}</div>}
    {batch && <>
      <div className="portal-context local-context">
        <label>Филиал из локального файла<select aria-label="Филиал импортированных данных" value={branch} onChange={e => setBranch(e.target.value)}>
          <option value="">Вся сеть · итог отчёта</option>
          {branches.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
        </select></label>
        <div className="local-period"><strong>Склад: {summary?.stockDate ? date(summary.stockDate) : 'нет источника'} · срез из Excel</strong>
          <span>Период продаж вверху указан пользователем</span>
        </div>
        <button className="local-secondary" onClick={reset}>Сбросить данные</button>
      </div>
      <p className="local-selection"><strong>{selectedName}</strong> · {branch ? 'Строка филиала, без добавления сетевого итога' : 'Официальная строка 2, не сумма итога и филиалов'}</p>
    </>}
    <div className="portal-metrics">
      {KEYS.map(key => {
        const report = sourceFor(key), row = selectRow(report, branch);
        const value = row?.values[key];
        return <article className="portal-metric local-metric" key={key} data-metric={key}>
          <div className="local-metric-title"><Icon name={key === 'sales' ? 'chart' : key === 'margin' ? 'wallet' : key === 'stock' ? 'stock' : 'calendar'} /><span className="portal-muted">{METRIC_NAMES[key]}</span></div>
          <strong>{number(value, key === 'margin')}</strong>
          <span className="portal-metric-meta">{key === 'margin' ? '₽ · включая КСО' : key === 'aged' ? 'шт. · по методике 45+ источника' : 'шт.'}</span>
          <span className="portal-metric-meta">{batch
            ? key === 'stock' || key === 'aged' ? summary?.stockDate ? `Срез ${date(summary.stockDate)}` : 'Сводка склада не загружена'
              : dateRange(batch.period.start, batch.period.end)
            : 'Загрузите источник и укажите период'}</span>
          {batch && <button className="portal-metric-bottom local-source-button" onClick={openDetails}>
            {sourceAddress(report, row, key)} <span aria-hidden="true">↗</span>
          </button>}
        </article>;
      })}
    </div>
    <p className="portal-footnote local-memory-note"><Icon name="shield" />Только в памяти страницы · уход с дашборда, смена роли и перезагрузка сбрасывают импорт. Нет данных ≠ 0.</p>
    <section className="network-focus" aria-labelledby="focus-title">
      <div className="portal-section-head"><h2 id="focus-title">Фокусы внимания</h2><span className="portal-muted">Не настроены · не оценка результатов</span></div>
      <div className="network-focus-grid">
        {[
          ['Планы и RunRate', 'Нужны период, план и версия формулы'],
          ['Оборачиваемость', 'Нужны база склада и методика расчёта'],
          ['Ежедневник и дисциплина', 'Нужны шаблоны, факты и целевые значения'],
        ].map(([title, note]) => <div className="network-focus-card" key={title}><Icon name="target" /><div><strong>{title}</strong><span>{note}</span></div><span className="focus-dash">—</span></div>)}
      </div>
    </section>
    {!batch && <section className="network-empty" aria-labelledby="network-title">
      <div className="portal-section-head"><h2 id="network-title">Филиалы сети</h2><span className="portal-chip">Требуется источник</span></div>
      <div className="network-empty-body"><span className="network-empty-symbol"><Icon name="network" /></span><div><h3>Сеть начнётся с ваших данных</h3><p>Загрузите отчёты, чтобы увидеть филиалы и раскрыть их показатели.<br />Дивизионы и РМ появятся только после утверждённого сопоставления OrgUnit.</p></div><button className="local-secondary" onClick={openImport}>Подключить Excel</button></div>
    </section>}
    {batch && <>
      {sales && <div className="local-plan-result">
        <strong>План продаж: {planKnown ? `${number(valueFor(sales, branch, 'plan'))}${valueFor(sales, branch, 'plan') != null ? ' шт.' : ''}` : 'период не подтверждён'}</strong>
        <span>{planKnown ? `${dateRange(batch.period.planStart, batch.period.planEnd)} · даты указаны пользователем · ${sourceAddress(sales, selectRow(sales, branch), 'plan')}`
          : 'Значение скрыто. Укажите период плана при повторном импорте.'}</span>
        {planKnown && batch.period.start === batch.period.planStart && batch.period.end === batch.period.planEnd &&
          valueFor(sales, branch, 'plan')! > 0 && valueFor(sales, branch, 'sales') != null
          ? <span>Выполнение: {number(valueFor(sales, branch, 'sales')! / valueFor(sales, branch, 'plan')! * 100, true)}% · факт и план только из отчёта продаж</span>
          : <span>Процент выполнения не рассчитан: нужен сопоставимый период и ненулевой план.</span>}
      </div>}
      <details ref={details} className="portal-panel local-details">
        <summary>Источники, ячейки и сверка <span className={hasMismatch ? 'portal-warning' : 'portal-muted'}>· {hasMismatch ? 'есть расхождения или пропуски' : 'итоги сверены'}</span></summary>
        <p>При наличии двух отчётов карточки продаж и маржи берутся только из сводки. Маржа включает КСО: колонка W сводки или P отчёта продаж; N сводки и M продаж — маржа без КСО. Формулы не пересчитываются: используются сохранённые в Excel значения.</p>
        {issues.map(issue => <p className="local-notice" key={issue}>{issue}</p>)}
        {batch.reports.map(report => <div className="local-report-detail" key={report.kind}>
          <h3>{REPORT_NAMES[report.kind]}</h3>
          <p className="local-filename">{report.file} · лист {report.sheet} · филиалов: {report.branches.length}</p>
          <div className="local-table-wrap" role="region" aria-label={`Ячейки: ${REPORT_NAMES[report.kind]}`} tabIndex={0}>
            <table className="local-table">
              <caption>{selectedName} · значения выбранной строки и сверка всего отчёта</caption>
              <thead><tr><th scope="col">Показатель</th><th scope="col">Ячейка выбранной строки</th><th scope="col">Значение</th><th scope="col">Итог отчёта · строка 2</th><th scope="col">Сумма филиалов</th><th scope="col">Разница / сверка</th></tr></thead>
              <tbody>{reconcile(report).filter(c => c.metric !== 'plan' || planKnown).map(c => <tr key={c.metric}>
                <th scope="row">{METRIC_NAMES[c.metric]}{!['sales', 'stock', 'aged', 'plan'].includes(c.metric) ? ', ₽' : ', шт.'}</th>
                <td>{sourceAddress(report, selectRow(report, branch), c.metric)}</td>
                <td>{number(valueFor(report, branch, c.metric), !['sales', 'stock', 'aged', 'plan'].includes(c.metric))}</td>
                <td>{number(c.official, !['sales', 'stock', 'aged', 'plan'].includes(c.metric))}<small>{sourceAddress(report, report.total, c.metric)}</small></td>
                <td>{number(c.sum, !['sales', 'stock', 'aged', 'plan'].includes(c.metric))}</td>
                <td className={!c.matches ? 'portal-warning' : ''}>{c.delta == null ? 'Неполные данные' : c.matches ? 'Совпадает' : `Расхождение: ${number(c.delta, true)}`}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>)}
        {batch.skipped.length > 0 && <div className="local-skipped"><h3>Пропущенные файлы · {batch.skipped.length}</h3>
          <ul>{batch.skipped.map((f, i) => <li key={i}><span className="local-filename">{f.file}</span><br />{f.reason}</li>)}</ul>
        </div>}
        <p className="portal-footnote">Допуск сверки денежных сумм — менее 0,01 ₽. Если хотя бы одна ячейка отсутствует, сумма филиалов не подставляется. Загруженный отчёт не связан с доступами и задачами портала.</p>
      </details>
      <section className="local-branches" aria-labelledby="local-branches-title">
        <div className="portal-section-head"><div><h2 id="local-branches-title">Филиалы из отчётов <span className="network-count">{branches.length}</span></h2><p className="portal-muted">Список из Excel, не оргструктура. Дивизионы и РМ не сопоставлены.</p></div>
          {branch && <button className="portal-text-button" onClick={() => setBranch('')}>Вернуться к итогу сети</button>}
        </div>
        <div className="network-branch-list">{branches.map(([key, name]) => <details key={key} className="network-branch">
          <summary><Icon name="chevron" /><strong>{name}</strong><span className="network-branch-source">{batch.reports.filter(r => selectRow(r, key)).map(r => r.kind === 'summary' ? 'Сводка' : 'Продажи').join(' + ')}</span><span className="portal-chip">Без оценки</span></summary>
          <div className="network-branch-content">
            <div className="network-branch-values">{KEYS.map(metric => <div key={metric}><span>{METRIC_NAMES[metric]}</span><strong>{number(valueFor(sourceFor(metric), key, metric), metric === 'margin')}{metric === 'margin' && valueFor(sourceFor(metric), key, metric) != null ? ' ₽' : ''}</strong><small>{sourceAddress(sourceFor(metric), selectRow(sourceFor(metric), key), metric)}</small></div>)}</div>
            <button className="portal-text-button" onClick={() => { setBranch(key); document.getElementById('metrics-title')?.scrollIntoView({ block: 'start' }); }}>Показать в карточках и сверке ↑</button>
          </div>
        </details>)}</div>
        <details className="local-tabular-details"><summary>Таблица всех филиалов · сравнить показатели</summary>
        <div className="local-table-wrap local-branch-scroll" role="region" aria-label="Показатели филиалов" tabIndex={0}>
          <table className="local-table">
            <caption>Продажи / маржа: {primary && REPORT_NAMES[primary.kind]}. Склад: сводка. Филиалы обоих отчётов сохранены.</caption>
            <thead><tr><th scope="col">Филиал</th><th scope="col">Продажи, шт.</th><th scope="col">Маржа + КСО, ₽</th><th scope="col">Склад, шт.</th><th scope="col">45+, шт.</th><th scope="col">Наличие в отчётах</th></tr></thead>
            <tbody>{branches.map(([key, name]) => <tr key={key} className={branch === key ? 'local-selected-row' : ''}>
              <th scope="row"><button className="local-branch-button" aria-pressed={branch === key} onClick={() => setBranch(key)}>{name}</button></th>
              {KEYS.map(metric => <td key={metric}>{number(valueFor(sourceFor(metric), key, metric), metric === 'margin')}</td>)}
              <td>{batch.reports.filter(r => selectRow(r, key)).map(r => r.kind === 'summary' ? 'Сводка' : 'Продажи').join(' + ')}</td>
            </tr>)}</tbody>
          </table>
        </div>
        </details>
      </section>
    </>}
  </section>;
}
