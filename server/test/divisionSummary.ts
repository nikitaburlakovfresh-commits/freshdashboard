// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,authed,login,Session } from './helpers';

let admin:Session,rf:Session,rmUser:Session,division:string,other:string;
let a:string,b:string,c:string,grantA:string,grantB:string,grantC:string,network:string;
const base='/api/v1/metrics';
const password=randomBytes(32).toString('base64url');
const PERIOD={start:'2026-08-01',end:'2026-08-31'};
const summary=(s:Session,q=`?start=${PERIOD.start}&end=${PERIOD.end}`)=>
  authed(s).get(`${base}/divisions/deviations${q}`);

async function unit(code:string,name:string,kind:string,parent:string|null) {
  const id=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,$2,$3,'ACTIVE','2020-01-01')`,[id,code,kind]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,$2,'2020-01-01','Synthetic isolated division summary fixture')`,[id,name]);
  if(parent!==null)await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,
    effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic isolated division summary fixture')`,
  [id,parent]);
  return id;
}

/**
 * Выдаёт допуск READ к перечню показателей филиала и возвращает grant_id.
 * Роль допуска намеренно не REGIONAL_MANAGER: назначение РМ проверяется отдельно,
 * иначе вакансия филиала была бы скрыта техническим грантом доступа.
 */
async function readAccess(branch:string,metrics:string[],user=admin.userId) {
  const grant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[user,branch])).rows[0].id;
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',$2,'SYNTHETIC_READ_FOR_DIVISION',$3)`,[grant,metrics,audit]);
  return grant as string;
}

async function publish(branch:string,grant:string,metric:string,value:number,unitCode='COUNT') {
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.publish','report_stage',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  const batch=(await pool.query(`INSERT INTO report_staging_batches(id,actor_user_id,grant_id,network_id,source_code,
    period,fingerprint,status,storage_state,parser_version,mapping_version)
    VALUES($1,$2,$3,$4,'QLIK_AGGREGATE_MANUAL','{}',$5,'QUARANTINE','WRITING','TEST_V1','UNRESOLVED_V1')
    RETURNING id`,[randomUUID(),admin.userId,grant,network,randomBytes(32).toString('hex')])).rows[0].id;
  const preview=(await pool.query(`INSERT INTO report_fact_previews(id,batch_id,actor_user_id,review_version,
    review_hash,command,proposal,proposal_hash) VALUES($1,$2,$3,1,'h','{}','{}',$4) RETURNING id`,
  [randomUUID(),batch,admin.userId,randomBytes(32).toString('hex')])).rows[0].id;
  const pub=(await pool.query(`INSERT INTO report_fact_publications(id,preview_id,actor_user_id,grant_id,audit_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[randomUUID(),preview,admin.userId,grant,audit])).rows[0].id;
  const revision=(await pool.query(`SELECT COALESCE(max(revision),0)+1 r FROM report_fact_snapshots
    WHERE org_unit_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4`,
  [branch,metric,PERIOD.start,PERIOD.end])).rows[0].r;
  const snap=(await pool.query(`INSERT INTO report_fact_snapshots(id,publication_id,org_unit_id,metric,period_start,
    period_end,value,unit,revision,provenance)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{"source":"SYNTHETIC"}') RETURNING id`,
  [randomUUID(),pub,branch,metric,PERIOD.start,PERIOD.end,value,unitCode,revision])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_current(org_unit_id,metric,period_start,period_end,snapshot_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_unit_id,metric,period_start,period_end)
    DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,[branch,metric,PERIOD.start,PERIOD.end,snap]);
  return snap as string;
}

