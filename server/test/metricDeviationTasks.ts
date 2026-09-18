// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,authed,login,Session,ORIGIN } from './helpers';

let admin:Session,rf:Session,branch:string,rmGrant:string,rfGrant:string;
let snapshots:Record<string,string>={};
const base='/api/v1/metrics';
const password=randomBytes(32).toString('base64url');
const PERIOD={start:'2026-08-01',end:'2026-08-31'};
const DUE='2026-09-30T09:00:00Z';

const key=()=>randomUUID();
const post=(body:any,s=admin,k=key())=>authed(s).post(`${base}/deviation-tasks`).set('Idempotency-Key',k).send(body);
const command=(patch:any={})=>({org_unit_id:branch,metric:'sales',period_start:PERIOD.start,period_end:PERIOD.end,
  snapshot_id:snapshots.sales,expected_rag:'RED',template_code:'pilot_task_v1',
  title:'Отклонение продаж: разобрать причины',due_at:DUE,
  reason:'Synthetic deviation follow-up for isolated suite',...patch});

async function publish(org:string,metric:string,value:number,unit='COUNT') {
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.publish','report_stage',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,org,randomUUID(),randomUUID()])).rows[0].id;
  const network=(await pool.query("SELECT id FROM org_directory_units WHERE kind='NETWORK' LIMIT 1")).rows[0].id;
  const batch=(await pool.query(`INSERT INTO report_staging_batches(id,actor_user_id,grant_id,network_id,source_code,
    period,fingerprint,status,storage_state,parser_version,mapping_version)
    VALUES($1,$2,$3,$4,'QLIK_AGGREGATE_MANUAL','{}',$5,'QUARANTINE','WRITING','TEST_V1','UNRESOLVED_V1')
    RETURNING id`,[randomUUID(),admin.userId,rmGrant,network,randomBytes(32).toString('hex')])).rows[0].id;
  const preview=(await pool.query(`INSERT INTO report_fact_previews(id,batch_id,actor_user_id,review_version,
    review_hash,command,proposal,proposal_hash) VALUES($1,$2,$3,1,'h','{}','{}',$4) RETURNING id`,
  [randomUUID(),batch,admin.userId,randomBytes(32).toString('hex')])).rows[0].id;
  const pub=(await pool.query(`INSERT INTO report_fact_publications(id,preview_id,actor_user_id,grant_id,audit_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[randomUUID(),preview,admin.userId,rmGrant,audit])).rows[0].id;
  const revision=(await pool.query(`SELECT COALESCE(max(revision),0)+1 r FROM report_fact_snapshots
    WHERE org_unit_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4`,
  [org,metric,PERIOD.start,PERIOD.end])).rows[0].r;
  const snap=(await pool.query(`INSERT INTO report_fact_snapshots(id,publication_id,org_unit_id,metric,period_start,
    period_end,value,unit,revision,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{"source":"SYNTHETIC"}') RETURNING id`,
  [randomUUID(),pub,org,metric,PERIOD.start,PERIOD.end,value,unit,revision])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_current(org_unit_id,metric,period_start,period_end,snapshot_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_unit_id,metric,period_start,period_end)
    DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,[org,metric,PERIOD.start,PERIOD.end,snap]);
  return snap as string;
}

async function setThreshold(patch:any={}) {
  return authed(admin).post(`${base}/thresholds`).send({metric:'sales',scope_kind:'NETWORK',
    direction:'HIGHER_IS_BETTER',basis:'ABSOLUTE',unit:'COUNT',green_from:100,amber_from:80,
    effective_from:'2026-01-01',reason:'Synthetic approved threshold for deviation suite',...patch});
}

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'deviation_admin',fullName:'Администратор отклонений · тест',
    password,reason:'Synthetic isolated deviation administration',approvalReference:'SYNTHETIC_DEVIATION_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('deviation_admin',password);rf=await login('rf_a');
  branch=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'DEV_TASK_BETA','ORG_UNIT','ACTIVE','2020-01-01')`,[branch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал отклонений · тест','2020-01-01','Synthetic isolated deviation fixture')`,[branch]);
  rmGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[admin.userId,branch])).rows[0].id;
  rfGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[rf.userId,branch])).rows[0].id;
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['sales','margin','plan'],'SYNTHETIC_READ_FOR_DEVIATION',$2)`,[rmGrant,audit]);
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage') ON CONFLICT DO NOTHING");
  snapshots.sales=await publish(branch,'sales',40);
  snapshots.margin=await publish(branch,'margin',500,'RUB');
  expect((await setThreshold()).status).toBe(201);
});
beforeEach(resetLimits);
afterAll(closePool);

test('MD-01 переход требует сессии, Origin, CSRF и ключа идемпотентности',async()=>{
  expect((await request(app).post(`${base}/deviation-tasks`).send(command())).status).toBe(401);
  expect((await request(app).post(`${base}/deviation-tasks`).set('Cookie',admin.cookie)
    .set('X-CSRF-Token',admin.csrf).set('Idempotency-Key',key()).send(command())).status).toBe(403);
  expect((await request(app).post(`${base}/deviation-tasks`).set('Cookie',admin.cookie).set('Origin',ORIGIN)
    .set('Idempotency-Key',key()).send(command())).status).toBe(403);
  expect((await authed(admin).post(`${base}/deviation-tasks`).send(command())).status).toBe(422);
});

test.each([
  {expected_rag:'GREEN'},{expected_rag:'NONE'},{metric:'unknown'},{metric:'kso'},
  {period_start:'2026-02-30'},{period_start:'2026-09-01'},{org_unit_id:'not-a-uuid'},
  {snapshot_id:'not-a-uuid'},{title:''},{title:'x'.repeat(201)},{reason:'короткое'},
  {template_code:'PILOT'},{template_code:'personal_daily_rf_v1'},{due_at:'2026-09-30 09:00'},
  {assignee_user_id:'not-a-uuid'},{extra:'field'} as any,
])('MD-02 некорректная команда не создаёт задачу %j',async patch=>{
  const before=(await pool.query('SELECT count(*)::int n FROM metric_deviation_tasks')).rows[0].n;
  const res=await post(command(patch));
  // 403 — показатель вне допуска пользователя, 404 — нет опубликованного значения.
  expect([422,404,403]).toContain(res.status);
  expect((await pool.query('SELECT count(*)::int n FROM metric_deviation_tasks')).rows[0].n).toBe(before);
});

test('MD-03 задача создаётся только по проверенному на сервере отклонению',async()=>{
  const res=await post(command());
  expect(res.status).toBe(201);
  expect(res.body.rag).toBe('RED');
  expect(res.body.observed_value).toBe(40);
  expect(res.body.assigned).toBe(false);
  const link=(await pool.query(`SELECT d.*,w.status,w.title,w.org_unit_id w_org FROM metric_deviation_tasks d
    JOIN work_items w ON w.id=d.work_item_id WHERE d.id=$1`,[res.body.deviation_task_id])).rows[0];
  expect(link.threshold_id).toBe(res.body.threshold_id);
  expect(link.snapshot_id).toBe(snapshots.sales);
  expect(link.status).toBe('DRAFT');
  expect(link.w_org).toBe(branch);
  const audit=(await pool.query("SELECT action,aggregate_type,reason FROM audit_log WHERE id=$1",[res.body.audit_id])).rows[0];
  expect(audit.aggregate_type).toBe('metric_deviation');
  expect(audit.action).toBe('metric.deviation.task_created');
  expect(audit.reason).toBe('Synthetic deviation follow-up for isolated suite');
  expect((await pool.query("SELECT count(*)::int n FROM outbox_events WHERE event_type='metric.deviation.task_created'"))
    .rows[0].n).toBeGreaterThan(0);
});

test('MD-04 повторная постановка по тому же отклонению отклоняется со ссылкой на задачу',async()=>{
  const res=await post(command({title:'Повторная задача по тому же отклонению'}));
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('DEVIATION_CONFLICT');
  expect(res.body.details.work_item_id).toBeTruthy();
});

test('MD-05 связь неизменяема: основание задачи нельзя переписать',async()=>{
  const row=(await pool.query('SELECT id FROM metric_deviation_tasks LIMIT 1')).rows[0];
  await expect(pool.query('UPDATE metric_deviation_tasks SET rag=$2 WHERE id=$1',[row.id,'AMBER'])).rejects.toThrow();
  await expect(pool.query('DELETE FROM metric_deviation_tasks WHERE id=$1',[row.id])).rejects.toThrow();
});

test('MD-06 отсутствие отклонения, порога и данных задачу не создаёт',async()=>{
  // Показатель в зелёной зоне: отклонения нет.
  const green=await publish(branch,'sales',150);
  expect((await post(command({snapshot_id:green}))).status).toBe(409);
  // Показатель без настроенного порога: отклонение не определено.
  expect((await post(command({metric:'margin',snapshot_id:snapshots.margin,expected_rag:'RED'}))).status).toBe(409);
  // Устаревшая версия снимка: сетку нужно перечитать.
  expect((await post(command({snapshot_id:snapshots.sales}))).status).toBe(409);
  // Период без опубликованного значения.
  expect((await post(command({period_start:'2026-07-01',period_end:'2026-07-31',
    snapshot_id:green}))).status).toBe(404);
  await publish(branch,'sales',40);
});

test('MD-07 без доступа к показателям филиала переход закрыт',async()=>{
  const res=await authed(rf).post(`${base}/deviation-tasks`).set('Idempotency-Key',key()).send(command());
  expect(res.status).toBe(403);
});

test('MD-08 ответственный назначается вместе с постановкой задачи',async()=>{
  const current=(await pool.query(`SELECT snapshot_id FROM report_fact_current
    WHERE org_unit_id=$1 AND metric='sales' AND period_start=$2`,[branch,PERIOD.start])).rows[0].snapshot_id;
  const res=await post(command({snapshot_id:current,assignee_user_id:rf.userId,
    title:'Отклонение продаж: поручение РФ'}));
  expect(res.status).toBe(201);
  expect(res.body.assigned).toBe(true);
  expect(res.body.assignee_user_id).toBe(rf.userId);
  const wi=(await pool.query('SELECT status,assignee_user_id FROM work_items WHERE id=$1',[res.body.work_item_id])).rows[0];
  expect(wi.status).toBe('ASSIGNED');
  expect(wi.assignee_user_id).toBe(rf.userId);
});

test('MD-09 сетка и перечень показывают поставленную задачу без пересчёта значений',async()=>{
  const grid=await authed(admin).get(`${base}/overview?start=${PERIOD.start}&end=${PERIOD.end}`);
  expect(grid.status).toBe(200);
  const cell=grid.body.branches.find((b:any)=>b.org_unit_id===branch).metrics.find((m:any)=>m.metric==='sales');
  expect(cell.snapshot_id).toBeTruthy();
  expect(cell.deviation_task).not.toBeNull();
  expect(cell.deviation_task.status).toBe('ASSIGNED');
  const list=await authed(admin).get(`${base}/deviation-tasks?start=${PERIOD.start}&end=${PERIOD.end}`);
  expect(list.status).toBe(200);
  expect(list.body.items.length).toBeGreaterThanOrEqual(2);
  expect(list.body.items.every((i:any)=>i.org_unit_id===branch)).toBe(true);
  expect((await authed(rf).get(`${base}/deviation-tasks?start=${PERIOD.start}&end=${PERIOD.end}`)).status).toBe(403);
  expect((await authed(admin).get(`${base}/deviation-tasks?start=2026-02-30&end=${PERIOD.end}`)).status).toBe(422);
  expect((await authed(admin).get(`${base}/deviation-tasks?start=${PERIOD.start}&end=${PERIOD.end}&x=1`)).status).toBe(422);
});
