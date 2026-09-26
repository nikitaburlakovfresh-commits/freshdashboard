import React, { useMemo, useState } from 'react';
import { createDirectTask, type AssignScope } from '../api/directTasks';

/**
 * «Поставить задачу» (26.09.2026): РФ и собственник — любой роли филиала и
 * запрос в УК; РОП, РОО, руководитель КСО, старшие — своим сотрудникам.
 * Кто кому может ставить — правила в базе, а не код.
 */
const tomorrow = () => {
  const d = new Date(Date.now() + 3 * 3600e3 + 864e5);
  return d.toISOString().slice(0, 10);
};

export default function DirectTaskDialog({ scopes: allScopes, onClose, onCreated }: {
  scopes: AssignScope[]; onClose: () => void; onCreated: (id: string) => void;
}) {
  // Только филиалы, где есть кому поставить задачу: у РМ их десятки, а
  // сотрудники заведены не везде.
  const scopes = allScopes.filter(s => s.people.length > 0 || s.uk_request);
  const [org, setOrg] = useState(scopes[0]?.org_unit_id ?? '');
  const scope = scopes.find(s => s.org_unit_id === org);
  const [kind, setKind] = useState<'TASK' | 'UK_REQUEST'>(scope && !scope.people.length && scope.uk_request ? 'UK_REQUEST' : 'TASK');
  const [person, setPerson] = useState('');
  const [due, setDue] = useState(tomorrow());
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groups = useMemo(() => {
    const m = new Map<string, { name: string; people: AssignScope['people'] }>();
    for (const p of scope?.people ?? []) {
      const g = m.get(p.role_code) ?? { name: p.role_name, people: [] };
      g.people.push(p); m.set(p.role_code, g);
    }
    return [...m.entries()];
  }, [scope]);
  const rm = scope?.uk_managers ?? [];

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    const [uid, role] = kind === 'UK_REQUEST' ? [rm[0]?.user_id, undefined] : person.split('|');
    if (!uid) { setError(kind === 'UK_REQUEST' ? 'У филиала не назначен региональный менеджер.' : 'Выберите исполнителя.'); return; }
    setBusy(true);
    try {
      const r = await createDirectTask({ kind, org_unit_id: org, assignee_user_id: uid, role_code: role,
        due_date: due, title: title.trim(), brief: brief.trim() || undefined });
      onCreated(r.id);
    } catch (err: any) { setError(err?.message ?? 'Не удалось поставить задачу.'); }
    finally { setBusy(false); }
  }

  return <div className="direct-task-backdrop" role="dialog" aria-modal="true" aria-labelledby="direct-task-title"
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="direct-task" onSubmit={submit}>
      <h2 id="direct-task-title">{kind === 'UK_REQUEST' ? 'Запрос в УК' : 'Поставить задачу'}</h2>
      {scopes.length > 1 && <label>Филиал<select value={org} onChange={e => { setOrg(e.target.value); setPerson(''); }}>
        {scopes.map(s => <option key={s.org_unit_id} value={s.org_unit_id}>{s.org_name}</option>)}</select></label>}
      {scope?.uk_request && <div className="direct-task-kind" role="radiogroup" aria-label="Тип">
        <button type="button" aria-pressed={kind === 'TASK'} onClick={() => setKind('TASK')}>Сотруднику филиала</button>
        <button type="button" aria-pressed={kind === 'UK_REQUEST'} onClick={() => setKind('UK_REQUEST')}>Запрос в УК</button>
      </div>}
      {kind === 'TASK' ? <label>Исполнитель<select required value={person} onChange={e => setPerson(e.target.value)}>
        <option value="">Выберите сотрудника</option>
        {groups.map(([code, g]) => <optgroup key={code} label={g.name}>
          {g.people.map(p => <option key={p.user_id + code} value={`${p.user_id}|${code}`}>{p.full_name}</option>)}</optgroup>)}
      </select>{!groups.length && <small>В филиале нет сотрудников, которым вы можете ставить задачи.</small>}</label>
        : <p className="direct-task-note">Запрос получит региональный менеджер{rm[0] ? `: ${rm[0].full_name}` : ''}.
          Он ответит сам или передаст профильной службе УК. Результат принимаете вы.</p>}
      <label>Что сделать<input required minLength={3} maxLength={200} value={title} onChange={e => setTitle(e.target.value)}
        placeholder={kind === 'UK_REQUEST' ? 'Например: согласовать скидку на Camry' : 'Например: обзвонить лиды за неделю'}/></label>
      <label>Подробности<textarea rows={3} maxLength={4000} value={brief} onChange={e => setBrief(e.target.value)}/></label>
      <label>Срок<input type="date" required value={due} min={tomorrow().slice(0, 10) > due ? undefined : undefined}
        onChange={e => setDue(e.target.value)}/></label>
      {error && <p role="alert" className="direct-task-error">{error}</p>}
      <div className="direct-task-actions">
        <button type="button" onClick={onClose}>Отмена</button>
        <button type="submit" className="direct-task-primary" disabled={busy}>{busy ? 'Ставлю…' : kind === 'UK_REQUEST' ? 'Отправить в УК' : 'Поставить'}</button>
      </div>
    </form>
  </div>;
}
