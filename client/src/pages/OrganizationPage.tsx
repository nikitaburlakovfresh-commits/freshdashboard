import React, { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext';
import { ApiError } from '../api/client';
import { checkOrganizationAdministration, getOrganizationHistory, getOrganizationTree,
  type DirectoryHistory, type DirectoryTree, type DirectoryUnit } from '../api/organization';
import { directoryRows } from '../components/orgDirectoryModel';
import Icon from '../components/Icon';
import '../styles/organization.css';

const kinds = { NETWORK: 'Сеть', DIVISION: 'Дивизион', CLUSTER: 'Кластер', ORG_UNIT: 'Филиал' };
const states = { PRE_LAUNCH: 'До запуска', ACTIVE: 'Активен', PAUSED: 'Приостановлен', CLOSED: 'Закрыт' };
const models = { FRANCHISE: 'Франшиза', OWN_OPERATION: 'Собственная операция', UC: 'Управляющая компания' };
const types = { CITY_FLAG: 'Городской флагман', EXPRESS: 'Экспресс', FULL_SERVICE: 'Полный сервис', PICKUP_POINT: 'Пункт выдачи', OUTLET: 'Аутлет' };
const interval = (from: string, to: string | null) => `${from} → ${to ? `${to} (не включая)` : 'открытый интервал'}`;

export default function OrganizationPage() {
  const { me } = useAuth();
  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [reload, setReload] = useState(0);
  const [tree, setTree] = useState<DirectoryTree | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(new Set<string>());
  const [history, setHistory] = useState<DirectoryHistory | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyBusy, setHistoryBusy] = useState(false);
  const [adminResult, setAdminResult] = useState('');
  const [adminBusy, setAdminBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setTree(null); setHistory(null); setSelected(null); setBusy(true); setError(''); setAdminResult('');
    if (!asOf) { setBusy(false); setError('Выберите дату среза.'); return; }
    getOrganizationTree(asOf).then(result => {
      if (!current) return;
      setTree(result); setSelected(result.items[0]?.id ?? null);
    }).catch(err => {
      if (current) setError(err instanceof ApiError ? `${err.message} (${err.code})` : 'Не удалось получить структуру. Проверьте соединение и повторите запрос.');
    }).finally(() => { if (current) setBusy(false); });
    return () => { current = false; };
  }, [asOf, reload, me?.user.id]);

  useEffect(() => {
    let current = true;
    setHistory(null); setHistoryError('');
    if (!selected) { setHistoryBusy(false); return; }
    setHistoryBusy(true);
    getOrganizationHistory(selected).then(result => {
      if (current) setHistory(result);
    }).catch(err => {
      if (current) setHistoryError(err instanceof ApiError ? `${err.message} (${err.code})` : 'История не загружена. Повторите запрос.');
    }).finally(() => { if (current) setHistoryBusy(false); });
    return () => { current = false; };
  }, [selected, reload, me?.user.id]);

  const rows = useMemo(() => directoryRows(tree?.items ?? [], search, collapsed), [tree, search, collapsed]);
  const unit = tree?.items.find(item => item.id === selected);
  function toggle(id: string) {
    setCollapsed(prev => { const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next; });
  }
  async function checkAdmin() {
    setAdminBusy(true); setAdminResult('');
    try {
      const result = await checkOrganizationAdministration(asOf);
      setTree(result);
      setAdminResult(`Сервер подтвердил административное чтение справочника: ${result.items.length} ед. Изменения, выдача ролей и импорт заблокированы.`);
    } catch (err) {
      setAdminResult(err instanceof ApiError ? `${err.message} (${err.status} ${err.code})` : 'Проверка недоступна. Изменения заблокированы.');
    } finally { setAdminBusy(false); }
  }
  function describeParent(item: DirectoryUnit) {
    return tree?.items.find(parent => parent.id === item.parent_id)?.display_name ??
      'Не подтверждена или вне вашего доступа';
  }
  return <div className="portal-dashboard org-page">
    <header className="portal-heading">
      <div><div className="portal-eyebrow">ОРГСТРУКТУРА · СПРАВОЧНИК V1</div><h1>Структура и доступ</h1>
        <p>Стабильные OrgUnit, названия и принадлежность на выбранную дату.</p></div>
      <span className="portal-chip"><Icon name="network" /> Только чтение</span>
    </header>
    <section className="org-scope" aria-label="Граница доступа">
      <Icon name="network" /><div><strong>{tree?.scope_mode === 'SYNTHETIC_DEMO_ONLY' ? 'Учебная структура · не серверные данные' : tree?.admin_review.authorized ? 'Административный обзор справочника · NETWORK' : 'Мой разрешённый контур'}</strong>
        <p>Дата меняет исторический срез, но не права. Видны только разрешённые сейчас единицы; чужие ветви и их названия скрыты.</p>
        <p>Пилотные A/B не сопоставлены с реальными филиалами. Бизнес-назначения и архивные учётные записи не импортированы.</p></div>
    </section>
    <div className="org-toolbar">
      <label>Дата среза (UTC)<input type="date" min="1900-01-01" max="9999-12-31" value={asOf} onChange={e => setAsOf(e.target.value)} /></label>
      <label className="org-search">Поиск в доступной структуре<input type="search" placeholder="Название или код" value={search} onChange={e => setSearch(e.target.value)} /></label>
      <button className="btn btn-secondary" onClick={() => setReload(value => value + 1)} disabled={busy}>Обновить доступ</button>
    </div>
    {busy && <div className="portal-panel" role="status">Загружаем структуру…</div>}
    {error && <div className="portal-panel org-error" role="alert"><strong>Структура недоступна</strong><p>{error}</p>
      <button className="btn btn-secondary" onClick={() => setReload(value => value + 1)}>Повторить</button></div>}
    {!busy && !error && tree && <div className="org-workspace">
      <section className="portal-panel org-tree" aria-label="Доступная структура">
        <div className="org-section-heading"><h2>Доступные единицы</h2><span>{tree.items.length}</span></div>
        <p className="portal-muted org-small">Сеть → дивизион → кластер → филиал. Иерархия не расширяет назначенные права.</p>
        {tree.items.length === 0 ? <div className="org-empty"><strong>Нет доступных единиц на эту дату</strong><p>Выберите более поздний срез или запросите проверку действующего назначения. Пропущенные данные не заменяются вымышленной структурой.</p></div> :
          rows.length === 0 ? <p role="status">В вашем контуре ничего не найдено.</p> :
          <ul className="org-tree-list">{rows.map(({ unit: row, depth, hasChildren }) =>
            <li key={row.id} style={{ paddingLeft: `${Math.min(depth, 4) * 14}px` }}>
              {hasChildren && <button className="org-expand" aria-label={`${collapsed.has(row.id) ? 'Раскрыть' : 'Свернуть'} ${row.display_name}`}
                aria-expanded={!collapsed.has(row.id) || !!search.trim()} onClick={() => toggle(row.id)}>{collapsed.has(row.id) && !search.trim() ? '+' : '−'}</button>}
              <button className={`org-tree-node${selected === row.id ? ' selected' : ''}`} aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>
                <span className="org-node-icon"><Icon name={row.kind === 'ORG_UNIT' ? 'grid' : 'network'} /></span>
                <span><strong>{row.display_name}</strong><small>{kinds[row.kind]} · {row.code}{row.is_demo ? ' · тестовый' : ''}</small></span>
              </button>
            </li>)}</ul>}
        <p className="org-small portal-muted">Если родитель скрыт или не подтверждён, единица показана отдельно. Это не перевод в другой дивизион.</p>
      </section>
      <section className="portal-panel org-detail" aria-label="Карточка организационной единицы">
        {unit ? <>
          <div className="portal-eyebrow">{kinds[unit.kind]} · {unit.is_demo ? 'СИНТЕТИЧЕСКИЙ ПИЛОТ' : 'СПРАВОЧНИК'}</div>
          <h2>{unit.display_name}</h2>
          <div className="org-status-row"><span className="portal-chip">{states[unit.lifecycle_state]}</span>{unit.demo_locked && <span className="portal-chip">Изменения заблокированы</span>}</div>
          <dl className="org-facts">
            <div><dt>Стабильный OrgUnit ID</dt><dd className="org-id">{unit.id}</dd></div>
            <div><dt>Родительская единица</dt><dd>{describeParent(unit)}</dd></div>
            <div><dt>Бизнес-модель</dt><dd>{unit.business_model ? models[unit.business_model] : 'Не подтверждена'}</dd></div>
            <div><dt>Тип филиала</dt><dd>{unit.type_code ? types[unit.type_code] : 'Не подтверждён'}</dd></div>
            <div><dt>Имя в срезе</dt><dd>{interval(unit.name_effective_from, unit.name_effective_to)}</dd></div>
            <div><dt>Принадлежность в срезе</dt><dd>{interval(unit.affiliation_effective_from, unit.affiliation_effective_to)}</dd></div>
          </dl>
          <div className="org-history"><h3>История названий и принадлежности</h3>
            <p className="org-small portal-muted">Интервалы полуоткрытые: начальная дата включена, конечная — нет. История не даёт архивных прав к задачам, финансам или людям.</p>
            {historyBusy && <p role="status">Загружаем историю…</p>}
            {historyError && <p className="org-error" role="alert">{historyError}</p>}
            {history && <>
              <h4>Названия</h4><ol>{history.names.map(row => <li key={row.effective_from}><strong>{row.display_name}</strong><small>{interval(row.effective_from, row.effective_to)}</small></li>)}</ol>
              <h4>Принадлежность</h4><ol>{history.affiliations.map(row => <li key={row.effective_from}><strong>{row.parent_id ? tree.items.find(item => item.id === row.parent_id)?.display_name ?? 'Родитель вне текущего среза' : 'Родитель не подтверждён или скрыт'}</strong>
                <span>{row.business_model ? models[row.business_model] : 'Бизнес-модель не подтверждена'}</span><small>{interval(row.effective_from, row.effective_to)}</small></li>)}</ol>
            </>}
          </div>
        </> : <div className="org-empty"><Icon name="network" /><h2>Выберите единицу</h2><p>Карточка и история доступны только в вашем текущем scope.</p></div>}
      </section>
    </div>}
    <section className="portal-panel org-admin" aria-label="Административное согласование">
      <div><div className="portal-eyebrow">АДМИНИСТРАТИВНЫЙ ОБЗОР</div><h2>{tree?.admin_review.authorized ? 'Доступ администратора: только проверка справочника' : 'Административное чтение требует отдельного назначения'}</h2>
        <p>{tree?.admin_review.authorized ? 'SUPER_ADMIN · Владелец платформы. Действующее право: organization.directory.review — метаданные и история справочника сети. Оно не открывает задачи, финансы, кадровые данные или чужие уведомления.' : 'Пилотные RM/RF не получают сетевой доступ через название должности. Сервер проверяет действующее назначение, scope и permission при каждом запросе.'}</p>
        <p>Запись, согласование изменений, выдача ролей, активация архивных учётных записей и импорт пока не реализованы — в том числе для администратора.</p>
        <p className="org-small portal-muted">По ТЗ COMDIR должен соответствовать COMMERCIAL_DIRECTOR, а не REGIONAL_MANAGER. Этот реестр ролей и нормализация ещё не включены; каталог и согласование назначений — следующий этап.</p>
      </div><button className="btn btn-secondary" onClick={checkAdmin} disabled={adminBusy}>{adminBusy ? 'Проверка…' : 'Проверить полномочия'}</button>
      {adminResult && <p className="org-admin-result" role="status">{adminResult}</p>}
    </section>
  </div>;
}
