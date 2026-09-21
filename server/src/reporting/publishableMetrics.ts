import { REPORT_SPECS, FUNNEL_CHANNELS, FUNNEL_CHANNEL_KEYS, type ReportKind } from './shared/reportModel';
/**
 * Показатели, которые портал принимает из агрегатных отчётов QLIK. Состав
 * выводится из спецификаций отчётов, а не перечисляется вручную, поэтому
 * добавление столбца в спецификацию не требует правки допусков в коде.
 *
 * Отчёт с обязательным каналом (воронка) даёт по одному столбцу источника
 * столько показателей, сколько каналов: обращения и звонки пишутся в разные
 * показатели, потому что заголовки их выгрузок совпадают и складывать их в
 * один показатель нельзя.
 */
export const PUBLISHABLE_METRICS: string[] = [...new Set(
  (Object.keys(REPORT_SPECS) as ReportKind[]).flatMap(kind => {
    const columns = Object.keys(REPORT_SPECS[kind].columns);
    if (!REPORT_SPECS[kind].channelRequired) return columns;
    return FUNNEL_CHANNEL_KEYS.flatMap(channel => {
      const map = FUNNEL_CHANNELS[channel].metrics as Record<string, string>;
      return columns.map(c => map[c] ?? c);
    });
  }))];
