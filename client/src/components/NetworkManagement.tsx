import React, { useRef, useState } from 'react';
import Icon from './Icon';
import { METRIC_NAMES, REPORT_NAMES, selectRow, sourceAddress, type ReportBatch } from '../imports/reportModel';
import { NETWORK_KEYS, metricValue, networkSource, networkBranches, rankedBranches, salesPlan, stockShare,
  stockDeviation, validateStockTarget, type NetworkMetric, type FocusFilter, type StockTarget } from '../imports/networkModel';
import '../styles/network.css';

const fmt = (v: number | null | undefined, digits = 0) => v == null ? 'Нет данных'
  : v.toLocaleString('ru-RU', { maximumFractionDigits: digits });
const pct = (v: number | null) => v == null ? '—' : `${fmt(v, 2)}%`;
const date = (value: string) => value.split('-').reverse().join('.');
const range = (start: string, end: string) => `${date(start)} — ${date(end)} включительно`;
export default function NetworkManagement({ batch, openImport }: { batch: ReportBatch | null; openImport: () => void }) {
  const [metric, setMetric] = useState<NetworkMetric>('sales');
  const [direction, setDirection] = useState<'asc' | 'desc'>('desc');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FocusFilter>('all');
  const [selected, setSelected] = useState('');
  const [mapping, setMapping] = useState(false);
  const [target, setTarget] = useState<StockTarget | null>(null);
  const [targetRaw, setTargetRaw] = useState('');
  const [targetError, setTargetError] = useState('');
  const [targetNotice, setTargetNotice] = useState('');
  const [month, setMonth] = useState(batch?.reports.find(r => r.kind === 'summary')?.stockDate?.slice(0, 7) ?? '');
  const branchDialog = useRef<HTMLDialogElement>(null);
  const targetDialog = useRef<HTMLDialogElement>(null);
  const branches = batch ? networkBranches(batch) : [];
  const rows = batch ? rankedBranches(batch, metric, direction, query, filter, target) : [];
  const plan = batch ? salesPlan(batch) : null;
  const share = batch ? stockShare(batch) : null;
  const salesChecked = batch ? branches.filter(b => salesPlan(batch, b.key).ratio != null).length : 0;
  const salesBelow = batch ? branches.filter(b => (salesPlan(batch, b.key).gap ?? 0) > 0).length : 0;
  const stockChecked = batch ? branches.filter(b => stockDeviation(batch, b.key, target) != null).length : 0;
  const stockAbove = batch ? branches.filter(b => (stockDeviation(batch, b.key, target) ?? 0) > 0).length : 0;
  const selectedBranch = branches.find(b => b.key === selected);
  const branchPlan = batch && selectedBranch ? salesPlan(batch, selected) : null;
  const branchStock = batch && selectedBranch ? stockShare(batch, selected) : null;
  const viewFocus = (next: FocusFilter) => { setFilter(next); setQuery(''); document.getElementById('network-comparison')?.scrollIntoView({ block: 'start' }); };
  const openBranch = (key: string) => { setSelected(key); setMapping(false); branchDialog.current?.showModal(); };
  const editTarget = () => { setTargetRaw(target ? String(target.value) : ''); setTargetError(''); targetDialog.current?.showModal(); };
  const applyTarget = (event: React.FormEvent) => {
    event.preventDefault();
    if (!batch) return;
    try {
      const value = validateStockTarget(month, targetRaw, batch);
      setTarget({ month, value, revision: (target?.revision ?? 0) + 1 });
      setTargetNotice('Черновик применён только в памяти страницы. Это не утверждённый фокус или норматив сети.');
      targetDialog.current?.close();
    } catch (e) { setTargetError((e as Error).message); }
  };
  return <>
    <section className="network-focus" aria-labelledby="focus-title">
      <div className="portal-section-head"><div><h2 id="focus-title">Фокусы внимания</h2><p className="portal-muted">Рабочие сравнения из файла · не активированные Monthly Focus</p></div><span className="portal-chip">Без RAG и итоговой оценки</span></div>
      <div className="network-live-focus-grid">
        <article className="network-live-focus" data-testid="sales-focus">
          <div className="network-focus-caption"><Icon name="target" /><h3>Продажи · факт / план</h3><span>01</span></div>
          <strong className="network-focus-value">{pct(plan?.ratio ?? null)}</strong>
          <p>{plan?.plan != null ? `${fmt(plan.fact)} / ${fmt(plan.plan)} шт.` : 'План из второго отчёта'}</p>
          <p className="network-focus-explain">{plan?.reason || (batch ? `${range(batch.period.start, batch.period.end)}. Факт C / план B × 100, только отчёт продаж.` : 'Загрузите отчёт продаж и подтвердите оба периода.')}</p>
          {batch?.period.planStart && <p>План: {range(batch.period.planStart, batch.period.planEnd)} · даты подтверждены пользователем.</p>}
          <div className="network-focus-action"><span>Проверено {salesChecked} из {branches.length} филиалов</span><button disabled={!salesChecked} onClick={() => viewFocus('sales-gap')}>Ниже плана: {salesChecked ? salesBelow : '—'} →</button></div>
        </article>
        <article className="network-live-focus" data-testid="stock-focus">
          <div className="network-focus-caption"><Icon name="stock" /><h3>Доля склада 45+</h3><span>02</span></div>
          <strong className="network-focus-value">{pct(share?.value ?? null)}</strong>
          <p>{share?.report?.stockDate ? `${fmt(share.aged)} / ${fmt(share.stock)} шт. · ${date(share.report.stockDate)}` : 'Срез склада из сводки'}</p>
          <p className="network-focus-explain">{share?.reason || '45+ / весь склад × 100. Обе величины из одной сводки на одну дату; не среднее долей филиалов.'}</p>
          <div className="network-target-line"><span>{target ? `Черновик ≤ ${fmt(target.value, 2)}% · ${target.month} · v${target.revision}` : 'Цель не настроена · нет нормы по умолчанию'}</span><button disabled={!share?.report?.stockDate} onClick={editTarget}>{target ? 'Изменить' : 'Задать цель'}</button></div>
          {target && <div className="network-focus-action"><span>Проверено {stockChecked} из {branches.length}</span><button disabled={!stockChecked} onClick={() => viewFocus('aged-gap')}>Выше черновика: {stockChecked ? stockAbove : '—'} →</button></div>}
        </article>
      </div>
      <p className="portal-footnote" role="status">{targetNotice || 'Сравнение не подтверждает достижение на конец месяца. Для ACTIVE нужны реестр метрик, источники, пробный расчёт прошлого месяца, OrgUnit, ответственные и аудит (§11.2).'}</p>
      <details className="network-pending"><summary>Ещё 3 направления не настроены · отсутствие расчёта не означает отсутствие риска</summary>
        <div><p><strong>Маржа / MBO:</strong> факт есть в KPI; плановая база, версия и approval отсутствуют — HOLD_POLICY_REQUIRED (§9, D-05).</p>
          <p><strong>RunRate / оборачиваемость:</strong> формула продаж с cutoff и временем, а также база оборота не утверждены. Не заменяем их роялти-формулой §22.5.2.</p>
          <p><strong>Ежедневник / дисциплина:</strong> нет бизнес-шаблонов и фактов. Синтетические задачи A/B не подставляются в сеть.</p>
          <p>Это перечень зависимостей, не пять опубликованных слотов. В production — 1–5 уникальных фокусов на scope и месяц (§11.2.2, §22.4).</p></div>
      </details>
    </section>
    <section className="portal-panel network-comparison" id="network-comparison" aria-labelledby="network-title">
      <div className="portal-section-head"><div><h2 id="network-title">Сравнение филиалов <span className="network-count">{branches.length}</span></h2><p className="portal-muted">Вся сеть из локального файла · распределение по РМ не настроено</p></div><span className="portal-chip">Не production RBAC</span></div>
      {!batch ? <div className="network-empty-body"><Icon name="network" /><div><h3>От показателя — к филиалу</h3><p>Загрузите два отчёта для сравнения фактов, плана продаж и склада 45+.</p></div><button className="local-secondary" onClick={openImport}>Подключить Excel</button></div> : <>
        <div className="network-controls">
          <label className="network-search">Поиск филиала<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="Название из Excel" /></label>
          <label>Ранжировать по<select aria-label="Метрика ранжирования" value={metric} onChange={e => setMetric(e.target.value as NetworkMetric)}>{NETWORK_KEYS.map(k => <option key={k} value={k}>{METRIC_NAMES[k]}</option>)}</select></label>
          <label>Порядок<select aria-label="Порядок ранжирования" value={direction} onChange={e => setDirection(e.target.value as 'asc' | 'desc')}><option value="desc">По убыванию</option><option value="asc">По возрастанию</option></select></label>
          <label>Фокус<select aria-label="Фильтр фокуса" value={filter} onChange={e => setFilter(e.target.value as FocusFilter)}><option value="all">Все филиалы</option><option value="sales-gap" disabled={!salesChecked}>Ниже плана продаж</option><option value="aged-gap" disabled={!stockChecked}>Выше цели 45+ · черновик</option></select></label>
        </div>
        <div className="network-table-meta"><span role="status">Показано {rows.length} из {branches.length} · ранги всей выборки до поиска; одинаковые значения делят место</span><button className="portal-text-button" onClick={() => { setQuery(''); setFilter('all'); setMetric('sales'); setDirection('desc'); }}>Сбросить фильтры</button></div>
        <p className="network-scroll-hint">Таблица прокручивается вправо → · название филиала закреплено</p>
        <div className="local-table-wrap" role="region" aria-label="Сравнение филиалов сети" tabIndex={0}>
          <table className="local-table network-ranking">
            <caption>Место — по {METRIC_NAMES[metric].toLocaleLowerCase('ru')}, {direction === 'desc' ? 'убыванию' : 'возрастанию'}, не оценка качества. Пропуски всегда в конце. Сортировка только по количествам и деньгам.</caption>
            <thead><tr><th scope="col">Место</th><th scope="col">Филиал</th>{NETWORK_KEYS.map(k => <th key={k} scope="col" aria-sort={metric === k ? direction === 'desc' ? 'descending' : 'ascending' : 'none'}><button onClick={() => { setMetric(k); setDirection(metric === k && direction === 'desc' ? 'asc' : 'desc'); }}>{k === 'sales' ? 'Продажи, шт.' : k === 'margin' ? 'Маржа + КСО, ₽' : k === 'stock' ? 'Склад, шт.' : '45+, шт.'}{metric === k ? direction === 'desc' ? ' ↓' : ' ↑' : ''}</button></th>)}<th scope="col">Факт / план, %<small>Отчёт продаж C / B</small></th><th scope="col">Доля 45+, %<small>Сводка AB / E</small></th></tr></thead>
            <tbody>{rows.map(row => <tr key={row.key} data-branch={row.key}><td>{row.rank ?? '—'}</td><th scope="row"><button className="local-branch-button" onClick={() => openBranch(row.key)}>{row.name} <span aria-hidden="true">↗</span></button></th>{NETWORK_KEYS.map(k => <td className={metric === k ? 'network-sorted' : ''} key={k}>{fmt(metricValue(networkSource(batch, k), row.key, k), k === 'margin' ? 2 : 0)}</td>)}<td>{pct(salesPlan(batch, row.key).ratio)}</td><td>{pct(stockShare(batch, row.key).value)}</td></tr>)}
              {!rows.length && <tr><td colSpan={8}>Нет филиалов по выбранному условию. Непроверенные строки не означают отсутствие отклонений.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="portal-footnote">Продажи и маржа: {REPORT_NAMES[networkSource(batch, 'sales')!.kind]}. План/факт — отдельно из отчёта продаж, без смешивания источников. {range(batch.period.start, batch.period.end)}. Склад: {share?.report?.stockDate ? date(share.report.stockDate) : 'нет среза'}. Сетевой итог в KPI не меняется при фильтрации.</p>
      </>}
    </section>
    <dialog ref={targetDialog} className="local-import-drawer network-drawer" aria-labelledby="target-title">
      <div className="local-drawer-content"><div className="local-drawer-heading"><h2 id="target-title">Цель 45+ · локальный черновик</h2><button aria-label="Закрыть цель" className="shell-icon-button" onClick={() => targetDialog.current?.close()}><Icon name="close" /></button></div>
        <p>Направление — снизить / не превышать. Вы задаёте личную цель сравнения, не норматив сети. Нет публикации, утверждения и денежного эффекта; после ухода или замены пакета черновик исчезнет.</p>
        <form className="network-target-form" onSubmit={applyTarget}><label>Месяц складского среза<input aria-label="Месяц цели" type="month" required value={month} onChange={e => setMonth(e.target.value)} /></label><label>Целевая доля, % · не более<input aria-label="Целевая доля" type="text" inputMode="decimal" required value={targetRaw} onChange={e => setTargetRaw(e.target.value)} placeholder="От 0 до 100, без значения по умолчанию" /></label>
          {targetError && <p role="alert" className="portal-error">{targetError}</p>}
          <button className="portal-primary" type="submit">Применить черновик</button>
          {target && <button type="button" className="local-secondary" onClick={() => { setTarget(null); setFilter('all'); setTargetNotice('Черновик цели удалён. Оценка по цели не выполняется.'); targetDialog.current?.close(); }}>Удалить черновик</button>}
        </form></div>
    </dialog>
    <dialog ref={branchDialog} className="local-import-drawer network-drawer" aria-labelledby="branch-inspect-title">
      <div className="local-drawer-content"><div className="local-drawer-heading"><div><span className="portal-eyebrow">ДЕТАЛИ СТРОКИ · СЕТЬ ОСТАЁТСЯ НА МЕСТЕ</span><h2 id="branch-inspect-title">{selectedBranch?.name}</h2></div><button aria-label="Закрыть филиал" className="shell-icon-button" onClick={() => branchDialog.current?.close()}><Icon name="close" /></button></div>
        {batch && selectedBranch && <>
          <p className="local-privacy">Локальное имя из Excel, не OrgUnit. Ответственный РМ и права на бизнес-филиал не определены.</p>
          <div className="network-inspect-values">{NETWORK_KEYS.map(k => { const report = networkSource(batch, k); return <article key={k}><span>{METRIC_NAMES[k]}</span><strong>{fmt(metricValue(report, selected, k), k === 'margin' ? 2 : 0)} {k === 'margin' ? '₽' : 'шт.'}</strong><small>{sourceAddress(report, selectRow(report, selected), k)}</small><small>{report?.file ?? 'Нет источника'}</small></article>; })}</div>
          <div className="network-inspect-note"><h3>Продажи · сопоставление с планом</h3><p>{fmt(branchPlan?.fact)} / {fmt(branchPlan?.plan)} шт. · {pct(branchPlan?.ratio ?? null)}</p><p>{branchPlan?.reason || `Разница до плана: ${fmt(branchPlan?.gap)} шт. Факт C / план B одного отчёта.`}</p><p>Факт: {range(batch.period.start, batch.period.end)}. План: {batch.period.planStart ? range(batch.period.planStart, batch.period.planEnd) : 'период не подтверждён'}.</p>
            <small>{sourceAddress(branchPlan?.report, selectRow(branchPlan?.report, selected), 'sales')} / {sourceAddress(branchPlan?.report, selectRow(branchPlan?.report, selected), 'plan')} · {branchPlan?.report?.file}</small></div>
          <div className="network-inspect-note"><h3>Склад 45+ · {pct(branchStock?.value ?? null)}</h3><p>{branchStock?.reason || `${fmt(branchStock?.aged)} / ${fmt(branchStock?.stock)} × 100 · ${date(branchStock?.report?.stockDate ?? '')}`}</p><p>{target && stockDeviation(batch, selected, target) != null ? `Разница с черновиком ≤ ${fmt(target.value, 2)}%: ${fmt(stockDeviation(batch, selected, target), 2)} п.п. Не итоговое достижение месяца.` : 'Цель не настроена или нет сопоставимых данных; нет оценки.'}</p></div>
          <button className="local-secondary" onClick={() => setMapping(!mapping)} aria-expanded={mapping}>Задача по этому филиалу · нужен OrgUnit</button>
          {mapping && <div role="status" className="local-notice"><strong>Создание заблокировано до сопоставления.</strong><p>Нужны подтверждённый OrgUnit, принадлежность филиала, действующий ответственный и grant на создание. Название из файла не связывается автоматически с тестовыми A/B. Ни одной задачи не создано.</p></div>}
        </>}
      </div>
    </dialog>
  </>;
}
