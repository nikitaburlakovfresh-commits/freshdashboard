// Isolated synthetic local PG16 only. No deployed source fixtures or credentials.
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes,randomUUID } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { provisionReportStaging } from '../src/reporting/provisioning';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { createApp } from '../src/app';
import { app,login,authed,Session,ORIGIN } from './helpers';
import { makeWorkbook,summaryRows,salesRows } from './reportFixtures';
import { sourceItemId } from '../src/reporting/review';

const root='10000000-0000-4000-8000-000000000004',otherRoot=randomUUID(),branchA=randomUUID(),branchB=randomUUID();
const pw=randomBytes(32).toString('base64url');
let admin:Session,rm:Session,rf:Session,grant:string,batch:any,initial:any,latest:any,lastCommand:any,lastKey:string;
let paths:string[]=[];
const base=()=>`/api/v1/report-batches/${batch.id}`;
const body=(extra:any={})=>({expected_version:latest.current.version,preview_hash:batch.preview_hash,period:null,
  edits:[],reason:'Synthetic draft review only',...extra});
const save=(b:any,key:string=randomUUID(),s=admin)=>authed(s).post(base()+'/review').set('Idempotency-Key',key).send(b);
const refresh=async()=>{latest=(await authed(admin).get(base()+'/review')).body;return latest;};
beforeAll(async()=>{
  process.env.REPORT_STORAGE_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-review-test-'));
  const a=await bootstrapFirstAdministrator({login:'review_drafts_test',fullName:'Synthetic review administrator',password:pw,
    reason:'Isolated synthetic review test',approvalReference:'SYNTHETIC_LOCAL_TEST_ONLY'});grant=a.grantId;
  await provisionOrganizationEditor('review_drafts_test','SYNTHETIC_LOCAL_EDITOR_APPROVAL');
  await provisionReportStaging('review_drafts_test','SYNTHETIC_LOCAL_STAGING_APPROVAL');
  admin=await login('review_drafts_test',pw);rm=await login('rm_a');rf=await login('rf_a');
  for(const [id,code,kind,parent] of [[otherRoot,'OTHER_SYNTHETIC_ROOT','NETWORK',null],[branchA,'SYNTHETIC_REVIEW_A','ORG_UNIT',root],[branchB,'SYNTHETIC_REVIEW_B','ORG_UNIT',root]]) {
    await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from) VALUES($1,$2,$3,'PRE_LAUNCH','2020-01-01')`,[id,code,kind]);
    await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic local test only')`,[id,'Тестовая единица '+code]);
    await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic local test only')`,[id,parent]);
  }
  const u=await authed(admin).post('/api/v1/report-batches').field('metadata',JSON.stringify({network_id:root,period:{state:'REQUIRES_CONFIRMATION'}}))
    .attach('files',Buffer.from(makeWorkbook(summaryRows())),'synthetic-summary.xlsx')
    .attach('files',Buffer.from(makeWorkbook(salesRows())),'synthetic-sales.xlsx');
  expect(u.status).toBe(200);
  const p=await authed(admin).post(`/api/v1/report-batches/${u.body.id}/probe`).send({expected_version:u.body.version});
  expect(p.status).toBe(200);batch=p.body;
  initial=(await pool.query(`SELECT
    (SELECT count(*) FROM org_directory_units) directory,(SELECT count(*) FROM role_grants) grants,
    (SELECT count(*) FROM role_permissions) permissions,(SELECT count(*) FROM work_items) tasks`)).rows[0];
  paths=[base()+'/review',base()+'/overview',base()+'/branches/'+sourceItemId(batch.id,'summary',3)];
});
beforeEach(resetLimits);afterAll(closePool);
test('REVIEW-01 read creates no revision; stable UUID rows and current non-demo candidates',async()=>{
  await refresh();expect(latest.current.version).toBe(0);expect(latest.current.period).toBeNull();
  expect(latest.rows).toHaveLength(4);expect(new Set(latest.rows.map((r:any)=>r.item_id)).size).toBe(4);
  expect(latest.rows.every((r:any)=>r.status==='UNRESOLVED')).toBe(true);
  expect(latest.candidates.map((c:any)=>c.id).sort()).toEqual([branchA,branchB].sort());
  expect((await pool.query('SELECT count(*)::int n FROM report_review_revisions')).rows[0].n).toBe(0);
});
test('REVIEW-02 anonymous, RM and RF are denied at every new endpoint',async()=>{
  for(const url of paths) {
    expect((await request(app).get(url)).status).toBe(401);
    for(const s of [rm,rf])expect((await authed(s).get(url)).status).toBe(403);
  }
  for(const s of [rm,rf])expect((await save(body(),randomUUID(),s)).status).toBe(403);
});
test('REVIEW-03 foreign and unknown batches/row IDs cannot be read or edited',async()=>{
  const foreign=randomUUID();
  await pool.query(`INSERT INTO report_staging_batches(id,actor_user_id,grant_id,network_id,source_code,period,fingerprint,
    status,storage_state,parser_version,mapping_version,version,preview,preview_hash)
    SELECT $1,$2,grant_id,network_id,source_code,period,fingerprint,status,storage_state,parser_version,mapping_version,version,preview,preview_hash
    FROM report_staging_batches WHERE id=$3`,[foreign,rm.userId,batch.id]);
  for(const suffix of ['/review','/overview','/branches/'+randomUUID()])
    expect((await authed(admin).get('/api/v1/report-batches/'+foreign+suffix)).status).toBe(404);
  expect((await authed(admin).post('/api/v1/report-batches/'+foreign+'/review').set('Idempotency-Key',randomUUID()).send(body())).status).toBe(404);
  for(const suffix of ['/review','/overview','/branches/'+randomUUID()])
    expect((await authed(admin).get('/api/v1/report-batches/'+randomUUID()+suffix)).status).toBe(404);
  expect((await authed(admin).get(base()+'/branches/'+randomUUID())).status).toBe(404);
  await pool.query('UPDATE app_users SET full_name=full_name WHERE id=$1',[admin.userId]); // no privilege widening
  // Ownership cannot be reassigned: the original immutable upload guard protects it.
  await expect(pool.query('UPDATE report_staging_batches SET actor_user_id=$2,version=version+1 WHERE id=$1',[batch.id,rm.userId])).rejects.toThrow();
});
test('REVIEW-04 Origin, CSRF and idempotency key are mandatory',async()=>{
  expect((await request(app).post(base()+'/review').set('Cookie',admin.cookie).send(body())).status).toBe(403);
  expect((await request(app).post(base()+'/review').set('Cookie',admin.cookie).set('Origin',ORIGIN).send(body())).status).toBe(403);
  expect((await authed(admin).post(base()+'/review').send(body())).status).toBe(422);
});
test.each([
  {period:{state:'CONFIRMED'}},{period:{start:'2030-02-30',end:'2030-03-01',planStart:'',planEnd:'',basis:'Synthetic proposal basis'}},
  {period:{start:'2030-04-01',end:'2030-04-08',planStart:'2030-04-01',planEnd:'',basis:'Synthetic proposal basis'}},
  {period:{start:'2030-04-01',end:'2030-04-08',planStart:'',planEnd:'',basis:'yes'}},
  {reason:'yes'},{expected_version:-1},{approved:true},{metrics:{sales:999}},
  {edits:[{item_id:randomUUID(),org_unit_id:null}]},{edits:Array.from({length:101},()=>({item_id:randomUUID(),org_unit_id:null}))}
])('REVIEW-05 invalid, invented and overbroad payload fails atomically case %#',async extra=>{
  expect((await save(body(extra))).status).toBe(422);
  expect((await pool.query('SELECT count(*)::int n FROM report_review_revisions')).rows[0].n).toBe(0);
});
test('REVIEW-06 draft period + explicit UUID proposal persist without approval or original changes',async()=>{
  lastCommand=body({period:{start:'2030-04-01',end:'2030-04-08',planStart:'',planEnd:'',basis:'Synthetic dates suggested for owner review'},
    edits:[{item_id:sourceItemId(batch.id,'summary',3),org_unit_id:branchA}]});
  lastKey=randomUUID();const r=await save(lastCommand,lastKey);expect(r.status).toBe(200);expect(r.body.version).toBe(1);
  expect(r.body.canonical_applied).toBe(false);await refresh();
  expect(latest.current.period.start).toBe('2030-04-01');expect(latest.rows.find((r:any)=>r.item_id===sourceItemId(batch.id,'summary',3)).status).toBe('PROPOSED');
  const original=(await authed(admin).get(base())).body;expect(original.period).toEqual(batch.period);
  expect(original.preview_hash).toBe(batch.preview_hash);expect(original.preview).toEqual(batch.preview);
});
test('REVIEW-07 repeat command has one durable effect; same key/different body and stale version/hash conflict',async()=>{
  expect((await save(lastCommand,lastKey)).body.version).toBe(1);
  expect((await save({...lastCommand,reason:'Different synthetic reason'},lastKey)).status).toBe(409);
  expect((await save(lastCommand)).status).toBe(409);
  expect((await save(body({preview_hash:'f'.repeat(64)})))).toHaveProperty('status',409);
  expect((await pool.query('SELECT count(*)::int n FROM report_review_revisions')).rows[0].n).toBe(1);
});
test('REVIEW-08 reject root, demo, nonexistent, foreign and duplicate same-format targets',async()=>{
  for(const target of [root,otherRoot,randomUUID(),'10000000-0000-4000-8000-000000000001']) {
    expect((await save(body({edits:[{item_id:sourceItemId(batch.id,'summary',4),org_unit_id:target}]}))).status).toBe(422);
  }
  expect((await save(body({edits:[{item_id:sourceItemId(batch.id,'summary',4),org_unit_id:branchA}]}))).status).toBe(422);
  expect((await save(body({edits:[{item_id:latest.rows[1].item_id,org_unit_id:null},{item_id:latest.rows[1].item_id,org_unit_id:null}]}))).status).toBe(422);
});
test('REVIEW-09 cross-format same target stays separate source rows, sparse edits retain other proposals',async()=>{
  const sales=latest.rows.find((r:any)=>r.report_kind==='sales');
  const r=await save(body({edits:[{item_id:sales.item_id,org_unit_id:branchA}]}));expect(r.status).toBe(200);await refresh();
  expect(latest.current.mappings).toHaveLength(2);expect(latest.current.period).toBeNull();
  const o=await authed(admin).get(base()+'/overview');expect(o.status).toBe(200);
  expect(o.body.mode).toBe('PREVIEW');expect(o.body.rows).toHaveLength(4);expect(o.body.reports).toHaveLength(2);
  expect(o.body.reports.map((r:any)=>r.total.values.sales)).toEqual([8,8]);
  expect(o.body.commit_available).toBe(false);expect(o.headers['cache-control']).toBe('no-store, private');
});
test('REVIEW-10 branch detail is exactly one immutable source row with null/negative/source address preserved',async()=>{
  const r=await authed(admin).get(paths[2]);expect(r.status).toBe(200);
  expect(r.body.row.values.sales).toBe(3);expect(r.body.row.values.margin).toBe(-20);
  expect(r.body.report.sheet).toBe('Synthetic');expect(r.body.report.columns.margin).toBe('W');
  expect(r.body.row.row).toBe(3);expect(r.body.report.branches).toBeUndefined();
  expect(r.body.files).toHaveLength(2);expect(r.body.preview_hash).toBe(batch.preview_hash);
});
test('REVIEW-11 concurrent edits use CAS; one revision wins, neither overwrite nor extra audit',async()=>{
  const responses=await Promise.all([save(body({reason:'Concurrent synthetic first'})),save(body({reason:'Concurrent synthetic second'}))]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,409]);await refresh();
  expect(latest.current.version).toBe(3);expect(latest.history).toHaveLength(3);
});
test('REVIEW-12 audit failure rolls back revision, outbox and idempotent record',async()=>{
  await pool.query(`CREATE FUNCTION test_review_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='REPORT_REVIEW_DRAFT_SAVED' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_review_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_review_audit_failure()`);
  const key=randomUUID(),command=body();
  try{expect((await save(command,key)).status).toBe(503);}
  finally{await pool.query('DROP TRIGGER test_review_failure ON audit_log; DROP FUNCTION test_review_audit_failure()');}
  expect((await pool.query('SELECT count(*)::int n FROM idempotency_records WHERE key=$1',[key])).rows[0].n).toBe(0);
  await refresh();expect(latest.current.version).toBe(3);
  expect((await save(command,key)).status).toBe(200);await refresh();
});
test('REVIEW-13 revisions immutable; fresh app reads same server state, outbox has NONE policy',async()=>{
  await expect(pool.query(`UPDATE report_review_revisions SET period=NULL WHERE batch_id=$1`,[batch.id])).rejects.toThrow();
  await expect(pool.query(`DELETE FROM report_review_revisions WHERE batch_id=$1`,[batch.id])).rejects.toThrow();
  const reopened=await request(createApp()).get(base()+'/review').set('Cookie',admin.cookie);
  expect(reopened.body.current).toEqual(latest.current);
  const events=await pool.query(`SELECT e.notification_policy,count(*)::int n FROM outbox_events o JOIN event_catalog e USING(event_type)
    WHERE event_type='report.review.drafted' GROUP BY 1`);
  expect(events.rows).toEqual([{notification_policy:'NONE',n:latest.current.version}]);
});
test('REVIEW-14 changed current affiliation marks prior draft stale; save fails until explicitly cleared',async()=>{
  await pool.query(`UPDATE org_directory_affiliation_history SET effective_to='2021-01-01' WHERE org_unit_id=$1 AND effective_to IS NULL`,[branchA]);
  await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason)
    VALUES($1,$2,'2021-01-01','Synthetic affiliation moved for stale test')`,[branchA,otherRoot]);
  await refresh();expect(latest.rows.filter((r:any)=>r.status==='STALE')).toHaveLength(2);
  expect(latest.candidates.some((r:any)=>r.id===branchA)).toBe(false);
  expect((await save(body())).status).toBe(422);
  expect((await save(body({edits:latest.current.mappings.map((m:any)=>({item_id:m.item_id,org_unit_id:null}))}))).status).toBe(200);
  await refresh();expect(latest.current.mappings).toHaveLength(0);
});
test.each(['capability revoked','capability expired','grant revoked','grant expired','directory permission removed','session expired'])(
  'REVIEW-15 every new endpoint and idempotent replay rechecks %s',async kind=>{
    if(kind==='capability revoked')await pool.query('UPDATE report_staging_access SET revoked_at=now() WHERE grant_id=$1',[grant]);
    if(kind==='capability expired')await pool.query(`UPDATE report_staging_access SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE grant_id=$1`,[grant]);
    if(kind==='grant revoked')await pool.query('UPDATE role_grants SET revoked_at=now() WHERE id=$1',[grant]);
    if(kind==='grant expired')await pool.query(`UPDATE role_grants SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE id=$1`,[grant]);
    if(kind==='directory permission removed')await pool.query(`DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='organization.directory.review'`);
    if(kind==='session expired')await pool.query(`UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=$1`,[admin.userId]);
    try {
      for(const url of paths)expect([401,403]).toContain((await authed(admin).get(url)).status);
      expect([401,403]).toContain((await save(lastCommand,lastKey)).status);
    } finally {
      if(kind==='session expired')admin=await login('review_drafts_test',pw);
      else {
        await pool.query('UPDATE report_staging_access SET revoked_at=NULL,valid_until=NULL WHERE grant_id=$1',[grant]);
        await pool.query('UPDATE role_grants SET revoked_at=NULL,valid_until=NULL WHERE id=$1',[grant]);
        await pool.query(`INSERT INTO role_permissions VALUES('SUPER_ADMIN','organization.directory.review') ON CONFLICT DO NOTHING`);
      }
    }
  });
test('REVIEW-16 no canonical mutation or downloads; existing permission count and lifecycle preserved',async()=>{
  const counts=(await pool.query(`SELECT
    (SELECT count(*) FROM org_directory_units) directory,(SELECT count(*) FROM role_grants) grants,
    (SELECT count(*) FROM role_permissions) permissions,(SELECT count(*) FROM work_items) tasks`)).rows[0];
  expect(counts).toEqual(initial);
  expect((await pool.query('SELECT lifecycle_state FROM org_directory_units WHERE id=$1',[branchA])).rows[0].lifecycle_state).toBe('PRE_LAUNCH');
  expect((await authed(admin).get(base()+`/files/${batch.files[0].id}/download`)).status).toBe(403);
  for(const action of ['commit','approve','apply','mapping'])expect((await authed(admin).post(base()+'/'+action).send({approved:true})).status).toBe(403);
});
test('REVIEW-17 UUID path spelling does not alter stable source IDs or draft stream',async()=>{
  const upper='/api/v1/report-batches/'+batch.id.toUpperCase();
  const r=await authed(admin).get(upper+'/review');
  expect(r.status).toBe(200);expect(r.body.rows).toEqual(latest.rows);
  const key=randomUUID(),command=body();
  const a=await authed(admin).post(upper+'/review').set('Idempotency-Key',key).send(command);
  expect(a.status).toBe(200);expect(a.body.batch_id).toBe(batch.id);
  expect((await save(command,key)).body).toEqual(a.body);
});
