import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import type { ActorContext } from './workItemService';
import { diaryFor } from './diaryDelegation';
import { aged45 } from '../metrics/derived';

/**
 * Подсказки ежедневника из данных портала.
 *
 * Решение владельца 26.09.2026: часть ежедневника должна заполняться из базы,
 * а работа руководителя — над отклонениями. Подсказка не пишет в поле сама:
 * рядом с полем видно значение, его источник и дату, а кнопка «Подставить»
 * кладёт его в поле как обычный ввод. Так в ежедневнике остаётся то, что человек
 * подтвердил, и видно, откуда число взялось.
 *
 * Правила.
 *  - Только опубликованные данные: сводный отчёт QLIK из report_fact_current и
 *    реестр VIN. Предпросмотр загрузки сюда не попадает.
 *  - Берём последний срез не позже даты ежедневника в месяце этой даты.
 *    Период среза показывается: «на дату» означает дату конца периода отчёта,
 *    а не дату ежедневника.
 *  - Нет данных — нет подсказки. Ноль не подставляется.
 *  - У каждой подсказки записана формула — словами, как она видна в интерфейсе.
 */

export interface Hint {
  field_path: string; value: number; unit: string;
  as_of: string; period: string; source: string; formula: string; note?: string;
  /**
   * Проверка ввода человека (решение владельца 26.09.2026: значение из базы в
   * поле не ставится, а ввод сверяется с ним).
   *  MIN   — введено меньше минимума, нужного для выполнения плана: предупреждение
   *          «для достижения плана нужно не менее N».
   *  MATCH — введённое расходится с данными портала больше чем на tolerance.
   */
  check?: 'MIN' | 'MATCH'; min?: number; tolerance?: number;
}

async function facts(c: PoolClient, org: string, date: string) {
  const rows = (await c.query(
    `SELECT DISTINCT ON (f.metric) f.metric, f.period_start::text ps, f.period_end::text pe, s.value::float8 v
       FROM report_fact_current f JOIN report_fact_snapshots s ON s.id = f.snapshot_id
      WHERE f.org_unit_id = $1
        AND f.period_start >= date_trunc('month', $2::date)::date
        AND f.period_start <= $2::date
      ORDER BY f.metric, f.period_end DESC`, [org, date])).rows;
  return new Map(rows.map(r => [r.metric as string, { v: Number(r.v), ps: r.ps as string, pe: r.pe as string }]));
}

