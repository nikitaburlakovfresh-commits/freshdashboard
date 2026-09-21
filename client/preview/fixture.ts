// Данные предпросмотра — настоящий ответ портала по филиалу Дагомыс за
// 01.09–20.09 и настоящий реестр на срез 19.09, снятые с базы прода.
// Ничего не досчитано и не придумано.
import card from './card.json';
import stock from './stock.json';
export type { BranchCardData, VehicleStockRow } from '../src/api/metrics.ts';
export const readBranchCard=async()=>card as any;
export const readVehicleStock=async()=>({mode:'PUBLISHED_DETAIL',observed_on:'2026-09-19',
  items:stock as any[],aggregation:'NONE'}) as any;
