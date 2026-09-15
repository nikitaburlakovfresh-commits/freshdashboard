// Separately executed isolated suite: --testMatch '**/test/orgChanges.editor.ts'.
// Shares the guarded fresh_pilot_test global setup, never a production restore.
import request from 'supertest';
import { randomBytes,randomUUID } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor,editorPermissions } from '../src/domain/orgEditorProvisioning';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,login,authed,idemKey,Session } from './helpers';
let admin:Session,rm:Session,rf:Session,grantId:string,root:any,branch:any,division:any,cluster:any;
const password=randomBytes(32).toString('base64url');
const today=new Date().toISOString().slice(0,10);
const later=(days:number)=>new Date(Date.now()+days*86400000).toISOString().slice(0,10);
const base='/api/v1/organization/proposals';
const change=(extra:any={})=>({operation:'ORG_UNIT_CREATE',code:'TEST_'+randomUUID().replace(/-/g,''),
  kind:'NETWORK',display_name:'Synthetic editor fixture',effective_from:today,reason:'Isolated synthetic editor test only',...extra});
const create=async(c:any,session=admin,key=idemKey('create'))=>authed(session).post(base).set('Idempotency-Key',key).send({change:c});
const command=async(p:any,action:string,body:any={},session=admin,key=idemKey(action))=>authed(session).post(`${base}/${p.id}/${action}`)
  .set('Idempotency-Key',key).send({expected_version:p.version,...body});
