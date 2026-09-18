// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,authed,login,Session,ORIGIN } from './helpers';

let admin:Session,rf:Session,branch:string,otherBranch:string,rfGrant:string;
const base='/api/v1/metrics';
const password=randomBytes(32).toString('base64url');
const PERIOD={start:'2026-08-01',end:'2026-08-31'};

const threshold=(patch:any={})=>({metric:'sales',scope_kind:'NETWORK',direction:'HIGHER_IS_BETTER',
  basis:'ABSOLUTE',unit:'COUNT',green_from:100,amber_from:80,effective_from:'2026-01-01',
  reason:'Synthetic approved threshold configuration',...patch});
const setT=(body:any,s=admin)=>authed(s).post(`${base}/thresholds`).send(body);
const overview=(s=rf,q=`?start=${PERIOD.start}&end=${PERIOD.end}`)=>authed(s).get(`${base}/overview${q}`);

/** Публикует синтетический опубликованный срез напрямую, минуя загрузку файлов. */
async function publish(org:string,metric:string,value:number,unit='COUNT') {
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.publish','report_stage',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,org,randomUUID(),randomUUID()])).rows[0].id;
  const network=(await pool.query("SELECT id FROM org_directory_units WHERE kind='NETWORK' LIMIT 1")).rows[0].id;
  const batch=(await pool.query(`INSERT INTO report_staging_batches(id,actor_user_id,grant_id,network_id,source_code,
    period,fingerprint,status,storage_state,parser_version,mapping_version)
    VALUES($1,$2,$3,$4,'QLIK_AGGREGATE_MANUAL','{}',$5,'QUARANTINE','WRITING','TEST_V1','UNRESOLVED_V1')
    RETURNING id`,[randomUUID(),admin.userId,rfGrant,network,randomBytes(32).toString('hex')])).rows[0].id;
  const preview=(await pool.query(`INSERT INTO report_fact_previews(id,batch_id,actor_user_id,review_version,
    review_hash,command,proposal,proposal_hash) VALUES($1,$2,$3,1,'h','{}','{}',$4) RETURNING id`,
  [randomUUID(),batch,admin.userId,'a'.repeat(64)])).rows[0].id;
  const pub=(await pool.query(`INSERT INTO report_fact_publications(id,preview_id,actor_user_id,grant_id,audit_id)
    VALUES($1,$2,$3,$4,$5) RETURNING id`,[randomUUID(),preview,admin.userId,rfGrant,audit])).rows[0].id;
  const snap=(await pool.query(`INSERT INTO report_fact_snapshots(id,publication_id,org_unit_id,metric,period_start,
    period_end,value,unit,revision,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,'{"source":"SYNTHETIC"}') RETURNING id`,
  [randomUUID(),pub,org,metric,PERIOD.start,PERIOD.end,value,unit])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_current(org_unit_id,metric,period_start,period_end,snapshot_id)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(org_unit_id,metric,period_start,period_end)
    DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id`,[org,metric,PERIOD.start,PERIOD.end,snap]);
}

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'threshold_admin',fullName:'Администратор порогов · тест',password,
    reason:'Synthetic isolated threshold administration',approvalReference:'SYNTHETIC_THRESHOLD_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('threshold_admin',password);rf=await login('rf_a');
  branch=randomUUID();otherBranch=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'RAG_BETA','ORG_UNIT','ACTIVE','2020-01-01'),($2,'RAG_BETA_2','ORG_UNIT','ACTIVE','2020-01-01')`,
  [branch,otherBranch]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал светофора · тест','2020-01-01','Synthetic isolated RAG fixture'),
      ($2,'Филиал вне допуска · тест','2020-01-01','Synthetic isolated RAG fixture')`,[branch,otherBranch]);
  rfGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[rf.userId,branch])).rows[0].id;
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['sales','margin','plan'],'SYNTHETIC_READ_APPROVAL_FOR_RAG',$2)`,[rfGrant,audit]);
  await publish(branch,'sales',120);
  await publish(branch,'margin',50,'RUB');
  await publish(otherBranch,'sales',10);
});
beforeEach(resetLimits);
afterAll(closePool);