const ru = (d: string) => d.slice(8, 10) + '.' + d.slice(5, 7);
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function diaryReference(ctx: ActorContext, diaryId: string) {
  return withTransaction(async c => {
    const d = await diaryFor(c, ctx, diaryId, false);
    const hints: Hint[] = [];
    if (d.role_code !== 'RF') return { business_date: d.business_date, hints };
    const f = await facts(c, d.org_unit_id, d.business_date);
    const monthEnd = (await c.query(
      `SELECT (date_trunc('month',$1::date)+interval '1 month -1 day')::date::text e`, [d.business_date])).rows[0].e as string;
    // Оставшиеся дни месяца, включая день ежедневника: план на сегодня входит в остаток.
    const daysLeft = Number(monthEnd.slice(8, 10)) - Number(d.business_date.slice(8, 10)) + 1;

    const sales = f.get('sales'), plan = f.get('plan');
    if (sales && plan && plan.v > 0) {
      hints.push({ field_path: 't1_sales_pct', value: r1(sales.v / plan.v * 100), unit: '%', as_of: sales.pe,
        period: `${ru(sales.ps)}–${ru(sales.pe)}`, source: 'Сводный отчёт QLIK',
        formula: `Факт продаж ${sales.v} шт на ${ru(sales.pe)} ÷ план месяца ${plan.v} шт × 100`,
        check: 'MATCH', tolerance: 0.5 });
      if (daysLeft > 0 && plan.v > sales.v)
        hints.push({ field_path: 't1_sales_plan', value: r1((plan.v - sales.v) / daysLeft), unit: 'шт', as_of: sales.pe,
          period: `${ru(sales.ps)}–${ru(sales.pe)}`, source: 'Сводный отчёт QLIK',
          formula: `Остаток плана ${plan.v - sales.v} шт ÷ ${daysLeft} дн. до конца месяца`,
          note: 'Если факт отчёта снят раньше даты ежедневника, остаток завышен на продажи этих дней.',
          // Продажи — целые машины: 3,8 в день означает не менее 4.
          check: 'MIN', min: Math.ceil((plan.v - sales.v) / daysLeft) });
    }
    const sf = f.get('suppliesFact'), sp = f.get('suppliesPlan');
    if (sf && sp && sp.v > 0)
      hints.push({ field_path: 't1_supply_pct', value: r1(sf.v / sp.v * 100), unit: '%', as_of: sf.pe,
        period: `${ru(sf.ps)}–${ru(sf.pe)}`, source: 'Сводный отчёт QLIK',
        formula: `Факт поставок ${sf.v} шт на ${ru(sf.pe)} ÷ план поставок месяца ${sp.v} шт × 100`,
        check: 'MATCH', tolerance: 0.5 });
    // План поставок в отчёте QLIK — месячный: во всех срезах 20, 25 и 26.09
    // одно и то же значение 113. Поэтому остаток на день считается так же, как
    // у продаж.
    if (sf && sp && daysLeft > 0 && sp.v > sf.v)
      hints.push({ field_path: 't1_supply_plan', value: r1((sp.v - sf.v) / daysLeft), unit: 'шт', as_of: sf.pe,
        period: `${ru(sf.ps)}–${ru(sf.pe)}`, source: 'Сводный отчёт QLIK',
        formula: `Остаток плана поставок ${sp.v - sf.v} шт ÷ ${daysLeft} дн. до конца месяца`,
        note: 'Если факт отчёта снят раньше даты ежедневника, остаток завышен на поставки этих дней.',
        check: 'MIN', min: Math.ceil((sp.v - sf.v) / daysLeft) });
    const m = f.get('margin'), pm = f.get('planMargin');
    if (m && pm && daysLeft > 0 && pm.v > m.v)
      hints.push({ field_path: 't1_km', value: Math.round((pm.v - m.v) / daysLeft), unit: '₽', as_of: m.pe,
        period: `${ru(m.ps)}–${ru(m.pe)}`, source: 'Сводный отчёт QLIK',
        formula: `Остаток плана маржи (КСО + железо) ${Math.round(pm.v - m.v).toLocaleString('ru-RU')} ₽ ÷ ${daysLeft} дн.`,
        check: 'MIN', min: Math.ceil((pm.v - m.v) / daysLeft) });

    // Задача 5 — по реестру VIN. Висяки 45+ бывают по всему складу и по
    // выкупу; в поле подставляется весь склад, выкуп показан рядом, чтобы их
    // можно было отличить (правило владельца).
    // Висяки 45+ в задаче 5 — только выкуп (решение владельца 26.09.2026):
    // и доля, и деньги считаются по машинам с типом поставки «Выкуп».
    const buy = (await aged45(c, [d.org_unit_id], d.business_date, 'BUYOUT')).get(d.org_unit_id);
    if (buy) {
      hints.push({ field_path: 't5_share_pct', value: r1(buy.share * 100), unit: '%', as_of: buy.observed_on,
        period: `срез ${ru(buy.observed_on)}`, source: 'Реестр VIN, выкуп',
        formula: `${buy.aged} машин выкупа 45+ дней ÷ ${buy.total} машин выкупа на складе × 100`,
        check: 'MATCH', tolerance: 0.5 });
      if (buy.aged_cost !== null)
        hints.push({ field_path: 't5_share_rub', value: Math.round(buy.aged_cost), unit: '₽', as_of: buy.observed_on,
          period: `срез ${ru(buy.observed_on)}`, source: 'Реестр VIN, выкуп',
          formula: `Себестоимость ${buy.aged} машин выкупа 45+ дней`,
          // Деньги вводят округлённо: расхождение до 1 % или 1 000 ₽ не ошибка.
          check: 'MATCH', tolerance: Math.max(1000, Math.round(buy.aged_cost * 0.01)) });
    }
    const old = (await c.query(
      `WITH l AS (SELECT max(observed_on) d FROM vehicle_stock_rows WHERE org_unit_id=$1 AND observed_on<=$2::date)
       SELECT l.d::text d, count(*) FILTER (WHERE r.days_on_stock>30) n,
              avg(r.days_on_stock) FILTER (WHERE r.days_on_stock>30)::float8 age,
              count(*) FILTER (WHERE r.days_on_stock>30 AND r.sale_price_rub>0 AND r.market_price_rub>0) nm,
              avg(r.sale_price_rub/r.market_price_rub*100)
                FILTER (WHERE r.days_on_stock>30 AND r.sale_price_rub>0 AND r.market_price_rub>0)::float8 mkt
         FROM l JOIN vehicle_stock_rows r ON r.org_unit_id=$1 AND r.observed_on=l.d GROUP BY l.d`,
      [d.org_unit_id, d.business_date])).rows[0];
    if (old && Number(old.n) > 0) {
      hints.push({ field_path: 't5_age', value: r1(old.age), unit: 'дн', as_of: old.d, period: `срез ${ru(old.d)}`,
        source: 'Реестр VIN, выкуп + комиссия', formula: `Средние дни на складе у ${old.n} машин старше 30 дней, выкуп + комиссия` });
      if (Number(old.nm) > 0)
        hints.push({ field_path: 't5_market', value: r1(old.mkt), unit: '%', as_of: old.d, period: `срез ${ru(old.d)}`,
          source: 'Реестр VIN, выкуп + комиссия', formula: `Средняя цена продажи ÷ рыночная цена × 100 по ${old.nm} машинам старше 30 дней, выкуп + комиссия`,
          check: 'MATCH', tolerance: 0.5 });
    }
    // Машины без переоценки больше 10 дней — список для поручений (решение
    // владельца 26.09.2026). Основание — колонка выгрузки «Изменения Цены
    // продажи, дн.»: сколько дней цена не менялась.
    const stale = (await c.query(
      `WITH l AS (SELECT max(observed_on) d FROM vehicle_stock_rows WHERE org_unit_id=$1 AND observed_on<=$2::date)
       SELECT l.d::text observed_on, i.vehicle_key vin, r.make, r.model, r.production_year,
              r.days_on_stock, r.price_changes_days::float8 days_without_reprice, r.price_changes_count,
              r.supply_type, r.sale_price_rub::float8 sale_price_rub, r.market_price_rub::float8 market_price_rub
         FROM l JOIN vehicle_stock_rows r ON r.org_unit_id=$1 AND r.observed_on=l.d
         JOIN vehicle_identity i ON i.id=r.vehicle_id
        WHERE r.price_changes_days > $3
        ORDER BY r.price_changes_days DESC, r.days_on_stock DESC`,
      [d.org_unit_id, d.business_date, STALE_REPRICE_DAYS])).rows;
    return { business_date: d.business_date, hints,
      stale_prices: { threshold_days: STALE_REPRICE_DAYS, observed_on: stale[0]?.observed_on ?? null, rows: stale } };
  });
}
const STALE_REPRICE_DAYS = 10;
