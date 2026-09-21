/*
 * Модель балла филиала: чистые проверки расчёта без базы и HTTP.
 * Эталон — рабочая модель старого портала (dist/index.cjs) и ТЗ v2.12 §22.1.
 * Числа в проверках взяты со скринов боевого портала от 21.09.2026.
 */
import { computeBranchScore, type ScoringModel } from '../src/metrics/scoring';

const base: ScoringModel = {
  id: 'synthetic', score_cap: 120,
  red_score_below: 80, red_revenue_runrate_below: 75, red_weak_metric_below: 70,
  red_weak_metric_count: 2, stop_turnover_below: 75,
  green_score_above: 90, green_revenue_above: 85, green_turnover_above: 85, green_no_metric_below: 70,
  conversion_green_from: 17, conversion_green_score: 110,
  conversion_amber_from: 14, conversion_amber_score: 90, conversion_red_score: 50,
  green_score_from: null, amber_score_from: null,
  effective_from: '2026-09-01', effective_to: null, reason: 'Проверка расчёта',
  weights: [],
};

describe('балл филиала по ТЗ §22.1', () => {
  it('ставит статус по баллу, когда заданы пороги 90 и 80 (ТЗ §22.1)', () => {
    // Рабочая модель старого портала: статус определяется только баллом,
    // прежние правила порога выручки и стоп-фактора не применяются.
    const live: ScoringModel = { ...base, green_score_from: 90, amber_score_from: 80, weights: [
      { metric: 'forecast', weight: 40, evaluation: 'RATIO_TO_PLAN', plan_metric: 'plan',
        rule_role: 'ORDINARY', band_green: null, band_amber: null, direction: null }] };
    // 100% прогноза к плану → балл 100 → зелёный, хотя оборачиваемости нет вовсе.
    expect(computeBranchScore(live, new Map([['forecast', 50], ['plan', 50]]), '2026-08-20').rag).toBe('GREEN');
    expect(computeBranchScore(live, new Map([['forecast', 42], ['plan', 50]]), '2026-08-20').rag).toBe('AMBER');
    expect(computeBranchScore(live, new Map([['forecast', 30], ['plan', 50]]), '2026-08-20').rag).toBe('RED');
  });
  it('считает прогноз к плану без коэффициента месяца', () => {
    const live: ScoringModel = { ...base, weights: [
      { metric: 'forecast', weight: 40, evaluation: 'RATIO_TO_PLAN', plan_metric: 'plan',
        rule_role: 'ORDINARY', band_green: null, band_amber: null, direction: null }] };
    // 30/42 = 71,4%. С коэффициентом месяца получилось бы больше 100% — это и
    // была ошибка прежней модели.
    const r = computeBranchScore(live, new Map([['forecast', 30], ['plan', 42]]), '2026-08-20');
    expect(r.components[0].score).toBeCloseTo(30 / 42 * 100, 6);
  });
  it('применяет полосы показателя в обе стороны', () => {
    const up: ScoringModel = { ...base, weights: [
      { metric: 'turnoverCommission', weight: 20, evaluation: 'BAND_PCT', plan_metric: null,
        rule_role: 'ORDINARY', band_green: 36, band_amber: 32, direction: 'HIGHER_IS_BETTER' }] };
    expect(computeBranchScore(up, new Map([['turnoverCommission', 0.40]]), '2026-08-20').components[0].score).toBe(110);
    expect(computeBranchScore(up, new Map([['turnoverCommission', 0.33]]), '2026-08-20').components[0].score).toBe(90);
    expect(computeBranchScore(up, new Map([['turnoverCommission', 0.31]]), '2026-08-20').components[0].score).toBe(50);
    const down: ScoringModel = { ...base, weights: [
      { metric: 'buyback45Share', weight: 10, evaluation: 'BAND_PCT', plan_metric: null,
        rule_role: 'ORDINARY', band_green: 10, band_amber: 15, direction: 'LOWER_IS_BETTER' }] };
    // Чем меньше доля залежавшихся машин, тем лучше.
    expect(computeBranchScore(down, new Map([['buyback45Share', 0.08]]), '2026-08-20').components[0].score).toBe(110);
    expect(computeBranchScore(down, new Map([['buyback45Share', 0.13]]), '2026-08-20').components[0].score).toBe(90);
    expect(computeBranchScore(down, new Map([['buyback45Share', 0.53]]), '2026-08-20').components[0].score).toBe(50);
  });
  it('воспроизводит филиал Дагомыс боевого портала', () => {
    // Скрин владельца от 21.09.2026, вкладка филиала Дагомыс: разбивка по
    // метрикам 69%, продажи 70%, Маржа+КСО 121%, выкуп 53%, комиссия 31%,
    // конверсия 13%, доля 45+ 53%.
    const live: ScoringModel = { ...base, green_score_from: 90, amber_score_from: 80, weights: [
      { metric: 'forecast', weight: 40, evaluation: 'RATIO_TO_PLAN', plan_metric: 'plan',
        rule_role: 'ORDINARY', band_green: null, band_amber: null, direction: null },
      { metric: 'forecastMargin', weight: 15, evaluation: 'RATIO_TO_PLAN', plan_metric: 'planMargin',
        rule_role: 'ORDINARY', band_green: null, band_amber: null, direction: null },
      { metric: 'turnoverBuyout', weight: 10, evaluation: 'BAND_PCT', plan_metric: null,
        rule_role: 'ORDINARY', band_green: 95, band_amber: 85, direction: 'HIGHER_IS_BETTER' },
      { metric: 'turnoverCommission', weight: 20, evaluation: 'BAND_PCT', plan_metric: null,
        rule_role: 'ORDINARY', band_green: 36, band_amber: 32, direction: 'HIGHER_IS_BETTER' },
      { metric: 'funnelTrafficToDeal', weight: 5, evaluation: 'BAND_PCT', plan_metric: null,
        rule_role: 'ORDINARY', band_green: 17, band_amber: 14, direction: 'HIGHER_IS_BETTER' },
      { metric: 'buyback45Share', weight: 10, evaluation: 'BAND_PCT', plan_metric: null,
        rule_role: 'ORDINARY', band_green: 10, band_amber: 15, direction: 'LOWER_IS_BETTER' }] };
    const r = computeBranchScore(live, new Map([
      ['forecast', 21], ['plan', 30],
      ['forecastMargin', 5192765], ['planMargin', 4301000],
      ['turnoverBuyout', 0.53], ['turnoverCommission', 0.31],
      ['funnelTrafficToDeal', 0.13], ['buyback45Share', 0.53]]), '2026-09-21');
    // 70*40 + 120*15 + 50*10 + 50*20 + 50*5 + 50*10 = 6900 / 100 = 69
    expect(Math.round(r.score!)).toBe(69);
    expect(r.rag).toBe('RED');
  });
});
