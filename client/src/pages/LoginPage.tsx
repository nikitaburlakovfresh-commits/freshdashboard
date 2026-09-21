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
    <div className="login-page"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#F5F6F8',
        padding: 20,
      }}
    >
      <form className="login-form"
        onSubmit={onSubmit}
        style={{
          width: 380,
          background: '#fff',
          borderRadius: 16,
          padding: 32,
          boxShadow: '0 1px 3px rgba(0,0,0,0.06), 0 8px 24px rgba(0,0,0,0.04)',
        }}
      >
        <div className="login-brand" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
          <Logo size={32} />
          <span style={{ fontWeight: 700, fontSize: 18, color: 'var(--fresh-dark)' }}>Вход в портал</span>
        </div>
        <div style={{ marginBottom: 24 }}>
          <span className="pilot-badge">Синтетический пилот — не боевые данные</span>
        </div>

        <label htmlFor="login" style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, color: 'var(--fresh-dark)' }}>
          Логин
        </label>
        <input
          id="login" value={loginValue}
          onChange={(e) => setLoginValue(e.target.value)}
          autoFocus
          autoComplete="username"
          placeholder="rm_a"
          style={inputStyle}
        />

        <label htmlFor="password" style={{ display: 'block', fontSize: 13, fontWeight: 500, marginBottom: 6, marginTop: 16, color: 'var(--fresh-dark)' }}>
          Пароль
        </label>
        <input
          id="password" type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          style={inputStyle}
        />

        {error && (
          <div role="alert" style={{ marginTop: 14, color: 'var(--fresh-danger)', fontSize: 13, fontWeight: 500 }}>{error}</div>
        )}

        <button type="submit" disabled={submitting || !loginValue || !password} style={buttonStyle(submitting)}>
          {submitting ? 'Вход…' : 'Войти'}
        </button>

        <p style={{ marginTop: 18, fontSize: 12, color: 'var(--fresh-text-muted)', lineHeight: 1.5 }}>
          Личный вход в тестовый контур пилота. Если открыт во встроенном предпросмотре без
          cookie-поддержки, откройте приложение по прямой ссылке в отдельной вкладке.
        </p>
        <p style={{ marginTop: 18, fontSize: 13, textAlign: 'center' }}>
          Нет доступа? <a href="/register">Зарегистрироваться</a> — администратор портала
          подтвердит учётную запись.
        </p>
      </form>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--fresh-border)',
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
