import type { ReviewView, DraftPeriod, ReviewCommand, ReviewRow } from '../api/reportReview';
import { validatePeriod, type MetricKey } from '../imports/reportModel';

export const draftPeriodLabel=(p:DraftPeriod|null)=>p?`${p.start} — ${p.end} · предложенный период`:'Период продаж не подтверждён';
export const mappingLabel=(row:ReviewRow)=>({UNRESOLVED:'Нет привязки',PROPOSED:'Привязка предложена',STALE:'Привязка устарела'}[row.status]);
export const metricUnit=(key:MetricKey)=>['sales','stock','aged','plan'].includes(key)?'шт.':'руб.';
export const reportNumber=(n:number|null|undefined)=>n==null?'Нет данных':n.toLocaleString('ru-RU',{maximumFractionDigits:2});
export function reviewCommand(view:ReviewView,period:DraftPeriod|null,selected:Record<string,string>,reason:string):ReviewCommand {
  if(reason.trim().length<10 || reason.length>500)throw new Error('Укажите основание изменения черновика: 10–500 символов.');
  if(period) {
    validatePeriod(period);
    if(period.basis.trim().length<10 || period.basis.length>500)throw new Error('Укажите основание предложения периода: 10–500 символов.');
  }
  const edits=view.rows.filter(r=>(selected[r.item_id]||null)!==r.org_unit_id)
    .map(r=>({item_id:r.item_id,org_unit_id:selected[r.item_id]||null}));
  if(edits.length>100)throw new Error('Сохраните не более 100 изменений привязки за один раз.');
  return {expected_version:view.current.version,preview_hash:view.preview_hash,period,edits,reason:reason.trim()};
}
