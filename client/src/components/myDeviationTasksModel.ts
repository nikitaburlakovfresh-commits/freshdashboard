import type { DueState,MyDeviationTask } from '../api/metrics';
import { formatValue } from './metricThresholdModel';

/** Подписи срока: считаются по факту срока и статуса, без домыслов. */
export const DUE_LABELS:Record<DueState,string>={
  OVERDUE:'Срок истёк',
  DUE_SOON:'Срок близко',
  ON_TRACK:'В срок',
  CLOSED:'Закрыта',
};

export const dueTone=(s:DueState):'bad'|'warn'|'neutral'=>
  s==='OVERDUE'?'bad':s==='DUE_SOON'?'warn':'neutral';

/**
 * Основание задачи. Цифры показываются только когда сервер их раскрыл: у
 * ответственного без отдельного допуска к показателю значения скрыты, и это
 * не выдаётся за отсутствие отклонения.
 */
export function basisLabel(t:Pick<MyDeviationTask,'values_visible'|'observed_value'|'basis_value'|'unit'|'basis'>):string {
  if(!t.values_visible||t.observed_value===null||t.basis_value===null)
    return 'Значения скрыты: нет допуска к показателю';
  return `${formatValue(t.observed_value,t.unit??'COUNT')} против ${formatValue(t.basis_value,t.unit??'COUNT')}`;
}
