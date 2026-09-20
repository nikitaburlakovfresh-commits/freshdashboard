import { type StagingBatch, type StagingPeriod } from '../api/reportBatches';
import { validatePeriod, type ImportPeriod } from '../imports/reportModel';

export function periodMetadata(confirmed:boolean,period:ImportPeriod,confirmation:string):StagingPeriod {
  if(!confirmed)return {state:'REQUIRES_CONFIRMATION'};
  validatePeriod(period);
  if(confirmation.trim().length<10 || confirmation.length>500) throw new Error('Укажите основание подтверждения периода (10–500 символов).');
  return {state:'CONFIRMED',...period,confirmation:confirmation.trim()};
}
export function checkStagingFiles(files:{name:string;size:number}[]) {
  if(!files.length || files.length>10) throw new Error('Выберите от одного до десяти агрегатных XLSX одного пакета.');
  if(files.some(f=>!f.size || f.size>8*1024*1024 || !/\.xlsx$/i.test(f.name))) throw new Error('Допустимы XLSX до 8 МиБ каждый.');
}
export const stagingStatus=(b:Pick<StagingBatch,'status'|'storage_state'>)=>
  b.storage_state==='WRITING'?'Загрузка не завершена':({QUARANTINE:'В карантине',NEEDS_MAPPING:'Нужна привязка филиалов',REJECTED:'Проверка не пройдена'}[b.status]);
export const periodLabel=(p:StagingPeriod)=>p.state==='CONFIRMED'?`${p.start} — ${p.end}`:'Период не подтверждён';
export const blockerLabel=(code:string)=>({
  NEEDS_MAPPING:'Названия филиалов не сопоставлены со стабильными OrgUnit UUID.',
  PERIOD_REQUIRES_CONFIRMATION:'Период продаж не подтверждён; дата склада его не заменяет.',
  PLAN_PERIOD_UNCONFIRMED:'Период плана не подтверждён.',
  MALWARE_SCAN_REQUIRED:'Антивирусная проверка не подключена. Исходники остаются в карантине; скачивание закрыто.',
  CANONICAL_COMMIT_NOT_IMPLEMENTED:'Публикация в рабочие показатели не входит в этот этап.',
  INVALID_SOURCE:'Формат или структура файла не прошли проверку.',
}[code] ?? code);
