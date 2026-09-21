import React, { useEffect, useState } from 'react';
import { getRegistrationDirectory, submitRegistration } from '../api/adminSettings';
import Logo from '../components/Logo';

/**
 * Регистрация сотрудника при первом обращении к порталу.
 *
 * Доступ появляется только после подтверждения администратором портала: до
 * этого человека нет ни в оргструктуре, ни в отчётности по людям.
 *
 * Пароль человек задаёт здесь сам, и он сразу уходит хешем. Поэтому после
 * подтверждения никому не нужно передавать пароль — ни в переписке, ни голосом.
 */
export default function RegisterPage() {
  const [roles, setRoles] = useState<{ code: string; display_name: string }[]>([]);
  const [branches, setBranches] = useState<{ id: string; display_name: string }[]>([]);
  const [form, setForm] = useState({
    full_name: '', login: '', primary_email: '', phone: '',
    requested_role_code: '', requested_org_unit_id: '', comment: '',
    password: '', password2: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    getRegistrationDirectory()
      .then(r => { setRoles(r.roles); setBranches(r.branches); })
      .catch(() => setError('Не удалось загрузить перечень должностей и филиалов. Обновите страницу.'));
  }, []);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(p => ({ ...p, [k]: e.target.value }));

  const send = async () => {
    setError(null);
    if (form.password !== form.password2) { setError('Пароли не совпадают.'); return; }
    if (form.password.length < 12) { setError('Пароль должен быть не короче 12 знаков.'); return; }
    setBusy(true);
    try {
      const { password2, ...payload } = form;
      void password2;
      const res = await submitRegistration(payload);
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
    <h1>Регистрация сотрудника</h1>
    <p className="org-small">
      Заполните данные и задайте пароль. Доступ откроется после подтверждения
      администратором портала — войдёте этим же логином и паролем.
    </p>
    {error && <p className="role-view-error">{error}</p>}

    <label className="role-view-field"><span>Фамилия и имя</span>
      <input type="text" value={form.full_name} onChange={set('full_name')} autoComplete="name" /></label>
    <label className="role-view-field"><span>Логин (строчные латинские буквы, цифры, точка)</span>
      <input type="text" value={form.login} onChange={set('login')} autoComplete="username" /></label>
    <label className="role-view-field"><span>Рабочая почта</span>
      <input type="email" value={form.primary_email} onChange={set('primary_email')} autoComplete="email" /></label>
    <label className="role-view-field"><span>Телефон (необязательно)</span>
      <input type="tel" value={form.phone} onChange={set('phone')} autoComplete="tel" /></label>
    <label className="role-view-field"><span>Должность</span>
      <select value={form.requested_role_code} onChange={set('requested_role_code')}>
        <option value="">— выберите должность —</option>
        {roles.map(r => <option key={r.code} value={r.code}>{r.display_name}</option>)}
      </select></label>
    <label className="role-view-field"><span>Филиал</span>
      <select value={form.requested_org_unit_id} onChange={set('requested_org_unit_id')}>
        <option value="">— выберите филиал —</option>
        {branches.map(b => <option key={b.id} value={b.id}>{b.display_name}</option>)}
      </select></label>
    <label className="role-view-field"><span>Пароль (не короче 12 знаков)</span>
      <input type="password" value={form.password} onChange={set('password')} autoComplete="new-password" /></label>
    <label className="role-view-field"><span>Пароль ещё раз</span>
      <input type="password" value={form.password2} onChange={set('password2')} autoComplete="new-password" /></label>
    <label className="role-view-field"><span>Комментарий администратору (необязательно)</span>
      <input type="text" value={form.comment} onChange={set('comment')} /></label>

    <button type="button" className="btn role-view-primary" onClick={send} disabled={busy}>
      Отправить заявку
    </button>
    <a className="login-alt-link" href="/">У меня уже есть доступ — войти</a>
  </div></div>;
}
