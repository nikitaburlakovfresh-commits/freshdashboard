import React, { useState } from 'react';
import { createWorkItem } from '../api/endpoints';
import type { Grant } from '../api/types';
import { orgUnitLabel } from '../constants/orgUnits';

export default function CreateTaskModal({
  grants,
  onClose,
  onCreated,
}: {
  grants: Grant[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const rmOrgs = grants.filter((g) => g.role === 'REGIONAL_MANAGER');
  const [orgUnitId, setOrgUnitId] = useState(rmOrgs[0]?.org_unit_id ?? '');
  const [title, setTitle] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!orgUnitId) {
      setError('Нет доступного филиала для постановки задач.');
      return;
    }
    if (!title.trim() || Array.from(title).length > 200) {
      setError('Укажите название задачи.');
      return;
    }
    if (!dueAt) {
      setError('Укажите срок выполнения.');
      return;
    }
    setSubmitting(true);
    try {
      const dueIso = new Date(`${dueAt}Z`).toISOString().replace(/\.\d{3}Z$/, 'Z');
      await createWorkItem({ org_unit_id: orgUnitId, title, due_at: dueIso });
      onCreated();
      onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Не удалось создать задачу.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 40, padding: 16 }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
        role="dialog"
        aria-label="Новая задача"
        aria-modal="true"
        style={{ width: 420, maxWidth: '100%', maxHeight:'90vh', overflowY:'auto', background: 'var(--fresh-surface)', border: '1px solid var(--fresh-border)', borderRadius: 16, padding: 28 }}
      >
        <h2 style={{ margin: 0, marginBottom: 20, fontSize: 24, color: 'var(--fresh-dark)' }}>Новая задача</h2>

        <label htmlFor="task-org" style={labelStyle}>Филиал · контур задач</label>
        <select id="task-org" value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} style={inputStyle}>
          {rmOrgs.map((g) => (
            <option key={g.org_unit_id} value={g.org_unit_id}>
              {orgUnitLabel(g.org_unit_id)}
            </option>
          ))}
        </select>

        <label htmlFor="task-title" style={labelStyle}>Название</label>
        <input id="task-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} style={inputStyle} placeholder="Например: Проверить остатки на складе" />

        <label htmlFor="task-due" style={labelStyle}>Срок выполнения (UTC)</label>
        <input id="task-due" type="datetime-local" value={dueAt} onChange={(e) => setDueAt(e.target.value)} style={inputStyle} />

        {error && <div role="alert" style={{ color: 'var(--fresh-danger)', fontSize: 13, marginTop: 10 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 10, marginTop: 22 }}>
          <button type="button" onClick={onClose} style={secondaryBtn}>
            Отмена
          </button>
          <button type="submit" disabled={submitting} style={primaryBtn(submitting)}>
            {submitting ? 'Создание…' : 'Создать'}
          </button>
        </div>
      </form>
    </div>
  );
}

const labelStyle: React.CSSProperties = { display: 'block', fontSize: 13, fontWeight: 500, marginTop: 14, marginBottom: 6, color: 'var(--fresh-dark)' };
const inputStyle: React.CSSProperties = { width: '100%', minHeight: 44, padding: '9px 12px', borderRadius: 8, border: '1px solid var(--fresh-border)', fontSize: 14 };
const secondaryBtn: React.CSSProperties = { flex: 1, minHeight: 44, padding: '10px', borderRadius: 16, border: '1px solid var(--fresh-border)', background: 'var(--fresh-surface)', color: 'var(--fresh-dark)', fontWeight: 500, cursor: 'pointer' };
function primaryBtn(disabled: boolean): React.CSSProperties {
  return { flex: 1, minHeight: 44, padding: '10px', borderRadius: 16, border: 'none', background: '#003DFF', color: '#fff', fontWeight: 500, cursor: disabled ? 'default' : 'pointer' };
}
