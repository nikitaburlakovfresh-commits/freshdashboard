import React, { useState } from 'react';
import Logo from '../components/Logo';
import { useAuth } from '../auth/AuthContext';

export default function LoginPage() {
  const { login } = useAuth();
  const [loginValue, setLoginValue] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login(loginValue.trim(), password);
    } catch (err: any) {
      setError(err?.message ?? 'Неверный логин или пароль.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F5F6F8',
        padding: 20,
      }}
    >
      <form
        onSubmit={onSubmit}
        style={{
          width: 380,
          background: '#fff',
          borderRadius: 16,
          padding: 32,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Logo size={32} />
          <span style={{ fontWeight: 700, fontSize: 18, color: '#292D34' }}>FRESH Portal</span>
        </div>
        <div style={{ marginBottom: 24 }}>
          <span className="pilot-badge">Синтетический пилот — не боевые данные</span>
        </div>

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, color: '#292D34' }}>
          Логин
        </label>
        <input
          value={loginValue}
          onChange={(e) => setLoginValue(e.target.value)}
          autoFocus
          autoComplete="username"
          placeholder="rm_a"
          style={inputStyle}
        />

        <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6, marginTop: 16, color: '#292D34' }}>
          Пароль
        </label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          style={inputStyle}
        />

        {error && (
          <div style={{ marginTop: 14, color: '#D92D20', fontSize: 13, fontWeight: 500 }}>{error}</div>
        )}

        <button type="submit" disabled={submitting || !loginValue || !password} style={buttonStyle(submitting)}>
          {submitting ? 'Вход…' : 'Войти'}
        </button>

        <p style={{ marginTop: 18, fontSize: 12, color: '#6b7280', lineHeight: 1.5 }}>
          Личный вход в тестовый контур пилота. Если открыт во встроенном предпросмотре без
          cookie-поддержки, откройте приложение по прямой ссылке в отдельной вкладке.
        </p>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #E2E4E9',
  fontSize: 14,
  outline: 'none',
};

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    width: '100%',
    marginTop: 22,
    padding: '11px 16px',
    borderRadius: 8,
    border: 'none',
    background: disabled ? '#A9B8FF' : '#003DFF',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
  };
}
