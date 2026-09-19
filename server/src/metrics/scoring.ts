// Балл филиала и светофор. Ни один вес, порог, cap или полоса конверсии
// не зашиты в код: расчёт возможен только по действующей версии модели,
// настроенной внутри портала. Нет модели или нет данных → статус NONE,
// это не ноль и не выполнение плана.
import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { withTransaction } from '../db/pool';
import { authorizeNetworkPermissions } from '../domain/accessChanges';
import { writeAuditAndOutbox } from '../domain/auditOutbox';
import { ApiError } from '../util/errors';
import { isMetricKey, METRIC_NAMES } from '../reporting/shared/reportModel';
import type { Rag } from './thresholds';

const invalid = (s: string) => new ApiError('VALIDATION_ERROR', s);
const isDate = (v: unknown): v is string => {
  if (typeof v !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(v)) return false;
  const t = Date.parse(`${v}T00:00:00.000Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
};

export type Evaluation = 'RUN_RATE' | 'RATIO_X100' | 'CONVERSION_BANDS';
export type RuleRole = 'ORDINARY' | 'REVENUE' | 'TURNOVER_STOP';
export interface ScoringWeight {
  metric: string; weight: number; evaluation: Evaluation;
  plan_metric: string | null; rule_role: RuleRole;
}
export interface ScoringModel {
  id: string; score_cap: number;
  red_score_below: number; red_revenue_runrate_below: number;
  red_weak_metric_below: number; red_weak_metric_count: number;
  stop_turnover_below: number;
  green_score_above: number; green_revenue_above: number;
  green_turnover_above: number; green_no_metric_below: number;
  conversion_green_from: number; conversion_green_score: number;
  conversion_amber_from: number; conversion_amber_score: number;
  conversion_red_score: number;
  effective_from: string; effective_to: string | null; reason: string;
  weights: ScoringWeight[];
}
export interface ScoreComponent {
  metric: string; metric_name: string; weight: number; evaluation: Evaluation;
  rule_role: RuleRole; fact: number | null; plan: number | null;
  /** Балл компонента после cap; null, когда данных для расчёта нет. */
  score: number | null;
  /** Почему компонент не посчитан. Отсутствие данных не заменяется нулём. */
  missing: 'FACT_NOT_PUBLISHED' | 'PLAN_NOT_PUBLISHED' | 'PLAN_NOT_POSITIVE' | null;
}
export interface BranchScore {
  score: number | null; rag: Rag; model_id: string | null;
  month_progress: number | null; components: ScoreComponent[];
  /** Основания статуса: показываются руководителю, а не выводятся из воздуха. */
  reasons: string[];
}

/** K = прошедшие дни / дни в месяце, не более 1. Расчёт run-rate без K неверен. */
export function monthProgress(on: string): number {
  if (!isDate(on)) throw invalid('Дата среза указана неверно.');
  const [y, m, d] = on.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Math.min(1, d / days);
}

const capped = (value: number, cap: number) => Math.min(cap, value);

/**
 * Балл и статус филиала по опубликованным значениям показателей.
 * `values` содержит только опубликованные показатели, доступные пользователю.
 */
export function computeBranchScore(
  model: ScoringModel | null, values: Map<string, number>, on: string,
): BranchScore {
  if (!model) return { score: null, rag: 'NONE', model_id: null, month_progress: null, components: [], reasons: ['Модель балла не настроена в портале.'] };
  const k = monthProgress(on);
  const components: ScoreComponent[] = [];
  for (const w of model.weights) {
    const name = (METRIC_NAMES as Record<string, string>)[w.metric] ?? w.metric;
    const fact = values.has(w.metric) ? values.get(w.metric)! : null;
    const plan = w.plan_metric && values.has(w.plan_metric) ? values.get(w.plan_metric)! : null;
    const base = { metric: w.metric, metric_name: name, weight: w.weight, evaluation: w.evaluation, rule_role: w.rule_role };
    if (fact === null || !Number.isFinite(fact)) {
      components.push({ ...base, fact: null, plan, score: null, missing: 'FACT_NOT_PUBLISHED' });
      continue;
    }
    if (w.evaluation === 'RUN_RATE') {
      if (plan === null || !Number.isFinite(plan)) {
        components.push({ ...base, fact, plan: null, score: null, missing: 'PLAN_NOT_PUBLISHED' });
        continue;
      }
      if (plan <= 0) {
        components.push({ ...base, fact, plan, score: null, missing: 'PLAN_NOT_POSITIVE' });
        continue;
      }
      components.push({ ...base, fact, plan, score: capped((fact / (plan * k)) * 100, model.score_cap), missing: null });
      continue;
    }
    if (w.evaluation === 'RATIO_X100') {
      components.push({ ...base, fact, plan, score: capped(fact * 100, model.score_cap), missing: null });
      continue;
    }
    const band = fact >= model.conversion_green_from ? model.conversion_green_score
      : fact >= model.conversion_amber_from ? model.conversion_amber_score : model.conversion_red_score;
    components.push({ ...base, fact, plan, score: capped(band, model.score_cap), missing: null });
  }
  const scored = components.filter(c => c.score !== null && c.weight > 0);
  const weightSum = scored.reduce((s, c) => s + c.weight, 0);
  const score = weightSum > 0
    ? scored.reduce((s, c) => s + c.score! * c.weight, 0) / weightSum : null;
  const roleScore = (role: RuleRole) => components.find(c => c.rule_role === role)?.score ?? null;
  const revenue = roleScore('REVENUE'), turnover = roleScore('TURNOVER_STOP');
  const weak = components.filter(c => c.score !== null && c.score < model.red_weak_metric_below);
  const reasons: string[] = [];
  if (score === null) {
    for (const c of components.filter(c => c.missing)) reasons.push(`${c.metric_name}: нет данных для расчёта.`);
    return { score: null, rag: 'NONE', model_id: model.id, month_progress: k, components, reasons };
  }
  let rag: Rag = 'AMBER';
  if (score < model.red_score_below) reasons.push(`Балл ${score.toFixed(1)} ниже порога ${model.red_score_below}.`);
  if (revenue !== null && revenue < model.red_revenue_runrate_below)
    reasons.push(`Run-rate выручки ${revenue.toFixed(1)} ниже порога ${model.red_revenue_runrate_below}.`);
  if (turnover !== null && turnover < model.stop_turnover_below)
    reasons.push(`Оборачиваемость ${turnover.toFixed(1)} ниже стоп-фактора ${model.stop_turnover_below}.`);
  if (weak.length >= model.red_weak_metric_count)
    reasons.push(`Показателей ниже ${model.red_weak_metric_below}: ${weak.length}.`);
  if (reasons.length) rag = 'RED';
  else if (score > model.green_score_above && revenue !== null && revenue > model.green_revenue_above
    && turnover !== null && turnover > model.green_turnover_above
    && !components.some(c => c.score !== null && c.score < model.green_no_metric_below)) {
    rag = 'GREEN';
    reasons.push('Все условия зелёного статуса выполнены.');
  } else {
    if (revenue === null) reasons.push('Run-rate выручки не рассчитан: зелёный статус не подтверждается.');
    if (turnover === null) reasons.push('Оборачиваемость не рассчитана: зелёный статус не подтверждается.');
    if (!reasons.length) reasons.push('Условия зелёного статуса не выполнены полностью.');
  }
  return { score, rag, model_id: model.id, month_progress: k, components, reasons };
}

const MODEL_FIELDS = ['score_cap', 'red_score_below', 'red_revenue_runrate_below', 'red_weak_metric_below',
  'red_weak_metric_count', 'stop_turnover_below', 'green_score_above', 'green_revenue_above',
  'green_turnover_above', 'green_no_metric_below', 'conversion_green_from', 'conversion_green_score',
  'conversion_amber_from', 'conversion_amber_score', 'conversion_red_score'] as const;

/** Действующая на дату модель балла вместе с весами. */
export async function resolveScoringModel(c: PoolClient, on: string): Promise<ScoringModel | null> {
  const row = (await c.query(`SELECT id,${MODEL_FIELDS.map(f => `${f}::text ${f}`).join(',')},
    to_char(effective_from,'YYYY-MM-DD') effective_from,to_char(effective_to,'YYYY-MM-DD') effective_to,reason
    FROM scoring_models WHERE effective_from<=$1 AND (effective_to IS NULL OR effective_to>$1)`, [on])).rows[0];
  if (!row) return null;
  const weights = (await c.query(
    'SELECT metric,weight::text weight,evaluation,plan_metric,rule_role FROM scoring_weights WHERE model_id=$1 ORDER BY metric',
    [row.id])).rows;
  const model: any = { id: row.id, effective_from: row.effective_from, effective_to: row.effective_to, reason: row.reason };
  for (const f of MODEL_FIELDS) model[f] = Number(row[f]);
  model.weights = weights.map((w: any) => ({ ...w, weight: Number(w.weight) }));
  return model as ScoringModel;
}

interface Command {
  model: Record<string, number>; weights: ScoringWeight[]; effective_from: string; reason: string;
}
function parse(raw: any): Command {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || Object.keys(raw).some(k => !['weights', 'effective_from', 'reason', ...MODEL_FIELDS].includes(k)))
    throw invalid('Передайте только поля модели балла.');
  const model: Record<string, number> = {};
  for (const f of MODEL_FIELDS) {
    const v = raw[f];
    if (!Number.isFinite(v) || v < 0) throw invalid(`Укажите числовое значение параметра «${f}».`);
    model[f] = v;
  }
  if (!Number.isInteger(model.red_weak_metric_count) || model.red_weak_metric_count < 1)
    throw invalid('Количество слабых показателей для красного статуса — целое число от 1.');
  if (model.green_score_above < model.red_score_below)
    throw invalid('Порог зелёного не может быть ниже порога красного.');
  if (model.score_cap < model.green_score_above)
    throw invalid('Ограничение балла не может быть ниже порога зелёного.');
  if (!(model.conversion_green_from > model.conversion_amber_from))
    throw invalid('Полоса зелёной конверсии должна быть выше жёлтой.');
  if (!(model.conversion_green_score >= model.conversion_amber_score
    && model.conversion_amber_score >= model.conversion_red_score))
    throw invalid('Баллы полос конверсии должны убывать от зелёной к красной.');
  if (!Array.isArray(raw.weights) || raw.weights.length < 1 || raw.weights.length > 40)
    throw invalid('Укажите веса показателей (от 1 до 40).');
  const weights: ScoringWeight[] = [];
  const seen = new Set<string>(), roles = new Set<string>();
  for (const w of raw.weights) {
    if (!w || typeof w !== 'object' || Array.isArray(w)
      || Object.keys(w).some(k => !['metric', 'weight', 'evaluation', 'plan_metric', 'rule_role'].includes(k)))
      throw invalid('Передайте только поля веса показателя.');
    const rule_role = w.rule_role ?? 'ORDINARY';
    const plan_metric = w.plan_metric ?? null;
    if (typeof w.metric !== 'string' || !isMetricKey(w.metric))
      throw invalid('Вес задаётся для показателя из справочника показателей.');
    if (seen.has(w.metric)) throw invalid('Показатель указан в весах дважды.');
    seen.add(w.metric);
    if (!Number.isFinite(w.weight) || w.weight < 0 || w.weight > 1000)
      throw invalid('Вес показателя — число от 0 до 1000.');
    if (!['RUN_RATE', 'RATIO_X100', 'CONVERSION_BANDS'].includes(w.evaluation))
      throw invalid('Укажите способ расчёта показателя.');
    if (plan_metric !== null && (typeof plan_metric !== 'string' || !isMetricKey(plan_metric)))
      throw invalid('Показатель плана должен быть из справочника показателей.');
    if (w.evaluation === 'RUN_RATE' && plan_metric === null)
      throw invalid('Для run-rate укажите показатель плана.');
    if (w.evaluation !== 'RUN_RATE' && plan_metric !== null)
      throw invalid('Показатель плана применим только к run-rate.');
    if (!['ORDINARY', 'REVENUE', 'TURNOVER_STOP'].includes(rule_role))
      throw invalid('Укажите роль показателя в правилах светофора.');
    if (rule_role !== 'ORDINARY') {
      if (roles.has(rule_role)) throw invalid('Роль в правилах светофора может быть только у одного показателя.');
      roles.add(rule_role);
    }
    weights.push({ metric: w.metric, weight: w.weight, evaluation: w.evaluation, plan_metric, rule_role });
  }
  if (!weights.some(w => w.weight > 0)) throw invalid('Хотя бы один показатель должен иметь вес больше нуля.');
  if (!isDate(raw.effective_from)) throw invalid('Укажите дату вступления в силу в формате ГГГГ-ММ-ДД.');
  if (typeof raw.reason !== 'string' || raw.reason.trim().length < 16 || raw.reason.length > 500)
    throw invalid('Укажите основание изменения модели балла (16–500 символов).');
  return { model, weights, effective_from: raw.effective_from, reason: raw.reason.trim() };
}

export async function listScoringModels(auth: AuthedUser, query: any) {
  if (Object.keys(query ?? {}).some(k => k !== 'history')) throw invalid('Фильтры настройки не принимаются.');
  const history = query?.history === 'true';
  return withTransaction(async c => {
    await authorizeNetworkPermissions(c, auth, ['metric.scoring.manage']);
    const rows = (await c.query(`SELECT id,${MODEL_FIELDS.map(f => `${f}::text ${f}`).join(',')},
      to_char(effective_from,'YYYY-MM-DD') effective_from,to_char(effective_to,'YYYY-MM-DD') effective_to,
      reason,created_at FROM scoring_models WHERE $1 OR effective_to IS NULL
      ORDER BY effective_from DESC LIMIT 201`, [history])).rows;
    const weights = rows.length
      ? (await c.query(`SELECT model_id,metric,weight::text weight,evaluation,plan_metric,rule_role
        FROM scoring_weights WHERE model_id=ANY($1::uuid[]) ORDER BY metric`, [rows.map(r => r.id)])).rows : [];
    return {
      items: rows.map(r => ({ ...r, weights: weights.filter(w => w.model_id === r.id) })),
      metric_names: METRIC_NAMES, history,
    };
  });
}

/** Новая версия модели балла. Действующая закрывается датой вступления в силу новой. */
export async function setScoringModel(auth: AuthedUser, body: any, requestId: string) {
  const cmd = parse(body);
  return withTransaction(async c => {
    await authorizeNetworkPermissions(c, auth, ['metric.scoring.manage']);
    await c.query('LOCK TABLE scoring_models, scoring_weights IN SHARE ROW EXCLUSIVE MODE');
    const previous = (await c.query(`SELECT id,to_char(effective_from,'YYYY-MM-DD') effective_from
      FROM scoring_models WHERE effective_to IS NULL`)).rows[0] ?? null;
    if (previous && previous.effective_from >= cmd.effective_from)
      throw invalid('Дата вступления в силу должна быть позже текущей версии модели балла.');
    const id = randomUUID();
    const audit = await writeAuditAndOutbox(c, {
      actorUserId: auth.userId, actorRole: null, orgUnitId: null, workItemId: null,
      action: 'metric.scoring.set', aggregateType: 'metric_scoring', aggregateId: id, aggregateVersion: 1,
      requestId, beforeState: previous, afterState: { id, ...cmd.model, weights: cmd.weights },
      reason: cmd.reason, resolution: 'APPLIED', retentionClass: 'SECURITY_5Y',
      eventType: 'metric.scoring.changed', payload: { effective_from: cmd.effective_from },
    });
    if (previous) await c.query('UPDATE scoring_models SET effective_to=$2 WHERE id=$1', [previous.id, cmd.effective_from]);
    await c.query(`INSERT INTO scoring_models(id,${MODEL_FIELDS.join(',')},effective_from,reason,created_by,audit_id)
      VALUES($1,${MODEL_FIELDS.map((_, i) => `$${i + 2}`).join(',')},
      $${MODEL_FIELDS.length + 2},$${MODEL_FIELDS.length + 3},$${MODEL_FIELDS.length + 4},$${MODEL_FIELDS.length + 5})`,
    [id, ...MODEL_FIELDS.map(f => cmd.model[f]), cmd.effective_from, cmd.reason, auth.userId, audit]);
    for (const w of cmd.weights)
      await c.query(`INSERT INTO scoring_weights(id,model_id,metric,weight,evaluation,plan_metric,rule_role)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [randomUUID(), id, w.metric, w.weight, w.evaluation, w.plan_metric, w.rule_role]);
    return { id, previous_id: previous?.id ?? null, audit_id: audit, effective_from: cmd.effective_from };
  });
}
