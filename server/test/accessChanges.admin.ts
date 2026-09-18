// Isolated suite, synthetic local PostgreSQL only.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { provisionAccessAdministration,accessPermissions } from '../src/domain/accessProvisioning';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { getEffectiveGrants } from '../src/domain/grants';
import { app,login,authed,idemKey,Session,ORIGIN } from './helpers';
let admin:Session,rf:Session,rm:Session,branch:string,other:string,inactive:string,networkGrant:string;
const password=randomBytes(32).toString('base64url'),base='/api/v1/access/proposals';
const create=(c:any,s=admin,key=idemKey('access-create'))=>authed(s).post(base).set('Idempotency-Key',key).send({change:c});
const command=(p:any,action:string,extra:any={},s=admin,key=idemKey(action))=>authed(s).post(`${base}/${p.id}/${action}`)
  .set('Idempotency-Key',key).send({expected_version:p.version,...extra});
const change=(patch:any={})=>({operation:'GRANT_ROLE',user_id:rf.userId,role_code:'ROP',org_unit_id:branch,
  valid_from:'NOW',valid_until:null,reason:'Synthetic approved local assignment',...patch});
async function preview(c:any) {
  const d=await create(c);expect(d.status).toBe(200);
  const v=await command(d.body,'preview');expect(v.status).toBe(200);return v.body;
}
async function apply(c:any) {
  const v=await preview(c);expect(v.preview_summary.issues).toEqual([]);
  const a=await command(v,'apply',{preview_token:v.preview_token});expect(a.status).toBe(200);return a.body;
}
beforeAll(async()=>{
  const b=await bootstrapFirstAdministrator({login:'access_test',fullName:'Synthetic access administrator',password,
    reason:'Synthetic isolated access tests',approvalReference:'SYNTHETIC_ACCESS_TEST_APPROVAL'});
  networkGrant=b.grantId;await provisionOrganizationEditor('access_test','SYNTHETIC_EDITOR_APPROVAL');
  admin=await login('access_test',password);rf=await login('rf_a');rm=await login('rm_a');
  for(const state of ['ACTIVE','ACTIVE','PRE_LAUNCH']) {
    const id=randomUUID();
    await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
      VALUES($1,$2,'ORG_UNIT',$3,'2020-01-01')`,[id,'ACCESS_'+id.replace(/-/g,''),state]);
    await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
      VALUES($1,'Synthetic access branch','2020-01-01','Synthetic isolated test')`,[id]);
    await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason)
      VALUES($1,'10000000-0000-4000-8000-000000000004','2020-01-01','Synthetic isolated test')`,[id]);
    if(!branch)branch=id;else if(!other)other=id;else inactive=id;
  }
});
beforeEach(resetLimits);afterAll(closePool);
test('ACCESS-01 migration confers no rights; explicit operator provisioning is bounded, audited and idempotent',async()=>{
  expect((await authed(admin).get('/api/v1/access/directory')).status).toBe(403);
  await expect(provisionAccessAdministration('rm_a','SYNTHETIC_ACCESS_TEST_APPROVAL')).rejects.toThrow();
  await expect(provisionAccessAdministration('access_test','short')).rejects.toThrow();
  const hashes=(await pool.query('SELECT id,password_hash,auth_epoch FROM app_users ORDER BY id')).rows;
  expect((await provisionAccessAdministration('access_test','SYNTHETIC_ACCESS_TEST_APPROVAL')).status).toBe('PROVISIONED');
  expect((await provisionAccessAdministration('access_test','SYNTHETIC_ACCESS_TEST_APPROVAL')).status).toBe('ALREADY_PROVISIONED');
  expect((await pool.query('SELECT id,password_hash,auth_epoch FROM app_users ORDER BY id')).rows).toEqual(hashes);
  expect((await pool.query('SELECT count(*)::int n FROM access_administration_provisioning')).rows[0].n).toBe(1);
  const permissions=(await authed(admin).get('/api/v1/me')).body.grants[0].permissions;
  expect(accessPermissions.every(p=>permissions.includes(p))).toBe(true);
});
test('ACCESS-02 anonymous, RF, RM and forged payload cannot read or write administration',async()=>{
  expect((await request(app).get('/api/v1/access/directory')).status).toBe(401);
  for(const s of [rf,rm]) {
    expect((await authed(s).get('/api/v1/access/directory')).status).toBe(403);
    expect((await authed(s).get(base)).status).toBe(403);
    expect((await authed(s).get(`${base}/${randomUUID()}`)).status).toBe(403);
    expect((await create({scope_kind:'NETWORK',approved:true},s)).status).toBe(403);
    expect((await command({id:randomUUID(),version:1},'apply',{},s)).status).toBe(403);
  }
});
test('ACCESS-03 safe directory exposes no credentials and offers only implemented roles, not demo branches',async()=>{
  const r=await authed(admin).get('/api/v1/access/directory');expect(r.status).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify(r.body)).not.toMatch(/password|token_digest|csrf|auth_epoch/);
  expect(r.body.roles.map((x:any)=>x.code).sort()).toEqual(['REGIONAL_MANAGER','RF','ROO','ROP']);
  expect(r.body.branches.every((x:any)=>!['A','B'].includes(x.code))).toBe(true);
});
test('ACCESS-04 CSRF, Origin, exact permission and idempotency required',async()=>{
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('Origin',ORIGIN).send({change:change()})).status).toBe(403);
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).set('Origin','https://invalid.example').send({change:change()})).status).toBe(403);
  expect((await authed(admin).post(base).send({change:change()})).status).toBe(422);
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='user.assign_role'");
  try {expect((await create(change())).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','user.assign_role')");}
  expect((await create(change({scope_kind:'NETWORK'}))).status).toBe(422);
  expect((await create(change({valid_from:'2026-02-30T00:00:00.000Z'}))).status).toBe(422);
});
test.each([
  ['self',()=>({user_id:admin.userId})],
  ['network role',()=>({role_code:'SUPER_ADMIN'})],
  ['unimplemented role',()=>({role_code:'BH'})],
  ['demo branch',()=>({org_unit_id:'00000000-0000-4000-8000-00000000000a'})],
  ['division or network',()=>({org_unit_id:'10000000-0000-4000-8000-000000000004'})],
  ['inactive branch',()=>({org_unit_id:inactive})],
  ['past start',()=>({valid_from:'2020-01-01T00:00:00.000Z'})],
  ['bad interval',()=>({valid_until:'2020-01-01T00:00:00.000Z'})],
  ['missing user',()=>({user_id:randomUUID()})],
])('ACCESS-05 %s cannot obtain a usable preview',async(_name,patch)=>{
  const p=await preview(change(patch()));expect(p.status).toBe('DRAFT');expect(p.preview_token).toBeNull();
  expect(p.preview_summary.valid).toBe(false);
});
test('ACCESS-06 persist/reopen only; no implicit grant and no raw preview hash',async()=>{
  const count=(await pool.query('SELECT count(*)::int n FROM role_grants')).rows[0].n;
  const c=change(),key=idemKey('draft'),d=await create(c,admin,key);
  expect(d.status).toBe(200);expect(d.body.status).toBe('DRAFT');expect(d.body.preview_hash).toBeUndefined();
  expect((await create(c,admin,key)).body).toEqual(d.body);
  expect((await create({...c,reason:'Different synthetic approval'},admin,key)).status).toBe(409);
  expect((await authed(admin).get(`${base}/${d.body.id}`)).body.history).toHaveLength(1);
  expect((await command(d.body,'apply',{preview_token:randomUUID()})).status).toBe(409);
  expect((await pool.query('SELECT count(*)::int n FROM role_grants')).rows[0].n).toBe(count);
});
test('ACCESS-07 valid apply is atomic, concurrent replay does not duplicate, other branches remain unchanged',async()=>{
  const v=await preview(change());expect(v.preview_summary.valid).toBe(true);
  const before=(await pool.query('SELECT * FROM role_grants WHERE org_unit_id<>$1 OR org_unit_id IS NULL ORDER BY id',[branch])).rows;
  const key=idemKey('apply'),body={preview_token:v.preview_token};
  const [a,b]=await Promise.all([command(v,'apply',body,admin,key),command(v,'apply',body,admin,key)]);
  expect(a.status).toBe(200);expect(b.body).toEqual(a.body);expect(a.body.status).toBe('APPLIED');
  expect((await pool.query('SELECT count(*)::int n FROM role_grants WHERE id=$1',[v.target_id])).rows[0].n).toBe(1);
  expect((await pool.query('SELECT * FROM role_grants WHERE org_unit_id<>$1 OR org_unit_id IS NULL ORDER BY id',[branch])).rows).toEqual(before);
  const history=(await authed(admin).get(`${base}/${v.id}`)).body.history;expect(history).toHaveLength(3);
  expect((await pool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1',[v.id])).rows[0].n).toBe(3);
  expect(JSON.stringify((await pool.query('SELECT after_state FROM audit_log WHERE aggregate_id=$1',[v.id])).rows)).not.toContain(v.preview_token);
  expect((await command(v,'apply',body)).status).toBe(409);
  await expect(pool.query('UPDATE access_change_proposals SET version=version+1 WHERE id=$1',[v.id])).rejects.toMatchObject({code:'23514'});
});
test('ACCESS-08 overlap blocked in service and in database',async()=>{
  expect((await preview(change())).preview_summary.valid).toBe(false);
  await expect(pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
    VALUES($1,'ROP',$2,now())`,[rf.userId,branch])).rejects.toMatchObject({code:'23P01'});
});
test('ACCESS-09 future adjacent intervals coexist but are not effective today',async()=>{
  const start=new Date(Date.now()+86400000).toISOString(),middle=new Date(Date.now()+172800000).toISOString(),end=new Date(Date.now()+259200000).toISOString();
  await apply(change({role_code:'ROO',valid_from:start,valid_until:middle}));
  await apply(change({role_code:'ROO',valid_from:middle,valid_until:end}));
  const client=await pool.connect();
  try {expect((await getEffectiveGrants(client,rf.userId)).some(g=>g.role==='ROO'&&g.orgUnitId===branch)).toBe(false);} finally {client.release();}
});
test.each(['expiry','actor','catalog','user','assignment'])('ACCESS-10 stale %s rejects apply',async(kind)=>{
  const v=await preview(change({org_unit_id:other,role_code:'RF'}));expect(v.preview_summary.valid).toBe(true);
  if(kind==='expiry') await pool.query("UPDATE access_change_proposals SET version=version+1,preview_expires_at=now()-interval '1 minute' WHERE id=$1",[v.id]);
  if(kind==='actor') await pool.query('UPDATE access_change_proposals SET version=version+1,preview_actor=$2 WHERE id=$1',[v.id,rm.userId]);
  if(kind==='catalog') await pool.query("DELETE FROM role_permissions WHERE role_code='RF' AND permission_code='work_item.submit'");
  if(kind==='user') await pool.query('UPDATE app_users SET is_active=false WHERE id=$1',[rf.userId]);
  if(kind==='assignment') await pool.query("INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from) VALUES($1,'ROO',$2,now())",[rf.userId,other]);
  try {
    const current=(await authed(admin).get(`${base}/${v.id}`)).body;
    expect((await command(current,'apply',{preview_token:v.preview_token})).status).toBe(409);
    expect((await pool.query('SELECT 1 FROM role_grants WHERE id=$1',[v.target_id])).rowCount).toBe(0);
  } finally {
    if(kind==='catalog') await pool.query("INSERT INTO role_permissions VALUES('RF','work_item.submit')");
    if(kind==='user') await pool.query('UPDATE app_users SET is_active=true WHERE id=$1',[rf.userId]);
  }
});
test('ACCESS-11 current authorization checked before successful replay',async()=>{
  const c=change({role_code:'RF',org_unit_id:other}),key=idemKey('reauth');
  expect((await create(c,admin,key)).status).toBe(200);
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='access.change.draft'");
  try {expect((await create(c,admin,key)).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','access.change.draft')");}
});
test('ACCESS-12 no network or demo revocation; unfinished tasks block real revocation',async()=>{
  expect((await preview({operation:'REVOKE_ROLE',grant_id:networkGrant,reason:'Synthetic forbidden network revoke'})).preview_summary.valid).toBe(false);
  const demo=(await pool.query("SELECT id FROM role_grants WHERE user_id=$1 AND role_code='RF'",[rf.userId])).rows[0].id;
  expect((await preview({operation:'REVOKE_ROLE',grant_id:demo,reason:'Synthetic forbidden demo revoke'})).preview_summary.valid).toBe(false);
  const g=(await pool.query("SELECT id FROM role_grants WHERE user_id=$1 AND role_code='ROP' AND org_unit_id=$2",[rf.userId,branch])).rows[0].id;
  const task=(await pool.query(`INSERT INTO work_items(org_unit_id,template_version_id,title,due_at,created_by)
    VALUES($1,'00000000-0000-4000-8000-000000000101','Synthetic pending ownership',now()+interval '1 day',$2) RETURNING id`,[branch,rf.userId])).rows[0].id;
  const c={operation:'REVOKE_ROLE',grant_id:g,reason:'Synthetic approved local revocation'};
  expect((await preview(c)).preview_summary.issues.join(' ')).toContain('незавершённые');
  await pool.query("UPDATE work_items SET status='CANCELLED' WHERE id=$1",[task]);
  const result=await apply(c);expect(result.preview_summary.after_grant.revoked_at).toBeTruthy();
  expect(result.preview_summary.after_grant.grant_version).toBe(2);
  expect((await preview(c)).preview_summary.valid).toBe(false);
  expect((await apply(change())).status).toBe('APPLIED'); // new UUID, old evidence remains
});
test('ACCESS-13 audit failure rolls back the grant and successful idempotency response',async()=>{
  const v=await preview(change({user_id:rm.userId,org_unit_id:other,role_code:'RF'}));
  await pool.query(`CREATE FUNCTION test_fail_access_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='ACCESS_CHANGE_APPLY' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER test_fail_access BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_fail_access_audit()');
  const key=idemKey('rollback');
  try {
    expect((await command(v,'apply',{preview_token:v.preview_token},admin,key)).status).toBe(503);
    expect((await pool.query('SELECT 1 FROM role_grants WHERE id=$1',[v.target_id])).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM idempotency_records WHERE key=$1",[key])).rowCount).toBe(0);
    expect((await pool.query('SELECT status FROM access_change_proposals WHERE id=$1',[v.id])).rows[0].status).toBe('PREVIEW');
  } finally {
    await pool.query('DROP TRIGGER test_fail_access ON audit_log');await pool.query('DROP FUNCTION test_fail_access_audit()');
  }
  expect((await command(v,'apply',{preview_token:v.preview_token},admin,key)).status).toBe(200);
});
test('ACCESS-14 revoke and concurrent task create serialize; no task created after lost authorization',async()=>{
  const a=await apply(change({user_id:rm.userId,org_unit_id:other,role_code:'REGIONAL_MANAGER'}));
  const v=await preview({operation:'REVOKE_ROLE',grant_id:a.target_id,reason:'Synthetic revoke race approval'});
  const [revoke,task]=await Promise.all([
    command(v,'apply',{preview_token:v.preview_token}),
    authed(rm).post('/api/v1/work-items').set('Idempotency-Key',idemKey('race-task')).send({
      org_unit_id:other,template_code:'pilot_task_v1',title:'Synthetic race task',due_at:new Date(Date.now()+86400000).toISOString()})
  ]);
  // Either the task commits first and invalidates revoke, or revoke commits
  // first and task authorization is denied. Both succeeding is forbidden.
  expect([[200,403],[409,201]]).toContainEqual([revoke.status,task.status]);
});
