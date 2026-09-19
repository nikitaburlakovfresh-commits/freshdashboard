// Isolated real PostgreSQL suite. Only synthetic identities, branches and values.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { verifyOutcome } from '../src/metrics/branchCard';
import { app,authed,login,Session,ORIGIN } from './helpers';

let admin:Session,rf:Session,branch:string,foreign:string,rmGrant:string;
const base='/api/v1/metrics';
const password=randomBytes(32).toString('base64url');
const PERIOD={start:'2026-08-01',end:'2026-08-31'};
const card=(org=branch,s=admin,q=`?start=${PERIOD.start}&end=${PERIOD.end}`)=>
  authed(s).get(`${base}/branches/${org}${q}`);

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

/** Ставит задачу по текущему отклонению показателя через рабочий API. */
async function openTask(metric:string,expected:'RED'|'AMBER') {
  const snapshot=(await pool.query(`SELECT snapshot_id FROM report_fact_current
    WHERE org_unit_id=$1 AND metric=$2 AND period_start=$3 AND period_end=$4`,
  [branch,metric,PERIOD.start,PERIOD.end])).rows[0].snapshot_id;
  const res=await authed(admin).post(`${base}/deviation-tasks`).set('Idempotency-Key',randomUUID())
    .send({org_unit_id:branch,metric,period_start:PERIOD.start,period_end:PERIOD.end,snapshot_id:snapshot,
      expected_rag:expected,template_code:'pilot_task_v1',title:`Отклонение ${metric}: разобрать причины`,
      due_at:'2026-09-30T09:00:00Z',reason:'Synthetic deviation follow-up for branch card suite'});
  expect(res.status).toBe(201);
  return res.body;
}

beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'card_admin',fullName:'Администратор карточки · тест',password,
    reason:'Synthetic isolated branch card administration',approvalReference:'SYNTHETIC_CARD_APPROVAL'});
  expect(b.grantId).toBeTruthy();
  admin=await login('card_admin',password);rf=await login('rf_a');
  branch=randomUUID();foreign=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,'CARD_BETA','ORG_UNIT','ACTIVE','2020-01-01'),($2,'CARD_FOREIGN','ORG_UNIT','ACTIVE','2020-01-01')`,
  [branch,foreign]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Филиал карточки · тест','2020-01-01','Synthetic isolated card fixture'),
      ($2,'Филиал вне допуска · тест','2020-01-01','Synthetic isolated card fixture')`,[branch,foreign]);
  rmGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[admin.userId,branch])).rows[0].id;
  const audit=(await pool.query(`INSERT INTO audit_log(actor_user_id,actor_role,org_unit_id,work_item_id,action,
    aggregate_type,aggregate_id,aggregate_version,request_id,before_state,after_state,resolution,retention_class)
    VALUES($1,null,$2,null,'test.access','access',$3,1,$4,'{}','{}','APPLIED','SECURITY_5Y') RETURNING id`,
  [admin.userId,branch,randomUUID(),randomUUID()])).rows[0].id;
  await pool.query(`INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
    VALUES($1,'READ',ARRAY['sales','margin','aged'],'SYNTHETIC_READ_FOR_CARD',$2)`,[rmGrant,audit]);
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','metric.threshold.manage') ON CONFLICT DO NOTHING");
  const th=(patch:any)=>authed(admin).post(`${base}/thresholds`).send({scope_kind:'NETWORK',basis:'ABSOLUTE',
    unit:'COUNT',effective_from:'2026-01-01',reason:'Synthetic approved threshold for branch card',...patch});
  expect((await th({metric:'sales',direction:'HIGHER_IS_BETTER',green_from:100,amber_from:80})).status).toBe(201);
  expect((await th({metric:'aged',direction:'LOWER_IS_BETTER',green_from:10,amber_from:30})).status).toBe(201);
  await publish(branch,'sales',40);
  await publish(branch,'aged',50);
  await publish(branch,'margin',500,'RUB');
  await publish(foreign,'sales',10);
});
beforeEach(resetLimits);
afterAll(closePool);

test('BC-01 карточка требует сессии и отдельного допуска к показателям филиала',async()=>{
  expect((await request(app).get(`${base}/branches/${branch}?start=${PERIOD.start}&end=${PERIOD.end}`)).status).toBe(401);
  expect((await card(foreign)).status).toBe(404);
  expect((await card(branch,rf)).status).toBe(404);
});

test.each(['?start=2026-02-30&end=2026-08-31',`?start=${PERIOD.end}&end=${PERIOD.start}`,
  `?start=${PERIOD.start}`,`?start=${PERIOD.start}&end=${PERIOD.end}&x=1`])
