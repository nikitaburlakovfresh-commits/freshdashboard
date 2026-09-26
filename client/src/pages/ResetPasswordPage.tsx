import React, { useState } from 'react';
import { submitPasswordReset } from '../api/adminSettings';
import Logo from '../components/Logo';

/**
 * Восстановление пароля (решение владельца 26.09.2026). Почты в портале нет,
 * поэтому человек сам задаёт новый пароль, а администратор портала подтверждает
 * заявку. Пароль сразу уходит хешем и никому не передаётся.
 */
export default function ResetPasswordPage() {
  const [form, setForm] = useState({ login: '', password: '', password2: '', comment: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm(p => ({ ...p, [k]: e.target.value }));

  const send = async () => {
    setError(null);
    if (!form.login.trim()) { setError('Укажите логин.'); return; }
    if (form.password.length < 12) { setError('Пароль должен быть не короче 12 знаков.'); return; }
    if (form.password !== form.password2) { setError('Пароли не совпадают.'); return; }
    setBusy(true);
    try {
      const res = await submitPasswordReset({ login: form.login.trim(), password: form.password, comment: form.comment || undefined });
      setSent(res.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отправить заявку.');
    } finally { setBusy(false); }
  };

  if (sent) return <div className="login-shell"><div className="login-card">
    <Logo />
    <h1>Заявка отправлена</h1>
    <p>{sent}</p>
    <a className="btn" href="/">Вернуться ко входу</a>
  </div></div>;

  return <div className="login-shell"><div className="login-card register-card">
    <Logo />
    <h1>Восстановление пароля</h1>
    <p className="org-small">
      Укажите свой логин и задайте новый пароль. Он заработает после подтверждения
      администратором портала — до этого действует прежний.
    </p>
    {error && <p className="role-view-error">{error}</p>}
    <label className="role-view-field"><span>Логин</span>
      <input type="text" value={form.login} onChange={set('login')} autoComplete="username"
        autoCapitalize="none" autoCorrect="off" spellCheck={false} /></label>
    <label className="role-view-field"><span>Новый пароль (не короче 12 знаков)</span>
      <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" /></label>
    <label className="role-view-field"><span>Новый пароль ещё раз</span>
      <input type="password" value={form.password2} onChange={set('password2')} autoComplete="new-password" /></label>
    <label className="role-view-field"><span>Комментарий администратору (необязательно)</span>
      <input type="text" maxLength={500} value={form.comment} onChange={set('comment')} /></label>
    <button type="button" className="btn role-view-primary" onClick={send} disabled={busy}>Отправить заявку</button>
    <a className="login-alt-link" href="/">Вспомнил пароль — войти</a>
  </div></div>;
}
