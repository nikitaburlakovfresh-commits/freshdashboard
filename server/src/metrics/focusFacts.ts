import type { PoolClient } from 'pg';

/**
 * Факт фокусов внимания (решение владельца 30.09.2026: фокусы должны заполняться).
 *
 * Формулы взяты из спецификации старого портала (2026-09-19_overview_spec_from_legacy.md)
 * и считаются только по опубликованным данным в области доступа пользователя:
 * — показатели QLIK за тот же срез, что и обзор;
 * — реестр VIN: последний срез не позже даты обзора, выкуп и комиссия;
 * — ежедневники портала за последние 7 дней.
 * Если источника нет, факт остаётся пустым с основанием — ноль не подставляется.
 */
export type FocusBasis = 'PUBLISHED_METRICS' | 'VIN_REGISTRY' | 'DAILY_LOGS'
  | 'SOURCE_NOT_PUBLISHED' | 'NOT_MAPPED_TO_PUBLISHED_METRIC';
export interface FocusFact { fact: number | null; fact_basis: FocusBasis; fact_note: string | null }

const round1 = (v: number) => Math.round(v * 10) / 10;

export async function focusFacts(c: PoolClient, codes: string[], totals: Map<string, number>,
  orgs: string[], on: string): Promise<Map<string, FocusFact>> {
  const out = new Map<string, FocusFact>();
  const get = (m: string) => totals.has(m) ? totals.get(m)! : null;
  const none = (note: string): FocusFact => ({ fact: null, fact_basis: 'SOURCE_NOT_PUBLISHED', fact_note: note });
  const metric = (v: number | null, note: string, missing: string): FocusFact =>
    v === null || !Number.isFinite(v) ? none(missing) : { fact: round1(v), fact_basis: 'PUBLISHED_METRICS', fact_note: note };

  const needVin = codes.some(c => ['not_in_ads_share', 'leads_per_car', 'reprice_discipline', 'in_market_share',
    'hangers45_total', 'hangers45_buyback', 'hangers45_commission', 'commission_outflow_share', 'stock_units_end'].includes(c));
  let vin: any = null;
  if (needVin && orgs.length) {
    vin = (await c.query(`WITH l AS (SELECT max(observed_on) d FROM vehicle_stock_current
        WHERE org_unit_id=ANY($1::uuid[]) AND observed_on<=$2::date)
      SELECT to_char(l.d,'DD.MM.YYYY') d, count(*)::int n,
        count(*) FILTER (WHERE r.advertising_status IS NOT NULL)::int na,
        count(*) FILTER (WHERE r.advertising_status IS NOT NULL AND r.advertising_status<>'Выгружено')::int noads,
        sum(r.leads)::float8 leads, count(r.leads)::int nl,
        count(*) FILTER (WHERE (CASE WHEN coalesce(r.price_changes_count,0)>0 THEN r.price_changes_days ELSE r.days_on_stock END) IS NOT NULL)::int nr,
        count(*) FILTER (WHERE (CASE WHEN coalesce(r.price_changes_count,0)>0 THEN r.price_changes_days ELSE r.days_on_stock END)<=12)::int fresh,
        count(*) FILTER (WHERE r.sale_price_rub>0 AND r.market_price_rub>0)::int nm,
        count(*) FILTER (WHERE r.sale_price_rub>0 AND r.market_price_rub>0 AND r.sale_price_rub<=r.market_price_rub)::int inm,
        count(*) FILTER (WHERE r.days_on_stock IS NOT NULL)::int nd,
        count(*) FILTER (WHERE r.days_on_stock>=45)::int aged,
        count(*) FILTER (WHERE r.supply_type='Выкуп' AND r.days_on_stock IS NOT NULL)::int nb,
        count(*) FILTER (WHERE r.supply_type='Выкуп' AND r.days_on_stock>=45)::int agedb,
        count(*) FILTER (WHERE r.supply_type='Комиссия' AND r.days_on_stock IS NOT NULL)::int nc,
        count(*) FILTER (WHERE r.supply_type='Комиссия' AND r.days_on_stock>=45)::int agedc,
        count(*) FILTER (WHERE r.supply_type='Комиссия')::int commission
      FROM l JOIN vehicle_stock_current r ON r.observed_on=l.d AND r.org_unit_id=ANY($1::uuid[])
      WHERE r.supply_type IN ('Выкуп','Комиссия') GROUP BY l.d`, [orgs, on])).rows[0] ?? null;
  }
  const vinFact = (num: number, den: number, note: string): FocusFact => !vin || den <= 0
    ? none('нет среза реестра VIN') : { fact: round1(num / den * 100), fact_basis: 'VIN_REGISTRY', fact_note: `${note} · реестр VIN на ${vin.d}` };

  for (const code of codes) {
    const sales = get('sales'), revenue = get('revenue'), margin = get('margin'), plan = get('plan'),
      forecast = get('forecast'), planMargin = get('planMargin'), forecastMargin = get('forecastMargin');
    switch (code) {
      case 'sales_units': out.set(code, metric(sales, 'продажи из QLIK', 'продажи не опубликованы')); break;
      case 'avg_sale_price': out.set(code, metric(sales && revenue !== null ? revenue / sales : null, 'выручка ÷ продажи', 'выручка не опубликована')); break;
      case 'margin_fact': out.set(code, metric(margin === null ? null : margin / 1e6, 'маржа из QLIK, млн ₽', 'маржа не опубликована')); break;
      case 'sales_forecast_pct': out.set(code, metric(plan && forecast !== null ? forecast / plan * 100 : null, 'прогноз ÷ план продаж', 'прогноз или план не опубликованы')); break;
      case 'margin_runrate': out.set(code, metric(planMargin && forecastMargin !== null ? forecastMargin / planMargin * 100 : null, 'прогноз ÷ план маржи', 'прогноз или план маржи не опубликованы')); break;
      case 'traffic_count': out.set(code, metric(get('funnelTraffic'), 'трафик из QLIK', 'трафик не опубликован')); break;
      case 'conversion_traffic_to_deal': { const t = get('funnelTraffic'), d = get('funnelDeals');
        out.set(code, metric(t && d !== null ? d / t * 100 : null, 'сделки ÷ трафик', 'воронка не опубликована')); break; }
      case 'conversion_visit_to_deal': { const v = get('funnelVisits'), d = get('funnelDeals');
        out.set(code, metric(v && d !== null ? d / v * 100 : null, 'сделки ÷ визиты', 'воронка не опубликована')); break; }
      case 'not_in_ads_share': out.set(code, vinFact(vin?.noads ?? 0, vin?.na ?? 0, 'не выгружено в рекламу ÷ все авто')); break;
      case 'reprice_discipline': out.set(code, vinFact(vin?.fresh ?? 0, vin?.nr ?? 0, 'цена менялась не позже 12 дней назад')); break;
      case 'in_market_share': out.set(code, vinFact(vin?.inm ?? 0, vin?.nm ?? 0, 'цена продажи не выше рыночной')); break;
      case 'leads_per_car': out.set(code, !vin || !vin.nl ? none('нет среза реестра VIN')
        : { fact: round1(vin.leads / vin.nl), fact_basis: 'VIN_REGISTRY', fact_note: `лиды ÷ авто · реестр VIN на ${vin.d}` }); break;
      // Склад 45+ (ТЗ, «висяки»): авто со сроком хранения CRM от 45 дней ÷ авто того же вида.
      case 'hangers45_total': out.set(code, vinFact(vin?.aged ?? 0, vin?.nd ?? 0, 'склад 45+ ÷ весь склад')); break;
      case 'hangers45_buyback': out.set(code, vinFact(vin?.agedb ?? 0, vin?.nb ?? 0, 'выкуп 45+ ÷ склад выкупа')); break;
      case 'hangers45_commission': out.set(code, vinFact(vin?.agedc ?? 0, vin?.nc ?? 0, 'комиссия 45+ ÷ склад комиссии')); break;
      case 'stock_units_end': out.set(code, !vin ? none('нет среза реестра VIN')
        : { fact: vin.n, fact_basis: 'VIN_REGISTRY', fact_note: `авто в реестре VIN на ${vin.d}` }); break;
      // Отток комиссионного склада (решение владельца 07.10.2026): отток за месяц из
      // «Сводного отчёта» QLIK ÷ комиссионный склад на последний срез реестра VIN.
      case 'commission_outflow_share': { const o = get('outflow');
        out.set(code, o === null ? none('отток не опубликован — нужен «Сводный отчёт» QLIK')
          : !vin || !vin.commission ? none('нет среза реестра VIN')
            : { fact: round1(o / vin.commission * 100), fact_basis: 'PUBLISHED_METRICS',
              fact_note: `отток ${o} ÷ комиссия на складе ${vin.commission} · реестр VIN на ${vin.d}` }); break; }
      case 'daily_usage_pct': out.set(code, await dailyUsage(c, orgs)); break;
      default: out.set(code, { fact: null, fact_basis: 'NOT_MAPPED_TO_PUBLISHED_METRIC', fact_note: null });
    }
  }
  return out;
}

