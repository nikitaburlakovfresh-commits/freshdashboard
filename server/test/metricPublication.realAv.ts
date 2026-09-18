// Opt-in, real ClamAV + current official signatures. No Jest mock of scanner.
// The globalSetup guard permits only the local, disposable fresh_pilot_test DB.
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
import { authed,login,Session,TEST_PASSWORD } from './helpers';
import { makeWorkbook,summaryRows } from './reportFixtures';
import { sourceItemId } from '../src/reporting/review';
const root='10000000-0000-4000-8000-000000000004';
const branches=[randomUUID(),randomUUID()];
let admin:Session,reader:Session,batch:any,review:any,storage:string;
const period={start:'2030-04-01',end:'2030-04-08',planStart:'',planEnd:'',basis:'Synthetic real AV integration period only'};
const body=()=>({review_version:review.current.version,
  choices:[{metric:'sales',source:'summary',methodology:'Synthetic full source rows, count units, no derived formula.'}],
  reason:'Synthetic local AV release verification',confirm_source_aggregates:true});
beforeAll(async()=>{
  storage=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-real-av-'));process.env.REPORT_STORAGE_DIR=storage;
  const password=TEST_PASSWORD+'-RealAVOnly2026';
  const first=await bootstrapFirstAdministrator({login:'av_local_admin',fullName:'Synthetic AV Administrator',password,
    reason:'Synthetic local real AV test',approvalReference:'SYNTHETIC_LOCAL_AV_ONLY'});
  await provisionOrganizationEditor('av_local_admin','SYNTHETIC_LOCAL_AV_EDITOR');
  await provisionReportStaging('av_local_admin','SYNTHETIC_LOCAL_AV_STAGE');
  await provisionFactAccess(first.grantId,'PUBLISH',['sales'],'SYNTHETIC_LOCAL_AV_PUBLISH');
  admin=await login('av_local_admin',password);reader=await login('rm_a');
  for(const [i,id] of branches.entries()){
    await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
      VALUES($1,$2,'ORG_UNIT','PRE_LAUNCH','2020-01-01')`,[id,'AV_SYNTHETIC_'+i]);
    await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
      VALUES($1,$2,'2020-01-01','Synthetic local AV fixture')`,[id,'Synthetic AV Branch '+i]);
    await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason)
      VALUES($1,$2,'2020-01-01','Synthetic local AV fixture')`,[id,root]);
  }
  const grant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
    VALUES($1,'REGIONAL_MANAGER',$2,now()) RETURNING id`,[reader.userId,branches[0]])).rows[0].id;
  await provisionFactAccess(grant,'READ',['sales'],'SYNTHETIC_LOCAL_AV_READ');
  const u=await authed(admin).post('/api/v1/report-batches')
    .field('metadata',JSON.stringify({network_id:root,period:{state:'REQUIRES_CONFIRMATION'}}))
    .attach('files',Buffer.from(makeWorkbook(summaryRows())),'synthetic-av.xlsx');
  expect(u.status).toBe(200);
  const p=await authed(admin).post(`/api/v1/report-batches/${u.body.id}/probe`).send({expected_version:u.body.version});
  expect(p.status).toBe(200);batch=p.body;
  review=(await authed(admin).get(`/api/v1/report-batches/${batch.id}/review`)).body;
  const draft=await authed(admin).post(`/api/v1/report-batches/${batch.id}/review`)
    .set('Idempotency-Key',randomUUID()).send({expected_version:review.current.version,preview_hash:batch.preview_hash,
      period,edits:branches.map((id,i)=>({item_id:sourceItemId(batch.id,'summary',i+3),org_unit_id:id})),
      reason:'Synthetic mapping for real scanner integration'});
  expect(draft.status).toBe(200);
  review=(await authed(admin).get(`/api/v1/report-batches/${batch.id}/review`)).body;
},60000);
afterAll(async()=>{await closePool();if(storage)await fs.rm(storage,{recursive:true,force:true});});
test('REAL-AV-01 unscanned XLSX blocked, real scan produces bound CLEAN receipt',async()=>{
  const endpoint=`/api/v1/report-facts/${batch.id}`;
  expect((await authed(admin).post(endpoint+'/preview').send(body())).body.can_commit).toBe(false);
  const result=await authed(admin).post(endpoint+'/scan').send({});
  expect(result.status).toBe(200);expect(result.body.results[0].result).toBe('CLEAN');
  const receipt=(await pool.query('SELECT scanner,result,content_hash FROM report_source_scans')).rows;
  expect(receipt).toHaveLength(1);expect(receipt[0].scanner).toMatch(/^ClamAV .*\/\d+\//);
  expect(receipt[0].content_hash).toBeTruthy();
},90000);
test('REAL-AV-02 real clean receipt permits publication, reader gets only own branch',async()=>{
  const endpoint=`/api/v1/report-facts/${batch.id}`;
  const preview=await authed(admin).post(endpoint+'/preview').send(body());
  expect(preview.status).toBe(200);expect(preview.body.can_commit).toBe(true);
  const applied=await authed(admin).post(endpoint+'/publish').set('Idempotency-Key',randomUUID())
    .send({preview_id:preview.body.preview_id,proposal_hash:preview.body.proposal_hash,confirm:true});
  expect(applied.status).toBe(200);
  const read=await authed(reader).get('/api/v1/report-facts?start=2030-04-01&end=2030-04-08');
  expect(read.status).toBe(200);expect(read.body.items).toHaveLength(1);
  expect(read.body.items[0]).toMatchObject({org_unit_id:branches[0],metric:'sales',value:'3'});
});
test('REAL-AV-03 harmless EICAR test pattern is rejected by actual scanner',async()=>{
  const eicar=Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  expect((await scanBytes(eicar)).result).toBe('INFECTED');
},90000);
