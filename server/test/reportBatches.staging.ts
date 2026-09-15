// Separate isolated suite, same local PG16/name guard as editor tests.
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes,randomUUID } from 'crypto';
import { zipSync,unzipSync,strToU8,strFromU8 } from 'fflate';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor,editorPermissions } from '../src/domain/orgEditorProvisioning';
import { provisionReportStaging } from '../src/reporting/provisioning';
import { validateXlsx } from '../src/reporting/zipSafety';
import { parseMetadata } from '../src/reporting/service';
import { storageRoot,readSource } from '../src/reporting/storage';
import * as probeModule from '../src/reporting/probe';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,login,authed,Session,ORIGIN } from './helpers';
import { createApp } from '../src/app';
import { makeWorkbook,summaryRows,salesRows } from './reportFixtures';

const base='/api/v1/report-batches',root='10000000-0000-4000-8000-000000000004';
const password=randomBytes(32).toString('base64url');
const summary=Buffer.from(makeWorkbook(summaryRows())),sales=Buffer.from(makeWorkbook(salesRows()));
const metadata={network_id:root,period:{state:'REQUIRES_CONFIRMATION'}};
let admin:Session,rm:Session,rf:Session,grantId:string,saved:any;
const upload=(meta:any=metadata,files=[summary],session=admin,names=['synthetic-summary.xlsx'])=>{
  const r=authed(session).post(base).field('metadata',JSON.stringify(meta));
  files.forEach((f,i)=>r.attach('files',f,{filename:names[i] ?? 'synthetic-sales.xlsx',contentType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}));
  return r;
};
const runProbe=(batch:any,session=admin)=>authed(session).post(`${base}/${batch.id}/probe`).send({expected_version:batch.version});
const freshSummary=(label:string)=>{
  const rows=summaryRows();rows[2][0]=label;return Buffer.from(makeWorkbook(rows));
};
beforeAll(async()=>{
  process.env.REPORT_STORAGE_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-staging-test-'));
  const b=await bootstrapFirstAdministrator({login:'report_staging_test',fullName:'Synthetic report administrator',password,
    reason:'Isolated synthetic staging test',approvalReference:'SYNTHETIC_LOCAL_TEST_ONLY'});
  grantId=b.grantId;admin=await login('report_staging_test',password);rm=await login('rm_a');rf=await login('rf_a');
  await provisionOrganizationEditor('report_staging_test','SYNTHETIC_LOCAL_EDITOR_APPROVAL');
});
beforeEach(resetLimits);afterAll(closePool);

