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
const settings=(s:Session)=>authed(s).get(`${base}/portal-settings`);
const setSetting=(s:Session,body:any)=>authed(s).post(`${base}/portal-settings`)
  .set('Idempotency-Key',randomUUID()).send(body);
const KEY='deviation_task_due_soon_hours';

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
      due_at:due,reason:'Synthetic deviation follow-up for portal settings suite',
      assignee_user_id:assign?rf.userId:null});
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'pst_admin',fullName:'Администратор настроек · тест',password,
    reason:'Synthetic isolated portal settings administration',approvalReference:'SYNTHETIC_PST_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('pst_admin',password);rf=await login('rf_a');other=await login('rf_b');
  branch=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'PST_BETA','ORG_UNIT','ACTIVE','2020-01-01')`,[branch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал настроек · тест','2020-01-01','Synthetic isolated assignee fixture')`,[branch]);
  rmGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[admin.userId,branch])).rows[0].id;
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01')`,[rf.userId,branch]);
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['sales','aged'],'SYNTHETIC_READ_FOR_PST',$2)`,[rmGrant,audit]);
  await pool.query(`INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage')
    ON CONFLICT DO NOTHING`);
  await pool.query(`INSERT INTO role_permissions VALUES('SUPER_ADMIN','portal.setting.manage')
    ON CONFLICT DO NOTHING`);
  const th=(patch:any)=>authed(admin).post(`${base}/thresholds`).send({scope_kind:'NETWORK',basis:'ABSOLUTE',
    unit:'COUNT',effective_from:'2026-01-01',reason:'Synthetic approved threshold for portal settings',...patch});
  expect((await th({metric:'sales',direction:'HIGHER_IS_BETTER',green_from:100,amber_from:80})).status).toBe(201);
  expect((await th({metric:'aged',direction:'LOWER_IS_BETTER',green_from:10,amber_from:30})).status).toBe(201);
  await publish('sales',40);
  await publish('aged',50);
});
beforeEach(resetLimits);
afterAll(async()=>{
  await pool.query('UPDATE portal_settings SET value_number=72 WHERE key=$1',[KEY]);
  await closePool();
});

test('PS-01 реестр настроек доступен только с правом и отдаёт границы значения',async()=>{
  expect((await settings(rf)).status).toBe(403);
  const res=await settings(admin);
  expect(res.status).toBe(200);
  const item=res.body.items.find((i:any)=>i.key===KEY);
  expect(item).toMatchObject({value_number:72,unit:'HOURS',min:1,max:720,integer:true});
  expect(item.title).toBeTruthy();
});

test('PS-02 значение проверяется границами и требует основания',async()=>{
  expect((await setSetting(rf,{key:KEY,value:24,reason:'Synthetic attempt without permission'})).status).toBe(403);
  expect((await setSetting(admin,{key:KEY,value:0,reason:'Synthetic out of range value'})).status).toBe(422);
  expect((await setSetting(admin,{key:KEY,value:1000,reason:'Synthetic out of range value'})).status).toBe(422);
  expect((await setSetting(admin,{key:KEY,value:12.5,reason:'Synthetic fractional hours value'})).status).toBe(422);
  expect((await setSetting(admin,{key:KEY,value:24,reason:'коротко'})).status).toBe(422);
  expect((await setSetting(admin,{key:'unknown_setting',value:24,
    reason:'Synthetic unknown setting key'})).status).toBe(404);
});

test('PS-03 порог «срок близко» берётся из настройки, а не из кода',async()=>{
  const due=new Date(Date.now()+48*3600*1000).toISOString().replace(/\.\d+Z$/,'Z');
  const task=await openTask('sales',due);
  const before=await mine(rf);
  expect(before.body.due_soon_hours).toBe(72);
  expect(before.body.items.find((i:any)=>i.work_item_id===task.work_item_id).due_state).toBe('DUE_SOON');
  const changed=await setSetting(admin,{key:KEY,value:24,
    reason:'Synthetic narrower due soon window for settings suite'});
  expect(changed.status).toBe(200);
  expect(changed.body).toMatchObject({value_number:24,changed:true,value_before:72});
  const after=await mine(rf);
  expect(after.body.due_soon_hours).toBe(24);
  // То же самое отклонение при более узком окне уже не считается близким сроком.
  expect(after.body.items.find((i:any)=>i.work_item_id===task.work_item_id).due_state).toBe('ON_TRACK');
  expect(after.body.counts.due_soon).toBe(0);
});

test('PS-04 повторная установка того же значения не создаёт записи истории',async()=>{
  const same=await setSetting(admin,{key:KEY,value:24,reason:'Synthetic repeat of the same value'});
  expect(same.body).toMatchObject({changed:false,value_number:24});
  const rows=await pool.query('SELECT count(*)::int n FROM portal_setting_changes WHERE key=$1',[KEY]);
  expect(rows.rows[0].n).toBe(1);
});

test('PS-05 история изменений настройки не переписывается и связана с аудитом',async()=>{
  const res=await settings(admin);
  const h=res.body.history.filter((x:any)=>x.key===KEY);
  expect(h[0]).toMatchObject({value_before:72,value_after:24});
  expect(h[0].changed_by_login).toBe('pst_admin');
  expect(h[0].reason).toMatch(/due soon window/);
  await expect(pool.query("UPDATE portal_setting_changes SET reason='подмена основания записи'"))
    .rejects.toThrow(/append-only/);
  await expect(pool.query('DELETE FROM portal_setting_changes')).rejects.toThrow(/append-only/);
  const audit=await pool.query(`SELECT count(*)::int n FROM audit_log
    WHERE action='portal.setting.changed' AND retention_class='SECURITY_5Y'`);
  expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
});
