// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,authed,login,Session } from './helpers';
import { drainNotificationsForTests } from '../src/workers/notificationConsumer';

let admin:Session,rf:Session,other:Session,branch:string,rmGrant:string;
const base='/api/v1/metrics';
const password=randomBytes(32).toString('base64url');
const PERIOD={start:'2026-08-01',end:'2026-08-31'};
const policies=(s:Session)=>authed(s).get(`${base}/notification-policies`);
const setPolicy=(s:Session,body:any)=>authed(s).post(`${base}/notification-policies`)
  .set('Idempotency-Key',randomUUID()).send(body);
/** Уведомления получателя из in-app перечня. */
async function inbox(userId:string) {
  await drainNotificationsForTests();
  return (await pool.query(`SELECT n.message,n.work_item_id FROM notifications n
    WHERE n.recipient_user_id=$1 ORDER BY n.created_at`,[userId])).rows;
}

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
      due_at:due,reason:'Synthetic deviation follow-up for deviation notification suite',
      assignee_user_id:assign?rf.userId:null});
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'ndf_admin',fullName:'Администратор уведомлений · тест',password,
    reason:'Synthetic isolated deviation notification administration',approvalReference:'SYNTHETIC_NDF_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('ndf_admin',password);rf=await login('rf_a');other=await login('rf_b');
  branch=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'NDF_BETA','ORG_UNIT','ACTIVE','2020-01-01')`,[branch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал уведомлений · тест','2020-01-01','Synthetic isolated assignee fixture')`,[branch]);
  rmGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[admin.userId,branch])).rows[0].id;
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01')`,[rf.userId,branch]);
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['sales','aged'],'SYNTHETIC_READ_FOR_NDF',$2)`,[rmGrant,audit]);
  await pool.query(`INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO role_permissions VALUES('SUPER_ADMIN','notification.policy.manage')
    ON CONFLICT DO NOTHING`);
  const th=(patch:any)=>authed(admin).post(`${base}/thresholds`).send({scope_kind:'NETWORK',basis:'ABSOLUTE',
    unit:'COUNT',effective_from:'2026-01-01',reason:'Synthetic approved threshold for deviation notification',...patch});
  expect((await th({metric:'sales',direction:'HIGHER_IS_BETTER',green_from:100,amber_from:80})).status).toBe(201);
  expect((await th({metric:'aged',direction:'LOWER_IS_BETTER',green_from:10,amber_from:30})).status).toBe(201);
  await publish('sales',40);
  await publish('aged',50);
});
beforeEach(resetLimits);
afterAll(closePool);

test('ND-01 ответственный получает уведомление о задаче по отклонению',async()=>{
  const task=await openTask('sales','2026-09-30T09:00:00Z');
  const got=await inbox(rf.userId);
  expect(got).toHaveLength(1);
  expect(got[0].message).toBe('Вам назначена задача по отклонению показателя.');
  expect(got[0].work_item_id).toBe(task.work_item_id);
  // Текст шаблонный: значения показателя в уведомление не попадают.
  expect(got[0].message).not.toMatch(/\d/);
  // Постановщик себе уведомление не создаёт.
  expect(await inbox(admin.userId)).toEqual([]);
});

test('ND-02 уведомление адресуется новому ответственному при переназначении',async()=>{
  await publish('aged',49);
  const task=await openTask('aged','2026-09-29T09:00:00Z',false);
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01')`,[other.userId,branch]);
  const v=(await pool.query('SELECT entity_version FROM work_items WHERE id=$1',[task.work_item_id])).rows[0];
  const res=await authed(admin).post(`/api/v1/work-items/${task.work_item_id}/assign`)
    .set('Idempotency-Key',randomUUID())
    .send({expected_entity_version:v.entity_version,assignee_user_id:other.userId});
  expect(res.status).toBe(200);
  const got=await inbox(other.userId);
  expect(got.map((r:any)=>r.work_item_id)).toContain(task.work_item_id);
  expect(got[got.length-1].message).toBe('Вам назначена задача по отклонению показателя.');
});