/**
 * Ежедневник, среднее заполнение: сумма процентов заполнения ежедневников за
 * последние 7 дней ÷ (5 рабочих дней × число ролей с настроенным окном), не выше 100%.
 * Знаменатель — только филиалы, где ежедневники включены: пилот не делится на всю сеть.
 */
async function dailyUsage(c: PoolClient, orgs: string[]): Promise<FocusFact> {
  if (!orgs.length) return { fact: null, fact_basis: 'SOURCE_NOT_PUBLISHED', fact_note: 'ежедневники не включены' };
  const expected = Number((await c.query(`SELECT count(*)::int n FROM (SELECT DISTINCT org_unit_id, role_code
      FROM daily_log_policies WHERE org_unit_id=ANY($1::uuid[])) x`, [orgs])).rows[0]?.n ?? 0);
  if (!expected) return { fact: null, fact_basis: 'SOURCE_NOT_PUBLISHED', fact_note: 'окна ежедневников не настроены' };
  const r = (await c.query(`SELECT coalesce(sum(x.filled::float8/nullif(x.total,0)*100),0)::float8 pct, count(*)::int n FROM (
      SELECT w.id, (SELECT count(*) FROM jsonb_array_elements(t.field_schema) e)::int total,
        count(f.field_path) FILTER (WHERE f.value IS NOT NULL AND btrim(f.value)<>'')::int filled
      FROM daily_log_records d JOIN work_items w ON w.id=d.work_item_id
      JOIN templates t ON t.id=w.template_version_id
      LEFT JOIN work_item_fields f ON f.work_item_id=w.id
      WHERE w.org_unit_id=ANY($1::uuid[]) AND w.status<>'CANCELLED'
        AND d.business_date>(now() AT TIME ZONE 'Europe/Moscow')::date-7
        AND EXISTS (SELECT 1 FROM daily_log_policies p WHERE p.org_unit_id=w.org_unit_id AND p.role_code=d.role_code)
      GROUP BY w.id, t.field_schema) x`, [orgs])).rows[0];
  const fact = Math.min(100, Number(r.pct) / (5 * expected));
  return { fact: round1(fact), fact_basis: 'DAILY_LOGS',
    fact_note: `${r.n} ежедневников за 7 дней · ${expected} ролей с окном заполнения` };
}
