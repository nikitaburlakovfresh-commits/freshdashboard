import React, { useEffect, useRef, useState } from 'react';
import Logo from '../components/Logo';
import { useAuth } from '../auth/AuthContext';

/** Показывать заставку один раз на открытие портала, а не на каждый возврат
 *  к экрану входа внутри той же вкладки. */
const INTRO_SHOWN_KEY = 'fresh_intro_shown';

export default function LoginPage() {
  const { login } = useAuth();
  const [introDone, setIntroDone] = useState(() => {
    try { return sessionStorage.getItem(INTRO_SHOWN_KEY) === '1'; } catch { return false; }
  });
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

  const finishIntro = () => {
    try { sessionStorage.setItem(INTRO_SHOWN_KEY, '1'); } catch { /* приватный режим — просто покажем снова */ }
    setIntroDone(true);
  };

  if (!introDone) return <IntroScreen onEnter={finishIntro} />;

  return (
    <div className="login-page"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--fresh-bg)',
        padding: 20,
      }}
    >
      <form className="login-form"
        onSubmit={onSubmit}
        style={{
          width: 'min(380px, 100%)',
          background: 'var(--fresh-surface)',
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
          autoCapitalize="none" autoCorrect="off" spellCheck={false}
          placeholder="Ваш логин"
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
        <p style={{ marginTop: 14, fontSize: 13, textAlign: 'center' }}>
          <a href="/reset-password">Забыли пароль?</a>
        </p>
        <p style={{ marginTop: 10, fontSize: 13, textAlign: 'center' }}>
          Нет доступа? <a href="/register">Зарегистрироваться</a> — администратор портала
          подтвердит учётную запись.
        </p>
      </form>
    </div>
  );
}

/**
 * Стартовый экран портала: ролик Fresh, после которого появляется кнопка «Войти».
 *
 * Звук выключен намеренно: браузеры не дают автозапуск со звуком, и ролик просто
 * не начался бы. Кнопка «Пропустить» есть с самого начала — если автозапуск
 * запрещён политикой браузера или человек заходит десятый раз за день, экран не
 * должен становиться препятствием. Как только ролик закончился, появляется
 * крупная кнопка входа.
 */
function IntroScreen({ onEnter }: { onEnter: () => void }) {
  const [ended, setEnded] = useState(false);
  const video = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const node = video.current;
    if (!node) return;
    // Если браузер отказал в автозапуске, ролик ждать бессмысленно — сразу
    // показываем кнопку входа.
    const attempt = node.play();
    if (attempt && typeof attempt.catch === 'function') attempt.catch(() => setEnded(true));
    // Страховка: событие окончания может не прийти — при подвисшей буферизации
    // или если ролик не начался. Вход не должен зависеть от этого события, поэтому
    // кнопка появляется и по таймеру, не позже чем через 12 секунд.
    const guard = setTimeout(() => setEnded(true), 12000);
    return () => clearTimeout(guard);
  }, []);

  return (
    <div className="intro-screen">
      <video
        ref={video}
        className="intro-video"
        src="/intro/fresh-intro.mp4"
        poster="/intro/fresh-intro.jpg"
        muted
        playsInline
        preload="auto"
        onEnded={() => setEnded(true)}
        onError={() => setEnded(true)}
      />
      <div className="intro-overlay">
        {ended ? (
          <button type="button" className="intro-enter" onClick={onEnter} autoFocus>Войти</button>
        ) : (
          <button type="button" className="intro-skip" onClick={() => setEnded(true)}>Пропустить</button>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid var(--fresh-border)',
  background: 'var(--fresh-subtle)',
  color: 'var(--fresh-dark)',
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
    background: disabled ? 'var(--fresh-blue-disabled)' : 'var(--fresh-blue)',
    color: '#fff',
    fontSize: 14,
    fontWeight: 600,
    cursor: disabled ? 'default' : 'pointer',
  };
}