test('ND-03 политика рассылки читается из настроек, а не из кода',async()=>{
  const off=await setPolicy(admin,{event_type:'work_item.assigned',policy:'NONE',
    reason:'Synthetic switch off assignment notifications'});
  expect(off.status).toBe(200);
  expect(off.body).toMatchObject({notification_policy:'NONE',changed:true,policy_before:'ASSIGNEE'});
  await publish('sales',44);
  const task=await openTask('sales','2026-09-28T09:00:00Z');
  await drainNotificationsForTests();
  const rows=await inbox(rf.userId);
  expect(rows.some((r:any)=>r.work_item_id===task.work_item_id)).toBe(false);
  // Событие всё равно обработано: доказательный след не теряется.
  const receipts=await pool.query(`SELECT count(*)::int n FROM consumer_receipts r
    JOIN outbox_events e ON e.event_id=r.event_id WHERE e.event_type='work_item.assigned'`);
  expect(receipts.rows[0].n).toBeGreaterThan(0);
  const back=await setPolicy(admin,{event_type:'work_item.assigned',policy:'ASSIGNEE',
    reason:'Synthetic restore assignment notifications'});
  expect(back.status).toBe(200);
});

test('ND-04 изменение политики требует права, основания и известного события',async()=>{
  expect((await setPolicy(rf,{event_type:'work_item.assigned',policy:'NONE',
    reason:'Synthetic attempt without permission'})).status).toBe(403);
  expect((await policies(rf)).status).toBe(403);
  expect((await setPolicy(admin,{event_type:'work_item.assigned',policy:'NONE',reason:'коротко'})).status).toBe(422);
  expect((await setPolicy(admin,{event_type:'work_item.assigned',policy:'ALL',
    reason:'Synthetic unsupported policy value'})).status).toBe(422);
  expect((await setPolicy(admin,{event_type:'work_item.unknown_event',policy:'NONE',
    reason:'Synthetic unknown catalog event'})).status).toBe(404);
  const list=await policies(admin);
  expect(list.status).toBe(200);
  expect(list.body.policies).toEqual(['NONE','ASSIGNEE','REVIEWERS']);
  const row=list.body.items.find((i:any)=>i.event_type==='work_item.assigned');
  expect(row.notification_policy).toBe('ASSIGNEE');
});

test('ND-05 история изменений политики сохраняется и не переписывается',async()=>{
  const list=await policies(admin);
  const history=list.body.history.filter((h:any)=>h.event_type==='work_item.assigned');
  expect(history.length).toBeGreaterThanOrEqual(2);
  expect(history[0]).toMatchObject({policy_after:'ASSIGNEE',policy_before:'NONE'});
  expect(history[0].changed_by_login).toBe('ndf_admin');
  await expect(pool.query(`UPDATE notification_policy_changes SET reason='подмена основания записи'`))
    .rejects.toThrow(/append-only/);
});

test('ND-06 обычная задача сохраняет прежний общий текст уведомления',async()=>{
  const created=await authed(admin).post('/api/v1/work-items').set('Idempotency-Key',randomUUID())
    .send({org_unit_id:branch,template_code:'pilot_task_v1',title:'Плановая задача без отклонения',
      due_at:'2031-01-01T00:00:00Z'});
  expect(created.status).toBe(201);
  const id=created.body.id??created.body.work_item_id;
  const v=(await pool.query('SELECT entity_version FROM work_items WHERE id=$1',[id])).rows[0];
  expect((await authed(admin).post(`/api/v1/work-items/${id}/assign`).set('Idempotency-Key',randomUUID())
    .send({expected_entity_version:v.entity_version,assignee_user_id:rf.userId})).status).toBe(200);
  const got=(await inbox(rf.userId)).filter((r:any)=>r.work_item_id===id);
  expect(got).toHaveLength(1);
  expect(got[0].message).toBe('Вам назначена задача.');
});
