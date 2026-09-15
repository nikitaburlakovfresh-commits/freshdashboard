import request from 'supertest';
import { randomBytes } from 'crypto';
import { pool, closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { _resetForTests as resetRateLimits } from '../src/auth/rateLimit';
import { app, login, authed, idemKey, Session } from './helpers';

const input = { login:'first_admin_test', fullName:'Synthetic administrator', password:randomBytes(32).toString('base64url'),
  reason:'Synthetic test of explicitly approved first administrator', approvalReference:'LOCAL_ISOLATED_TEST_APPROVAL_ONLY' };
let admin:Session, grantId:string;
const A='00000000-0000-4000-8000-00000000000a';
beforeEach(resetRateLimits);
afterAll(closePool);

test('BOOT-01 rejects weak credentials or missing approval before writing',async()=>{
  await expect(bootstrapFirstAdministrator({...input,password:'short'})).rejects.toThrow('Invalid');
  await expect(bootstrapFirstAdministrator({...input,approvalReference:''})).rejects.toThrow('Invalid');
  await expect(bootstrapFirstAdministrator({...input,login:'UPPERCASE'})).rejects.toThrow('Invalid');
  expect((await pool.query('SELECT count(*)::int n FROM administrator_bootstrap')).rows[0].n).toBe(0);
});
test('BOOT-02 failure of audit is atomic: no identity or grant survives',async()=>{
  await pool.query(`CREATE FUNCTION test_bootstrap_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action='FIRST_ADMINISTRATOR_BOOTSTRAP' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER test_bootstrap_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION test_bootstrap_audit_failure()`);
  try {
    await expect(bootstrapFirstAdministrator(input)).rejects.toThrow('synthetic audit failure');
    expect((await pool.query('SELECT count(*)::int n FROM app_users WHERE login=$1',[input.login])).rows[0].n).toBe(0);
    expect((await pool.query("SELECT count(*)::int n FROM role_grants WHERE role_code='SUPER_ADMIN'")).rows[0].n).toBe(0);
  } finally { await pool.query('DROP TRIGGER test_bootstrap_audit_failure ON audit_log; DROP FUNCTION test_bootstrap_audit_failure()'); }
});
test('BOOT-03 creates exactly one personal admin, least permission, atomic journal/outbox',async()=>{
  const result=await bootstrapFirstAdministrator(input); grantId=result.grantId;
  admin=await login(input.login,input.password);
  const me=await authed(admin).get('/api/v1/me');
  expect(me.status).toBe(200);
  expect(me.body.grants).toHaveLength(1);
  expect(me.body.grants[0]).toMatchObject({role:'SUPER_ADMIN',scope_kind:'NETWORK',org_unit_id:null,permissions:['organization.directory.review']});
  const evidence=await pool.query(`SELECT b.reason,b.approval_reference,a.action,a.actor_user_id,a.after_state,e.event_type,u.user_kind,u.password_hash
    FROM administrator_bootstrap b JOIN audit_log a ON a.id=b.audit_id JOIN outbox_events e ON e.audit_id=a.id JOIN app_users u ON u.id=b.user_id`);
  expect(evidence.rowCount).toBe(1);
  expect(evidence.rows[0]).toMatchObject({reason:input.reason,approval_reference:input.approvalReference,
    actor_user_id:null,user_kind:'INDIVIDUAL',action:'FIRST_ADMINISTRATOR_BOOTSTRAP',event_type:'access.first_administrator_bootstrapped'});
  expect(evidence.rows[0].password_hash).toMatch(/^\$argon2id\$/);
  expect(JSON.stringify(evidence.rows[0].after_state)).not.toContain(input.password);
});
test('BOOT-04 rerun/new target refuses without resetting identity/password; journal immutable',async()=>{
  await expect(bootstrapFirstAdministrator(input)).rejects.toThrow('Bootstrap refused');
  await expect(bootstrapFirstAdministrator({...input,login:'another_admin_test'})).rejects.toThrow('Bootstrap refused');
  await expect(pool.query('UPDATE administrator_bootstrap SET reason=$1',['changed reason test'])).rejects.toMatchObject({code:'23514'});
  await expect(pool.query('DELETE FROM administrator_bootstrap')).rejects.toMatchObject({code:'23514'});
  expect((await pool.query("SELECT count(*)::int n FROM role_grants WHERE role_code='SUPER_ADMIN'")).rows[0].n).toBe(1);
});
test('ADMIN-01 network review exposes directory metadata/history, never people/legal/credentials',async()=>{
  const res=await authed(admin).get('/api/v1/organization/admin-review?as_of=2026-09-15');
  expect(res.status).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body.scope_mode).toBe('CURRENT_NETWORK_DIRECTORY_REVIEW');
  expect(res.body.admin_review).toEqual({authorized:true,permission:'organization.directory.review',writes_authorized:false});
  expect(res.body.items).toHaveLength(6);
  expect(JSON.stringify(res.body)).not.toMatch(/legal_entity_id|contract_id|password|login|full_name|change_reason/);
  expect((await authed(admin).get(`/api/v1/organization/units/${A}/history`)).status).toBe(200);
  expect((await authed(admin).get('/api/v1/organization/tree?as_of=2019-01-01')).body.items).toEqual([]);
  expect((await authed(admin).get('/api/v1/organization/admin-review?role=SUPER_ADMIN')).status).toBe(422);
});
test('ADMIN-02 administrator cannot write organizations, grants, imports or create business tasks',async()=>{
  for(const action of ['proposals','proposals/approve','units','grants','import/commit']) {
    expect((await authed(admin).post('/api/v1/organization/'+action).send({approved:true})).status).toBe(403);
  }
  const tasks=await authed(admin).get('/api/v1/work-items');
  expect(tasks.status).toBe(200);expect(tasks.body.items).toEqual([]);
  const created=await authed(admin).post('/api/v1/work-items').set('Idempotency-Key',idemKey('admin-deny')).send({
    org_unit_id:A,template_code:'pilot_task_v1',title:'Must not exist',due_at:'2027-01-01T10:00:00Z',
  });
  expect(created.status).toBe(403);
  expect((await authed(admin).get('/api/v1/notifications')).body.items).toEqual([]);
});
test('ADMIN-03 RM/RF retain 403 admin and 404 cross-branch, no role flag bypass',async()=>{
  for(const user of ['rm_a','rf_a']) {
    const session=await login(user);
    expect((await authed(session).get('/api/v1/organization/admin-review')).status).toBe(403);
    expect((await authed(session).get('/api/v1/organization/units/00000000-0000-4000-8000-00000000000b/history')).status).toBe(404);
    expect((await authed(session).get('/api/v1/organization/tree')).body.items.map((r:any)=>r.id)).toEqual([A]);
  }
});
test('ADMIN-04 role name alone is insufficient; remove permission immediately denies',async()=>{
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN'");
  try {
    expect((await authed(admin).get('/api/v1/organization/admin-review')).status).toBe(403);
    expect((await authed(admin).get('/api/v1/organization/tree')).body.items).toEqual([]);
    expect((await authed(admin).get(`/api/v1/organization/units/${A}/history`)).status).toBe(404);
  } finally { await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','organization.directory.review')"); }
});
test.each(['revoked','expired','future'])('ADMIN-05 %s grant denies next request even for historical date',async(mode)=>{
  const before=(await pool.query('SELECT * FROM role_grants WHERE id=$1',[grantId])).rows[0];
  try {
    if(mode==='revoked')await pool.query('UPDATE role_grants SET revoked_at=now() WHERE id=$1',[grantId]);
    if(mode==='expired')await pool.query("UPDATE role_grants SET valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE id=$1",[grantId]);
    if(mode==='future')await pool.query("UPDATE role_grants SET valid_from=now()+interval '1 day' WHERE id=$1",[grantId]);
    expect((await authed(admin).get('/api/v1/organization/admin-review?as_of=2025-01-01')).status).toBe(403);
    expect((await authed(admin).get('/api/v1/organization/tree')).body.items).toEqual([]);
  } finally { await pool.query('UPDATE role_grants SET revoked_at=$2,valid_from=$3,valid_until=$4 WHERE id=$1',[grantId,before.revoked_at,before.valid_from,before.valid_until]); }
});
test('ADMIN-06 inactive/shared/rotated/revoked-session fences deny admin; anonymous requires auth',async()=>{
  expect((await request(app).get('/api/v1/organization/admin-review')).status).toBe(401);
  for(const field of ['is_active','password_last_shared_indicator']) {
    await pool.query(`UPDATE app_users SET ${field}=$2 WHERE id=$1`,[admin.userId,field!=='is_active']);
    try { expect((await authed(admin).get('/api/v1/organization/admin-review')).status).toBe(401); }
    finally { await pool.query(`UPDATE app_users SET ${field}=$2 WHERE id=$1`,[admin.userId,field==='is_active']); }
  }
  await pool.query('UPDATE app_users SET auth_epoch=auth_epoch+1 WHERE id=$1',[admin.userId]);
  expect((await authed(admin).get('/api/v1/organization/admin-review')).status).toBe(401);
  admin=await login(input.login,input.password);
  expect((await authed(admin).post('/api/v1/auth/logout').send({})).status).toBe(200);
  expect((await authed(admin).get('/api/v1/organization/admin-review')).status).toBe(401);
});
test('ADMIN-DB network scope cannot be laundered into a business branch assignment',async()=>{
  await expect(pool.query(`INSERT INTO role_grants(user_id,role_code,scope_kind,org_unit_id,valid_from)
    VALUES($1,'SUPER_ADMIN','ORG_UNIT',$2,now())`,[admin.userId,A])).rejects.toMatchObject({code:'23503'});
  await expect(pool.query(`INSERT INTO role_grants(user_id,role_code,scope_kind,org_unit_id,valid_from)
    VALUES($1,'REGIONAL_MANAGER','NETWORK',NULL,now())`,[admin.userId])).rejects.toMatchObject({code:'23503'});
});
