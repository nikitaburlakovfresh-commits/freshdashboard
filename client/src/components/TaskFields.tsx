import React from 'react';
import type { FieldDef, WorkItem } from '../api/types';
import type { FieldDrafts } from '../domain/taskForm';
import { parseGroup } from '../domain/taskForm';
import type { DiaryDelegation, DiaryHint } from '../api/dailyLogs';
import type { DelegateSource } from './DelegateDialog';
import '../styles/task-fields.css';

/**
 * Пояснения к полям, которых нет в неизменяемом шаблоне. Решение владельца
 * 26.09.2026: у процента план/факт должно быть видно, что он на дату.
 */
const FIELD_NOTES: Record<string, string> = {
  t1_sales_pct: '% выполнения плана месяца на дату последнего отчёта: факт продаж с начала месяца ÷ план месяца.',
  t1_supply_pct: '% выполнения плана поставок на дату последнего отчёта: факт поставок с начала месяца ÷ план поставок за тот же период.',
};
const STATUS_RU: Record<string, string> = { ASSIGNED: 'назначена', IN_PROGRESS: 'в работе',
  SUBMITTED: 'на проверке у вас', COMPLETED: 'принята', CANCELLED: 'отменена', DRAFT: 'черновик' };
const isDone = (path: string) => /_done$/.test(path);
const fmt = (v: number, unit: string) => `${v.toLocaleString('ru-RU')} ${unit}`;