test('MT-01 миграция не выдаёт право никому; нужны явные права настройки',async()=>{
  expect((await pool.query("SELECT count(*)::int n FROM role_permissions WHERE permission_code='metric.threshold.manage'")).rows[0].n).toBe(0);
  expect((await authed(admin).get(`${base}/thresholds`)).status).toBe(403);
  expect((await setT(threshold())).status).toBe(403);
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage')");
  expect((await authed(admin).get(`${base}/thresholds`)).status).toBe(200);
});

test('MT-02 без сессии, для филиальной роли и без CSRF/Origin настройка закрыта',async()=>{
  expect((await request(app).get(`${base}/thresholds`)).status).toBe(401);
  expect((await authed(rf).get(`${base}/thresholds`)).status).toBe(403);
  expect((await setT(threshold(),rf)).status).toBe(403);
  expect((await request(app).post(`${base}/thresholds`).set('Cookie',admin.cookie).set('Origin',ORIGIN)
    .send(threshold())).status).toBe(403);
  expect((await request(app).post(`${base}/thresholds`).set('Cookie',admin.cookie)
    .set('X-CSRF-Token',admin.csrf).set('Origin','https://evil.example').send(threshold())).status).toBe(403);
});

test.each([
  {metric:'__proto__'},{metric:'unknown'},{green_from:80,amber_from:100},{green_from:'100'},
  {basis:'PLAN_PERCENT',unit:'RUB'},{reason:'short'},{effective_from:'2026-02-30'},
  {scope_kind:'ORG_UNIT'},{scope_kind:'NETWORK',org_unit_id:randomUUID()},{unit:'PIECES'},
])('MT-03 некорректная настройка отклоняется %j',async patch=>{
  expect((await setT(threshold(patch))).status).toBe(422);
});

