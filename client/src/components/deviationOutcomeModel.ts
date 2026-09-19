import type { Outcome } from '../api/metrics';
import { formatValue } from './metricThresholdModel';

/**
 * Подписи проверки результата задачи. Формулировки честные: закрытие задачи и
 * отсутствие новой публикации не выдаются за влияние на показатель.
 */
export const OUTCOME_LABELS:Record<Outcome,string>={
  NO_PUBLISHED_VALUE:'Нет опубликованного значения за период',
  NOT_REPUBLISHED:'Показатель не переопубликован — результат не подтверждён',
  STATUS_IMPROVED:'Статус улучшился после новой публикации',
  STATUS_WORSENED:'Статус ухудшился после новой публикации',
  STATUS_UNKNOWN:'Новое значение есть, но статус не определён',
  UNCHANGED:'Значение не изменилось',
  VALUE_IMPROVED:'Значение улучшилось, статус не изменился',
  VALUE_WORSENED:'Значение ухудшилось',
};

export const outcomeTone=(o:Outcome):'good'|'bad'|'neutral'=>
  o==='STATUS_IMPROVED'||o==='VALUE_IMPROVED'?'good'
    :o==='STATUS_WORSENED'||o==='VALUE_WORSENED'?'bad':'neutral';

/** Дельта показывается только когда есть новое опубликованное значение. */
export function deltaLabel(delta:number|null,unit:'COUNT'|'RUB'|null):string {
  if(delta===null)return '—';
  const sign=delta>0?'+':delta<0?'−':'';
  return `${sign}${formatValue(Math.abs(delta),unit??'COUNT')}`;
}
