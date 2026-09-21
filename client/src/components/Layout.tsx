import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import Logo from './Logo';
import Icon, { type IconName } from './Icon';
import { canSeeNavLink, navPermissions, type NavLinkDef } from './navAccess';
import { getOrganizationTree } from '../api/organization';
import { useReportDate } from '../state/reportDate';
import RoleViewBar from './RoleViewBar';
import { getPendingRegistrations } from '../api/adminSettings';

type NavGroup = { label: string; links: NavLinkDef<IconName>[] };

/**
 * Рабочий контур: только то, чем ежедневно пользуются коммерческий директор,
 * дивизиональный руководитель, региональный менеджер и роли филиала.
 * Раздел попадает сюда исключительно с явным признаком work: true.
 */
const workGroups: NavGroup[] = [
  { label: 'Результат сети', links: [
    { path: '/', label: 'Обзор сети · KPI', icon: 'chart', work: true },
    { path: '/operational', label: 'Вся сеть · задачи и отклонения', icon: 'grid', work: true },
    { path: '/division-summary', label: 'Сводка по дивизионам', icon: 'chart', work: true },
  ] },
  { label: 'Моя работа', links: [
    { path: '/tasks', label: 'Задачи', icon: 'check', work: true },
    { path: '/my-deviations', label: 'Мои задачи по отклонениям', icon: 'target', work: true },
    { path: '/diary', label: 'Ежедневник', icon: 'calendar', work: true, future: true },
    { path: '/notifications', label: 'Уведомления', icon: 'bell', work: true },
  ] },
];

/**
 * Администрирование портала. Здесь всё, что нужно для настройки, а не для
 * ежедневной работы руководителя: приём данных, правила расчёта, доступы,
 * оргструктура и служебные разделы. Любой новый раздел без work: true
 * попадает сюда по умолчанию, поэтому рабочее меню не разрастается само.
 */
const adminGroups: NavGroup[] = [
  { label: 'Данные и отчёты', links: [
    { path: '/prepared-reports', label: 'Загрузка пакета отчётов QLIK', icon: 'upload' },
    { path: '/saved-network', label: 'Предпросмотр публикации', icon: 'chart' },
  ] },
  { label: 'Правила расчёта', links: [
    { path: '/settings/thresholds', label: 'Пороги показателей', icon: 'target' },
    { path: '/settings/source-naming', label: 'Названия филиалов в отчётах', icon: 'layers' },
    { path: '/settings/scoring', label: 'Модель балла филиала', icon: 'target' },
    { path: '/settings/focus', label: 'Фокусы внимания месяца', icon: 'target' },
    { path: '/settings/notifications', label: 'Уведомления и сроки', icon: 'target' },
  ] },
  { label: 'Доступ и структура', links: [
    { path: '/access/roles', label: 'Роли и права', icon: 'shield' },
    { path: '/access/registrations', label: 'Заявки на доступ', icon: 'check' },
    { path: '/organization', label: 'Оргструктура сети', icon: 'network' },
    { path: '/access', label: 'Пользователи и назначения', icon: 'network' },
  ] },
  { label: 'Служебное', links: [
    { path: '/modules', label: 'Готовность модулей', icon: 'layers' },
    { path: '/analytics', label: 'Продажи и склад', icon: 'chart', future: true },
    { path: '/kpi', label: 'KPI и MBO', icon: 'target', future: true },
    { path: '/bdr', label: 'БДР · план и факт', icon: 'wallet', future: true },
  ] },
];

const allLinks = [...workGroups, ...adminGroups].flatMap(g => g.links);
const ADMIN_OPEN_KEY = 'fresh-nav-admin-open';
const ADMIN_GROUPS_KEY = 'fresh-nav-admin-groups';

/** Срез позже сегодняшнего дня не существует: поле даты ограничено текущей датой. */
const TODAY=new Date().toISOString().slice(0,10);