test('MT-04 неизвестный филиал не принимается, версии историчны и не перезаписываются',async()=>{
  expect((await setT(threshold({scope_kind:'ORG_UNIT',org_unit_id:randomUUID()}))).status).toBe(404);
  const first=await setT(threshold());
  expect(first.status).toBe(201);
  expect((await setT(threshold({green_from:110,amber_from:90,effective_from:'2026-01-01'}))).status).toBe(422);
  const second=await setT(threshold({green_from:110,amber_from:90,effective_from:'2026-09-01',
    reason:'Synthetic approved tightening of the threshold'}));
  expect(second.status).toBe(201);
  expect(second.body.previous_id).toBe(first.body.id);
  const rows=(await pool.query(`SELECT to_char(effective_from,'YYYY-MM-DD') f,to_char(effective_to,'YYYY-MM-DD') t
    FROM metric_thresholds WHERE metric='sales' AND org_unit_id IS NULL ORDER BY effective_from`)).rows;
  expect(rows).toEqual([{f:'2026-01-01',t:'2026-09-01'},{f:'2026-09-01',t:null}]);
  await expect(pool.query('UPDATE metric_thresholds SET green_from=1 WHERE id=$1',[first.body.id])).rejects.toThrow();
  await expect(pool.query('DELETE FROM metric_thresholds WHERE id=$1',[first.body.id])).rejects.toThrow();
  expect((await pool.query('SELECT count(*)::int n FROM audit_log WHERE action=$1',['metric.threshold.set'])).rows[0].n).toBe(2);
  expect((await pool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1',[second.body.id])).rows[0].n).toBe(1);
  const history=await authed(admin).get(`${base}/thresholds?history=true`);
  expect(history.body.items.filter((i:any)=>i.metric==='sales').length).toBe(2);
  expect(JSON.stringify(history.body)).not.toMatch(/password|csrf|auth_epoch|token_digest/);
});

test('MT-05 сетка филиалов: статусы из настроек, отсутствие данных даёт NONE',async()=>{
  const r=await overview();
  expect(r.status).toBe(200);
  expect(r.body.mode).toBe('PUBLISHED_SOURCE_AGGREGATES');
  expect(r.body.branches.map((b:any)=>b.display_name)).toEqual(['Филиал светофора · тест']);
  const cells=r.body.branches[0].metrics;
  // Порог продаж действует на 31.08.2026: зелёный от 100.
  expect(cells.find((c:any)=>c.metric==='sales')).toMatchObject({rag:'GREEN',value:120,basis:'ABSOLUTE'});
  // Для маржи порог не настроен — статуса нет, а не ноль и не выполнение.
  expect(cells.find((c:any)=>c.metric==='margin')).toMatchObject({rag:'NONE',threshold_id:null});
  expect(r.body.branches[0].metrics_without_threshold).toEqual(['margin']);
  // План не публиковался: строки нет вовсе, ноль не подставляется.
  expect(cells.some((c:any)=>c.metric==='plan')).toBe(false);
  expect(r.body.thresholds_configured).toBe(true);
});

test('MT-06 порог филиала вытесняет сетевой, направление учитывается',async()=>{
  const branchLevel=await setT(threshold({scope_kind:'ORG_UNIT',org_unit_id:branch,green_from:200,amber_from:150,
    effective_from:'2026-02-01',reason:'Synthetic approved branch specific threshold'}));
  expect(branchLevel.status).toBe(201);
  let cells=(await overview()).body.branches[0].metrics;
  expect(cells.find((c:any)=>c.metric==='sales')).toMatchObject({rag:'RED',threshold_id:branchLevel.body.id});
  const lower=await setT(threshold({metric:'margin',direction:'LOWER_IS_BETTER',unit:'RUB',
    green_from:40,amber_from:60,effective_from:'2026-02-01',reason:'Synthetic approved inverse direction threshold'}));
  expect(lower.status).toBe(201);
  cells=(await overview()).body.branches[0].metrics;
  expect(cells.find((c:any)=>c.metric==='margin').rag).toBe('AMBER');
  expect((await overview()).body.branches[0].rag).toBe('RED');
});

test('MT-07 база «процент плана» без плана не даёт статуса',async()=>{
  const pct=await setT(threshold({metric:'plan',basis:'PLAN_PERCENT',unit:'PCT',green_from:100,amber_from:90,
    effective_from:'2026-02-01',reason:'Synthetic approved plan percent threshold'}));
  expect(pct.status).toBe(201);
  const cells=(await overview()).body.branches[0].metrics;
  expect(cells.some((c:any)=>c.metric==='plan')).toBe(false);
  await publish(branch,'plan',100);
  const after=(await overview()).body.branches[0].metrics;
  expect(after.find((c:any)=>c.metric==='plan')).toMatchObject({rag:'GREEN',basis:'PLAN_PERCENT',basis_value:100});
});

test('MT-08 сетка держит границы допуска и валидирует период',async()=>{
  expect((await overview(rf,`?start=${PERIOD.start}&end=${PERIOD.end}&org=${otherBranch}`)).status).toBe(404);
  expect((await overview(rf,'?start=2026-08-31&end=2026-08-01')).status).toBe(422);
  expect((await overview(rf,'?start=2026-08-01')).status).toBe(422);
  expect((await overview(rf,`?start=${PERIOD.start}&end=${PERIOD.end}&limit=5`)).status).toBe(422);
  // У администратора нет отдельного допуска на чтение бизнес-показателей.
  expect((await overview(admin)).status).toBe(403);
  const scoped=await overview(rf,`?start=${PERIOD.start}&end=${PERIOD.end}&org=${branch}`);
  expect(scoped.body.branches.length).toBe(1);
  expect(JSON.stringify(scoped.body)).not.toMatch(/RAG_BETA_2|вне допуска/);
});
