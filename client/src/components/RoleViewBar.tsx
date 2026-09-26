import React, { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';
import {
  getRoleViewStatus, getRoleViewCandidates, enterRoleView, exitRoleView,
  type RoleViewStatus, type RoleViewRole,
} from '../api/roleView';

/**
 * Просмотр глазами роли — для владельца платформы.
 *
 * Зачем: при разработке и разборе ошибок нужно видеть экран так, как его видит
 * руководитель филиала или региональный менеджер, не выпрашивая его пароль.
 * На старом портале это работало через вход под пользователем; здесь то же
 * самое, но только на чтение и с ограничением по времени.
 *
 * Баннер видно всегда, пока режим включён: иначе легко забыть, чьими глазами
 * смотришь, и принять чужую картину за свою.
 */

function formatLeft(expiresAt: string): string {
  const ms = new Date(expiresAt).getTime() - Date.now();
  if (ms <= 0) return 'время истекло';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `осталось ${m}:${String(s).padStart(2, '0')}`;
}

/**
 * slot='banner' — широкая полоса над содержимым, видна пока режим включён.
 * slot='button' — кнопка входа в шапке, видна только вне режима.
 * Две позиции вместо одной: полосу нельзя ужимать в ряд иконок, иначе она
 * перестаёт читаться, а это единственный признак чужой личности на экране.
 */
export default function RoleViewBar({ isOwner, slot }: { isOwner: boolean; slot: 'banner' | 'button' }) {
  const [status, setStatus] = useState<RoleViewStatus | null>(null);
  const [roles, setRoles] = useState<RoleViewRole[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [roleCode, setRoleCode] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const viewing = status?.viewing === true;

  const refresh = useCallback(async () => {
    try { setStatus(await getRoleViewStatus()); } catch { /* статус не критичен для работы экрана */ }
  }, []);

  // Статус спрашиваем всегда: в режиме просмотра права на экране — чужие, и
  // isOwner ложен. Раньше из-за этого баннер с возвратом не появлялся вовсе,
  // и владельцу приходилось выходить из портала (26.09.2026).
  useEffect(() => { void refresh(); }, [isOwner, refresh]);

  // Тикаем раз в секунду только когда режим включён: таймер должен быть
  // правдивым, а вне режима считать нечего.
  useEffect(() => {
    if (!viewing) return;
    const id = window.setInterval(() => setTick(t => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [viewing]);

  // Срок вышел — сервер сбросит режим сам, нам остаётся перезагрузить экран,
  // чтобы данные не остались чужими.
  useEffect(() => {
    if (!viewing || !status?.expires_at) return;
    if (new Date(status.expires_at).getTime() - Date.now() <= 0) window.location.reload();
  }, [tick, viewing, status?.expires_at]);

  const openPicker = async () => {
    setPickerOpen(true);
    setError(null);
    if (roles) return;
    try {
      const res = await getRoleViewCandidates();
      setRoles(res.roles);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось получить список учётных записей.');
    }
  };

  const candidates = useMemo(
    () => roles?.find(r => r.role_code === roleCode)?.candidates ?? [],
    [roles, roleCode],
  );

  const enter = async () => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      await enterRoleView(userId);
      // Полная перезагрузка — намеренно: смена личности меняет меню, доступы и
      // все загруженные данные, частичное обновление оставило бы смесь.
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось включить просмотр.');
      setBusy(false);
    }
  };

  const leave = async () => {
    setBusy(true);
    try {
      await exitRoleView();
      window.location.assign('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось выйти из просмотра.');
      setBusy(false);
    }
  };

  if (viewing && status) {
    if (slot !== 'banner') return null;
    return <div className="role-view-bar" role="status">
      <Icon name="eye" />
      <span className="role-view-text">
        Просмотр глазами роли: <strong>{status.as?.full_name}</strong> ({status.as?.login}).
        Портал только показывает данные, изменения недоступны.
        {status.expires_at && <> · {formatLeft(status.expires_at)}</>}
      </span>
      <button type="button" className="role-view-exit" onClick={leave} disabled={busy}>
        Вернуться к своей учётной записи{status.admin?.full_name ? ` · ${status.admin.full_name}` : ''}
      </button>
    </div>;
  }

  if (!isOwner || slot !== 'button') return null;

  return <>
    {/* Кнопка была безымянной иконкой глаза среди прочих иконок шапки, и
        владелец портала решил, что режима просмотра в портале нет вообще.
        Иконка без подписи не находится: подписываем словами. */}
    <button type="button" className="shell-icon-button role-view-open" onClick={openPicker}
      aria-label="Просмотр глазами роли" title="Просмотр глазами роли: увидеть портал так, как его видит сотрудник">
      <Icon name="eye" />
      <span className="role-view-open-text">Глазами роли</span>
    </button>
    {pickerOpen && <div className="role-view-modal" role="dialog" aria-modal="true"
      aria-label="Просмотр глазами роли"
      onClick={e => { if (e.target === e.currentTarget) setPickerOpen(false); }}>
      <div className="role-view-modal-inner">
        <h2>Просмотр глазами роли</h2>
        <p className="role-view-hint">
          Выберите роль и действующую учётную запись. Портал покажет экраны так, как их видит
          этот сотрудник, на 30 минут и только для чтения. Вход и выход пишутся в журнал.
        </p>
        {error && <p className="role-view-error">{error}</p>}
        {!roles && !error && <p>Загружаем список…</p>}
        {roles && roles.length === 0 && <p>
          Нет действующих персональных учётных записей, под которыми можно смотреть.
        </p>}
        {roles && roles.length > 0 && <>
          <label className="role-view-field">
            <span>Роль</span>
            <select value={roleCode} onChange={e => { setRoleCode(e.target.value); setUserId(''); }}>
              <option value="">— выберите роль —</option>
              {roles.map(r => <option key={r.role_code} value={r.role_code}>
                {r.role_name} ({r.candidates.length})
              </option>)}
            </select>
          </label>
          <label className="role-view-field">
            <span>Учётная запись</span>
            <select value={userId} onChange={e => setUserId(e.target.value)} disabled={!roleCode}>
              <option value="">— выберите сотрудника —</option>
              {candidates.map(c => <option key={c.user_id} value={c.user_id}>
                {c.full_name}{c.org_unit_name ? ` · ${c.org_unit_name}` : ''} ({c.login})
              </option>)}
            </select>
          </label>
        </>}
        <div className="role-view-actions">
          <button type="button" onClick={() => setPickerOpen(false)}>Отмена</button>
          <button type="button" className="role-view-primary" onClick={enter}
            disabled={!userId || busy}>
            Смотреть глазами роли
          </button>
        </div>
      </div>
    </div>}
  </>;
}
