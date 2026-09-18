// Чистая логика отображения статусов и порогов: без сетевых вызовов,
// без пересчёта значений и без подстановки нулей.
export type Rag='RED'|'AMBER'|'GREEN'|'NONE';
export const RAG_LABELS:Record<Rag,string>={RED:'Красный',AMBER:'Жёлтый',GREEN:'Зелёный',NONE:'Нет данных'};
export const UNIT_LABELS:Record<string,string>={COUNT:'шт.',RUB:'руб.',PCT:'%'};
export interface RagCellView {
  rag:Rag; basis:'ABSOLUTE'|'PLAN_PERCENT'|null; basis_value:number|null; threshold_id:string|null;
}
export function formatValue(value:number,unit:string):string {
  return `${value.toLocaleString('ru-RU',{maximumFractionDigits:2})} ${UNIT_LABELS[unit]??unit}`;
}
export function ragReason(cell:RagCellView):string {
  if(!cell.threshold_id)return 'Порог не настроен — статус не рассчитывается.';
  if(cell.basis==='PLAN_PERCENT')
    return cell.basis_value===null
      ? 'Порог задан от плана, но план за период не опубликован.'
      : `Исполнение плана: ${cell.basis_value.toLocaleString('ru-RU',{maximumFractionDigits:1})} %.`;
  return 'Порог задан в абсолютном значении показателя.';
}
/** Форма ввода порога корректна только если зелёный строго лучше жёлтого. */
export function thresholdOrderValid(direction:'HIGHER_IS_BETTER'|'LOWER_IS_BETTER',
  green:number,amber:number):boolean {
  if(!Number.isFinite(green)||!Number.isFinite(amber))return false;
  return direction==='HIGHER_IS_BETTER'?green>amber:green<amber;
}
