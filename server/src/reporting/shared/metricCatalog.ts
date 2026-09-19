// Единый каталог агрегатных показателей QLIK-выгрузок.
// Каждый показатель обязан объявить единицу измерения, тип значения и то,
// складывается ли он по филиалам. Неаддитивные показатели (доли, удельные,
// сроки, проценты) НЕ проверяются сверкой «сумма строк = итог отчёта»:
// такая сверка для них математически неверна и раньше блокировала бы приём.
// Отсутствие значения остаётся пропуском и никогда не превращается в ноль.

export type MetricUnit = 'COUNT' | 'RUB' | 'PCT' | 'DAYS' | 'RUB_PER_UNIT';

export interface MetricSpec {
  /** Человеческое название для интерфейса проверки и публикации. */
  name: string;
  unit: MetricUnit;
  /** Значение — неотрицательное целое количество. */
  count: boolean;
  /** Складывается по филиалам до итога отчёта. */
  additive: boolean;
}

export const METRICS = {
  // --- ядро, поддерживалось до расширения ---
  sales: { name: 'Продажи автомобилей', unit: 'COUNT', count: true, additive: true },
  margin: { name: 'Маржа + КСО', unit: 'RUB', count: false, additive: true },
  stock: { name: 'Автомобили на складе', unit: 'COUNT', count: true, additive: true },
  aged: { name: 'Склад 45+', unit: 'COUNT', count: true, additive: true },
  plan: { name: 'План продаж', unit: 'COUNT', count: true, additive: true },
  revenue: { name: 'Выручка', unit: 'RUB', count: false, additive: true },
  baseMargin: { name: 'Маржа без КСО', unit: 'RUB', count: false, additive: true },
  kso: { name: 'КСО', unit: 'RUB', count: false, additive: true },

  // --- склад, оборачиваемость, ПТЗ, рентабельность (сводка) ---
  stockStart: { name: 'Склад на начало периода, шт.', unit: 'COUNT', count: true, additive: true },
  stockStartCost: { name: 'Склад на начало периода, руб.', unit: 'RUB', count: false, additive: true },
  stockCost: { name: 'Склад себестоимость, руб.', unit: 'RUB', count: false, additive: true },
  stockUnitCost: { name: 'Склад удельная себестоимость, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  outflow: { name: 'Отток, шт.', unit: 'COUNT', count: true, additive: true },
  turnoverBuyout: { name: 'Оборачиваемость для мотивации, выкуп', unit: 'PCT', count: false, additive: false },
  turnoverCommission: { name: 'Оборачиваемость для мотивации, комиссия', unit: 'PCT', count: false, additive: false },
  purchasePrice: { name: 'Цена в закупке, руб.', unit: 'RUB', count: false, additive: true },
  unitMargin: { name: 'Факт удельная маржа, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  unitKso: { name: 'Факт удельное КСО, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  unitMarginKso: { name: 'Факт удельная маржа + КСО, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  ptzCost: { name: 'Стоимость ПТЗ, руб.', unit: 'RUB', count: false, additive: true },
  ptzCount: { name: 'Количество ПТЗ', unit: 'COUNT', count: true, additive: true },
  royaltyKso: { name: 'Сумма к роялти по КСО', unit: 'RUB', count: false, additive: true },
  mdProfitability: { name: 'Рентабельность МД по всем видам сделок', unit: 'PCT', count: false, additive: false },
  saleDays: { name: 'Срок продажи, дней', unit: 'DAYS', count: false, additive: false },
  stockDays: { name: 'Срок стоянки на складе, дней', unit: 'DAYS', count: false, additive: false },
  agedCost: { name: 'Склад 45+ себестоимость, руб.', unit: 'RUB', count: false, additive: true },
  agedShare: { name: 'Доля 45+ средний возраст', unit: 'PCT', count: false, additive: false },

  // --- БДР: план, прогноз, составляющие маржи ---
  forecast: { name: 'Прогноз продаж, шт.', unit: 'COUNT', count: false, additive: true },
  planKso: { name: 'План КСО, руб.', unit: 'RUB', count: false, additive: true },
  planIron: { name: 'План железо, руб.', unit: 'RUB', count: false, additive: true },
  factIron: { name: 'Факт железо, руб.', unit: 'RUB', count: false, additive: true },
  planMargin: { name: 'План маржа, руб.', unit: 'RUB', count: false, additive: true },
  forecastMargin: { name: 'Прогноз маржа, руб.', unit: 'RUB', count: false, additive: true },
  planUnitKso: { name: 'План удельное КСО, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  planUnitMargin: { name: 'План удельная маржа, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },

  // --- поставки ---
  suppliesPlan: { name: 'План поставок, шт.', unit: 'COUNT', count: true, additive: true },
  suppliesFact: { name: 'Факт поставок, шт.', unit: 'COUNT', count: true, additive: true },
  suppliesPlanCost: { name: 'План себестоимости поставок, руб.', unit: 'RUB', count: false, additive: true },
  suppliesFactCost: { name: 'Факт себестоимости поставок, руб.', unit: 'RUB', count: false, additive: true },
  suppliesForecast: { name: 'Прогноз поставок, шт.', unit: 'COUNT', count: false, additive: true },
  suppliesForecastCost: { name: 'Прогноз поставок, руб.', unit: 'RUB', count: false, additive: true },

  // --- финансовые услуги и кредиты ---
  creditsPlan: { name: 'План количества кредитов', unit: 'COUNT', count: true, additive: true },
  creditsGoogle: { name: 'Факт кредитов (Google), шт.', unit: 'COUNT', count: true, additive: true },
  creditsCrm: { name: 'Факт кредитов (CRM), шт.', unit: 'COUNT', count: true, additive: true },
  brokerPlan: { name: 'План брокерских сделок', unit: 'COUNT', count: true, additive: true },
  brokerFact: { name: 'Факт брокерских сделок', unit: 'COUNT', count: true, additive: true },
  creditSharePlan: { name: 'План доли кредита', unit: 'PCT', count: false, additive: false },
  creditShareFact: { name: 'Факт доли кредита', unit: 'PCT', count: false, additive: false },
  creditKsoPlan: { name: 'План КСО по кредитам, руб.', unit: 'RUB', count: false, additive: true },
  creditKsoFact: { name: 'Факт КСО по кредитам, руб.', unit: 'RUB', count: false, additive: true },
  incomePerCreditPlan: { name: 'План дохода на 1 кредит, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  incomePerCreditFact: { name: 'Факт дохода на 1 кредит, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  avgCreditPlan: { name: 'План средней суммы кредита, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  avgCreditFact: { name: 'Факт средней суммы кредита, руб.', unit: 'RUB_PER_UNIT', count: false, additive: false },
  incomeSharePlan: { name: 'План % дохода от суммы кредита', unit: 'PCT', count: false, additive: false },
  incomeShareFact: { name: 'Факт % дохода от суммы кредита', unit: 'PCT', count: false, additive: false },

  // --- Trade Up и кредиты по типу поставки (доли) ---
  tradeUpTotal: { name: 'Trade Up, итог', unit: 'PCT', count: false, additive: false },
  tradeUpCommission: { name: 'Trade Up, комиссия', unit: 'PCT', count: false, additive: false },
  tradeUpBuyout: { name: 'Trade Up, выкуп', unit: 'PCT', count: false, additive: false },
  creditShareTotal: { name: 'Кредиты (CRM), итог', unit: 'PCT', count: false, additive: false },
  creditShareCommission: { name: 'Кредиты (CRM), комиссия', unit: 'PCT', count: false, additive: false },
  creditShareBuyout: { name: 'Кредиты (CRM), выкуп', unit: 'PCT', count: false, additive: false },

  // --- воронка (обращения либо звонки; канал объявляет загружающий) ---
  funnelTraffic: { name: 'Воронка: трафик', unit: 'COUNT', count: true, additive: true },
  funnelVisits: { name: 'Воронка: визиты', unit: 'COUNT', count: true, additive: true },
  funnelDeals: { name: 'Воронка: сделки', unit: 'COUNT', count: true, additive: true },
  funnelTrafficToVisit: { name: 'Конверсия трафик → визит', unit: 'PCT', count: false, additive: false },
  funnelVisitToDeal: { name: 'Конверсия визит → сделка', unit: 'PCT', count: false, additive: false },
  funnelTrafficToDeal: { name: 'Конверсия трафик → сделка', unit: 'PCT', count: false, additive: false },
} as const satisfies Record<string, MetricSpec>;

export type MetricKey = keyof typeof METRICS;

export const METRIC_KEYS = Object.keys(METRICS) as MetricKey[];
export const METRIC_NAMES: Record<MetricKey, string> =
  Object.fromEntries(METRIC_KEYS.map(k => [k, METRICS[k].name])) as Record<MetricKey, string>;
export const isMetricKey = (value: unknown): value is MetricKey =>
  typeof value === 'string' && (METRIC_KEYS as string[]).includes(value);
export const isCountMetric = (metric: MetricKey) => METRICS[metric].count;
export const isAdditiveMetric = (metric: MetricKey) => METRICS[metric].additive;
