// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import { randomUUID, randomBytes } from 'crypto';
import { pool, closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { authed, login, Session } from './helpers';
import { computeBranchScore, monthProgress, type ScoringModel } from '../src/metrics/scoring';

let admin: Session, rf: Session, branch: string, rfGrant: string;
const base = '/api/v1/metrics';
const password = randomBytes(32).toString('base64url');
const PERIOD = { start: '2026-08-01', end: '2026-08-31' };

const model = (patch: any = {}) => ({
  score_cap: 120, red_score_below: 70, red_revenue_runrate_below: 75, red_weak_metric_below: 70,
  red_weak_metric_count: 2, stop_turnover_below: 75, green_score_above: 85, green_revenue_above: 85,
  green_turnover_above: 85, green_no_metric_below: 70, conversion_green_from: 17, conversion_green_score: 110,
  conversion_amber_from: 14, conversion_amber_score: 90, conversion_red_score: 50,
  effective_from: '2026-08-01', reason: 'Synthetic approved scoring model for tests',
  weights: [
    { metric: 'revenue', weight: 30, evaluation: 'RUN_RATE', plan_metric: 'planMargin', rule_role: 'REVENUE' },
    { metric: 'margin', weight: 25, evaluation: 'RUN_RATE', plan_metric: 'planMargin', rule_role: 'ORDINARY' },
    { metric: 'turnoverBuyout', weight: 15, evaluation: 'RATIO_X100', rule_role: 'TURNOVER_STOP' },
  ],
  ...patch,
});
const focus = (patch: any = {}) => ({
  month: '2026-08-01', effective_from: '2026-08-01',
  reason: 'Synthetic approved monthly focus configuration',
  slots: [1, 2, 3, 4, 5].map(slot => ({
    slot, metric_code: ['sales_units', 'margin_runrate', 'turnover_buyback', 'hangers45_total', 'conversion_visit_to_deal'][slot - 1], plan: null,
  })),
  ...patch,
});
const setModel = (body: any, s = admin) => authed(s).post(`${base}/scoring`).send(body);
const setFocus = (body: any, s = admin) => authed(s).post(`${base}/focus`).send(body);
const overview = (s = rf) => authed(s).get(`${base}/overview?start=${PERIOD.start}&end=${PERIOD.end}`);

/** Публикует синтетический опубликованный срез напрямую, минуя загрузку файлов. */
async function publish(org: string, metric: string, value: number, unit = 'RUB') {
  const audit = (await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.publish','report_stage',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId, org, randomUUID(), randomUUID()])).rows[0].id;
  const network = (await pool.query("SELECT id FROM org_directory_units WHERE kind='NETWORK' LIMIT 1")).rows[0].id;
  const batch = (await pool.query(`INSERT INTO report_staging_batches(id,actor_user_id,grant_id,network_id,source_code,
    period,fingerprint,status,storage_state,parser_version,mapping_version)
    VALUES($1,$2,$3,$4,'QLIK_AGGREGATE_MANUAL','{}',$5,'QUARANTINE','WRITING','TEST_V1','UNRESOLVED_V1')
    RETURNING id`, [randomUUID(), admin.userId, rfGrant, network, randomBytes(32).toString('hex')])).rows[0].id;
  const preview = (await pool.query(`INSERT INTO report_fact_previews(id,batch_id,actor_user_id,review_version,
    review_hash,command,proposal,proposal_hash) VALUES($1,$2,$3,1,'h','{}','{}',$4) RETURNING id`,
  [randomUUID(), batch, admin.userId, randomBytes(32).toString('hex')])).rows[0].id;
  const pub = (await pool.query(`INSERT INTO report_fact_publications(id,preview_id,actor_user_id,grant_id,audit_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id`, [randomUUID(), preview, admin.userId, rfGrant, audit])).rows[0].id;
  const snap = (await pool.query(`INSERT INTO report_fact_snapshots(id,publication_id,org_unit_id,metric,period_start,
    period_end,value,unit,revision,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'{"source":"SYNTHETIC"}') RETURNING id`,
  [randomUUID(), pub, org, metric, PERIOD.start, PERIOD.end, value, unit])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_current(org_unit_id,metric,period_start,period_end,snapshot_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_unit_id,metric,period_start,period_end)
    DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`, [org, metric, PERIOD.start, PERIOD.end, snap]);
}

beforeAll(async () => {
  const b = await bootstrapFirstAdministrator({
    login: 'scoring_admin', fullName: 'Администратор балла · тест', password,
    reason: 'Synthetic isolated scoring administration', approvalReference: 'SYNTHETIC_SCORING_APPROVAL',
  });
  expect(b.grantId).toBeTruthy();
  admin = await login('scoring_admin', password); rf = await login('rf_a');
  branch = randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'SCORE_BETA','ORG_UNIT','ACTIVE','2020-01-01')`, [branch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал балла · тест','2020-01-01','Synthetic isolated scoring fixture')`, [branch]);
  rfGrant = (await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01') RETURNING id`, [rf.userId, branch])).rows[0].id;
  const audit = (await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId, branch, randomUUID(), randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['revenue','margin','planMargin','turnoverBuyout'],'SYNTHETIC_READ_FOR_SCORE',$2)`,
  [rfGrant, audit]);
  await publish(branch, 'planMargin', 100);
  await publish(branch, 'revenue', 100);
  await publish(branch, 'margin', 100);
  await publish(branch, 'turnoverBuyout', 1, 'PCT');
});
beforeEach(resetLimits);
afterAll(closePool);

describe('коэффициент месяца', () => {
  it('равен доле прошедших дней и не превышает единицу', () => {
    expect(monthProgress('2026-08-31')).toBe(1);
    expect(monthProgress('2026-08-15')).toBeCloseTo(15 / 31, 10);
    expect(() => monthProgress('2026-02-30')).toThrow();
  });
});

describe('расчёт балла без обращения к базе', () => {
  const base: ScoringModel = { ...(model() as any), id: 'synthetic', effective_to: null };
  it('не выдаёт ноль при отсутствии данных', () => {
    const r = computeBranchScore(base, new Map(), '2026-08-31');
    expect(r.score).toBeNull();
    expect(r.rag).toBe('NONE');
    expect(r.components.every(c => c.missing !== null)).toBe(true);
  });
  it('без настроенной модели не считает балл', () => {
    expect(computeBranchScore(null, new Map([['revenue', 100]]), '2026-08-31').rag).toBe('NONE');
  });
  it('ограничивает балл компонентом cap', () => {
    const r = computeBranchScore(base, new Map([['revenue', 1000], ['planMargin', 100]]), '2026-08-31');
    expect(r.components.find(c => c.metric === 'revenue')!.score).toBe(120);
  });
  it('учитывает стоп-фактор оборачиваемости', () => {
    const r = computeBranchScore(base, new Map([
      ['revenue', 100], ['margin', 100], ['planMargin', 100], ['turnoverBuyout', 0.5]]), '2026-08-31');
    expect(r.rag).toBe('RED');
    expect(r.reasons.some(s => s.includes('стоп-фактора'))).toBe(true);
  });
  it('даёт зелёный статус только при выполнении всех условий', () => {
    const r = computeBranchScore(base, new Map([
      ['revenue', 95], ['margin', 95], ['planMargin', 100], ['turnoverBuyout', 0.95]]), '2026-08-31');
    expect(r.rag).toBe('GREEN');
    expect(r.score).toBeCloseTo((95 * 30 + 95 * 25 + 95 * 15) / 70, 6);
  });
  it('не подтверждает зелёный без рассчитанной оборачиваемости', () => {
    const r = computeBranchScore(base, new Map([['revenue', 95], ['margin', 95], ['planMargin', 100]]), '2026-08-31');
    expect(r.rag).toBe('AMBER');
  });
  it('считает красным при двух слабых показателях', () => {
    const r = computeBranchScore(base, new Map([
      ['revenue', 90], ['margin', 60], ['planMargin', 100], ['turnoverBuyout', 0.6]]), '2026-08-31');
    expect(r.rag).toBe('RED');
  });
  it('применяет полосы конверсии', () => {
    const conv: ScoringModel = { ...base, weights: [
      { metric: 'creditShareFact', weight: 10, evaluation: 'CONVERSION_BANDS', plan_metric: null, rule_role: 'ORDINARY' }] };
    expect(computeBranchScore(conv, new Map([['creditShareFact', 18]]), '2026-08-31').components[0].score).toBe(110);
    expect(computeBranchScore(conv, new Map([['creditShareFact', 15]]), '2026-08-31').components[0].score).toBe(90);
    expect(computeBranchScore(conv, new Map([['creditShareFact', 10]]), '2026-08-31').components[0].score).toBe(50);
  });
  it('не считает run-rate при нулевом плане', () => {
    const r = computeBranchScore(base, new Map([['revenue', 100], ['planMargin', 0]]), '2026-08-31');
    expect(r.components.find(c => c.metric === 'revenue')!.missing).toBe('PLAN_NOT_POSITIVE');
  });
});

describe('настройка модели балла', () => {
  it('закрыта без права и открывается только явной выдачей', async () => {
    expect((await pool.query(
      "SELECT count(*)::int n FROM role_permissions WHERE permission_code='metric.scoring.manage'")).rows[0].n).toBe(0);
    expect((await setModel(model())).status).toBe(403);
    expect((await setFocus(focus())).status).toBe(403);
    await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.scoring.manage')");
    await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.focus.manage')");
    expect((await setModel(model())).status).toBe(201);
  });
  it('отклоняет неизвестный показатель и лишние поля', async () => {
    expect((await setModel(model({ weights: [
      { metric: 'unknownMetric', weight: 10, evaluation: 'RATIO_X100' }] }))).status).toBe(422);
    expect((await setModel({ ...model(), extra: 1 })).status).toBe(422);
  });
  it('требует показатель плана для run-rate и запрещает его иначе', async () => {
    expect((await setModel(model({ weights: [
      { metric: 'revenue', weight: 30, evaluation: 'RUN_RATE' }] }))).status).toBe(422);
    expect((await setModel(model({ weights: [
      { metric: 'turnoverBuyout', weight: 15, evaluation: 'RATIO_X100', plan_metric: 'planMargin' }] }))).status).toBe(422);
  });
  it('запрещает две метрики с одной ролью светофора', async () => {
    expect((await setModel(model({ weights: [
      { metric: 'revenue', weight: 30, evaluation: 'RUN_RATE', plan_metric: 'planMargin', rule_role: 'REVENUE' },
      { metric: 'margin', weight: 25, evaluation: 'RUN_RATE', plan_metric: 'planMargin', rule_role: 'REVENUE' },
    ] }))).status).toBe(422);
  });
  it('требует основание и корректные пороги', async () => {
    expect((await setModel(model({ reason: 'коротко' }))).status).toBe(422);
    expect((await setModel(model({ green_score_above: 10, red_score_below: 70 }))).status).toBe(422);
    expect((await setModel(model({ conversion_amber_from: 20 }))).status).toBe(422);
  });
  it('новая версия закрывает предыдущую и пишет аудит', async () => {
    const r = await setModel(model({ effective_from: '2026-09-01', score_cap: 130 }));
    expect(r.status).toBe(201);
    expect(r.body.previous_id).toBeTruthy();
    const rows = (await pool.query(`SELECT to_char(effective_to,'YYYY-MM-DD') t FROM scoring_models
      WHERE id=$1`, [r.body.previous_id])).rows;
    expect(rows[0].t).toBe('2026-09-01');
    expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE aggregate_type='metric_scoring'"))
      .rows[0].n).toBeGreaterThan(0);
    expect((await setModel(model({ effective_from: '2026-08-15' }))).status).toBe(422);
  });
  it('запрещает изменение сохранённой версии', async () => {
    const id = (await pool.query('SELECT id FROM scoring_models LIMIT 1')).rows[0].id;
    await expect(pool.query('UPDATE scoring_weights SET weight=1 WHERE model_id=$1', [id])).rejects.toThrow();
  });
});

describe('фокусы внимания месяца', () => {
  it('требуют ровно пять слотов и уникальных показателей', async () => {
    expect((await setFocus(focus({ slots: focus().slots.slice(0, 4) }))).status).toBe(422);
    const dup = focus().slots.map((s: any, i: number) => (i === 1 ? { ...s, metric_code: 'sales_units' } : s));
    expect((await setFocus(focus({ slots: dup }))).status).toBe(422);
  });
  it('отклоняют показатель вне каталога фокусов', async () => {
    const bad = focus().slots.map((s: any, i: number) => (i === 0 ? { ...s, metric_code: 'no_such_focus' } : s));
    expect((await setFocus(focus({ slots: bad }))).status).toBe(404);
  });
  it('сохраняют версию с планом вручную и закрывают предыдущую', async () => {
    expect((await setFocus(focus())).status).toBe(201);
    const second = await setFocus(focus({
      effective_from: '2026-08-10',
      slots: focus().slots.map((s: any, i: number) => (i === 0 ? { ...s, plan: 1000 } : s)),
    }));
    expect(second.status).toBe(201);
    expect(second.body.previous_id).toBeTruthy();
    expect((await pool.query(`SELECT plan::text plan FROM focus_slots WHERE configuration_id=$1 AND slot=1`,
      [second.body.id])).rows[0].plan).toBe('1000');
    expect((await setFocus(focus({ effective_from: '2026-08-05' }))).status).toBe(422);
  });
  it('перечисляют каталог и действующие версии', async () => {
    const r = await authed(admin).get(`${base}/focus?month=2026-08-01`);
    expect(r.status).toBe(200);
    expect(r.body.slot_count).toBe(5);
    expect(r.body.catalog.length).toBeGreaterThanOrEqual(5);
    expect(r.body.configurations.length).toBe(1);
  });
});

describe('обзор сети', () => {
  it('показывает балл филиала, сводку сети и фокусы без подмены факта', async () => {
    const r = await overview();
    expect(r.status).toBe(200);
    expect(r.body.scoring.configured).toBe(true);
    const b = r.body.branches.find((x: any) => x.org_unit_id === branch);
    expect(b.score).not.toBeNull();
    expect(['GREEN', 'AMBER', 'RED']).toContain(b.score_rag);
    expect(r.body.network.branches_with_score).toBe(1);
    expect(r.body.network.average_score).toBeCloseTo(b.score, 6);
    expect(r.body.focus.configured).toBe(true);
    expect(r.body.focus.slots).toHaveLength(5);
    expect(r.body.focus.slots.every((s: any) => s.fact === null
      && s.fact_basis === 'NOT_MAPPED_TO_PUBLISHED_METRIC')).toBe(true);
  });
});
