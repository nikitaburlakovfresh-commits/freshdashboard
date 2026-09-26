import React from 'react';
import type { FieldDef, WorkItem } from '../api/types';
import type { FieldDrafts } from '../domain/taskForm';
import { parseGroup } from '../domain/taskForm';
import type { DiaryDelegation, DiaryHint, StalePrices, StaleCar, ColorRule, Rag, DelegationTarget, RoleRef } from '../api/dailyLogs';

/** Зона по правилу цвета; вне заданных зон — без цвета. */
export function ragOf(rule: ColorRule['rule'], raw: string | number | null | undefined): Rag | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (rule.options) return rule.options[String(raw)] ?? null;
  const v = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(v)) return null;
  for (const b of rule.bands ?? []) {
    if (b.gt !== undefined && !(v > b.gt)) continue;
    if (b.gte !== undefined && !(v >= b.gte)) continue;
    if (b.lt !== undefined && !(v < b.lt)) continue;
    if (b.lte !== undefined && !(v <= b.lte)) continue;
    return b.color;
  }
  return null;
}
const RAG_WORD: Record<Rag, string> = { GREEN: 'зелёная зона', AMBER: 'жёлтая зона', RED: 'красная зона' };
import type { DelegateSource } from './DelegateDialog';
import '../styles/task-fields.css';

/**
 * Пояснения к полям, которых нет в неизменяемом шаблоне. Решение владельца
 * 26.09.2026: у процента план/факт должно быть видно, что он на дату.
 */
const FIELD_NOTES: Record<string, string> = {
  t1_sales_pct: '% выполнения месячного плана на дату: факт продаж с начала месяца ÷ план месяца. Цвет — по темпу RunRate: 100 % и выше — идём на план.',
  t5_share_pct: 'Только выкуп: доля машин выкупа, которые стоят 45 дней и больше, от всех машин выкупа на складе.',
  t5_share_rub: 'Только выкуп, в процентах: себестоимость машин выкупа 45+ дней ÷ себестоимость всего выкупленного склада × 100.',
  t5_age: 'Выкуп + комиссия: весь склад старше 30 дней.',
  t5_market: 'Выкуп + комиссия: весь склад старше 30 дней.',
  t1_supply_pct: '% выполнения месячного плана поставок на дату: факт ÷ план месяца. Цвет — по темпу RunRate.',
};
const STATUS_RU: Record<string, string> = { ASSIGNED: 'назначена', IN_PROGRESS: 'в работе',
  SUBMITTED: 'на проверке у вас', COMPLETED: 'принята', CANCELLED: 'отменена', DRAFT: 'черновик' };
const isDone = (path: string) => /_done$/.test(path);
/** Задачи ответственным по итогам встречи: финальный срок и промежуточная точка. */
export interface MeetingTaskRequest {
  section_num: number; section_title: string; field_path: string; row_index: number | null;
  owners: string[]; goal: string; summary: string; due: string; next: string;
}
const fmt = (v: number, unit: string) => `${v.toLocaleString('ru-RU')} ${unit}`;

/** Список «Роль; Роль» ↔ массив. Точка с запятой — разделитель, в названиях ролей её нет. */
export const splitPick = (v: string) => v.split(/;|,/).map(x => x.trim()).filter(Boolean);
/** Раскрывающийся список с галочками: можно отметить несколько вариантов. */
function MultiPick({ value, groups, onChange, disabled, label }: {
  value: string; groups: { title: string; items: string[] }[]; onChange: (v: string) => void; disabled: boolean; label: string;
}) {
  const picked = splitPick(value);
  const known = new Set(groups.flatMap(g => g.items));
  const extra = picked.filter(x => !known.has(x));
  const toggle = (x: string) => onChange((picked.includes(x) ? picked.filter(y => y !== x) : [...picked, x]).join('; '));
  return <details className="task-multipick">
    <summary aria-label={label}>{picked.length ? picked.join(', ') : 'Выберите из списка'}</summary>
    {[...groups, ...(extra.length ? [{ title: 'Указано ранее', items: extra }] : [])].map(g => g.items.length > 0 &&
      <fieldset key={g.title} disabled={disabled}><legend>{g.title}</legend>
        {g.items.map(x => <label key={x} className="task-multipick-item">
          <input type="checkbox" checked={picked.includes(x)} onChange={() => toggle(x)} /> {x}</label>)}
      </fieldset>)}
  </details>;
}

