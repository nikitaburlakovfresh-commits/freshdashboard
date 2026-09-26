import React, { useEffect, useState } from 'react';
import { createDelegation, delegationTargets, moscowToday, type DelegationTarget } from '../api/dailyLogs';

/** Откуда поручение: раздел ежедневника и, если есть, конкретная запись списка. */
export interface DelegateSource {
  section_num: number | null; section_title: string;
  field_path?: string | null; row_index?: number | null; link?: string | null; text?: string;
}

/**
 * Поручение из ежедневника: кому, на какой день и что сделать.
 *
 * Каждая машина или звонок поручается отдельно — разным людям или никому
 * (решение владельца 26.09.2026). Поручение себе на будущий день — тот же путь:
 * в выбранный день задача появится в собственном ежедневнике.
 */
export default function DelegateDialog({ diaryId, source, onClose, onCreated }: {
  diaryId: string; source: DelegateSource; onClose: () => void; onCreated: () => void;
}) {
  const [targets, setTargets] = useState<DelegationTarget[]>([]);
  const [selfId, setSelfId] = useState('');
  const [target, setTarget] = useState('');
  const [date, setDate] = useState(moscowToday());
  const what = source.row_index != null ? `${source.section_title} · запись ${source.row_index + 1}` : source.section_title;
  const [title, setTitle] = useState(what.slice(0, 200));
  const [brief, setBrief] = useState([source.text, source.link].filter(Boolean).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    delegationTargets(diaryId).then(d => { if (live) { setTargets(d.targets); setSelfId(d.self_user_id); } })
      .catch(e => { if (live) setError(e?.message ?? 'Не удалось загрузить сотрудников филиала.'); });
    return () => { live = false; };
  }, [diaryId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const t = targets.find(x => `${x.user_id}|${x.role_code}` === target);
    if (!t) { setError('Выберите, кому поручить.'); return; }
    if (!date) { setError('Укажите день.'); return; }
    if (title.trim().length < 3) { setError('Название задачи — не короче 3 символов.'); return; }
    setBusy(true); setError(null);
    try {
      await createDelegation(diaryId, { assignee_user_id: t.user_id, role_code: t.role_code, due_date: date,
        title: title.trim(), brief: brief.trim() || undefined, section_num: source.section_num,
        field_path: source.field_path ?? null, row_index: source.row_index ?? null, link: source.link || null });
      onCreated();
    } catch (err: any) { setError(err?.message ?? 'Не удалось поставить задачу.'); }
    finally { setBusy(false); }
  }

  return <div className="portal-modal-backdrop" onClick={onClose} role="presentation">
    <form className="portal-modal" onClick={e => e.stopPropagation()} onSubmit={submit}
      role="dialog" aria-modal="true" aria-label="Поручить задачу">
      <h3>Поручить задачу</h3>
      <p className="portal-muted">{what}</p>
      <label>Кому
        <select value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">Выберите сотрудника</option>
          {targets.map(t => <option key={`${t.user_id}|${t.role_code}`} value={`${t.user_id}|${t.role_code}`}>
            {t.user_id === selfId ? 'Себе' : t.full_name} · {t.role_name}</option>)}
        </select>
      </label>
      <label>На какой день
        <input type="date" value={date} min={moscowToday()} onChange={e => setDate(e.target.value)} />
      </label>
      <p className="portal-muted">В этот день задача появится у исполнителя в блоке «Задачи от руководителя».
        Срок — конец дня. Результат вернётся вам на проверку.</p>
      <label>Название задачи
        <input value={title} maxLength={200} onChange={e => setTitle(e.target.value)} />
      </label>
      <label>Что сделать
        <textarea value={brief} rows={4} maxLength={4000} onChange={e => setBrief(e.target.value)}
          placeholder="Ваш вывод и что нужно сделать" />
      </label>
      {error && <p role="alert">{error}</p>}
      <div className="portal-modal-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Отмена</button>
        <button className="btn" disabled={busy}>{busy ? 'Ставлю…' : 'Поручить'}</button>
      </div>
    </form>
  </div>;
}
