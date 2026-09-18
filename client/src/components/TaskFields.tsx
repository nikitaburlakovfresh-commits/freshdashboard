import React from 'react';
import type { FieldDef, WorkItem } from '../api/types';
import type { FieldDrafts } from '../domain/taskForm';
import { parseGroup } from '../domain/taskForm';
import '../styles/task-fields.css';

function Scalar({ def, value, onChange, disabled, label }: {
  def: FieldDef; value: string; onChange: (v: string) => void; disabled: boolean; label: string;
}) {
  const common = { 'aria-label': label, value, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(e.target.value) };
  if (def.type === 'text') return <textarea {...common} rows={3} maxLength={def.max_chars ?? 4000}/>;
  if (def.type === 'select') return <select {...common}><option value="">Выберите значение</option>{def.options?.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  return <input {...common} type={def.type === 'number' ? 'text' : def.type}
    inputMode={def.type === 'number' ? 'decimal' : undefined} maxLength={def.max_chars}/>;
}

export default function TaskFields({ item, drafts, editable, busy, onChange, onSave }: {
  item: WorkItem; drafts: FieldDrafts; editable: boolean; busy: boolean;
  onChange: (path: string, value: string) => void; onSave: (path: string) => void;
}) {
  return <div className="task-fields">
    <p className="task-fields-note">{item.template_display_name} · Роль: {item.owner_role ?? 'не определена'}.
      Сохранение каждого поля отдельно; сдача фиксирует все поля одной версией результата.</p>
    {item.template_code.startsWith('rf_') && <p className="task-fields-notice">Предварительная форма РФ. Введённые значения не публикуются как KPI; формулы и бизнес-приёмка форм ещё не завершены.</p>}
    {item.field_schema.map(def => {
      const saved = item.fields.find(f => f.field_path === def.field_path);
      const draft = drafts[def.field_path];
      const value = editable ? draft?.value ?? '' : saved?.value ?? '';
      const dirty = !!draft && draft.value !== draft.baseValue;
      const rows = def.type === 'repeatable_group' ? parseGroup(value) : null;
      return <section className="task-field" key={def.field_path}>
        <h3>{def.label}{def.required && <span className="task-required"> · обязательно</span>}</h3>
        {def.type === 'repeatable_group' ? <div>
          {rows === null ? <p role="alert">Сохранённый список имеет неподдерживаемый формат. Автоматическая замена отключена.</p> : <>
            {rows.map((row, index) => <fieldset key={index} disabled={busy} className="task-group-row">
              <legend>Запись {index + 1}</legend>
              {(def.child_fields ?? []).map(child => <label key={child.field_path}>
                <span>{child.label}{child.required ? ' · обязательно' : ''}</span>
                {editable ? <Scalar def={child} value={row[child.field_path] ?? ''} disabled={busy}
                  label={`${def.label} · ${index + 1} · ${child.label}`}
                  onChange={v => onChange(def.field_path, JSON.stringify(rows.map((r, i) => i === index ? { ...r, [child.field_path]: v } : r)))}/>
                  : <p className="task-field-value">{row[child.field_path] || 'Не заполнено'}</p>}
              </label>)}
              {editable && <button type="button" className="task-field-secondary" disabled={busy}
                onClick={() => onChange(def.field_path, JSON.stringify(rows.filter((_, i) => i !== index)))}>Удалить запись {index + 1}</button>}
            </fieldset>)}
            {!rows.length && <p className="task-fields-note">Записей нет.</p>}
            {editable && <button type="button" disabled={busy || rows.length >= (def.max_items ?? 100)} className="task-field-secondary"
              onClick={() => onChange(def.field_path, JSON.stringify([...rows, {}]))}>Добавить запись: {def.label}</button>}
            {editable && !value && (def.min_items ?? 0) === 0 && <button type="button" disabled={busy} className="task-field-secondary"
              onClick={() => onChange(def.field_path, '[]')}>Подтвердить отсутствие записей</button>}
            <p className="task-fields-note">Записей: {rows.length}. Минимум: {def.min_items ?? 0}, максимум: {def.max_items ?? 100}.</p>
          </>}
        </div> : editable ? <Scalar def={def} value={value} onChange={v => onChange(def.field_path, v)} disabled={busy} label={def.label}/>
          : <p className="task-field-value">{value || 'Не заполнено'}</p>}
        {def.type === 'number' && <p className="task-fields-note">Десятичный разделитель: точка.
          {def.min_value !== undefined && ` Минимум: ${def.min_value}.`}{def.max_value !== undefined && ` Максимум: ${def.max_value}.`} Отсутствие данных не равно нулю.</p>}
        {editable && <div className="task-field-footer">
          <button type="button" disabled={busy || !dirty || rows === null && def.type === 'repeatable_group'} onClick={() => onSave(def.field_path)}>Сохранить: {def.label}</button>
          <span aria-live="polite">{dirty ? 'Не сохранено' : saved?.value !== null ? 'Сохранено на сервере' : 'Не заполнено'}</span>
        </div>}
      </section>;
    })}
  </div>;
}
