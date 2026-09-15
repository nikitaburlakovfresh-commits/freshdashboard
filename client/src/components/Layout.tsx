import React, { useState } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import Logo from './Logo';

const linkStyle = (isActive: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  borderRadius: 8,
  color: isActive ? '#003DFF' : '#292D34',
  background: isActive ? '#EBF0FF' : 'transparent',
  fontWeight: isActive ? 600 : 500,
  fontSize: 14,
  textDecoration: 'none',
});

export default function Layout({ children }: { children: React.ReactNode }) {
  const { me, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const primaryRole = me?.grants?.some((g) => g.role === 'REGIONAL_MANAGER') ? 'REGIONAL_MANAGER' : 'RF';

  const nav = (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '4px 8px 20px' }}>
        <Logo />
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#292D34' }}>FRESH Portal</div>
          <span className="pilot-badge">Синтетика · Пилот</span>
        </div>
      </div>
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <NavLink to="/tasks" style={({ isActive }) => linkStyle(isActive)} onClick={() => setMobileOpen(false)}>
          Задачи
        </NavLink>
        <NavLink to="/notifications" style={({ isActive }) => linkStyle(isActive)} onClick={() => setMobileOpen(false)}>
          Уведомления
        </NavLink>
      </nav>
      <div style={{ marginTop: 'auto', paddingTop: 20, borderTop: '1px solid #E2E4E9' }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#292D34' }}>{me?.user.full_name}</div>
        <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
          {me?.user.login} · {primaryRole === 'REGIONAL_MANAGER' ? 'Постановщик' : 'Исполнитель'}
        </div>
        <button
          onClick={() => logout()}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid #E2E4E9',
            background: '#fff',
            color: '#292D34',
            fontSize: 13,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Выйти
        </button>
      </div>
    </>
  );

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <span className="mobile-pilot-label" style={{display:'none',position:'fixed',top:22,left:64,zIndex:19,fontSize:12,color:'#52616b'}}>Пилот · тестовые данные</span>
      <button
        aria-label="Открыть меню"
        onClick={() => setMobileOpen(true)}
        style={{
          display: 'none',
          position: 'fixed',
          top: 12,
          left: 12,
          zIndex: 20,
          width: 40,
          height: 40,
          borderRadius: 8,
          border: '1px solid #E2E4E9',
          background: '#fff',
        }}
        className="mobile-menu-btn"
      >
        ☰
      </button>

      <aside
        className="sidebar"
        style={{
          width: 240,
          flexShrink: 0,
          background: '#fff',
          borderRight: '1px solid #E2E4E9',
          padding: 20,
          flexDirection: 'column',
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        {nav}
      </aside>

      {mobileOpen && (
        <div
          onClick={() => setMobileOpen(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            zIndex: 30,
          }}
        >
          <aside
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 260,
              height: '100vh',
              background: '#fff',
              padding: 20,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {nav}
          </aside>
        </div>
      )}

      <main className="main-content" style={{ flex: 1, minWidth: 0, padding: '28px 32px', maxWidth: 1100 }}>{children}</main>

      <style>{`
        .sidebar { display: flex; }
        @media (max-width: 860px) {
          .sidebar { display: none !important; }
          .mobile-menu-btn { display: flex !important; align-items: center; justify-content: center; }
          .mobile-pilot-label { display: block !important; }
          .main-content { padding: 72px 16px 24px !important; }
        }
      `}</style>
    </div>
  );
}
