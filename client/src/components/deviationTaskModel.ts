import type { MetricCell } from '../api/metrics';
import { formatValue,RAG_LABELS } from './metricThresholdModel';

/** Задача ставится только по отклонению: красный или жёлтый статус. */
export const canOpenTask=(c:Pick<MetricCell,'rag'|'threshold_id'|'deviation_task'>):boolean=>
  (c.rag==='RED'||c.rag==='AMBER')&&!!c.threshold_id&&!c.deviation_task;

export const defaultTitle=(branch:string,c:Pick<MetricCell,'metric_name'|'value'|'unit'|'rag'>):string=>
  `${branch}: ${c.metric_name} — ${RAG_LABELS[c.rag].toLowerCase()} (${formatValue(c.value,c.unit)})`.slice(0,200);

/** Локальная дата (Europe/Moscow) → срок в UTC RFC3339, как требует сервер. */
export function dueIso(localDate:string,hour='18:00'):string|null {
  if(!/^\d{4}-\d\d-\d\d$/.test(localDate))return null;
  const t=Date.parse(`${localDate}T${hour}:00+03:00`);
  if(!Number.isFinite(t))return null;
  // Отсекаем несуществующие даты (31.02): иначе браузер молча сдвинет срок.
  const utcNoon=Date.parse(`${localDate}T12:00:00Z`);
  if(!Number.isFinite(utcNoon)||new Date(utcNoon).toISOString().slice(0,10)!==localDate)return null;
  return new Date(t).toISOString().replace(/\.\d{3}Z$/,'Z');
}

export interface DeviationDraft { template_code:string; title:string; due_date:string; reason:string }

/** Проверки повторяют серверные, чтобы не отправлять заведомо отклонённую команду. */
export function draftError(d:DeviationDraft):string|null {
  if(!d.template_code)return 'Выберите шаблон задачи.';
  const title=d.title.trim();
  if(!title)return 'Укажите название задачи.';
  if(Array.from(d.title).length>200)return 'Название задачи не длиннее 200 символов.';
  if(!dueIso(d.due_date))return 'Укажите срок выполнения задачи.';
  const reason=d.reason.trim();
  if(reason.length<16)return 'Основание должно содержать не менее 16 символов.';
  if(reason.length>500)return 'Основание не длиннее 500 символов.';
  return null;
}
