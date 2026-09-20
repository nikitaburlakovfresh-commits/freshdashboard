import { REPORT_SPECS, type ReportKind } from './shared/reportModel';
/**
 * Показатели, которые портал принимает из агрегатных отчётов QLIK. Состав
 * выводится из спецификаций отчётов, а не перечисляется вручную, поэтому
 * добавление столбца в спецификацию не требует правки допусков в коде.
 * Отчёты, требующие объявленного канала (воронка), в состав не входят.
 */
export const PUBLISHABLE_METRICS:string[]=[...new Set(
  (Object.keys(REPORT_SPECS) as ReportKind[])
    .filter(kind=>!REPORT_SPECS[kind].channelRequired)
    .flatMap(kind=>Object.keys(REPORT_SPECS[kind].columns)))];