async function openTask(branch:string,metric:string,due:string) {
  const snapshot=(await pool.query(`SELECT snapshot_id FROM report_fact_current
    WHERE org_unit_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4`,
  [branch,metric,PERIOD.start,PERIOD.end])).rows[0].snapshot_id;
  const res=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:branch,metric,period_start:PERIOD.start,period_end:PERIOD.end,snapshot_id:snapshot,
      expected_rag:'RED',template_code:'pilot_task_v1',title:`Отклонение ${metric}: разобрать причины`,
      due_at:due,reason:'Synthetic deviation follow-up for division summary suite',assignee_user_id:null});
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async()=>{
  const boot=await bootstrapFirstAdministrator({login:'divsum_admin',
    fullName:'Руководитель дивизиона · тест',password,
    reason:'Synthetic isolated division summary administration',
    approvalReference:'SYNTHETIC_DIVSUM_APPROVAL'});
  expect(boot.grantId).toBeTruthy();
  // globalSetup снимает права SUPER_ADMIN: возвращаем управление настройками портала.
  await pool.query(`INSERT INTO role_permissions(role_code,permission_code)
    VALUES('SUPER_ADMIN','portal.setting.manage') ON CONFLICT DO NOTHING`);
  admin=await login('divsum_admin',password);rf=await login('rf_a');rmUser=await login('rm_b');
  // Только не-демо сеть: демо-контур нельзя смешивать с боевой структурой.
  network=(await pool.query(`SELECT id FROM org_directory_units
    WHERE kind='NETWORK' AND NOT is_demo LIMIT 1`)).rows[0].id;
  division=await unit('DIVSUM_DIV','Дивизион Восток · тест','DIVISION',network);
  other=await unit('DIVSUM_DIV2','Дивизион Запад · тест','DIVISION',network);
  a=await unit('DIVSUM_A','Филиал А · тест','ORG_UNIT',division);
  b=await unit('DIVSUM_B','Филиал Б · тест','ORG_UNIT',division);
  c=await unit('DIVSUM_C','Филиал В · тест','ORG_UNIT',other);
  grantA=await readAccess(a,['sales','aged']);
  grantB=await readAccess(b,['sales','aged']);
  grantC=await readAccess(c,['sales']);
  // Действующий региональный менеджер есть только у филиала А: у Б вакансия.
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2020-01-01')`,[rmUser.userId,a]);
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01')`,[rf.userId,a]);
  // Постановщику задачи нужна роль РМ на филиале А; действующим РМ считается
  // назначение с более ранней датой вступления в силу.
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2021-01-01')`,[admin.userId,a]);
  await pool.query(`INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage')
    ON CONFLICT DO NOTHING`);
  const th=(patch:any)=>authed(admin).post(`${base}/thresholds`).send({scope_kind:'NETWORK',basis:'ABSOLUTE',
    unit:'COUNT',effective_from:'2026-01-01',reason:'Synthetic approved threshold for division summary',...patch});
  expect((await th({metric:'sales',direction:'HIGHER_IS_BETTER',green_from:100,amber_from:80})).status).toBe(201);
  expect((await th({metric:'aged',direction:'LOWER_IS_BETTER',green_from:10,amber_from:30})).status).toBe(201);
  // Филиал А: красный sales без задачи и жёлтый aged. Филиал Б: красный sales.
  // Филиал В в другом дивизионе. Публикации по aged филиала Б нет вовсе.
  await publish(a,grantA,'sales',40);
  await publish(a,grantA,'aged',20);
  await publish(b,grantB,'sales',30);
  await publish(c,grantC,'sales',150);
});
beforeEach(resetLimits);
afterAll(closePool);