function Scalar({ def, value, onChange, disabled, label }: {
  def: FieldDef; value: string; onChange: (v: string) => void; disabled: boolean; label: string;
}) {
  const common = { 'aria-label': label, value, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(e.target.value) };
  if (def.type === 'text') return <textarea {...common} rows={3} maxLength={def.max_chars ?? 4000}/>;
  if (def.type === 'select') return <select {...common}><option value="">Выберите значение</option>{def.options?.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  return <input {...common} type={def.type === 'number' ? 'text' : def.type}
    inputMode={def.type === 'number' ? 'decimal' : undefined} maxLength={def.max_chars}/>;
}

/**
 * Разделы формы. Ежедневник РФ — это 95 полей 28 задач: плоским списком он
 * нечитаем, поэтому поля собираются по номеру задачи из схемы шаблона.
 * Поля без номера раздела остаются одной группой без заголовка — так ведут себя
 * обычные задачи с парой полей.
 */
interface Section { num: number|null; title: string; hints: string[]; optional: boolean; fields: FieldDef[] }
export function groupFieldsBySection(schema: FieldDef[]): Section[] {
  const out: Section[] = [];
  for (const def of schema) {
    const num = def.section_num ?? null;
    const last = out[out.length - 1];
    if (last && last.num === num) { last.fields.push(def); continue; }
    out.push({ num, title: def.section_title ?? '', hints: def.section_hints ?? [],
      optional: !!def.optional, fields: [def] });
  }
  return out;
}

export default function TaskFields({ item, drafts, editable, busy, onChange, onSave, hints = [], delegations = [], onDelegate }: {
  item: WorkItem; drafts: FieldDrafts; editable: boolean; busy: boolean;
  onChange: (path: string, value: string) => void; onSave: (path: string) => void;
  hints?: DiaryHint[]; delegations?: DiaryDelegation[]; onDelegate?: (source: DelegateSource) => void;
}) {
  const sectionOf = (path: string) => item.field_schema.find(f => f.field_path === path);
  const delegationList = (list: DiaryDelegation[]) => list.length > 0 && <ul className="task-delegations">
    {list.map(d => <li key={d.id}><a href={`/tasks/${d.id}`}>{d.assignee_name ?? 'Исполнитель'} · на {d.due_date.slice(8, 10)}.{d.due_date.slice(5, 7)}</a>
      {' '}· {STATUS_RU[d.status] ?? d.status}</li>)}</ul>;
  const sections = groupFieldsBySection(item.field_schema);
  const grouped = sections.some(s => s.num !== null);
  // У ежедневника поля сохраняются сами через 0,7 секунды после ввода, поэтому
  // 95 кнопок «Сохранить» здесь только мешают: остаётся признак состояния.
  const autosaves = !!item.daily_log;
  const renderField = (def: FieldDef) => {
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
              {onDelegate && <button type="button" className="task-field-secondary"
                onClick={() => onDelegate({ section_num: def.section_num ?? null, section_title: def.section_title || def.label,
                  field_path: def.field_path, row_index: index, link: row.link ?? null,
                  text: Object.entries(row).filter(([k, v]) => k !== 'link' && v).map(([, v]) => v).join('\n') })}>Поручить запись {index + 1}</button>}
              {editable && <button type="button" className="task-field-secondary" disabled={busy}
                onClick={() => onChange(def.field_path, JSON.stringify(rows.filter((_, i) => i !== index)))}>Удалить запись {index + 1}</button>}
              {delegationList(delegations.filter(d => d.source_ref?.field_path === def.field_path && d.source_ref?.row_index === index))}
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
        {FIELD_NOTES[def.field_path] && <p className="task-fields-note">{FIELD_NOTES[def.field_path]}</p>}
        {hints.filter(h => h.field_path === def.field_path).map(h => <div className="task-hint" key={h.field_path}>
          <p><strong>По данным портала: {fmt(h.value, h.unit)}</strong> · {h.source}, {h.period}</p>
          <p className="task-fields-note">{h.formula}{h.note ? `. ${h.note}` : ''}</p>
          {editable && value !== String(h.value) && <button type="button" className="task-field-secondary" disabled={busy}
            onClick={() => onChange(def.field_path, String(h.value))}>Подставить {fmt(h.value, h.unit)}</button>}
        </div>)}
        {def.type === 'number' && <p className="task-fields-note">Десятичный разделитель: точка.
          {def.min_value !== undefined && ` Минимум: ${def.min_value}.`}{def.max_value !== undefined && ` Максимум: ${def.max_value}.`} Отсутствие данных не равно нулю.</p>}
        {editable && <div className="task-field-footer">
          {!autosaves && <button type="button" disabled={busy || !dirty || rows === null && def.type === 'repeatable_group'} onClick={() => onSave(def.field_path)}>Сохранить: {def.label}</button>}
          <span aria-live="polite">{dirty ? busy ? 'Сохраняю…' : 'Не сохранено' : saved?.value != null ? 'Сохранено на сервере' : 'Не заполнено'}</span>
        </div>}
      </section>;
  };

  return <div className="task-fields">
    <p className="task-fields-note">{item.template_display_name} · Роль: {item.owner_role ?? 'не определена'}.
      {autosaves ? ' Поля сохраняются сами; сдача фиксирует все поля одной версией результата.'
        : ' Сохранение каждого поля отдельно; сдача фиксирует все поля одной версией результата.'}</p>
    {item.template_code.startsWith('rf_') && <p className="task-fields-notice">Предварительная форма РФ. Введённые значения не публикуются как KPI; формулы и бизнес-приёмка форм ещё не завершены.</p>}
    {!grouped ? item.field_schema.map(renderField) : sections.map((section, index) => {
      // Состояние раздела берётся из его же отметки выполнения, а не
      // высчитывается по заполненности: «не выполнено» — это осознанный ответ,
      // и подменять его пустотой нельзя.
      const mark = section.fields.find(f => /_done$/.test(f.field_path));
      const markValue = mark ? item.fields.find(f => f.field_path === mark.field_path)?.value ?? '' : '';
      const answered = section.fields.filter(f =>
        (item.fields.find(sf => sf.field_path === f.field_path)?.value ?? '') !== '').length;
      // Закрытие дня открыто сразу: с него начинают и им заканчивают.
      const closing = section.num === 99;
      return <details className="task-section" key={`${section.num}-${index}`} open={closing}
        data-state={markValue === 'Выполнено' ? 'done' : markValue === 'Не выполнено' ? 'skipped' : undefined}>
        <summary>
          <span className="task-section-num">{closing || section.num === null ? '' : section.num}</span>
          <span className="task-section-title">{section.title || 'Поля задачи'}
            {section.optional && <em className="task-section-optional"> · необязательно</em>}</span>
          <span className="task-section-state">
            {markValue ? markValue : answered ? `заполнено ${answered} из ${section.fields.length}` : 'не заполнено'}</span>
        </summary>
        {section.hints.length > 0 && <ul className="task-section-hints">
          {section.hints.map((hint, i) => <li key={i}>{hint}</li>)}</ul>}
        {section.fields.filter(f => !isDone(f.field_path)).map(renderField)}
        {onDelegate && section.num !== null && !closing && <div className="task-section-delegate">
          <button type="button" className="task-field-secondary"
            onClick={() => onDelegate({ section_num: section.num, section_title: section.title,
              text: section.fields.filter(f => f.type === 'text')
                .map(f => item.fields.find(x => x.field_path === f.field_path)?.value).filter(Boolean).join('\n') })}>
            Поручить задачу по разделу</button>
          {delegationList(delegations.filter(d => d.source_ref?.section_num === section.num && d.source_ref?.row_index == null))}
        </div>}
        {mark && (() => {
          // Отметка выполнения — галочка внизу раздела (решение владельца
          // 26.09.2026): сделал задачу — поставил галочку. Хранится то же
          // значение «Выполнено» / «Не выполнено», шаблон не меняется.
          const draftValue = editable ? drafts[mark.field_path]?.value ?? markValue : markValue;
          return <label className="task-done-check">
            <input type="checkbox" checked={draftValue === 'Выполнено'} disabled={!editable || busy}
              onChange={e => onChange(mark.field_path, e.target.checked ? 'Выполнено' : 'Не выполнено')} />
            <span>Выполнено</span>
            {editable && drafts[mark.field_path] && drafts[mark.field_path].value !== drafts[mark.field_path].baseValue
              && <small>{busy ? 'сохраняю…' : 'не сохранено'}</small>}
          </label>;
        })()}
      </details>;
    })}
  </div>;
}
