import React, { useMemo, useState } from 'react';
import { createDirectTask, type AssignScope, type AssignPerson, type UkOptions } from '../api/directTasks';

/**
 * «Поставить задачу» — одно окно для всех ролей (26.09.2026).
 *  · Сотруднику филиала — по правилам «кто кому» (РФ и собственник — всем ролям
 *    филиала, РОП — СМОП и МОП, РМ и дивизиональный — сотрудникам своих филиалов).
 *  · Сотруднику УК — «всем всем в УК»: любой сотрудник УК любому сотруднику УК;
 *    задача относится ко всей сети или к конкретному филиалу.
 *  · Запрос в УК — от филиала региональному менеджеру.
 * Кто кому может ставить — правила в базе, а не код.
 */
type Kind = 'TASK' | 'UK_TASK' | 'UK_REQUEST';
const tomorrow = () => new Date(Date.now() + 3 * 3600e3 + 864e5).toISOString().slice(0, 10);

function byRole(people: AssignPerson[]) {
  const m = new Map<string, { name: string; people: AssignPerson[] }>();
  for (const p of people) {
    const g = m.get(p.role_code) ?? { name: p.role_name, people: [] };
    g.people.push(p); m.set(p.role_code, g);
  }
  return [...m.entries()];
}

export default function DirectTaskDialog({ scopes: allScopes, uk, onClose, onCreated }: {
  scopes: AssignScope[]; uk?: UkOptions | null; onClose: () => void; onCreated: (id: string) => void;
}) {
  // Только филиалы, где есть кому поставить задачу.
  const scopes = allScopes.filter(s => s.people.length > 0 || s.uk_request);
  const kinds: { k: Kind; label: string }[] = [
    ...(scopes.some(s => s.people.length) ? [{ k: 'TASK' as Kind, label: 'Сотруднику филиала' }] : []),
    ...(uk && uk.people.length ? [{ k: 'UK_TASK' as Kind, label: 'Сотруднику УК' }] : []),
    ...(scopes.some(s => s.uk_request) ? [{ k: 'UK_REQUEST' as Kind, label: 'Запрос в УК' }] : []),
  ];
  const [kind, setKind] = useState<Kind>(kinds[0]?.k ?? 'TASK');
  const branchScopes = kind === 'UK_REQUEST' ? scopes.filter(s => s.uk_request) : scopes.filter(s => s.people.length);
  const [org, setOrg] = useState(branchScopes[0]?.org_unit_id ?? '');
  const scope = branchScopes.find(s => s.org_unit_id === org) ?? branchScopes[0];
  const [ukScope, setUkScope] = useState(uk?.network_id ?? '');
  const [person, setPerson] = useState('');
  const [due, setDue] = useState(tomorrow());
  const [title, setTitle] = useState('');
  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const groups = useMemo(() => byRole(kind === 'UK_TASK' ? uk?.people ?? [] : scope?.people ?? []), [kind, scope, uk]);
  const rm = scope?.uk_managers ?? [];

  function switchKind(k: Kind) { setKind(k); setPerson(''); setError(''); }

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setError('');
    let body: Parameters<typeof createDirectTask>[0];
    const base = { due_date: due, title: title.trim(), brief: brief.trim() || undefined };
    if (kind === 'UK_REQUEST') {
      if (!rm[0]) { setError('У филиала не назначен региональный менеджер.'); return; }
      body = { kind, org_unit_id: scope!.org_unit_id, assignee_user_id: rm[0].user_id, ...base };
    } else if (kind === 'UK_TASK') {
      const [uid] = person.split('|');
      if (!uid) { setError('Выберите сотрудника УК.'); return; }
      if (!ukScope) { setError('Выберите, к чему относится задача.'); return; }
      body = { kind, org_unit_id: ukScope, assignee_user_id: uid, ...base };
    } else {
      const [uid, role] = person.split('|');
      if (!uid) { setError('Выберите исполнителя.'); return; }
      body = { kind, org_unit_id: scope!.org_unit_id, assignee_user_id: uid, role_code: role, ...base };
    }
    setBusy(true);
    try { onCreated((await createDirectTask(body)).id); }
    catch (err: any) { setError(err?.message ?? 'Не удалось поставить задачу.'); }
    finally { setBusy(false); }
  }

  return <div className="direct-task-backdrop" role="dialog" aria-modal="true" aria-labelledby="direct-task-title"
    onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <form className="direct-task" onSubmit={submit}>
      <h2 id="direct-task-title">{kind === 'UK_REQUEST' ? 'Запрос в УК' : 'Поставить задачу'}</h2>
      {kinds.length > 1 && <div className="direct-task-kind" role="radiogroup" aria-label="Кому">
        {kinds.map(x => <button key={x.k} type="button" aria-pressed={kind === x.k} onClick={() => switchKind(x.k)}>{x.label}</button>)}
      </div>}

      {kind !== 'UK_TASK' && branchScopes.length > 1 && <label>Филиал<select value={scope?.org_unit_id ?? ''}
        onChange={e => { setOrg(e.target.value); setPerson(''); }}>
        {branchScopes.map(s => <option key={s.org_unit_id} value={s.org_unit_id}>{s.org_name}</option>)}</select></label>}

      {kind === 'UK_REQUEST'
        ? <p className="direct-task-note">Запрос получит региональный менеджер{rm[0] ? `: ${rm[0].full_name}` : ''}.
            Он ответит сам или передаст профильной службе УК. Результат принимаете вы.</p>
        : <label>{kind === 'UK_TASK' ? 'Сотрудник УК' : 'Исполнитель'}<select required value={person} onChange={e => setPerson(e.target.value)}>
            <option value="">Выберите сотрудника</option>
            {groups.map(([code, g]) => <optgroup key={code} label={g.name}>
              {g.people.map(p => <option key={p.user_id + code} value={`${p.user_id}|${code}`}>{p.full_name}</option>)}</optgroup>)}
          </select>{!groups.length && <small>Нет сотрудников, которым вы можете ставить задачи.</small>}</label>}

      {kind === 'UK_TASK' && uk && <label>К чему относится<select value={ukScope} onChange={e => setUkScope(e.target.value)}>
        {uk.network_id && <option value={uk.network_id}>Вся сеть</option>}
        <optgroup label="Филиал">
          {uk.branches.map(b => <option key={b.org_unit_id} value={b.org_unit_id}>{b.org_name}</option>)}</optgroup>
      </select></label>}

      <label>Что сделать<input required minLength={3} maxLength={200} value={title} onChange={e => setTitle(e.target.value)}
        placeholder={kind === 'UK_REQUEST' ? 'Например: согласовать скидку на Camry'
          : kind === 'UK_TASK' ? 'Например: согласовать макет вывески' : 'Например: обзвонить лиды за неделю'}/></label>
      <label>Подробности<textarea rows={3} maxLength={4000} value={brief} onChange={e => setBrief(e.target.value)}/></label>
      <label>Срок<input type="date" required value={due} onChange={e => setDue(e.target.value)}/></label>
      {error && <p role="alert" className="direct-task-error">{error}</p>}
      <div className="direct-task-actions">
        <button type="button" onClick={onClose}>Отмена</button>
        <button type="submit" className="direct-task-primary" disabled={busy}>{busy ? 'Ставлю…' : kind === 'UK_REQUEST' ? 'Отправить в УК' : 'Поставить'}</button>
      </div>
    </form>
  </div>;
}