async function apply(c:any) {
  const d=await create(c);expect(d.status).toBe(200);
  const v=await command(d.body,'preview');expect(v.body.preview_summary.issues).toEqual([]);
  expect(v.body.status).toBe('PREVIEW');
  const a=await command(v.body,'apply',{preview_token:v.body.preview_token});expect(a.status).toBe(200);
  return a.body;
}
beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'org_editor_test',fullName:'Synthetic editor',password,
    reason:'Isolated approved editor tests',approvalReference:'SYNTHETIC_EDITOR_TEST_APPROVAL'});
  grantId=b.grantId;admin=await login('org_editor_test',password);rm=await login('rm_a');rf=await login('rf_a');
});
beforeEach(resetLimits);afterAll(closePool);
test('EDITOR-01 additive audited provisioning requires the existing named administrator, no password reset',async()=>{
  expect((await create(change())).status).toBe(403);
  await expect(provisionOrganizationEditor('rm_a','SYNTHETIC_TEST_APPROVAL')).rejects.toThrow();
  const before=(await pool.query('SELECT password_hash FROM app_users WHERE id=$1',[admin.userId])).rows;
  expect((await provisionOrganizationEditor('org_editor_test','SYNTHETIC_TEST_APPROVAL')).status).toBe('PROVISIONED');
  expect((await provisionOrganizationEditor('org_editor_test','SYNTHETIC_TEST_APPROVAL')).status).toBe('ALREADY_PROVISIONED');
  expect((await pool.query('SELECT password_hash FROM app_users WHERE id=$1',[admin.userId])).rows).toEqual(before);
  const me=await authed(admin).get('/api/v1/me');
  expect(me.body.grants[0].permissions.sort()).toEqual(['organization.directory.review',...editorPermissions].sort());
  expect((await pool.query('SELECT count(*)::int n FROM organization_editor_provisioning')).rows[0].n).toBe(1);
  expect((await authed(admin).get('/api/v1/work-items')).body.items).toEqual([]);
});
test('EDITOR-02 unauthenticated, RM, RF and guessed scopes denied before payload; no proposal leakage',async()=>{
  expect((await request(app).get(base)).status).toBe(401);
  for(const s of [rm,rf]) {
    expect((await create({approved:true},s)).status).toBe(403);
    expect((await authed(s).get(base)).status).toBe(403);
    expect((await authed(s).get(`${base}/${randomUUID()}`)).status).toBe(403);
    expect((await authed(s).patch(`${base}/${randomUUID()}`).send({})).status).toBe(403);
    expect((await command({id:randomUUID(),version:1},'preview',{},s)).status).toBe(403);
    expect((await command({id:randomUUID(),version:1},'apply',{},s)).status).toBe(403);
  }
  expect((await create(change({scope_kind:'NETWORK'}))).status).toBe(422);
});
test('EDITOR-03 exact permission required even with SUPER_ADMIN role; CSRF/Origin enforced',async()=>{
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='org_unit.create'");
  try {expect((await create(change())).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','org_unit.create')");}
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('Origin','http://localhost:5173').send({change:change()})).status).toBe(403);
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).set('Origin','https://other.invalid').send({change:change()})).status).toBe(403);
});
test('EDITOR-04 persist/reopen draft, stable UUID, no implicit application/root or history',async()=>{
  const before=(await pool.query('SELECT count(*)::int n FROM org_directory_units')).rows[0].n;
  const c=await create(change());root=c.body;
  expect(root.status).toBe('DRAFT');expect(root.version).toBe(1);
  expect((await authed(admin).get(`${base}/${root.id}`)).body.target_id).toBe(root.target_id);
  expect((await authed(admin).get(base)).body.items.some((p:any)=>p.id===root.id)).toBe(true);
  expect((await pool.query('SELECT count(*)::int n FROM org_directory_units')).rows[0].n).toBe(before);
  expect((await command(root,'apply',{preview_token:randomUUID()})).status).toBe(409);
});
test('EDITOR-05 preview CAS, idempotency and expiry; edit invalidates preview',async()=>{
  const key=idemKey('preview');
  const v=await command(root,'preview',{},admin,key);
  expect(v.body.preview_summary.valid).toBe(true);expect(v.body.version).toBe(2);
  expect((await command(root,'preview',{},admin,key)).body).toEqual(v.body);
  expect((await command(root,'preview')).status).toBe(409);
  const e=await authed(admin).patch(`${base}/${root.id}`).set('Idempotency-Key',idemKey('edit')).send({
    expected_version:v.body.version,change:{...root.change,display_name:'Synthetic root edited'}});
  expect(e.body.status).toBe('DRAFT');expect(e.body.preview_token).toBeNull();expect(e.body.target_id).toBe(root.target_id);
  expect((await command(v.body,'apply',{preview_token:v.body.preview_token})).status).toBe(409);
  root=e.body;
});
test('EDITOR-06 explicit apply atomically writes identity/history/audit/outbox; replay does not duplicate',async()=>{
  const v=(await command(root,'preview')).body;
  const key=idemKey('apply'),body={preview_token:v.preview_token};
  const [a,b]=await Promise.all([command(v,'apply',body,admin,key),command(v,'apply',body,admin,key)]);
  expect(a.status).toBe(200);expect(b.body).toEqual(a.body);root=a.body;
  expect(root.status).toBe('APPLIED');
  const u=(await pool.query('SELECT * FROM org_directory_units WHERE id=$1',[root.target_id])).rows[0];
  expect(u).toMatchObject({kind:'NETWORK',lifecycle_state:'PRE_LAUNCH',is_demo:false,pilot_org_unit_id:null});
  expect((await pool.query('SELECT count(*)::int n FROM org_directory_name_history WHERE org_unit_id=$1',[root.target_id])).rows[0].n).toBe(1);
  const h=await authed(admin).get(`${base}/${root.id}`);
  expect(h.body.history).toHaveLength(5);
  expect(h.body.history.at(-1)).toMatchObject({actor_user_id:admin.userId,action:'ORG_CHANGE_APPLY'});
  const events=(await pool.query("SELECT count(*)::int n FROM outbox_events WHERE aggregate_type='org_change' AND aggregate_id=$1",[root.id])).rows[0].n;
  expect(events).toBe(5);
  expect((await command(v,'apply',body)).status).toBe(409);
  expect((await authed(admin).patch(`${base}/${root.id}`).set('Idempotency-Key',idemKey('immutable')).send({expected_version:root.version,change:root.change})).status).toBe(409);
  await expect(pool.query('UPDATE org_change_proposals SET version=version+1 WHERE id=$1',[root.id])).rejects.toMatchObject({code:'23514'});
});
test.each([
  ['orphan',{kind:'DIVISION',parent_id:null}],
  ['level',{kind:'CLUSTER',parent_id:()=>root.target_id}],
  ['type',{kind:'NETWORK',type_code:'EXPRESS'}],
  ['invalid type',{kind:'ORG_UNIT',parent_id:()=>root.target_id,type_code:'GUESS'}],
  ['business model',{business_model:'AUTO'}],
  ['bad date',{effective_from:'2026-02-30'}],
  ['past date',{effective_from:'2020-01-01'}],
  ['missing name',{display_name:''}],
  ['unknown parent',{kind:'DIVISION',parent_id:()=>randomUUID()}],
  ['demo parent',{kind:'ORG_UNIT',parent_id:'00000000-0000-4000-8000-00000000000a'}],
])('EDITOR-07 %s fails explicit preview without directory writes',async(_name,patch)=>{
  const c=change(Object.fromEntries(Object.entries(patch).map(([k,v])=>[k,typeof v==='function'?v():v])));
  const p=(await create(c)).body;
  const v=await command(p,'preview');expect(v.status).toBe(200);expect(v.body.status).toBe('DRAFT');
  expect(v.body.preview_summary.valid).toBe(false);expect(v.body.preview_token).toBeNull();
  expect((await pool.query('SELECT 1 FROM org_directory_units WHERE id=$1',[p.target_id])).rowCount).toBe(0);
});
test('EDITOR-08 A/B and legacy identities cannot be renamed, moved or retyped; lifecycle/owner/import excluded',async()=>{
  for(const operation of ['ORG_UNIT_RENAME','ORG_UNIT_MOVE_TO_CLUSTER']) {
    const c={operation,target_id:'00000000-0000-4000-8000-00000000000a',effective_from:later(1),reason:'Protected identity test',
      ...(operation==='ORG_UNIT_RENAME'?{display_name:'Do not write'}:{parent_id:root.target_id})};
    const p=(await create(c)).body;
    expect((await command(p,'preview')).body.preview_summary.valid).toBe(false);
  }
  expect((await create(change({lifecycle_state:'ACTIVE'}))).status).toBe(422);
  expect((await create(change({operation:'ORG_UNIT_OWNER_CHANGE'}))).status).toBe(422);
  expect((await create(change({operation:'__proto__'}))).status).toBe(422);
});
test('EDITOR-09 creates supported full hierarchy with explicit parent and nullable unknown type/model',async()=>{
  division=await apply(change({kind:'DIVISION',parent_id:root.target_id}));
  cluster=await apply(change({kind:'CLUSTER',parent_id:division.target_id}));
  branch=await apply(change({kind:'ORG_UNIT',parent_id:cluster.target_id,type_code:'EXPRESS',business_model:'FRANCHISE'}));
  const history=await authed(admin).get(`/api/v1/organization/units/${branch.target_id}/history`);
  expect(history.body.affiliations[0]).toMatchObject({parent_id:cluster.target_id,business_model:'FRANCHISE'});
});
test('EDITOR-10 rename/reparent append half-open history, preserve UUID and previous metadata',async()=>{
  await apply({operation:'ORG_UNIT_RENAME',target_id:branch.target_id,display_name:'Synthetic renamed',effective_from:later(1),reason:'Synthetic rename test'});
  await apply({operation:'ORG_UNIT_MOVE_TO_CLUSTER',target_id:branch.target_id,parent_id:division.target_id,effective_from:later(1),reason:'Synthetic reparent test'});
  const h=(await authed(admin).get(`/api/v1/organization/units/${branch.target_id}/history`)).body;
  expect(h.names).toHaveLength(2);expect(h.names[0].effective_to).toBe(later(1));expect(h.names[1].effective_from).toBe(later(1));
  expect(h.affiliations).toHaveLength(2);expect(h.affiliations[1].business_model).toBe('FRANCHISE');
  const todayTree=(await authed(admin).get('/api/v1/organization/tree')).body.items.find((u:any)=>u.id===branch.target_id);
  expect(todayTree.parent_id).toBe(cluster.target_id);
  const futureTree=(await authed(admin).get(`/api/v1/organization/tree?as_of=${later(1)}`)).body.items.find((u:any)=>u.id===branch.target_id);
  expect(futureTree.parent_id).toBe(division.target_id);expect(futureTree.display_name).toBe('Synthetic renamed');
});
test('EDITOR-11 overlap/same-date rename and cycles refuse',async()=>{
  for(const c of [
    {operation:'ORG_UNIT_RENAME',target_id:branch.target_id,display_name:'Overlap',effective_from:later(1),reason:'Synthetic overlap'},
    {operation:'ORG_UNIT_MOVE_TO_CLUSTER',target_id:division.target_id,parent_id:cluster.target_id,effective_from:later(1),reason:'Synthetic cycle'},
  ]) expect((await command((await create(c)).body,'preview')).body.preview_summary.valid).toBe(false);
});
test('EDITOR-12 global directory revision invalidates another proposal preview',async()=>{
  const p=(await create(change())).body,v=(await command(p,'preview')).body;
  await apply(change());
  expect((await command(v,'apply',{preview_token:v.preview_token})).status).toBe(409);
  const refreshed=(await command(v,'preview')).body;
  expect((await command(refreshed,'apply',{preview_token:refreshed.preview_token})).status).toBe(200);
});
test('EDITOR-13 duplicate code race, changed idempotency payload, zero partial effect',async()=>{
  const c=change(),key=idemKey('same');
  const p=(await create(c,admin,key)).body;
  expect((await create({...c,display_name:'Other'},admin,key)).status).toBe(409);
  await apply(c);
  expect((await command(p,'preview')).body.preview_summary.valid).toBe(false);
});
test('EDITOR-14 apply failure rolls back identity, histories, proposal, audit, revision and idempotency atomically',async()=>{
  const v=(await command((await create(change())).body,'preview')).body;
  const key=idemKey('rollback'),count=(await pool.query('SELECT version FROM org_directory_revision')).rows[0].version;
  await pool.query(`CREATE FUNCTION test_editor_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='ORG_CHANGE_APPLY' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_editor_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_editor_fail()`);
  try {
    expect((await command(v,'apply',{preview_token:v.preview_token},admin,key)).status).toBe(503);
    expect((await pool.query('SELECT 1 FROM org_directory_units WHERE id=$1',[v.target_id])).rowCount).toBe(0);
    expect((await pool.query('SELECT version FROM org_directory_revision')).rows[0].version).toBe(count);
    expect((await pool.query('SELECT status FROM org_change_proposals WHERE id=$1',[v.id])).rows[0].status).toBe('PREVIEW');
    expect((await pool.query('SELECT 1 FROM idempotency_records WHERE key=$1',[key])).rowCount).toBe(0);
  } finally {await pool.query('DROP TRIGGER test_editor_fail ON audit_log; DROP FUNCTION test_editor_fail()');}
  expect((await command(v,'apply',{preview_token:v.preview_token},admin,key)).status).toBe(200);
});
test('EDITOR-15 revoked/future/expired current grant denies reads and successful replay regardless of historical date',async()=>{
  const c=change(),key=idemKey('revoke');await create(c,admin,key);
  const before=(await pool.query('SELECT * FROM role_grants WHERE id=$1',[grantId])).rows[0];
  for(const clause of ["revoked_at=now()","valid_from=now()+interval '1 day'","valid_from=now()-interval '2 days',valid_until=now()-interval '1 day'"]) {
    await pool.query(`UPDATE role_grants SET ${clause} WHERE id=$1`,[grantId]);
    try {
      expect((await create(c,admin,key)).status).toBe(403);
      expect((await authed(admin).get(base)).status).toBe(403);
      expect((await authed(admin).get('/api/v1/organization/tree?as_of=2020-01-01')).body.items).toEqual([]);
    } finally {await pool.query('UPDATE role_grants SET revoked_at=$2,valid_from=$3,valid_until=$4 WHERE id=$1',[grantId,before.revoked_at,before.valid_from,before.valid_until]);}
  }
});
test('EDITOR-16 preview token belongs to actor and expires; wrong token or actor never applies',async()=>{
  const v=(await command((await create(change())).body,'preview')).body;
  expect((await command(v,'apply',{preview_token:randomUUID()})).status).toBe(409);
  // A separate individually scoped editor, synthetic test only, no role shortcut.
  await pool.query("INSERT INTO role_grants(user_id,role_code,scope_kind,org_unit_id,valid_from) VALUES($1,'SUPER_ADMIN','NETWORK',NULL,now())",[rm.userId]);
  try { expect((await command(v,'apply',{preview_token:v.preview_token},rm)).status).toBe(409); }
  finally { await pool.query("DELETE FROM role_grants WHERE user_id=$1 AND role_code='SUPER_ADMIN'",[rm.userId]); }
  await pool.query("UPDATE org_change_proposals SET preview_expires_at=now()-interval '1 minute',version=version+1 WHERE id=$1",[v.id]);
  const expired=(await authed(admin).get(`${base}/${v.id}`)).body;
  expect((await command(expired,'apply',{preview_token:v.preview_token})).status).toBe(409);
});
test('EDITOR-17 parent temporal coverage and upstream orphan rejected',async()=>{
  const parent=await apply(change({effective_from:later(2)}));
  const d=(await create(change({kind:'DIVISION',parent_id:parent.target_id}))).body;
  expect((await command(d,'preview')).body.preview_summary.valid).toBe(false);
  const orphanId=randomUUID();
  await pool.query("INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from) VALUES($1,$2,'DIVISION','PRE_LAUNCH',$3)",[orphanId,'ORPHAN_'+randomUUID(),today]);
  await pool.query("INSERT INTO org_directory_affiliation_history(org_unit_id,effective_from,change_reason) VALUES($1,$2,'Synthetic orphan fixture')",[orphanId,today]);
  const p=(await create(change({kind:'CLUSTER',parent_id:orphanId}))).body;
  expect((await command(p,'preview')).body.preview_summary.issues.some((i:any)=>i.issue.includes('сирота'))).toBe(true);
});
test('EDITOR-18 no access leak or pilot FK bridge expansion after new structure applies',async()=>{
  for(const s of [rm,rf]) {
    expect((await authed(s).get(`/api/v1/organization/units/${branch.target_id}/history`)).status).toBe(404);
    expect((await authed(s).get('/api/v1/organization/tree')).body.items).toHaveLength(1);
  }
  expect((await pool.query('SELECT 1 FROM org_units WHERE id=$1',[branch.target_id])).rowCount).toBe(0);
  const rows=(await pool.query("SELECT permission_code FROM role_permissions WHERE role_code='SUPER_ADMIN'")).rows;
  expect(rows.some(r=>r.permission_code.startsWith('work_item.')||r.permission_code.startsWith('finance.'))).toBe(false);
});
