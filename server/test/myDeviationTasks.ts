// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,authed,login,Session } from './helpers';

let admin:Session,rf:Session,other:Session,branch:string,rmGrant:string;
const base='/api/v1/metrics';
const password=randomBytes(32).toString('base64url');
const PERIOD={start:'2026-08-01',end:'2026-08-31'};
const mine=(s:Session,q='')=>authed(s).get(`${base}/deviation-tasks/mine${q}`);

async function publish(metric:string,value:number,unit='COUNT') {
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.publish','report_stage',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
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
  [branch,metric,PERIOD.start,PERIOD.end])).rows[0].r;
  const snap=(await pool.query(`INSERT INTO report_fact_snapshots(id,publication_id,org_unit_id,metric,period_start,
    period_end,value,unit,revision,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'{"source":"SYNTHETIC"}') RETURNING id`,
  [randomUUID(),pub,branch,metric,PERIOD.start,PERIOD.end,value,unit,revision])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_current(org_unit_id,metric,period_start,period_end,snapshot_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_unit_id,metric,period_start,period_end)
    DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,[branch,metric,PERIOD.start,PERIOD.end,snap]);
  return snap as string;
}

/** Ставит задачу по текущему отклонению и назначает ответственного. */
async function openTask(metric:string,due:string,assign=true) {
  const snapshot=(await pool.query(`SELECT snapshot_id FROM report_fact_current
    WHERE org_unit_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4`,
  [branch,metric,PERIOD.start,PERIOD.end])).rows[0].snapshot_id;
  const res=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:branch,metric,period_start:PERIOD.start,period_end:PERIOD.end,snapshot_id:snapshot,
      expected_rag:'RED',template_code:'pilot_task_v1',title:`Отклонение ${metric}: разобрать причины`,
      due_at:due,reason:'Synthetic deviation follow-up for assignee screen suite',
      assignee_user_id:assign?rf.userId:null});
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'mine_admin',fullName:'Администратор задач · тест',password,
    reason:'Synthetic isolated assignee screen administration',approvalReference:'SYNTHETIC_MINE_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('mine_admin',password);rf=await login('rf_a');other=await login('rf_b');
  branch=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'MINE_BETA','ORG_UNIT','ACTIVE','2020-01-01')`,[branch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал ответственного · тест','2020-01-01','Synthetic isolated assignee fixture')`,[branch]);
  rmGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[admin.userId,branch])).rows[0].id;
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01')`,[rf.userId,branch]);
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['sales','aged'],'SYNTHETIC_READ_FOR_MINE',$2)`,[rmGrant,audit]);
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage') ON CONFLICT DO NOTHING");
  const th=(patch:any)=>authed(admin).post(`${base}/thresholds`).send({scope_kind:'NETWORK',basis:'ABSOLUTE',
    unit:'COUNT',effective_from:'2026-01-01',reason:'Synthetic approved threshold for assignee screen',...patch});
  expect((await th({metric:'sales',direction:'HIGHER_IS_BETTER',green_from:100,amber_from:80})).status).toBe(201);
  expect((await th({metric:'aged',direction:'LOWER_IS_BETTER',green_from:10,amber_from:30})).status).toBe(201);
  await publish('sales',40);
  await publish('aged',50);
});
beforeEach(resetLimits);
afterAll(closePool);

test('MY-01 экран требует сессии и не требует допуска к показателям',async()=>{
  expect((await request(app).get(`${base}/deviation-tasks/mine`)).status).toBe(401);
  const res=await mine(rf);
  expect(res.status).toBe(200);
  expect(res.body.items).toEqual([]);
  expect(res.body.counts).toEqual({total:0,overdue:0,due_soon:0,blocked:0});
});

test.each(['?state=CLOSED','?x=1','?state=open'])('MY-02 некорректный фильтр отклоняется %s',async q=>{
  expect((await mine(rf,q)).status).toBe(422);
});

test('MY-03 ответственный видит свои задачи с основанием, но без цифр вне допуска',async()=>{
  const task=await openTask('sales','2026-09-30T09:00:00Z');
  const res=await mine(rf);
  expect(res.status).toBe(200);
  const item=res.body.items.find((i:any)=>i.work_item_id===task.work_item_id);
  expect(item.branch_name).toBe('Филиал ответственного · тест');
  expect(item.metric_name).toBeTruthy();
  expect(item.rag).toBe('RED');
  expect(item.reason).toMatch(/assignee screen/);
  expect(item.status).toBe('ASSIGNED');
  // Отдельного допуска к показателям у РФ нет: цифры не раскрываются.
  expect(item.values_visible).toBe(false);
  expect(item.observed_value).toBeNull();
  expect(item.basis_value).toBeNull();
  expect(item.unit).toBeNull();
  expect(item.basis).toBeTruthy();
});

test('MY-04 задачи чужого ответственного не видны',async()=>{
  const res=await mine(other);
  expect(res.status).toBe(200);
  expect(res.body.items).toEqual([]);
  const admins=await mine(admin);
  expect(admins.body.items).toEqual([]);
});

test('MY-05 руководителю с допуском цифры основания раскрываются',async()=>{
  // Тот же перечень, но для пользователя с READ на sales: назначаем задачу ему.
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01')`,[admin.userId,branch]);
  const task=await openTask('aged','2026-09-29T09:00:00Z',false);
  const wi=(await pool.query('SELECT entity_version FROM work_items WHERE id=$1',[task.work_item_id])).rows[0];
  await authed(admin).post(`/api/v1/work-items/${task.work_item_id}/assign`).set('Idempotency-Key',randomUUID())
    .send({expected_entity_version:wi.entity_version,assignee_user_id:admin.userId});
  const res=await mine(admin);
  const item=res.body.items.find((i:any)=>i.work_item_id===task.work_item_id);
  expect(item).toBeTruthy();
  expect(item.values_visible).toBe(true);
  expect(item.observed_value).toBe(50);
  expect(item.unit).toBe('COUNT');
});

test('MY-06 срок считается фактом: просрочка, близкий срок и закрытые задачи',async()=>{
  const soon=new Date(Date.now()+24*3600*1000).toISOString().replace(/\.\d+Z$/,'Z');
  const past=new Date(Date.now()-24*3600*1000).toISOString().replace(/\.\d+Z$/,'Z');
  // Новая публикация того же периода даёт новую версию показателя, поэтому
  // задача не считается дублем уже поставленной.
  await publish('sales',45);
  await publish('aged',48);
  const a=await openTask('sales',soon);
  const b=await openTask('aged',past);
  const res=await mine(rf);
  const byId=(id:string)=>res.body.items.find((i:any)=>i.work_item_id===id);
  expect(byId(a.work_item_id).due_state).toBe('DUE_SOON');
  expect(byId(b.work_item_id).due_state).toBe('OVERDUE');
  expect(res.body.counts.overdue).toBeGreaterThanOrEqual(1);
  expect(res.body.counts.due_soon).toBeGreaterThanOrEqual(1);
  // Перечень отсортирован по сроку: ближайший срок выше.
  const dues=res.body.items.map((i:any)=>i.due_at);
  expect([...dues].sort()).toEqual(dues);
  await pool.query("UPDATE work_items SET status='CANCELLED' WHERE id=$1",[b.work_item_id]);
  const open=await mine(rf);
  expect(open.body.items.some((i:any)=>i.work_item_id===b.work_item_id)).toBe(false);
  const all=await mine(rf,'?state=ALL');
  const closed=all.body.items.find((i:any)=>i.work_item_id===b.work_item_id);
  expect(closed.due_state).toBe('CLOSED');
});