// Роли управляющей компании FRESH — остальные роли справочника считаются ролями филиала.
const UC_ROLES = new Set(['REGIONAL_MANAGER', 'DIVISION_MANAGER', 'COMMERCIAL_DIRECTOR', 'FINANCE_HEAD', 'HR_UC', 'LEGAL_UC',
  'FRESH_ACADEMY', 'QUALITY_CONTROL', 'KSO_HEAD']);

function Scalar({ def, value, onChange, disabled, label }: {
  def: FieldDef; value: string; onChange: (v: string) => void; disabled: boolean; label: string;
}) {
  const common = { 'aria-label': label, value, disabled, onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => onChange(e.target.value) };
  if (def.type === 'text') return <textarea {...common} rows={3} maxLength={def.max_chars ?? 4000}/>;
  if (def.type === 'select') return <select {...common}><option value="">Выберите значение</option>{def.options?.map(o => <option key={o} value={o}>{o}</option>)}</select>;
  // Числа — только целые (решение владельца 26.09.2026): запятая превращается
  // в точку, лишние символы отбрасываются, дробь округляется при выходе из поля.
  if (def.type === 'number') return <input {...common} type="text" inputMode="decimal"
    onChange={e => onChange(e.target.value.replace(',', '.').replace(/[^\d.-]/g, ''))}
    onBlur={() => { const n = Number(value); if (value.trim() !== '' && Number.isFinite(n) && String(Math.round(n)) !== value) onChange(String(Math.round(n))); }}/>;
  return <input {...common} type={def.type} maxLength={def.max_chars}/>;
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

export default function TaskFields({ item, drafts, editable, busy, onChange, onSave, hints = [], delegations = [], onDelegate, stale, colorRules = [], people, onMeetingTasks }: {
  item: WorkItem; drafts: FieldDrafts; editable: boolean; busy: boolean;
  onChange: (path: string, value: string) => void; onSave: (path: string) => void;
  hints?: DiaryHint[]; delegations?: DiaryDelegation[]; onDelegate?: (source: DelegateSource, batch?: DelegateSource[]) => void;
  stale?: StalePrices | null; colorRules?: ColorRule[];
  people?: { targets: DelegationTarget[]; roles: RoleRef[] } | null;
  onMeetingTasks?: (m: MeetingTaskRequest) => void;
}) {
  const sectionOf = (path: string) => item.field_schema.find(f => f.field_path === path);
  const delegationList = (list: DiaryDelegation[]) => list.length > 0 && <ul className="task-delegations">
    {list.map(d => <li key={d.id}><a href={`/tasks/${d.id}`}>{d.assignee_name ?? 'Исполнитель'} · на {d.due_date.slice(8, 10)}.{d.due_date.slice(5, 7)}</a>
      {' '}· {STATUS_RU[d.status] ?? d.status}</li>)}</ul>;
  // Участники встречи — любые роли филиала и УК FRESH; ответственные — роли
  // филиала, в которых есть сотрудники, чтобы задача дошла до человека.
  const participantGroups = people ? [
    { title: 'Филиал', items: people.roles.filter(r => !UC_ROLES.has(r.code)).map(r => r.display_name) },
    { title: 'УК FRESH', items: people.roles.filter(r => UC_ROLES.has(r.code)).map(r => r.display_name) }] : [];
  const ownerGroups = people ? [{ title: 'Роли филиала с сотрудниками',
    items: [...new Set(people.targets.map(t => t.role_name))] }] : [];
  const pickFor = (path: string) => !people ? null : path === 'people' ? participantGroups
    : path === 'owner' || path === 't9_mowner' ? ownerGroups : null;
  const meetingButton = (m: Omit<MeetingTaskRequest, 'owners'> & { owners: string }, list: DiaryDelegation[]) => onMeetingTasks &&
    <div className="task-meeting-tasks">
      <button type="button" className="task-field-secondary" disabled={busy || !splitPick(m.owners).length || !m.due}
        title={!splitPick(m.owners).length ? 'Выберите ответственных' : !m.due ? 'Укажите срок исполнения' : ''}
        onClick={() => onMeetingTasks({ ...m, owners: splitPick(m.owners) })}>
        Поставить задачи ответственным</button>
      <p className="task-fields-note">Каждому сотруднику выбранных ролей: задача на срок исполнения и, если указана,
        отдельная задача на промежуточную точку. Появятся в их задачах и ежедневниках в эти дни.</p>
      {delegationList(list)}
    </div>;
  // Поля, скрытые настройкой ежедневника (061), не показываются и не считаются в «заполнено N из M».
  const hiddenByConfig = new Set(item.daily_log?.hidden_fields ?? []);
  const sections = groupFieldsBySection(item.field_schema.filter(f => !hiddenByConfig.has(f.field_path)));
  const grouped = sections.some(s => s.num !== null);
  // У ежедневника поля сохраняются сами через 0,7 секунды после ввода, поэтому
  // 95 кнопок «Сохранить» здесь только мешают: остаётся признак состояния.
  const autosaves = !!item.daily_log;
  const cur = (p: string) => (editable ? drafts[p]?.value : undefined) ?? item.fields.find(f => f.field_path === p)?.value ?? '';
  const renderField = (def: FieldDef) => {
      const saved = item.fields.find(f => f.field_path === def.field_path);
      const draft = drafts[def.field_path];
      const value = editable ? draft?.value ?? '' : saved?.value ?? '';
      const dirty = !!draft && draft.value !== draft.baseValue;
      const rows = def.type === 'repeatable_group' ? parseGroup(value) : null;
      // Цвет: по введённому значению или, для basis PORTAL, по расчёту портала.
      const colorRule = colorRules.find(r => r.field_path === def.field_path);
      const portalHint = hints.find(h => h.field_path === def.field_path);
      const rag = !colorRule ? null : colorRule.basis === 'PORTAL' ? ragOf(colorRule.rule, portalHint?.rag_value)
        : ragOf(colorRule.rule, value);
      return <section className="task-field" key={def.field_path} data-rag={rag ?? undefined}>
        <h3>{def.label}{def.required && <span className="task-required"> · обязательно</span>}
          {rag && <span className="task-rag" data-rag={rag}>{RAG_WORD[rag]}{colorRule?.basis === 'PORTAL' && portalHint?.rag_label ? ` · ${portalHint.rag_label}` : ''}</span>}</h3>
        {def.type === 'repeatable_group' ? <div>
          {rows === null ? <p role="alert">Сохранённый список имеет неподдерживаемый формат. Автоматическая замена отключена.</p> : <>
            {rows.map((row, index) => <fieldset key={index} disabled={busy} className="task-group-row">
              <legend>Запись {index + 1}</legend>
              {(def.child_fields ?? []).map(child => <label key={child.field_path}>
                <span>{child.label}{child.required ? ' · обязательно' : ''}</span>
                {editable && pickFor(child.field_path) ? <MultiPick value={row[child.field_path] ?? ''} disabled={busy}
                  groups={pickFor(child.field_path)!} label={`${def.label} · ${index + 1} · ${child.label}`}
                  onChange={v => onChange(def.field_path, JSON.stringify(rows.map((r, i) => i === index ? { ...r, [child.field_path]: v } : r)))}/>
                : editable ? <Scalar def={child} value={row[child.field_path] ?? ''} disabled={busy}
                  label={`${def.label} · ${index + 1} · ${child.label}`}
                  onChange={v => onChange(def.field_path, JSON.stringify(rows.map((r, i) => i === index ? { ...r, [child.field_path]: v } : r)))}/>
                  : <p className="task-field-value">{row[child.field_path] || 'Не заполнено'}</p>}
              </label>)}
              {onDelegate && <button type="button" className="task-field-secondary"
                onClick={() => onDelegate({ section_num: def.section_num ?? null, section_title: def.section_title || def.label,
                  field_path: def.field_path, row_index: index, link: row.link ?? null,
                  text: Object.entries(row).filter(([k, v]) => k !== 'link' && v).map(([, v]) => v).join('\n') })}>Поручить запись {index + 1}</button>}
              {(def.child_fields ?? []).some(c => c.field_path === 'owner') && meetingButton({ section_num: def.section_num ?? 0,
                section_title: def.section_title || def.label, field_path: def.field_path, row_index: index,
                owners: row.owner ?? '', goal: row.goal ?? '', summary: row.summary ?? '', due: row.due ?? '', next: row.next ?? '' },
                delegations.filter(d => d.source_ref?.field_path === def.field_path && d.source_ref?.row_index === index))}
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
        </div> : editable && pickFor(def.field_path) ? <MultiPick value={value} groups={pickFor(def.field_path)!} disabled={busy}
            label={def.label} onChange={v => onChange(def.field_path, v)}/>
          : editable ? <Scalar def={def} value={value} onChange={v => onChange(def.field_path, v)} disabled={busy} label={def.label}/>
          : <p className="task-field-value">{value || 'Не заполнено'}</p>}
        {def.field_path === 't9_mnext' && meetingButton({ section_num: def.section_num ?? 9, section_title: def.section_title || 'Встреча с КЦ',
          field_path: 't9_mowner', row_index: null, owners: cur('t9_mowner'), goal: cur('t9_mgoal'), summary: cur('t9_msummary'),
          due: cur('t9_mdue'), next: value }, delegations.filter(d => d.source_ref?.field_path === 't9_mowner'))}
        {FIELD_NOTES[def.field_path] && <p className="task-fields-note">{FIELD_NOTES[def.field_path]}</p>}
        {hints.filter(h => h.field_path === def.field_path).map(h => {
          // Значение портала в поле не ставится (решение владельца 26.09.2026):
          // человек вводит своё, а портал предупреждает, если этого мало для
          // плана или если число расходится с отчётом.
          const entered = value.trim() === '' ? null : Number(value.replace(',', '.'));
          const warn = entered === null || !Number.isFinite(entered) ? null
            : h.check === 'MIN' && h.min !== undefined && entered < h.min
              ? `Для достижения плана нужно не менее ${fmt(h.min, h.unit)} в день. Сейчас указано ${fmt(entered, h.unit)}.`
            : h.check === 'MATCH' && Math.abs(entered - h.value) > (h.tolerance ?? 0)
              ? `По данным портала ${fmt(h.value, h.unit)}, указано ${fmt(entered, h.unit)}. Проверьте значение.`
            : null;
          return <div className="task-hint" key={h.field_path} data-warn={warn ? '' : undefined}>
            <p><strong>По данным портала: {fmt(Math.round(h.value), h.unit)}</strong>
              {colorRule?.basis === 'INPUT' && ragOf(colorRule.rule, h.value) && <span className="task-rag" data-rag={ragOf(colorRule.rule, h.value)!}>
                {RAG_WORD[ragOf(colorRule.rule, h.value)!]}</span>}
              {h.check === 'MIN' && h.min !== undefined && <> · нужно не менее {fmt(h.min, h.unit)}</>} · {h.source}, {h.period}</p>
            <p className="task-fields-note">{h.formula}{h.note ? `. ${h.note}` : ''}</p>
            {warn && <p className="task-hint-warn" role="alert">{warn}</p>}
            {(() => {
              // «Подставить»: для плана на день — минимум, нужный для плана;
              // для остальных — значение портала. Сохраняется автосохранением.
              const target = h.check === 'MIN' && h.min !== undefined ? Math.ceil(h.min) : Math.round(h.value);
              return editable && def.type === 'number' && value !== String(target) &&
                <button type="button" className="task-field-secondary task-hint-apply" disabled={busy}
                  onClick={() => onChange(def.field_path, String(target))}>Подставить {fmt(target, h.unit)}</button>;
            })()}
          </div>;
        })}
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
        {(() => {
          // Поля после вопроса «Да/Нет» в том же разделе нужны только при «Да»
          // (решение владельца 26.09.2026: блок встречи с КЦ свёрнут при «Нет»
          // и раскрывается к заполнению при «Да»). Уже сохранённые значения при
          // «Нет» не стираются — поля только скрываются.
          const hidden = new Set<string>(item.daily_log?.hidden_fields ?? []);
          let gate: string | null = null;
          for (const f of section.fields) {
            if (f.type === 'select') {
              gate = f.options?.includes('Да') && f.options?.includes('Нет') ? f.field_path : null;
              continue;
            }
            if (!gate) continue;
            const answer = editable ? drafts[gate]?.value ?? '' : item.fields.find(x => x.field_path === gate)?.value ?? '';
            if (answer !== 'Да') hidden.add(f.field_path);
          }
          return section.fields.filter(f => !isDone(f.field_path) && !hidden.has(f.field_path)).map(renderField);
        })()}
        {stale && section.fields.some(f => f.field_path === 't5_rows') && (() => {
          // Машины без переоценки больше 10 дней из реестра VIN — поручаются по
          // одной или все сразу, по отдельной задаче на каждую.
          const car = (x: StaleCar) => [x.make, x.model, x.production_year].filter(Boolean).join(' ') || x.vin;
          const src = (x: StaleCar): DelegateSource => ({ section_num: section.num, section_title: section.title,
            field_path: 'stale_price', vin: x.vin, label: `${car(x)} · ${x.vin}`,
            text: `${car(x)}, VIN ${x.vin}. Без переоценки ${x.days_without_reprice} дн., на складе ${x.days_on_stock ?? '—'} дн., ${x.supply_type ?? 'тип не указан'}.`
              + (x.sale_price_rub && x.market_price_rub ? ` Цена ${x.sale_price_rub.toLocaleString('ru-RU')} ₽, рынок ${x.market_price_rub.toLocaleString('ru-RU')} ₽.` : '') });
          return <details className="task-stale">
            <summary>Авто без переоценки более {stale.threshold_days} дней: {stale.rows.length}
              {stale.observed_on && ` · реестр VIN на ${stale.observed_on.slice(8, 10)}.${stale.observed_on.slice(5, 7)}`}</summary>
            {stale.rows.length === 0 ? <p className="task-fields-note">Таких машин нет.</p> : <>
              {onDelegate && <button type="button" className="task-field-secondary"
                onClick={() => onDelegate({ section_num: section.num, section_title: section.title }, stale.rows.map(src))}>
                Поручить все {stale.rows.length}</button>}
              <ul>{stale.rows.map(x => <li key={x.vin}>
                <div><strong>{car(x)}</strong> · {x.vin}</div>
                <div className="task-fields-note">Без переоценки {x.days_without_reprice} дн. · на складе {x.days_on_stock ?? '—'} дн. · {x.supply_type ?? 'тип не указан'}
                  {x.sale_price_rub && x.market_price_rub ? ` · цена ${Math.round(x.sale_price_rub / x.market_price_rub * 1000) / 10} % к рынку` : ''}</div>
                {onDelegate && <button type="button" className="task-field-secondary" onClick={() => onDelegate(src(x))}>Поручить</button>}
                {delegationList(delegations.filter(d => d.source_ref?.vin === x.vin))}
              </li>)}</ul>
            </>}
          </details>;
        })()}
        {onDelegate && closing && <div className="task-section-delegate">
          <button type="button" className="task-field-secondary"
            onClick={() => onDelegate({ section_num: 99, section_title: 'Закрытие дня', self: true })}>
            Поставить задачу себе на будущий день</button>
          <p className="task-fields-note">Задача появится в вашем ежедневнике в выбранный день.</p>
          {delegationList(delegations.filter(d => d.source_ref?.section_num === 99))}
        </div>}
        {onDelegate && section.num !== null && !closing && <div className="task-section-delegate">
          <button type="button" className="task-field-secondary"
            onClick={() => onDelegate({ section_num: section.num, section_title: section.title,
              text: section.fields.filter(f => f.type === 'text')
                .map(f => item.fields.find(x => x.field_path === f.field_path)?.value).filter(Boolean).join('\n') })}>
            Поручить задачу по разделу</button>
          {delegationList(delegations.filter(d => d.source_ref?.section_num === section.num && d.source_ref?.row_index == null && !d.source_ref?.vin && d.source_ref?.field_path !== 't9_mowner'))}
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
