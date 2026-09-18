// Isolated suite, synthetic localhost/fresh_pilot_test only.
import { randomBytes,randomUUID } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { provisionAccessAdministration } from '../src/domain/accessProvisioning';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { login,authed,idemKey,Session } from './helpers';
let admin:Session,rf:Session,rm:Session,root:string,branch:string;
const password=randomBytes(32).toString('base64url');
const today=new Date().toISOString().slice(0,10);
const day=(offset:number)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const base='/api/v1/organization/proposals';
const create=(change:any,s=admin)=>authed(s).post(base).set('Idempotency-Key',idemKey('draft')).send({change});
const cmd=(p:any,action:string,body:any={},s=admin,key=idemKey(action))=>
  authed(s).post(`${base}/${p.id}/${action}`).set('Idempotency-Key',key).send({expected_version:p.version,...body});
const activation=(id=branch,extra:any={})=>({operation:'ORG_UNIT_ACTIVATE',target_id:id,
  effective_from:today,reason:'Synthetic explicit launch approval',...extra});
async function prepare(c:any) {
  const d=await create(c);expect(d.status).toBe(200);
  const v=await cmd(d.body,'preview');expect(v.status).toBe(200);return v.body;
}
async function apply(c:any) {
  const v=await prepare(c);expect(v.preview_summary.issues).toEqual([]);
  const r=await cmd(v,'apply',{preview_token:v.preview_token});expect(r.status).toBe(200);return r.body;
}
async function make(kind='ORG_UNIT',date=today) {
  return (await apply({operation:'ORG_UNIT_CREATE',kind,code:'ACT_'+randomUUID().replace(/-/g,''),
    display_name:'Synthetic activation branch',parent_id:kind==='NETWORK'?null:root,
    effective_from:date,reason:'Synthetic local test structure'})).target_id as string;
}
async function state(id:string) {
  return (await pool.query(`SELECT lifecycle_state baseline,
    org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date) current,
    org_accepts_new_work(id) admits FROM org_directory_units WHERE id=$1`,[id])).rows[0];
}
beforeAll(async()=>{
  await bootstrapFirstAdministrator({login:'activation_test',fullName:'Synthetic launch administrator',password,
    reason:'Isolated launch testing',approvalReference:'LOCAL_SYNTHETIC_ACTIVATION_APPROVAL'});
  await provisionOrganizationEditor('activation_test','LOCAL_SYNTHETIC_ACTIVATION_APPROVAL');
  await provisionAccessAdministration('activation_test','LOCAL_SYNTHETIC_ACTIVATION_APPROVAL');
  admin=await login('activation_test',password);rf=await login('rf_a');rm=await login('rm_a');
  root=await make('NETWORK');branch=await make();
});
beforeEach(resetLimits);afterAll(closePool);
test('ACT-01 no permission is automatically granted; SUPER_ADMIN and branch roles cannot bypass it',async()=>{
  expect((await pool.query("SELECT 1 FROM role_permissions WHERE permission_code='org_unit.activate'")).rowCount).toBe(0);
  for(const actor of [admin,rf,rm]) expect((await create(activation(),actor)).status).toBe(403);
  // Synthetic explicit local-only grant, never an installer or production seed.
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','org_unit.activate')");
});
test('ACT-02 draft and valid preview change no lifecycle, grants, tasks or notifications',async()=>{
  const before=await state(branch);const v=await prepare(activation());
  expect(v.status).toBe('PREVIEW');expect(v.preview_summary.affected).toMatchObject({
    lifecycle_history:1,name_history:0,affiliation_history:0,role_grants:0,work_items:0,financial_records:0});
  expect(await state(branch)).toEqual(before);expect(before.current).toBe('PRE_LAUNCH');
});
test.each([
  ['tomorrow',()=>branch,{effective_from:day(1)}],
  ['yesterday',()=>branch,{effective_from:day(-1)}],
  ['nonexistent',()=>randomUUID(),{}],
  ['pilot',()=>'00000000-0000-4000-8000-00000000000a',{}],
  ['network',()=>root,{}],
  ['short reason',()=>branch,{reason:'x'}],
  ['invalid date',()=>branch,{effective_from:'2026-02-30'}],
])('ACT-03 rejects %s at preview without issuing capability',async(_name,id,extra)=>{
  const v=await prepare(activation(id(),extra));
  expect(v.status).toBe('DRAFT');expect(v.preview_summary.valid).toBe(false);expect(v.preview_token).toBeNull();
});
test('ACT-04 activation rejects arbitrary status, owner and parent injection',async()=>{
  for(const extra of [{lifecycle_state:'ACTIVE'},{parent_id:root},{display_name:'Overwrite'},{effective_at:'NOW'}])
    expect((await create(activation(branch,extra))).status).toBe(422);
});
test('ACT-05 imported real identity without editor provenance and future branch cannot activate',async()=>{
  const id=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,$2,'ORG_UNIT','PRE_LAUNCH','2020-01-01')`,[id,'IMPORT_'+id]);
  expect((await prepare(activation(id))).preview_summary.valid).toBe(false);
  const future=await make('ORG_UNIT',day(1));
  expect((await prepare(activation(future))).preview_summary.valid).toBe(false);
});
test('ACT-06 scheduled reparenting must be resolved explicitly before launch',async()=>{
  const id=await make(),newRoot=await make('NETWORK');
  await apply({operation:'ORG_UNIT_MOVE_TO_CLUSTER',target_id:id,parent_id:newRoot,effective_from:day(1),reason:'Synthetic planned reorganization'});
  const v=await prepare(activation(id));expect(v.preview_summary.valid).toBe(false);
  expect(v.preview_summary.issues.some((i:any)=>i.path==='parent_id')).toBe(true);
});
test('ACT-07 stale preview, actor-bound token, missing apply permission and revoked rights deny',async()=>{
  const v=await prepare(activation());
  expect((await cmd(v,'apply',{preview_token:randomUUID()})).status).toBe(409);
  expect((await cmd(v,'apply',{preview_token:v.preview_token},rf)).status).toBe(403);
  for(const perm of ['org_unit.activate','organization.change.apply']) {
    await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code=$1",[perm]);
    try { expect((await cmd(v,'apply',{preview_token:v.preview_token})).status).toBe(403); }
    finally { await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN',$1)",[perm]); }
  }
  await make();
  expect((await cmd(v,'apply',{preview_token:v.preview_token})).status).toBe(409);
});
test('ACT-08 audit failure rolls back activation, revision, proposal and idempotency together',async()=>{
  const v=await prepare(activation()),key=idemKey('rollback');
  const revision=(await pool.query('SELECT version FROM org_directory_revision')).rows[0].version;
  await pool.query(`CREATE FUNCTION test_activation_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='ORG_CHANGE_APPLY' THEN RAISE EXCEPTION 'synthetic activation audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_activation_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_activation_fail()`);
  try {
    expect((await cmd(v,'apply',{preview_token:v.preview_token},admin,key)).status).toBe(503);
    expect((await state(branch)).current).toBe('PRE_LAUNCH');
    expect((await pool.query('SELECT 1 FROM org_branch_activations WHERE org_unit_id=$1',[branch])).rowCount).toBe(0);
    expect((await pool.query('SELECT version FROM org_directory_revision')).rows[0].version).toBe(revision);
    expect((await pool.query('SELECT status FROM org_change_proposals WHERE id=$1',[v.id])).rows[0].status).toBe('PREVIEW');
    expect((await pool.query('SELECT 1 FROM idempotency_records WHERE key=$1',[key])).rowCount).toBe(0);
  } finally {await pool.query('DROP TRIGGER test_activation_fail ON audit_log; DROP FUNCTION test_activation_fail()');}
});
test('ACT-09 concurrent apply/replay creates exactly one activation with no implied business data',async()=>{
  const v=await prepare(activation()),key=idemKey('launch');
  const counts=async()=>(await pool.query(`SELECT (SELECT count(*) FROM role_grants) grants,
    (SELECT count(*) FROM work_items) tasks,(SELECT count(*) FROM notifications) notifications,
    (SELECT count(*) FROM report_staging_batches) reports`)).rows[0];
  const before=await counts();
  const [a,b]=await Promise.all([cmd(v,'apply',{preview_token:v.preview_token},admin,key),cmd(v,'apply',{preview_token:v.preview_token},admin,key)]);
  expect(a.status).toBe(200);expect(b.body).toEqual(a.body);expect(a.body.status).toBe('APPLIED');
  expect(await counts()).toEqual(before);
  expect(await state(branch)).toEqual({baseline:'PRE_LAUNCH',current:'ACTIVE',admits:true});
  expect((await pool.query('SELECT count(*)::int n FROM org_branch_activations WHERE org_unit_id=$1',[branch])).rows[0].n).toBe(1);
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='org_unit.activate'");
  try {expect((await cmd(v,'apply',{preview_token:v.preview_token},admin,key)).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','org_unit.activate')");}
});
test('ACT-10 current and historical lifecycle are distinct; history respects exact access scope',async()=>{
  const tree=(await authed(admin).get(`/api/v1/organization/tree?as_of=${today}`)).body;
  expect(tree.items.find((u:any)=>u.id===branch).lifecycle_state).toBe('ACTIVE');
  expect((await pool.query('SELECT org_lifecycle_at($1,$2::date) state',[branch,day(-1)])).rows[0].state).toBe('PRE_LAUNCH');
  const h=(await authed(admin).get(`/api/v1/organization/units/${branch}/history`)).body;
  expect(h.lifecycle_baseline.state).toBe('PRE_LAUNCH');expect(h.lifecycle).toHaveLength(1);
  expect(h.lifecycle[0]).toMatchObject({state:'ACTIVE',effective_from:today});
  expect((await authed(rf).get(`/api/v1/organization/units/${branch}/history`)).status).toBe(404);
});
test('ACT-11 identity and activation history cannot be edited or deleted; repeated launch invalid',async()=>{
  await expect(pool.query("UPDATE org_directory_units SET lifecycle_state='ACTIVE' WHERE id=$1",[branch])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("UPDATE org_units SET display_name='Changed' WHERE code='A'")).rejects.toMatchObject({code:'23514'});
  await expect(pool.query("UPDATE org_branch_activations SET reason='Changed reason' WHERE org_unit_id=$1",[branch])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('DELETE FROM org_branch_activations WHERE org_unit_id=$1',[branch])).rejects.toMatchObject({code:'23514'});
  expect((await prepare(activation())).preview_summary.valid).toBe(false);
  expect((await prepare({operation:'ORG_UNIT_RENAME',target_id:branch,display_name:'Cannot rename active branch',
    effective_from:day(1),reason:'Synthetic protected rename'})).preview_summary.valid).toBe(false);
});
test('ACT-12 activated branch appears in assignment directory but task access still requires a separate grant',async()=>{
  const catalog=(await authed(admin).get('/api/v1/access/directory')).body;
  expect(catalog.branches.find((b:any)=>b.id===branch).lifecycle_state).toBe('ACTIVE');
  const task={org_unit_id:branch,template_code:'pilot_task_v1',title:'Synthetic launch task',due_at:'2031-01-01T00:00:00Z'};
  expect((await authed(rm).post('/api/v1/work-items').set('Idempotency-Key',idemKey('nogrant')).send(task)).status).toBe(403);
  const d=await authed(admin).post('/api/v1/access/proposals').set('Idempotency-Key',idemKey('grant')).send({change:{
    operation:'GRANT_ROLE',user_id:rm.userId,role_code:'REGIONAL_MANAGER',org_unit_id:branch,valid_from:'NOW',valid_until:null,reason:'Synthetic separate operational assignment'}});
  expect(d.status).toBe(200);
  const p=await authed(admin).post(`/api/v1/access/proposals/${d.body.id}/preview`).set('Idempotency-Key',idemKey('grantpreview')).send({expected_version:d.body.version});
  expect(p.body.preview_summary.issues).toEqual([]);
  const a=await authed(admin).post(`/api/v1/access/proposals/${p.body.id}/apply`).set('Idempotency-Key',idemKey('grantapply')).send({expected_version:p.body.version,preview_token:p.body.preview_token});
  expect(a.status).toBe(200);
  expect((await authed(rm).post('/api/v1/work-items').set('Idempotency-Key',idemKey('withgrant')).send(task)).status).toBe(201);
});
test('ACT-13 database rejects a detached activation even with an existing branch',async()=>{
  const id=await make(),v=await prepare(activation(id));
  await expect(pool.query(`INSERT INTO org_branch_activations(org_unit_id,proposal_id,effective_from,actor_user_id,reason)
    VALUES($1,$2,$3,$4,$5)`,[id,v.id,today,admin.userId,v.change.reason])).rejects.toMatchObject({code:'23514'});
  expect((await state(id)).current).toBe('PRE_LAUNCH');
});