export default function Layout({ children }: { children: React.ReactNode }) {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const mobile = useRef<HTMLDialogElement>(null);
  const { reportDate, setReportDate } = useReportDate();
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('fresh-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('fresh-theme', theme); } catch { /* Theme persistence is optional. */ }
  }, [theme]);
  const permissions = navPermissions(me?.grants ?? []);
  const grants = me?.grants ?? [];
  // Просмотр глазами роли предлагаем только владельцу платформы: у остальных
  // ролей этой кнопки быть не должно даже визуально.
  const isOwner = grants.some(g => g.role === 'SUPER_ADMIN');
  // Счётчик ожидающих заявок на доступ: владелец платформы должен видеть новую
  // заявку, не заходя в раздел. Обновляется раз в минуту.
  const [pendingReg, setPendingReg] = useState(0);
  useEffect(() => {
    if (!isOwner) return;
    let alive = true;
    const tick = () => { getPendingRegistrations()
      .then(r => { if (alive) setPendingReg(r.pending); }).catch(() => {}); };
    tick();
    const id = window.setInterval(tick, 60000);
    return () => { alive = false; window.clearInterval(id); };
  }, [isOwner]);
  const visible = (groups: NavGroup[]) => groups
    .map(group => ({ ...group, links: group.links.filter(link => canSeeNavLink(link, grants, permissions)) }))
    .filter(group => group.links.length > 0);
  const work = useMemo(() => visible(workGroups), [me]);
  const admin = useMemo(() => visible(adminGroups), [me]);
  const adminPaths = admin.flatMap(g => g.links.map(l => l.path));
  const adminActive = adminPaths.some(p => pathname === p || pathname.startsWith(p + '/'));
  const [adminOpen, setAdminOpen] = useState(() => {
    try { return localStorage.getItem(ADMIN_OPEN_KEY) === '1'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(ADMIN_OPEN_KEY, adminOpen ? '1' : '0'); } catch { /* Persistence is optional. */ }
  }, [adminOpen]);
  const showAdmin = adminOpen || adminActive;
  // Внутренние разделы администрирования тоже раскрываются по отдельности,
  // чтобы длинный список настроек не разворачивался целиком.
  const [openGroups, setOpenGroups] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(ADMIN_GROUPS_KEY) ?? '[]') as string[]; } catch { return []; }
  });
  useEffect(() => {
    try { localStorage.setItem(ADMIN_GROUPS_KEY, JSON.stringify(openGroups)); } catch { /* Persistence is optional. */ }
  }, [openGroups]);
  const toggleGroup = (label: string) => setOpenGroups(list =>
    list.includes(label) ? list.filter(l => l !== label) : [...list, label]);
  const primaryRole = grants.some(g => g.role === 'SUPER_ADMIN') ? 'Администратор'
    : grants.some(g => g.role === 'REGIONAL_MANAGER') ? 'Постановщик' : 'Исполнитель';
  const current = pathname.startsWith('/branches/') || pathname.startsWith('/branch-card/') ? 'Карточка филиала'
    : allLinks.find(l => l.path === pathname || (l.path !== '/' && pathname.startsWith(l.path + '/')))?.label ?? 'Карточка задачи';
  const close = () => mobile.current?.close();
  const upload = () => { close(); navigate('/prepared-reports'); };
  const renderLink = (link: NavLinkDef<IconName>) => <NavLink key={link.path} to={link.path}
    end={link.path === '/'} onClick={close}
    className={({ isActive }) => `shell-nav-link${isActive ? ' active' : ''}`}>
    <Icon name={link.icon} /><span>{link.label}</span>
    {link.future && <span className="shell-future"
      title={link.path === '/diary' ? 'Рабочий beta-сценарий; полный каталог ещё в разработке' : 'Навигационный каркас · следующий этап'}
      aria-label={link.path === '/diary' ? 'Beta' : 'Следующий этап'}>{link.path === '/diary' ? 'β' : '○'}</span>}
  </NavLink>;
  // Дивизионы сети берутся из справочника оргструктуры на дату среза: список
  // не зашит в код и меняется вместе со структурой. Ошибка чтения не ломает
  // навигацию — раздел просто не показывается.
  const [divisions, setDivisions] = useState<{ id: string; display_name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    getOrganizationTree(reportDate)
      .then(tree => { if (alive) setDivisions(tree.items.filter(u => u.kind === 'DIVISION')
        .map(u => ({ id: u.id, display_name: u.display_name }))); })
      .catch(() => { if (alive) setDivisions([]); });
    return () => { alive = false; };
  }, [reportDate]);
  const nav = <>
    <NavLink className="shell-brand" to="/" onClick={close} aria-label="FRESH · Обзор сети">
      <Logo /><span>ПОРТАЛ УПРАВЛЕНИЯ СЕТЬЮ</span>
    </NavLink>
    <nav className="shell-nav" aria-label="Основная навигация">
      {work.map(group => <div className="shell-nav-group" key={group.label}>
        <div className="shell-nav-label">{group.label}</div>
        {group.links.map(renderLink)}
      </div>)}
      {divisions.length > 0 && <div className="shell-nav-group">
        <div className="shell-nav-label">Дивизионы</div>
        {divisions.map(d => <NavLink key={d.id} to={`/division-summary?division=${d.id}`} onClick={close}
          className={({ isActive }) => `shell-nav-link${isActive ? ' active' : ''}`}>
          <Icon name="network" /><span>{d.display_name}</span>
        </NavLink>)}
      </div>}
      {admin.length > 0 && <div className={`shell-nav-admin${showAdmin ? ' open' : ''}`}>
        <button type="button" className="shell-admin-toggle" onClick={() => setAdminOpen(v => !v)}
          aria-expanded={showAdmin} aria-controls="shell-admin-sections">
          <Icon name="layers" /><span>Администрирование</span>
          <span className="shell-admin-count">{adminPaths.length}</span>
          <Icon name="chevron" />
        </button>
        <div id="shell-admin-sections" className="shell-admin-sections" hidden={!showAdmin}>
          <p className="shell-admin-note">Настройка портала. В ежедневной работе руководителя не нужна.</p>
          {admin.map(group => {
            const groupActive = group.links.some(l => pathname === l.path || pathname.startsWith(l.path + '/'));
            const groupOpen = openGroups.includes(group.label) || groupActive;
            return <div className={`shell-nav-group shell-nav-subgroup${groupOpen ? ' open' : ''}`} key={group.label}>
              <button type="button" className="shell-subgroup-toggle" aria-expanded={groupOpen}
                onClick={() => toggleGroup(group.label)}>
                <span>{group.label}</span>
                <span className="shell-admin-count">{group.links.length}</span>
                <Icon name="chevron" />
              </button>
              <div hidden={!groupOpen}>{group.links.map(renderLink)}</div>
            </div>;
          })}
        </div>
      </div>}
    </nav>
    <div className="shell-sidebar-bottom">
      {canSeeNavLink({ path: '/prepared-reports', label: '', icon: 'upload' }, grants, permissions) && <>
        <button className="shell-upload" onClick={upload}><Icon name="upload" /><span>Загрузить QLIK-отчёты</span></button>
        <span className="shell-local-note">Excel · только в памяти страницы</span>
      </>}
      <div className="shell-account"><span className="shell-avatar">{me?.user.full_name?.slice(0, 1) ?? 'F'}</span>
        <div><strong>{me?.user.full_name}</strong><span>{primaryRole} · пилот R1</span></div>
        <button className="shell-icon-button" onClick={() => logout()} aria-label="Выйти" title="Выйти"><Icon name="logout" /></button>
      </div>
    </div>
  </>;
  return <div className="fresh-shell">
    <a href="#portal-main" className="shell-skip">К содержимому</a>
    <aside className="shell-sidebar">{nav}</aside>
    <dialog ref={mobile} className="shell-mobile-dialog" aria-label="Меню портала"
      onClick={e => { if (e.target === e.currentTarget) close(); }}>
      <div className="shell-mobile-inner">
        <button className="shell-menu-close" onClick={close}><Icon name="close" />Закрыть меню</button>{nav}
      </div>
    </dialog>
    <div className="shell-body">
      <header className="shell-topbar">
        <button className="shell-icon-button shell-menu-toggle" aria-label="Открыть меню" onClick={() => mobile.current?.showModal()}><Icon name="menu" /></button>
        <div className="shell-breadcrumb"><span>FRESH Portal</span><Icon name="chevron" /><strong>{current}</strong></div>
        <div className="shell-top-actions">
          <label className="shell-report-date">
            <span>Срез отчёта</span>
            <input type="date" value={reportDate} max={TODAY}
              aria-label="Дата отчётного среза"
              onChange={e => setReportDate(e.target.value)} />
          </label>
          <button className="shell-icon-button" aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="Сменить тему"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <NavLink className="shell-icon-button shell-bell" to={pendingReg > 0 ? '/access/registrations' : '/notifications'}
            aria-label={pendingReg > 0 ? `Заявок на доступ: ${pendingReg}` : 'Открыть уведомления'}
            title={pendingReg > 0 ? `Новых заявок на доступ: ${pendingReg}` : 'Уведомления'}>
            <Icon name="bell" />
            {pendingReg > 0 && <span className="shell-bell-badge">{pendingReg}</span>}
          </NavLink>
          <RoleViewBar isOwner={isOwner} slot="button" />
        </div>
      </header>
      <RoleViewBar isOwner={isOwner} slot="banner" />
      <main id="portal-main" className="main-content">{children}</main>
    </div>
  </div>;
}