test('DS-01 сводка требует сессии, допуска к показателям и точного периода',async()=>{
  expect((await request(app).get(`${base}/divisions/deviations`)).status).toBe(401);
  // У РФ филиала нет отдельного допуска к опубликованным показателям.
  expect((await summary(rf)).status).toBe(403);
  expect((await summary(admin,'?start=2026-08-01')).status).toBe(422);
  expect((await summary(admin,'?start=2026-08-31&end=2026-08-01')).status).toBe(422);
  expect((await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&x=1`)).status).toBe(422);
  expect((await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=not-a-uuid`)).status).toBe(422);
  expect((await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${randomUUID()}`)).status).toBe(404);
});

test('DS-02 филиалы группируются по дивизиону с разбором по показателям',async()=>{
  const res=await summary(admin);
  expect(res.status).toBe(200);
  expect(res.body.mode).toBe('PUBLISHED_SOURCE_AGGREGATES');
  expect(res.body.thresholds_configured).toBe(true);
  const east=res.body.divisions.find((d:any)=>d.division_id===division);
  expect(east.division_name).toBe('Дивизион Восток · тест');
  expect(east.branches_total).toBe(2);
  expect(east.red).toBe(2);
  expect(east.by_metric.sales).toMatchObject({red:2,amber:0});
  // Дивизионы упорядочены по остроте: сначала тот, где больше красных.
  expect(res.body.divisions[0].division_id).toBe(division);
  const west=res.body.divisions.find((d:any)=>d.division_id===other);
  expect(west.red).toBe(0);
  expect(west.green).toBe(1);
  expect(res.body.totals).toMatchObject({divisions:2,branches:3,red:2,amber:0});
});

test('DS-03 отсутствие публикации показано отдельно и не приравнено к нулю',async()=>{
  const res=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  expect(res.body.divisions).toHaveLength(1);
  const branch=res.body.divisions[0].branches.find((x:any)=>x.org_unit_id===b);
  expect(branch.metrics_accessible).toBe(2);
  expect(branch.metrics_published).toEqual(['sales']);
  // По aged данных нет: показатель в перечне отсутствующих, а не зелёный и не ноль.
  expect(branch.metrics_missing).toEqual(['aged']);
  expect(branch.red).toEqual(['sales']);
  expect(branch.amber).toEqual([]);
  // Период без публикаций вообще не даёт ни красных, ни зелёных.
  const empty=await summary(admin,'?start=2026-07-01&end=2026-07-31');
  expect(empty.body.totals).toMatchObject({red:0,amber:0,deviations_without_task:0});
  expect(empty.body.totals.branches_without_data).toBe(3);
});

test('DS-04 отклонения без поставленной задачи видны отдельно от задач со сроком',async()=>{
  const before=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  // Три отклонения без задачи: красный sales в двух филиалах и жёлтый aged филиала А.
  expect(before.body.divisions[0].deviations_without_task).toBe(3);
  expect(before.body.divisions[0].tasks_open).toBe(0);
  const past=new Date(Date.now()-24*3600*1000).toISOString().replace(/\.\d+Z$/,'Z');
  await openTask(a,'sales',past);
  const after=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  const d=after.body.divisions[0];
  expect(d.deviations_without_task).toBe(2);
  expect(d.tasks_open).toBe(1);
  expect(d.tasks_overdue).toBe(1);
  expect(d.tasks_due_soon).toBe(0);
  expect(after.body.due_soon_hours).toBeGreaterThan(0);
});

test('DS-05 разрез по региональным менеджерам показывает вакансию явно',async()=>{
  const res=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  const managers=res.body.divisions[0].managers;
  expect(managers).toHaveLength(2);
  const named=managers.find((m:any)=>m.user_id===rmUser.userId);
  expect(named.full_name).toBeTruthy();
  expect(named.is_vacant).toBe(false);
  expect(named.branch_ids).toEqual([a]);
  expect(named.tasks_overdue).toBe(1);
  const vacant=managers.find((m:any)=>m.is_vacant);
  expect(vacant.user_id).toBeNull();
  expect(vacant.full_name).toBeNull();
  expect(vacant.branch_ids).toEqual([b]);
  expect(vacant.red).toBe(1);
});

test('DS-06 сводка не выходит за пределы допусков пользователя',async()=>{
  // Отзыв допуска к филиалу В убирает его дивизион из сводки целиком.
  await pool.query('UPDATE report_fact_access SET revoked_at=now() WHERE grant_id=$1',[grantC]);
  const res=await summary(admin);
  expect(res.body.divisions.some((d:any)=>d.division_id===other)).toBe(false);
  expect(res.body.totals.branches).toBe(2);
  expect((await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${other}`)).status).toBe(404);
  // Показатель вне допуска не попадает в разбор даже при наличии публикации.
  await pool.query("UPDATE report_fact_access SET metrics=ARRAY['sales'] WHERE grant_id=$1",[grantA]);
  const narrowed=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  const branchA=narrowed.body.divisions[0].branches.find((x:any)=>x.org_unit_id===a);
  expect(branchA.metrics_accessible).toBe(1);
  expect(branchA.metrics_published).toEqual(['sales']);
  expect(branchA.metrics_missing).toEqual([]);
});

/** Изменение веса приоритетности риска внутри портала, с основанием. */
async function setWeight(key:string,value:number) {
  const res=await authed(admin).post(`${base}/portal-settings`).set('Idempotency-Key',randomUUID())
    .send({key,value,reason:'Synthetic risk priority tuning for division summary suite'});
  expect(res.status).toBe(200);
}

test('DS-07 приоритетность риска задаётся настройкой портала, а не кодом',async()=>{
  const before=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  const w=before.body.risk_weights;
  expect(w.risk_weight_red).toBeGreaterThan(0);
  const d=before.body.divisions[0];
  // Оценка риска считается ровно по утверждённым весам, без скрытых коэффициентов.
  const named=d.managers.find((m:any)=>m.user_id===rmUser.userId);
  expect(named.risk_score).toBe(named.red*w.risk_weight_red+named.amber*w.risk_weight_amber
    +named.deviations_without_task*w.risk_weight_deviation_without_task
    +named.tasks_overdue*w.risk_weight_task_overdue
    +named.branches_without_data*w.risk_weight_branch_without_data);
  expect(d.branches[0].risk_score).toBeGreaterThanOrEqual(d.branches[1].risk_score);

  // Филиал без опубликованных данных в дивизионе Запад: доступ есть, публикаций нет.
  const empty=await unit('DIVSUM_D','Филиал Г · тест','ORG_UNIT',other);
  await readAccess(empty,['sales']);
  const byColour=await summary(admin);
  expect(byColour.body.divisions[0].division_id).toBe(division);

  // Руководитель утверждает, что отсутствие данных важнее цвета: порядок меняется,
  // а сами показатели остаются прежними.
  await setWeight('risk_weight_red',0);
  await setWeight('risk_weight_amber',0);
  await setWeight('risk_weight_deviation_without_task',0);
  await setWeight('risk_weight_task_overdue',0);
  await setWeight('risk_weight_branch_without_data',1000);
  const byData=await summary(admin);
  expect(byData.body.divisions[0].division_id).toBe(other);
  expect(byData.body.divisions[0].branches_without_data).toBe(1);
  expect(byData.body.totals.red).toBe(byColour.body.totals.red);

  // История изменений настройки сохраняется вместе с основанием.
  const hist=await authed(admin).get(`${base}/portal-settings`);
  expect(hist.body.history.some((h:any)=>h.key==='risk_weight_branch_without_data'
    &&Number(h.value_after)===1000&&h.reason.length>=16)).toBe(true);

  await setWeight('risk_weight_red',100);
  await setWeight('risk_weight_amber',40);
  await setWeight('risk_weight_deviation_without_task',25);
  await setWeight('risk_weight_task_overdue',60);
  await setWeight('risk_weight_branch_without_data',15);
  expect((await summary(admin)).body.divisions[0].division_id).toBe(division);
});