('BC-02 некорректный фильтр карточки отклоняется %s',async q=>{
  expect((await card(branch,admin,q)).status).toBe(422);
  expect((await authed(admin).get(`${base}/branches/not-a-uuid?start=${PERIOD.start}&end=${PERIOD.end}`)).status).toBe(422);
});

test('BC-03 карточка показывает опубликованные показатели и отсутствие порога',async()=>{
  const res=await card();
  expect(res.status).toBe(200);
  expect(res.body.branch.display_name).toBe('Филиал карточки · тест');
  expect(res.body.mode).toBe('PUBLISHED_SOURCE_AGGREGATES');
  const sales=res.body.metrics.find((m:any)=>m.metric==='sales');
  expect(sales.rag).toBe('RED');
  expect(sales.direction).toBe('HIGHER_IS_BETTER');
  const margin=res.body.metrics.find((m:any)=>m.metric==='margin');
  expect(margin.rag).toBe('NONE');
  expect(res.body.metrics_without_threshold).toContain('margin');
  expect(res.body.metrics.some((m:any)=>m.metric==='kso')).toBe(false);
});

test('BC-04 история отклонений и результат: без новой публикации улучшения нет',async()=>{
  const task=await openTask('sales','RED');
  const res=await card();
  const item=res.body.deviations.find((d:any)=>d.work_item_id===task.work_item_id);
  expect(item.rag_at_creation).toBe('RED');
  expect(item.observed_value).toBe(40);
  expect(item.outcome).toBe('NOT_REPUBLISHED');
  expect(item.delta).toBeNull();
  expect(item.task.status).toBe('DRAFT');
});

test('BC-05 результат подтверждается только новой публикацией показателя',async()=>{
  await publish(branch,'sales',150);
  const res=await card();
  const item=res.body.deviations.find((d:any)=>d.metric==='sales');
  expect(item.outcome).toBe('STATUS_IMPROVED');
  expect(item.delta).toBe(110);
  expect(item.rag_now).toBe('GREEN');
  expect(item.current_value).toBe(150);
  expect(item.current_revision).toBeGreaterThan(1);
});

test('BC-06 ухудшение и обратное направление показателя считаются верно',async()=>{
  const aged=await openTask('aged','RED');
  await publish(branch,'aged',35);
  const better=(await card()).body.deviations.find((d:any)=>d.work_item_id===aged.work_item_id);
  // aged: меньше — лучше, 50 → 35 остаётся красным, но значение улучшилось.
  expect(better.rag_at_creation).toBe('RED');
  expect(better.delta).toBe(-15);
  expect(['VALUE_IMPROVED','STATUS_IMPROVED']).toContain(better.outcome);
  await publish(branch,'sales',30);
  const worse=(await card()).body.deviations.find((d:any)=>d.metric==='sales');
  expect(worse.outcome).toBe('VALUE_WORSENED');
  expect(worse.rag_now).toBe('RED');
});

test('BC-07 проверка результата не подменяет отсутствие данных нулём',()=>{
  const base={rag_at_creation:'RED' as const,observed_value:40,direction:'HIGHER_IS_BETTER' as const,
    snapshot_id:'s1',status:'COMPLETED'};
  expect(verifyOutcome({...base,current:null}).outcome).toBe('NO_PUBLISHED_VALUE');
  expect(verifyOutcome({...base,current:null}).delta).toBeNull();
  expect(verifyOutcome({...base,current:{snapshot_id:'s1',value:40,rag:'RED',revision:1}}).outcome)
    .toBe('NOT_REPUBLISHED');
  expect(verifyOutcome({...base,current:{snapshot_id:'s2',value:40,rag:'NONE',revision:2}}).outcome)
    .toBe('STATUS_UNKNOWN');
  expect(verifyOutcome({...base,current:{snapshot_id:'s2',value:40,rag:'RED',revision:2}}).outcome).toBe('UNCHANGED');
  expect(verifyOutcome({...base,current:{snapshot_id:'s2',value:30,rag:'AMBER',revision:2}}).outcome)
    .toBe('STATUS_IMPROVED');
  expect(verifyOutcome({...base,rag_at_creation:'AMBER',current:{snapshot_id:'s2',value:30,rag:'RED',revision:2}})
    .outcome).toBe('STATUS_WORSENED');
  // Закрытие задачи само по себе не является влиянием на показатель.
  expect(verifyOutcome({...base,status:'COMPLETED',current:{snapshot_id:'s1',value:40,rag:'RED',revision:1}}).outcome)
    .toBe('NOT_REPUBLISHED');
});
