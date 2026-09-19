import React, { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import Logo from './Logo';
import Icon, { type IconName } from './Icon';
import { canSeeNavLink, navPermissions } from './navAccess';

const groups: { label: string; links: { path: string; label: string; icon: IconName; future?: boolean }[] }[] = [
  { label: 'Обзор', links: [
    { path: '/', label: 'Вся сеть', icon: 'grid' },
    { path: '/network-overview', label: 'Обзор сети · балл и фокусы', icon: 'chart' },
    { path: '/saved-network', label: 'Обзор сети · PREVIEW', icon: 'chart' },
    { path: '/organization', label: 'Структура и доступ', icon: 'network' },
    { path: '/access', label: 'Пользователи и назначения', icon: 'network' },
    { path: '/prepared-reports', label: 'Подготовленные отчёты', icon: 'upload' },
    { path: '/analytics', label: 'Продажи и склад', icon: 'chart', future: true },
  ] },
  { label: 'Управление результатом', links: [
    { path: '/division-summary', label: 'Сводка по дивизионам', icon: 'chart' },
    { path: '/settings/thresholds', label: 'Пороги показателей', icon: 'target' },
    { path: '/settings/scoring', label: 'Модель балла филиала', icon: 'target' },
    { path: '/settings/focus', label: 'Фокусы внимания месяца', icon: 'target' },
    { path: '/settings/notifications', label: 'Уведомления и сроки', icon: 'target' },
    { path: '/kpi', label: 'KPI и MBO', icon: 'target', future: true },
    { path: '/bdr', label: 'БДР · план и факт', icon: 'wallet', future: true },
  ] },
  { label: 'Операционная работа', links: [
    { path: '/tasks', label: 'Задачи', icon: 'check' },
    { path: '/my-deviations', label: 'Мои задачи по отклонениям', icon: 'target' },
    { path: '/diary', label: 'Ежедневник', icon: 'calendar', future: true },
    { path: '/notifications', label: 'Уведомления', icon: 'bell' },
    { path: '/modules', label: 'Готовность модулей', icon: 'layers' },
  ] },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const { me, logout } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const mobile = useRef<HTMLDialogElement>(null);
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem('fresh-theme') === 'dark' ? 'dark' : 'light'; } catch { return 'light'; }
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('fresh-theme', theme); } catch { /* Theme persistence is optional. */ }
  }, [theme]);
  const permissions = navPermissions(me?.grants ?? []);
  const primaryRole = me?.grants?.some(g => g.role === 'SUPER_ADMIN') ? 'Администратор' : me?.grants?.some(g => g.role === 'REGIONAL_MANAGER') ? 'Постановщик' : 'Исполнитель';
  const current = pathname.startsWith('/branches/')||pathname.startsWith('/branch-card/') ? 'Карточка филиала' : groups.flatMap(g => g.links).find(l => l.path === pathname || (l.path!=='/'&&pathname.startsWith(l.path+'/')))?.label ?? 'Карточка задачи';
  const close = () => mobile.current?.close();
  const upload = () => { close(); navigate('/?import=1'); };
  const nav = <>
    <NavLink className="shell-brand" to="/" onClick={close} aria-label="FRESH · Обзор сети">
      <Logo /><span>ПОРТАЛ УПРАВЛЕНИЯ СЕТЬЮ</span>
    </NavLink>
    <nav className="shell-nav" aria-label="Основная навигация">
      {groups.map(group => ({...group, links: group.links.filter(link=>canSeeNavLink(link, me?.grants??[], permissions))}))
        .filter(group=>group.links.length>0).map(group => <div className="shell-nav-group" key={group.label}>
        <div className="shell-nav-label">{group.label}</div>
        {group.links.map(link => <NavLink key={link.path} to={link.path} end={link.path === '/'} onClick={close}
          className={({ isActive }) => `shell-nav-link${isActive ? ' active' : ''}`}>
          <Icon name={link.icon} /><span>{link.label}</span>
          {link.future && <span className="shell-future" title={link.path==='/diary'?'Рабочий beta-сценарий; полный каталог ещё в разработке':'Навигационный каркас · следующий этап'} aria-label={link.path==='/diary'?'Beta':'Следующий этап'}>{link.path==='/diary'?'β':'○'}</span>}
        </NavLink>)}
      </div>)}
      {canSeeNavLink({path:'/organization'}, me?.grants??[], permissions) && <div className="shell-nav-group shell-org">
        <div className="shell-nav-label">Оргструктура сети</div>
        <NavLink className="shell-org-line" to="/organization" onClick={close}><Icon name="network" /><span>Открыть справочник</span></NavLink>
        <p>История и текущий доступ<br />Без автоматических назначений</p>
      </div>}
    </nav>
    <div className="shell-sidebar-bottom">
      {canSeeNavLink({path:'/prepared-reports'}, me?.grants??[], permissions) && <>
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
        <div className="shell-top-actions"><span className="shell-stage">Сетевой срез · ТЗ v2.12</span>
          <button className="shell-icon-button" aria-label={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
            onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} title="Сменить тему"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
          <NavLink className="shell-icon-button" to="/notifications" aria-label="Открыть уведомления"><Icon name="bell" /></NavLink>
        </div>
      </header>
      <main id="portal-main" className="main-content">{children}</main>
    </div>
  </div>;
}
