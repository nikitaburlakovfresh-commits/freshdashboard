// Synthetic local PG16 only. The scanner boundary is mocked ONLY by Jest.
// This tests publication decisions, not the effectiveness of antivirus signatures.
jest.mock('../src/reporting/scanner',()=>({scanBytes:jest.fn(async()=>({scanner:'SYNTHETIC_TEST_SCANNER',result:'CLEAN'}))}));
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { provisionReportStaging } from '../src/reporting/provisioning';
import { provisionFactAccess } from '../src/reporting/factProvisioning';
import { scanBytes } from '../src/reporting/scanner';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,login,authed,Session,ORIGIN,TEST_PASSWORD } from './helpers';
import { makeWorkbook,summaryRows } from './reportFixtures';
import { sourceItemId } from '../src/reporting/review';
const root='10000000-0000-4000-8000-000000000004',a=randomUUID(),b=randomUUID();
const adminPassword=TEST_PASSWORD+'-SyntheticAdminOnly2026';
let admin:Session,rm:Session,rf:Session,grant:string,readerGrant:string,batch:any,review:any;
let preview:any,lastBody:any,lastKey:string,firstSnapshot:string;
const base=()=>`/api/v1/report-facts/${batch.id}`;
const count=async(table:string)=>(await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
const cmd=(extra:any={})=>({review_version:review.current.version,choices:[
  {metric:'sales',source:'summary',methodology:'Synthetic fixture counts, all rows included, units COUNT.'},
  {metric:'margin',source:'summary',methodology:'Synthetic fixture RUB, negative values preserved, no recalculation.'}],
  reason:'Synthetic explicit source priority and approval only',confirm_source_aggregates:true,...extra});
const verify=(body=cmd(),s=admin)=>authed(s).post(base()+'/preview').send(body);
const publish=(p=preview,key:string=randomUUID(),s=admin)=>authed(s).post(base()+'/publish').set('Idempotency-Key',key).send({preview_id:p.preview_id,proposal_hash:p.proposal_hash,confirm:true});
const scan=()=>authed(admin).post(base()+'/scan').send({});
const read=(s=rm,extra='')=>authed(s).get('/api/v1/report-facts?start=2030-04-01&end=2030-04-08'+extra);
const refresh=async()=>{review=(await authed(admin).get(`/api/v1/report-batches/${batch.id}/review`)).body;};
const draft=async(period:any,edits:any[]=[])=>{
  const r=await authed(admin).post(`/api/v1/report-batches/${batch.id}/review`).set('Idempotency-Key',randomUUID()).send({
    expected_version:review.current.version,preview_hash:batch.preview_hash,period,edits,reason:'Synthetic draft proposal only'});
  expect(r.status).toBe(200);await refresh();
};
const period={start:'2030-04-01',end:'2030-04-08',planStart:'',planEnd:'',basis:'Synthetic fixture period approved for tests only'};
beforeAll(async()=>{
  process.env.REPORT_STORAGE_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-fact-test-'));
  const user=await bootstrapFirstAdministrator({login:'fact_test_admin',fullName:'Synthetic publication administrator',password:adminPassword,
    reason:'Synthetic isolated publication test',approvalReference:'SYNTHETIC_LOCAL_TEST_APPROVAL'});grant=user.grantId;
  await provisionOrganizationEditor('fact_test_admin','SYNTHETIC_LOCAL_EDITOR_APPROVAL');
  await provisionReportStaging('fact_test_admin','SYNTHETIC_LOCAL_STAGE_APPROVAL');
  admin=await login('fact_test_admin',adminPassword);rm=await login('rm_a');rf=await login('rf_a');
  for(const [id,code] of [[a,'FACT_A_SYNTHETIC'],[b,'FACT_B_SYNTHETIC']]) {
    await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from) VALUES($1,$2,'ORG_UNIT','PRE_LAUNCH','2020-01-01')`,[id,code]);
    await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic local fixture')`,[id,'Синтетический филиал '+code]);
    await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic local fixture')`,[id,root]);
  }
  readerGrant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from) VALUES($1,'REGIONAL_MANAGER',$2,now()) RETURNING id`,[rm.userId,a])).rows[0].id;
  const u=await authed(admin).post('/api/v1/report-batches').field('metadata',JSON.stringify({network_id:root,period:{state:'REQUIRES_CONFIRMATION'}}))
    .attach('files',Buffer.from(makeWorkbook(summaryRows())),'synthetic-facts.xlsx');expect(u.status).toBe(200);
  const p=await authed(admin).post(`/api/v1/report-batches/${u.body.id}/probe`).send({expected_version:u.body.version});expect(p.status).toBe(200);batch=p.body;await refresh();
});
beforeEach(resetLimits);afterAll(closePool);
test('PUB-01 no automatic publication/read grants, private staging stays private',async()=>{
  expect(await count('report_fact_access')).toBe(0);
  const state=await authed(admin).get(base()+'/publication');expect(state.status).toBe(200);expect(state.body.can_publish).toBe(false);
  for(const s of [admin,rm,rf])expect((await read(s)).status).toBe(403);
  expect((await request(app).get(base()+'/publication')).status).toBe(401);
  expect((await authed(rm).get(base()+'/publication')).status).toBe(403);
  expect((await scan()).status).toBe(403);
});
test('PUB-02 explicit metric-level capability, no overwrite or network reader',async()=>{
  await provisionFactAccess(grant,'PUBLISH',['sales','margin','stock','aged'],'SYNTHETIC_PUBLICATION_ALLOWLIST');
  await provisionFactAccess(readerGrant,'READ',['sales'],'SYNTHETIC_BRANCH_SALES_ONLY');
  await expect(provisionFactAccess(grant,'READ',['sales'],'SYNTHETIC_FORBIDDEN_NETWORK')).rejects.toThrow();
  await expect(provisionFactAccess(readerGrant,'READ',['margin'],'SYNTHETIC_NO_SILENT_REPLACE')).rejects.toThrow();
  expect((await read()).body.items).toEqual([]);
  expect((await read(admin)).status).toBe(403);
});
test('PUB-03 explicit source selection; invalid payloads never publish',async()=>{
  await draft(period,[{item_id:sourceItemId(batch.id,'summary',3),org_unit_id:a},{item_id:sourceItemId(batch.id,'summary',4),org_unit_id:b}]);
  for(const extra of [{choices:[]},{confirm_source_aggregates:false},{metrics:{sales:9}},{review_version:0},
    {choices:[{metric:'sales',source:'auto',methodology:'Synthetic input methodology'}]},
    {choices:[{metric:'sales',source:'summary',methodology:'ok'}]}])expect((await verify(cmd(extra))).status).toBe(422);
  expect((await verify(cmd({choices:[{metric:'plan',source:'sales',methodology:'Synthetic plan method no permission'}]}))).status).toBe(403);
  expect(await count('report_fact_snapshots')).toBe(0);
});
test('PUB-04 AV missing blocks; no client fabricated scan override',async()=>{
  const p=await verify();expect(p.status).toBe(200);expect(p.body.can_commit).toBe(false);expect(p.body.preview_id).toBeNull();
  expect(p.body.blockers.join(' ')).toContain('антивирус');
  expect((await authed(admin).post(base()+'/scan').send({result:'CLEAN'})).status).toBe(422);
  expect((await verify(cmd({scan:'CLEAN'}))).status).toBe(422);
});
test('PUB-05 infected originals remain blocked, later clean scan can be evaluated',async()=>{
  (scanBytes as jest.Mock).mockResolvedValueOnce({scanner:'SYNTHETIC_INFECTED',result:'INFECTED'});
  expect((await scan()).status).toBe(200);expect((await verify()).body.can_commit).toBe(false);
  expect((await scan()).status).toBe(200);
  const p=await verify();expect(p.status).toBe(200);expect(p.body.blockers).toEqual([]);preview=p.body;expect(preview.can_commit).toBe(true);
  expect(preview.rows).toHaveLength(4);expect(preview.rows.find((x:any)=>x.org_unit_id===a&&x.metric==='margin').value).toBe(-20);
  expect(await count('report_fact_snapshots')).toBe(0);
});
test('PUB-06 Origin, CSRF, unknown query fields and idempotency key enforced',async()=>{
  const url=base()+'/publish',body={preview_id:preview.preview_id,proposal_hash:preview.proposal_hash,confirm:true};
  expect((await request(app).post(url).set('Cookie',admin.cookie).send(body)).status).toBe(403);
  expect((await request(app).post(url).set('Cookie',admin.cookie).set('Origin',ORIGIN).send(body)).status).toBe(403);
  expect((await authed(admin).post(url).send(body)).status).toBe(422);
  expect((await authed(admin).post(base()+'/preview?scope=NETWORK').send(cmd())).status).toBe(422);
  expect((await publish(preview,randomUUID(),rm)).status).toBe(403);
});
test('PUB-07 commit writes immutable snapshots and atomic audit, duplicate click replays once',async()=>{
  lastKey=randomUUID();lastBody=preview;
  const responses=await Promise.all([publish(preview,lastKey),publish(preview,lastKey)]);
  expect(responses.map(x=>x.status)).toEqual([200,200]);expect(responses[0].body).toEqual(responses[1].body);
  expect(await count('report_fact_snapshots')).toBe(4);expect(await count('report_fact_publications')).toBe(1);
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='REPORT_FACTS_PUBLISHED'")).rows[0].n).toBe(1);
  expect((await pool.query("SELECT count(*)::int n FROM outbox_events WHERE event_type='report.facts.published'")).rows[0].n).toBe(1);
  firstSnapshot=(await pool.query("SELECT id FROM report_fact_snapshots WHERE org_unit_id=$1 AND metric='sales'",[a])).rows[0].id;
  await expect(pool.query("UPDATE report_fact_snapshots SET value=0 WHERE id=$1",[firstSnapshot])).rejects.toThrow();
  await expect(pool.query("DELETE FROM report_fact_snapshots WHERE id=$1",[firstSnapshot])).rejects.toThrow();
});
test('PUB-08 current allowlist filters financial metrics and all other branches; exact period only',async()=>{
  const r=await read();expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store, private');
  expect(r.body.items).toHaveLength(1);expect(r.body.items[0]).toMatchObject({org_unit_id:a,metric:'sales',value:'3',revision:1});
  expect(r.body.items[0].provenance.address).toBe('H3');
  expect((await read(rm,'&org='+b)).status).toBe(404);
  expect((await read(rf)).status).toBe(403);
  expect((await authed(rm).get('/api/v1/report-facts?start=2030-04-01&end=2030-04-09')).body.items).toEqual([]);
  expect((await read(rm,'&metric=margin')).status).toBe(422);
});
test('PUB-09 changed draft invalidates checked publication',async()=>{
  const p=(await verify()).body;
  await draft({...period,basis:'Changed synthetic period basis, same dates'});
  expect((await publish(p)).status).toBe(409);expect(await count('report_fact_publications')).toBe(1);
  expect((await verify(cmd({review_version:review.current.version-1}))).status).toBe(409);
});
test('PUB-10 competing previews replace via new revision; stale second preview conflicts',async()=>{
  const p1=(await verify()).body,p2=(await verify()).body;
  expect(p1.rows.find((x:any)=>x.org_unit_id===a&&x.metric==='sales').previous_id).toBe(firstSnapshot);
  const rr=await Promise.all([publish(p1),publish(p2)]);expect(rr.map(x=>x.status).sort()).toEqual([200,409]);
  const history=await read(rm,'&history=true');expect(history.body.items).toHaveLength(2);
  expect(history.body.items[0]).toMatchObject({revision:2,replaces:firstSnapshot,is_current:true});
  expect(history.body.items[1].is_current).toBe(false);
});
test('PUB-11 audit failure rolls back facts, publication, pointers and idempotency',async()=>{
  const p=(await verify()).body,key=randomUUID(),before=await count('report_fact_snapshots');
  await pool.query(`CREATE FUNCTION test_fact_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='REPORT_FACTS_PUBLISHED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_fact_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fact_audit_failure()`);
  try{expect((await publish(p,key)).status).toBe(503);}
  finally{await pool.query('DROP TRIGGER test_fact_failure ON audit_log; DROP FUNCTION test_fact_audit_failure()');}
  expect(await count('report_fact_snapshots')).toBe(before);
  expect((await pool.query('SELECT count(*)::int n FROM idempotency_records WHERE key=$1',[key])).rows[0].n).toBe(0);
});
test('PUB-12 revoked publisher and reader cannot replay/read old results',async()=>{
  await pool.query("UPDATE report_fact_access SET revoked_at=now() WHERE grant_id=ANY($1::uuid[])",[[grant,readerGrant]]);
  expect((await publish(lastBody,lastKey)).status).toBe(403);expect((await read()).status).toBe(403);
  // Restore ONLY in the guarded synthetic test database.
  await pool.query("UPDATE report_fact_access SET revoked_at=NULL WHERE grant_id=ANY($1::uuid[])",[[grant,readerGrant]]);
});
test('PUB-13 missing period, unmapped source and historical gap block publication',async()=>{
  await draft(null);expect((await verify()).body.can_commit).toBe(false);
  await draft(period,[{item_id:sourceItemId(batch.id,'summary',4),org_unit_id:null}]);
  expect((await verify()).body.blockers.join(' ')).toContain('UUID');
  await draft({...period,start:'2019-01-01',end:'2019-01-08'},[{item_id:sourceItemId(batch.id,'summary',4),org_unit_id:b}]);
  expect((await verify()).body.blockers.join(' ')).toContain('Историческая'.toLowerCase());
  await draft(period);
});
test('PUB-14 source integrity rechecked even after valid preview',async()=>{
  const p=(await verify()).body,f=(await pool.query('SELECT * FROM report_staging_files WHERE batch_id=$1',[batch.id])).rows[0];
  const file=path.join(process.env.REPORT_STORAGE_DIR!,batch.id,f.id+'.blob'),bytes=await fs.readFile(file);
  await fs.writeFile(file,Buffer.from('corrupted synthetic fixture'));
  try{expect((await publish(p)).status).toBe(503);}
  finally{await fs.writeFile(file,bytes);}
});
test('PUB-15 stock uses source snapshot date, never sales range',async()=>{
  const p=(await verify(cmd({choices:[{metric:'stock',source:'summary',methodology:'Synthetic dated stock source, COUNT, no period summation.'}]}))).body;
  expect(p.can_commit).toBe(true);expect(p.rows.every((r:any)=>r.period_start==='2030-04-10'&&r.period_end==='2030-04-10')).toBe(true);
});
test('PUB-16 no upload original or diary mutations via publication',async()=>{
  const original=await authed(admin).get('/api/v1/report-batches/'+batch.id);
  expect(original.body.canonical_applied).toBe(false);expect(original.body.preview_hash).toBe(batch.preview_hash);
  const f=(await pool.query('SELECT id FROM report_staging_files WHERE batch_id=$1',[batch.id])).rows[0];
  expect((await authed(admin).get(`/api/v1/report-batches/${batch.id}/files/${f.id}/download`)).status).toBe(403);
  expect(await count('daily_log_records')).toBe(0);expect(await count('work_items')).toBe(0);
});
test('PUB-17 fabricated, expired and hash-modified previews rejected',async()=>{
  const p=(await verify()).body;
  expect((await publish({...p,preview_id:randomUUID()})).status).toBe(404);
  expect((await publish({...p,proposal_hash:'f'.repeat(64)})).status).toBe(409);
  const old=randomUUID();
  await pool.query(`INSERT INTO report_fact_previews(id,batch_id,actor_user_id,review_version,review_hash,command,proposal,proposal_hash,expires_at)
    SELECT $1,batch_id,actor_user_id,review_version,review_hash,command,proposal,proposal_hash,now()-interval '1 minute'
    FROM report_fact_previews WHERE id=$2`,[old,p.preview_id]);
  expect((await publish({...p,preview_id:old})).status).toBe(409);
});
test('PUB-18 changed antivirus receipt invalidates preview before commit',async()=>{
  const p=(await verify()).body;
  (scanBytes as jest.Mock).mockResolvedValueOnce({scanner:'SYNTHETIC_NEW_THREAT',result:'INFECTED'});
  expect((await scan()).status).toBe(200);
  expect((await publish(p)).status).toBe(409);
  expect((await scan()).status).toBe(200);
});
test('PUB-19 unavailable scanner is not a clean scan and does not create a receipt',async()=>{
  const before=await count('report_source_scans');
  (scanBytes as jest.Mock).mockRejectedValueOnce(new Error('Synthetic scanner unavailable'));
  expect((await scan()).status).toBe(503);
  expect(await count('report_source_scans')).toBe(before);
});
test('PUB-20 original totals mismatch blocks only publication, never manufactures zero',async()=>{
  const rows=summaryRows();rows[1][7]=999;
  const u=await authed(admin).post('/api/v1/report-batches').field('metadata',JSON.stringify({network_id:root,period:{state:'REQUIRES_CONFIRMATION'}}))
    .attach('files',Buffer.from(makeWorkbook(rows)),'synthetic-bad-total.xlsx');
  const prior=batch;
  const p=await authed(admin).post(`/api/v1/report-batches/${u.body.id}/probe`).send({expected_version:u.body.version});
  expect(p.status).toBe(200);batch=p.body;await refresh();
  await draft(period,[{item_id:sourceItemId(batch.id,'summary',3),org_unit_id:a},{item_id:sourceItemId(batch.id,'summary',4),org_unit_id:b}]);
  expect((await scan()).status).toBe(200);
  const v=await verify();expect(v.body.can_commit).toBe(false);expect(v.body.blockers.join(' ')).toContain('итог отчёта');
  batch=prior;await refresh();
});