test('DS-08 задача ставится прямо из строки сводки по её же основанию',async()=>{
  const res=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  const row=res.body.divisions[0].branches.find((x:any)=>x.org_unit_id===b);
  const dev=row.open_deviations.find((o:any)=>!o.has_task);
  expect(dev).toMatchObject({metric:'sales',rag:'RED'});
  expect(dev.snapshot_id).toBeTruthy();
  expect(dev.work_item_id).toBeNull();

  // Постановка задачи требует полномочий на филиале: без них строка сводки
  // остаётся видимой, но задача не создаётся.
  const denied=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:b,metric:dev.metric,period_start:PERIOD.start,period_end:PERIOD.end,
      snapshot_id:dev.snapshot_id,expected_rag:dev.rag,template_code:'pilot_task_v1',
      title:'Отклонение продаж: без полномочий',
      due_at:new Date(Date.now()+48*3600*1000).toISOString().replace(/\.\d+Z$/,'Z'),
      reason:'Attempt without branch authority from division summary row',assignee_user_id:null});
  expect(denied.status).toBe(403);
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2021-01-01')`,[admin.userId,b]);

  const created=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:b,metric:dev.metric,period_start:PERIOD.start,period_end:PERIOD.end,
      snapshot_id:dev.snapshot_id,expected_rag:dev.rag,template_code:'pilot_task_v1',
      title:'Отклонение продаж: разобрать причины',
      due_at:new Date(Date.now()+48*3600*1000).toISOString().replace(/\.\d+Z$/,'Z'),
      reason:'Task opened directly from division deviation summary row',assignee_user_id:null});
  expect(created.status).toBe(201);

  const after=await summary(admin,`?start=${PERIOD.start}&end=${PERIOD.end}&division=${division}`);
  const updated=after.body.divisions[0].branches.find((x:any)=>x.org_unit_id===b);
  const linked=updated.open_deviations.find((o:any)=>o.metric==='sales');
  expect(linked.has_task).toBe(true);
  expect(linked.work_item_id).toBe(created.body.work_item_id);
  expect(linked.task_status).toBeTruthy();
  expect(updated.deviations_without_task).toBe(row.deviations_without_task-1);
  expect(updated.tasks_due_soon).toBe(1);

  // Повторная постановка по тому же основанию не создаёт вторую задачу.
  const again=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:b,metric:dev.metric,period_start:PERIOD.start,period_end:PERIOD.end,
      snapshot_id:dev.snapshot_id,expected_rag:dev.rag,template_code:'pilot_task_v1',
      title:'Отклонение продаж: повтор',
      due_at:new Date(Date.now()+48*3600*1000).toISOString().replace(/\.\d+Z$/,'Z'),
      reason:'Duplicate attempt from division deviation summary row',assignee_user_id:null});
  expect(again.body.code).toBe('DEVIATION_CONFLICT');

  // Устаревшее основание из открытой сводки: показатель переопубликован — задача не ставится.
  await publish(b,grantB,'sales',25);
  const stale=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:b,metric:'sales',period_start:PERIOD.start,period_end:PERIOD.end,
      snapshot_id:dev.snapshot_id,expected_rag:'RED',template_code:'pilot_task_v1',
      title:'Отклонение продаж: устаревшее основание',
      due_at:new Date(Date.now()+48*3600*1000).toISOString().replace(/\.\d+Z$/,'Z'),
      reason:'Stale snapshot attempt from division deviation summary row',assignee_user_id:null});
  expect(stale.status).not.toBe(201);
  expect(stale.body.code).toBe('DEVIATION_CONFLICT');
});