test('STAGE-01 migration grants no staging rights; CLI refuses wrong user or no approval',async()=>{
  expect((await authed(admin).get(base)).status).toBe(403);
  expect((await pool.query('SELECT count(*)::int n FROM report_staging_access')).rows[0].n).toBe(0);
  await expect(provisionReportStaging('rm_a','SYNTHETIC_LOCAL_APPROVAL')).rejects.toThrow();
  await expect(provisionReportStaging('report_staging_test','')).rejects.toThrow();
});
test('STAGE-02 explicit provisioning is audited/idempotent, preserves password and seven permissions',async()=>{
  const before=(await pool.query('SELECT password_hash FROM app_users WHERE id=$1',[admin.userId])).rows;
  expect((await provisionReportStaging('report_staging_test','SYNTHETIC_BOUNDED_REPORT_APPROVAL')).status).toBe('PROVISIONED');
  expect((await provisionReportStaging('report_staging_test','SYNTHETIC_BOUNDED_REPORT_APPROVAL')).status).toBe('ALREADY_PROVISIONED');
  expect((await pool.query('SELECT password_hash FROM app_users WHERE id=$1',[admin.userId])).rows).toEqual(before);
  expect((await authed(admin).get('/api/v1/me')).body.grants[0].permissions.sort()).toEqual(['organization.directory.review',...editorPermissions].sort());
  expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='REPORT_STAGING_PROVISIONED'")).rows[0].n).toBe(1);
  expect((await authed(admin).get('/api/v1/work-items')).body.items).toEqual([]);
});
test('STAGE-03 every route requires authentication and a current admin capability, no RM/RF leakage',async()=>{
  for(const p of [base,base+'/capabilities',base+'/'+randomUUID(),base+'/'+randomUUID()+'/files/'+randomUUID()+'/download'])
    expect((await request(app).get(p)).status).toBe(401);
  for(const session of [rm,rf]) {
    for(const p of [base,base+'/capabilities',base+'/'+randomUUID(),base+'/'+randomUUID()+'/files/'+randomUUID()+'/download'])
      expect((await authed(session).get(p)).status).toBe(403);
    expect((await upload(metadata,[summary],session)).status).toBe(403);
    expect((await runProbe({id:randomUUID(),version:1},session)).status).toBe(403);
  }
});
test('STAGE-04 capability exposes only real roots; guessed scope, missing root and demo root denied',async()=>{
  const c=await authed(admin).get(base+'/capabilities');expect(c.status).toBe(200);
  expect(c.body.roots.map((x:any)=>x.id)).toEqual([root]);expect(c.body.commit_available).toBe(false);
  for(const id of [randomUUID(),'10000000-0000-4000-8000-000000000001'])
    expect((await upload({...metadata,network_id:id})).status).toBe(422);
  expect((await authed(admin).get(base+'?scope=NETWORK')).status).toBe(422);
  expect((await upload({...metadata,scope:'all'})).status).toBe(422);
});
test('STAGE-05 unsafe requests require Origin and CSRF before reading files',async()=>{
  expect((await request(app).post(base).set('Cookie',admin.cookie).field('metadata',JSON.stringify(metadata)).attach('files',summary,'a.xlsx')).status).toBe(403);
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('Origin',ORIGIN).send({})).status).toBe(403);
});
test('STAGE-06 upload persists private originals and unknown period; official ledger untouched',async()=>{
  const before=(await pool.query('SELECT count(*)::int n FROM org_directory_units')).rows[0].n;
  const r=await upload(metadata,[summary,sales]);expect(r.status).toBe(200);saved=r.body;
  expect(saved.status).toBe('QUARANTINE');expect(saved.storage_state).toBe('READY');
  expect(saved.period).toEqual({state:'REQUIRES_CONFIRMATION'});expect(saved.files).toHaveLength(2);
  expect(saved.preview).toBeNull();expect(saved.canonical_applied).toBe(false);
  const stat=await fs.stat(path.join(storageRoot(),saved.id,saved.files[0].id+'.blob'));expect(stat.mode&0o777).toBe(0o600);
  expect((await pool.query('SELECT count(*)::int n FROM org_directory_units')).rows[0].n).toBe(before);
  expect(r.headers['cache-control']).toBe('no-store, private');
});
test('STAGE-07 identical content reordered/renamed is durably deduplicated',async()=>{
  const r=await upload(metadata,[sales,summary],admin,['changed.xlsx','other.xlsx']);
  expect(r.status).toBe(200);expect(r.body.id).toBe(saved.id);expect(r.body.reused).toBe(true);
  expect((await pool.query('SELECT count(*)::int n FROM report_staging_batches')).rows[0].n).toBe(1);
});
test('STAGE-08 worker persists valid preview, separate network total/control rows and unresolved UUIDs',async()=>{
  const r=await runProbe(saved);expect(r.status).toBe(200);saved=r.body;
  expect(saved.status).toBe('NEEDS_MAPPING');expect(saved.preview.valid_structure).toBe(true);
  expect(saved.preview.reports).toHaveLength(2);
  const summaryReport=saved.preview.reports.find((x:any)=>x.kind==='summary');
  expect(summaryReport.total.values.sales).toBe(8);expect(summaryReport.stockDate).toBe('2030-04-10');
  expect(saved.period.state).toBe('REQUIRES_CONFIRMATION');
  expect(summaryReport.branches).toHaveLength(2);expect(saved.preview.mappings).toHaveLength(4);
  expect(saved.preview.mappings.every((m:any)=>m.org_unit_id===null && m.status==='NEEDS_MAPPING')).toBe(true);
  expect(saved.preview.blockers).toEqual(expect.arrayContaining(['NEEDS_MAPPING','PERIOD_REQUIRES_CONFIRMATION','MALWARE_SCAN_REQUIRED']));
  expect(saved.preview_hash).toMatch(/^[a-f0-9]{64}$/);
});
test('STAGE-09 repeat probe is idempotent and a fresh app instance reads persisted preview',async()=>{
  const r=await runProbe(saved);expect(r.status).toBe(200);expect(r.body.version).toBe(saved.version);expect(r.body.preview_hash).toBe(saved.preview_hash);
  const reopened=await request(createApp()).get(`${base}/${saved.id}`).set('Cookie',admin.cookie);
  expect(reopened.status).toBe(200);expect(reopened.body.preview).toEqual(saved.preview);
});
test('STAGE-10 quarantine gateway denies original download, commit, mapping and public raw paths',async()=>{
  expect((await authed(admin).get(`${base}/${saved.id}/files/${saved.files[0].id}/download`)).status).toBe(403);
  expect((await authed(rm).get(`${base}/${saved.id}`)).status).toBe(403);
  for(const action of ['commit','mapping','apply','delete'])
    expect((await authed(admin).post(`${base}/${saved.id}/${action}`).send({approved:true})).status).toBe(403);
  expect((await request(app).get('/'+saved.id+'/'+saved.files[0].id+'.blob')).status).toBe(404);
  expect((await authed(admin).get(`${base}/${randomUUID()}`)).status).toBe(404);
});
test('STAGE-11 confirmed sales period is explicit; plan remains independently unknown and blocks publication',async()=>{
  const period={state:'CONFIRMED',start:'2030-04-01',end:'2030-04-08',planStart:'',planEnd:'',confirmation:'Synthetic owner period confirmation only'};
  const r=await upload({...metadata,period});expect(r.status).toBe(200);expect(r.body.id).not.toBe(saved.id);
  const p=await runProbe(r.body);expect(p.body.period).toEqual(period);
  expect(p.body.preview.blockers).toContain('PLAN_PERIOD_UNCONFIRMED');expect(p.body.preview.blockers).not.toContain('PERIOD_REQUIRES_CONFIRMATION');
  const duplicate=await upload({...metadata,period:{...period,confirmation:'Reworded synthetic confirmation of SAME period'}});
  expect(duplicate.body.id).toBe(r.body.id);expect(duplicate.body.reused).toBe(true);
});
test.each([
  {state:'REQUIRES_CONFIRMATION',start:'2030-04-01'},
  {state:'CONFIRMED',start:'2030-02-30',end:'2030-03-02',planStart:'',planEnd:'',confirmation:'Synthetic confirmed period'},
  {state:'CONFIRMED',start:'2030-04-01',end:'2030-04-08',planStart:'2030-04-01',planEnd:'',confirmation:'Synthetic confirmed period'},
  {state:'CONFIRMED',start:'2030-04-01',end:'2030-04-08',planStart:'',planEnd:'',confirmation:'yes'},
])('STAGE-12 metadata rejects invented/invalid dates %j',period=>expect(()=>parseMetadata({...metadata,period})).toThrow());
test('STAGE-13 multipart rejects non-XLSX, third file, duplicate file, missing metadata and overlarge content',async()=>{
  expect((await upload(metadata,[Buffer.from('not a workbook')])).status).toBe(422);
  expect((await upload(metadata,[summary],admin,['detail.xlsm'])).status).toBe(422);
  expect((await upload(metadata,[summary,sales,summary])).status).toBe(422);
  expect((await upload(metadata,[summary,summary])).status).toBe(422);
  expect((await authed(admin).post(base).attach('files',summary,'a.xlsx')).status).toBe(422);
  expect((await upload(metadata,[Buffer.alloc(8*1024*1024+1)])).status).toBe(422);
});
test('STAGE-14 unrecognized detail file is quarantined/rejected, no partial normalized records',async()=>{
  const r=await upload(metadata,[Buffer.from(makeWorkbook([['VIN','Manager'],['SYNTHETIC','Nobody']]))]);
  expect(r.status).toBe(200);const p=await runProbe(r.body);
  expect(p.status).toBe(200);expect(p.body.status).toBe('REJECTED');expect(p.body.preview.valid_structure).toBe(false);
  expect(p.body.preview.reports).toBeUndefined();
});
test('STAGE-15 multi-file preview is atomic: one invalid file rejects entire batch',async()=>{
  const r=await upload(metadata,[freshSummary('Atomic synthetic'),Buffer.from(makeWorkbook([['unknown'],['bad']]))]);
  expect(r.status).toBe(200);const p=await runProbe(r.body);
  expect(p.body.status).toBe('REJECTED');expect(p.body.preview.reports).toBeUndefined();
});
test('STAGE-16 display filename is sanitized and never used as a storage key',async()=>{
  const r=await upload(metadata,[freshSummary('Sanitized synthetic')],admin,['../../secret/unsafe-<>&.xlsx']);
  expect(r.status).toBe(200);expect(r.body.files[0].display_name).not.toMatch(/[<>/&]/);
  expect(await fs.readdir(path.join(storageRoot(),r.body.id))).toEqual([r.body.files[0].id+'.blob']);
});
test('STAGE-17 parser supports both original aggregate contracts with CRC verification',()=>{
  expect(()=>validateXlsx(summary)).not.toThrow();expect(()=>validateXlsx(sales)).not.toThrow();
});
test.each([
  ['formula',(p:any)=>{p['xl/worksheets/sheet1.xml']=strToU8(strFromU8(p['xl/worksheets/sheet1.xml']).replace('<v>8</v>','<f>1+7</f><v>8</v>'));}],
  ['unicode-prefixed formula',(p:any)=>{p['xl/worksheets/sheet1.xml']=strToU8(strFromU8(p['xl/worksheets/sheet1.xml']).replace('<v>8</v>','<π:f xmlns:π="urn:synthetic">1+7</π:f><v>8</v>'));}],
  ['external',(p:any)=>{p['xl/_rels/workbook.xml.rels']=strToU8('<Relationships><Relationship TargetMode="External" Target="https://invalid.example"/></Relationships>');}],
  ['entity-encoded external',(p:any)=>{p['xl/_rels/workbook.xml.rels']=strToU8('<Relationships><Relationship TargetMode="Ext&#101;rnal" Target="https://invalid.example"/></Relationships>');}],
  ['DTD shared strings',(p:any)=>{p['xl/sharedStrings.xml']=strToU8('<!DOCTYPE x [<!ENTITY a "b">]><sst/>');}],
  ['macro',(p:any)=>{p['xl/vbaProject.bin']=new Uint8Array([1]);}],
  ['traversal',(p:any)=>{p['../file.xml']=strToU8('<a/>');}],
  ['second worksheet',(p:any)=>{p['xl/worksheets/sheet2.xml']=p['xl/worksheets/sheet1.xml'];}],
])('STAGE-18 rejects dangerous XLSX parts: %s',(_name,mutate)=>{
  const parts=unzipSync(summary);(mutate as Function)(parts);expect(()=>validateXlsx(Buffer.from(zipSync(parts)))).toThrow();
});
test('STAGE-19 ZIP CRC tampering and compression bomb rejected before parsing',()=>{
  const corrupt=Buffer.from(summary),idx=corrupt.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));
  corrupt[idx+16]^=1;expect(()=>validateXlsx(corrupt)).toThrow();
  const parts=unzipSync(summary);parts['xl/sharedStrings.xml']=strToU8('<sst>'+(' '.repeat(2*1024*1024))+'</sst>');
  expect(()=>validateXlsx(Buffer.from(zipSync(parts)))).toThrow();
});
test('STAGE-20 source/period/hash and probed snapshots are immutable in DB',async()=>{
  await expect(pool.query("UPDATE report_staging_batches SET period='{}',version=version+1 WHERE id=$1",[saved.id])).rejects.toThrow();
  await expect(pool.query("UPDATE report_staging_files SET display_name='changed.xlsx' WHERE batch_id=$1",[saved.id])).rejects.toThrow();
  await expect(pool.query('DELETE FROM report_staging_batches WHERE id=$1',[saved.id])).rejects.toThrow();
});
test('STAGE-21 grant revocation/expiry and capability revocation checked on EVERY endpoint',async()=>{
  const checks=async()=>{
    for(const p of [base,base+'/capabilities',base+'/'+saved.id,`${base}/${saved.id}/files/${saved.files[0].id}/download`])
      expect((await authed(admin).get(p)).status).toBe(403);
    expect((await upload()).status).toBe(403);expect((await runProbe(saved)).status).toBe(403);
  };
  for(const [table,column,value] of [['role_grants','revoked_at','now()'],['role_grants','valid_until',"now()-interval '1 second'"],
    ['report_staging_access','revoked_at','now()']] as const) {
    await pool.query(`UPDATE ${table} SET ${column}=${value} WHERE ${table==='role_grants'?'id':'grant_id'}=$1`,[grantId]);
    try {await checks();} finally {await pool.query(`UPDATE ${table} SET ${column}=NULL WHERE ${table==='role_grants'?'id':'grant_id'}=$1`,[grantId]);}
  }
});
test('STAGE-22 revoked session and auth epoch immediately deny all reads/writes',async()=>{
  await pool.query('UPDATE app_users SET auth_epoch=auth_epoch+1 WHERE id=$1',[admin.userId]);
  expect((await authed(admin).get(`${base}/${saved.id}`)).status).toBe(401);
  expect((await runProbe(saved)).status).toBe(401);admin=await login('report_staging_test',password);
  const session=await login('report_staging_test',password);
  await authed(session).post('/api/v1/auth/logout').send({});
  expect((await upload(metadata,[summary],session)).status).toBe(401);
});
test('STAGE-23 expiry DURING worker probe is rechecked before persisted preview',async()=>{
  const r=await upload(metadata,[freshSummary('Expiry during probe')]);expect(r.status).toBe(200);
  const spy=jest.spyOn(probeModule,'probeFiles').mockImplementationOnce(async()=>{
    await pool.query('UPDATE report_staging_access SET revoked_at=now() WHERE grant_id=$1',[grantId]);
    return {ok:false,error:'synthetic'};
  });
  try {
    expect((await runProbe(r.body)).status).toBe(403);
    expect((await pool.query('SELECT status,preview FROM report_staging_batches WHERE id=$1',[r.body.id])).rows[0]).toEqual({status:'QUARANTINE',preview:null});
  } finally {spy.mockRestore();await pool.query('UPDATE report_staging_access SET revoked_at=NULL WHERE grant_id=$1',[grantId]);}
});
test('STAGE-24 failed audit at reservation rolls back DB intent and creates no files',async()=>{
  const dirs=await fs.readdir(storageRoot());
  await pool.query(`CREATE FUNCTION test_report_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='REPORT_UPLOAD_RESERVED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_report_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_report_audit_failure()`);
  try {
    expect((await upload(metadata,[freshSummary('Audit rollback')])).status).toBe(503);
    expect(await fs.readdir(storageRoot())).toEqual(dirs);
  } finally {await pool.query('DROP TRIGGER test_report_audit_failure ON audit_log; DROP FUNCTION test_report_audit_failure()');}
});
test('STAGE-25 final-storage audit failure retains known intent, recovery probes hash-verified original',async()=>{
  await pool.query(`CREATE FUNCTION test_report_final_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='REPORT_QUARANTINED' THEN RAISE EXCEPTION 'synthetic final failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_report_final_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_report_final_failure()`);
  try {expect((await upload(metadata,[freshSummary('Final audit rollback')])).status).toBe(503);}
  finally {await pool.query('DROP TRIGGER test_report_final_failure ON audit_log; DROP FUNCTION test_report_final_failure()');}
  const r=await upload(metadata,[freshSummary('Final audit rollback')]);expect(r.body.reused).toBe(true);
  expect(r.body.storage_state).toBe('WRITING');
  const p=await runProbe(r.body);expect(p.status).toBe(200);expect(p.body.status).toBe('NEEDS_MAPPING');
});
test('STAGE-26 truncated original remains quarantine, no silent repair/delete or partial apply',async()=>{
  const r=await upload(metadata,[freshSummary('Truncated synthetic')]);expect(r.status).toBe(200);
  await fs.truncate(path.join(storageRoot(),r.body.id,r.body.files[0].id+'.blob'),20);
  expect((await runProbe(r.body)).status).toBe(422);
  expect((await authed(admin).get(`${base}/${r.body.id}`)).body.status).toBe('QUARANTINE');
});
test('STAGE-27 unsafe webroot configuration and symlink source rejected',async()=>{
  const previous=process.env.REPORT_STORAGE_DIR,web=process.env.CLIENT_DIST;
  process.env.REPORT_STORAGE_DIR='/tmp/public/private';process.env.CLIENT_DIST='/tmp/public';
  try {expect(()=>storageRoot()).toThrow();}
  finally {process.env.REPORT_STORAGE_DIR=previous;if(web)process.env.CLIENT_DIST=web;else delete process.env.CLIENT_DIST;}
  const r=await upload(metadata,[freshSummary('Symlink synthetic')]);expect(r.status).toBe(200);
  const target=path.join(storageRoot(),r.body.id,r.body.files[0].id+'.blob');
  // Preserve original test bytes; never delete old data.
  await fs.rename(target,target+'.retained');await fs.symlink(target+'.retained',target);
  await expect(readSource(r.body.id,r.body.files[0])).rejects.toThrow();
  expect((await runProbe(r.body)).status).toBe(422);
});
test('STAGE-28 wrong expected version denied; arbitrary client previews/metrics rejected',async()=>{
  const r=await upload(metadata,[freshSummary('Expected version synthetic')]);expect(r.status).toBe(200);
  expect((await runProbe({...r.body,version:r.body.version+1})).status).toBe(409);
  expect((await authed(admin).post(`${base}/${r.body.id}/probe`).send({expected_version:r.body.version,preview:{sales:999}})).status).toBe(422);
});
test('STAGE-29 role permission removal invalidates capability; revoked capability never auto-reactivated',async()=>{
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='organization.directory.review'");
  try {expect((await authed(admin).get(base)).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','organization.directory.review')");}
  await pool.query('UPDATE report_staging_access SET revoked_at=now() WHERE grant_id=$1',[grantId]);
  try {await expect(provisionReportStaging('report_staging_test','SYNTHETIC_NO_REACTIVATION')).rejects.toThrow();}
  finally {await pool.query('UPDATE report_staging_access SET revoked_at=NULL WHERE grant_id=$1',[grantId]);}
});
