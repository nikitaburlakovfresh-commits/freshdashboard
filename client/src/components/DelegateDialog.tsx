import React, { useEffect, useState } from 'react';
import { createDelegation, delegationTargets, moscowToday, type DelegationTarget } from '../api/dailyLogs';

/** Откуда поручение: раздел ежедневника и, если есть, конкретная запись списка. */
export interface DelegateSource {
  section_num: number | null; section_title: string;
  field_path?: string | null; row_index?: number | null; link?: string | null; text?: string;
  vin?: string | null; label?: string;
  /** Задача себе: исполнитель — сам автор, день по умолчанию — завтра. */
  self?: boolean;
}

/**
 * Поручение из ежедневника: кому, на какой день и что сделать.
 *
 * Каждая машина или звонок поручается отдельно — разным людям или никому
 * (решение владельца 26.09.2026). Поручение себе на будущий день — тот же путь:
 * в выбранный день задача появится в собственном ежедневнике.
 */
export default function DelegateDialog({ diaryId, source, batch, onClose, onCreated }: {
  diaryId: string; source: DelegateSource; batch?: DelegateSource[]; onClose: () => void; onCreated: () => void;
}) {
  const [targets, setTargets] = useState<DelegationTarget[]>([]);
  const [selfId, setSelfId] = useState('');
  const [target, setTarget] = useState('');
  const tomorrow = (() => { const d = new Date(moscowToday() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const [date, setDate] = useState(source.self ? tomorrow : moscowToday());
  const what = batch ? `${source.section_title} · ${batch.length} машин, по задаче на каждую`
    : source.label ? `${source.section_title} · ${source.label}` : source.row_index != null ? `${source.section_title} · запись ${source.row_index + 1}` : source.section_title;
  const [title, setTitle] = useState(source.self ? '' : (batch || source.label ? 'Переоценка' : what).slice(0, 200));
  const [brief, setBrief] = useState(batch ? 'Пересмотреть цену: машина без переоценки больше 10 дней.' : [source.text, source.link].filter(Boolean).join('\n'));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    delegationTargets(diaryId).then(d => { if (live) { setTargets(d.targets); setSelfId(d.self_user_id);
      if (source.self) { const me = d.targets.find(t => t.user_id === d.self_user_id); if (me) setTarget(`${me.user_id}|${me.role_code}`); } } })
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
      // Пакет — по отдельной задаче на каждую машину: каждую можно принять
      // или вернуть отдельно.
      for (const src of batch ?? [source]) {
        const t2 = src.label ? `${title.trim()} · ${src.label}`.slice(0, 200) : title.trim();
        const b2 = batch ? [brief.trim(), src.text].filter(Boolean).join('\n') : brief.trim();
        await createDelegation(diaryId, { assignee_user_id: t.user_id, role_code: t.role_code, due_date: date,
          title: t2, brief: b2 || undefined, section_num: src.section_num,
          field_path: src.field_path ?? null, row_index: src.row_index ?? null, link: src.link || null, vin: src.vin ?? null });
      }
      onCreated();
    } catch (err: any) { setError(err?.message ?? 'Не удалось поставить задачу.'); }
    finally { setBusy(false); }
  }

  return <div className="portal-modal-backdrop" onClick={onClose} role="presentation">
    <form className="portal-modal" onClick={e => e.stopPropagation()} onSubmit={submit}
      role="dialog" aria-modal="true" aria-label="Поручить задачу">
      <h3>{source.self ? 'Задача себе на будущий день' : 'Поручить задачу'}</h3>
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
        <button className="btn" disabled={busy}>{busy ? 'Ставлю…' : source.self ? 'Поставить себе' : 'Поручить'}</button>
      </div>
    </form>
  </div>;
}
