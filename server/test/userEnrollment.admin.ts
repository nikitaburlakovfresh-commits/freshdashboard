import request from 'supertest';
import { randomBytes,randomUUID } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { provisionAccessAdministration } from '../src/domain/accessProvisioning';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,login,authed,idemKey,Session,ORIGIN } from './helpers';
let admin:Session,rf:Session,counter=0;
const adminPassword=randomBytes(32).toString('base64url'),password='Synthetic-Personal-Password-2026',base='/api/v1/access/users';
const data=()=>{const i=++counter;return {login:`person_${i}`,full_name:`Synthetic Person ${i}`,primary_email:`person${i}@example.test`,reason:'Synthetic local enrollment approval'};};
const create=(b=data(),s=admin,key=idemKey('user-create'))=>authed(s).post(base).set('Idempotency-Key',key).send(b);
const invite=(u:any,action='issue',version=1,s=admin)=>authed(s).post(`${base}/${u.id}/enrollment/${action}`)
  .send({expected_version:version,reason:'Synthetic initial invitation approval'});
const accept=(token:string,p=password)=>request(app).post('/api/v1/auth/enrollment/accept').set('Origin',ORIGIN).send({token,password:p});
async function pending() {const c=await create();expect(c.status).toBe(201);const i=await invite(c.body);expect(i.status).toBe(200);return {u:c.body,i:i.body};}
beforeAll(async()=>{
  await bootstrapFirstAdministrator({login:'enrollment_admin',fullName:'Synthetic enrollment administrator',password:adminPassword,
    reason:'Synthetic isolated enrollment tests',approvalReference:'SYNTHETIC_ENROLLMENT_APPROVAL'});
  await provisionOrganizationEditor('enrollment_admin','SYNTHETIC_EDITOR_APPROVAL');
  await provisionAccessAdministration('enrollment_admin','SYNTHETIC_ACCESS_APPROVAL');
  admin=await login('enrollment_admin',adminPassword);rf=await login('rf_a');
});
beforeEach(resetLimits);afterAll(closePool);
test('ENROLL-01 migration adds no powers; exact permissions are necessary',async()=>{
  expect((await create()).status).toBe(403);
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','user.create')");
  const c=await create();expect(c.status).toBe(201);
  expect((await invite(c.body)).status).toBe(403);
  await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','user.enrollment.manage')");
  expect((await invite(c.body)).status).toBe(200);
});
test('ENROLL-02 authentication, branch isolation, CSRF and Origin',async()=>{
  expect((await request(app).post(base).set('Origin',ORIGIN).send(data())).status).toBe(401);
  expect((await create(data(),rf)).status).toBe(403);
  const {u,i}=await pending();
  expect((await invite(u,'issue',2,rf)).status).toBe(403);
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('Origin',ORIGIN).send(data())).status).toBe(403);
  expect((await request(app).post(base).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).set('Origin','https://evil.example').send(data())).status).toBe(403);
  expect((await request(app).post('/api/v1/auth/enrollment/accept').send({token:i.token,password})).status).toBe(403);
  expect((await authed(admin).post(base).send(data())).status).toBe(422);
});
test.each([
  {login:'UPPER'}, {full_name:' '},{primary_email:'shared'},{primary_email:'a@b c.test'},
  {reason:'short'},{scope_kind:'NETWORK'},{is_active:true},{password:'SharedPassword'}
])('ENROLL-03 strict schema rejects %j',async patch=>{
  expect((await create({...data(),...patch} as any)).status).toBe(422);
});
test('ENROLL-04 inactive, no grants, duplicate login/email blocked; idempotent concurrent creation',async()=>{
  const b=data(),key=idemKey('create');
  const [a,c]=await Promise.all([create(b,admin,key),create(b,admin,key)]);
  expect(a.status).toBe(201);expect(c.body).toEqual(a.body);
  expect(a.body.is_active).toBe(false);expect(a.body.primary_email).toBe(b.primary_email);
  expect((await create({...b,full_name:'Different name'},admin,key)).status).toBe(409);
  expect((await create(b)).status).toBe(409);
  expect((await create({...data(),primary_email:b.primary_email.toUpperCase()})).status).toBe(409);
  expect((await pool.query('SELECT 1 FROM role_grants WHERE user_id=$1',[a.body.id])).rowCount).toBe(0);
  expect((await request(app).post('/api/v1/auth/login').set('Origin',ORIGIN).send({login:b.login,password})).status).toBe(401);
});
test('ENROLL-05 token returned once, hash only, TTL 72h, no cache, no secret in durable logs',async()=>{
  const {u,i}=await pending();
  expect(i.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(Date.parse(i.enrollment.expires_at)-Date.now()).toBeGreaterThan(71.9*3600000);
  const row=(await pool.query('SELECT * FROM user_enrollments WHERE user_id=$1',[u.id])).rows[0];
  expect(row.token_digest.length).toBe(32);expect(row.token_digest.toString('utf8')).not.toContain(i.token);
  const d=await authed(admin).get('/api/v1/access/directory');
  expect(d.headers['cache-control']).toBe('no-store');expect(JSON.stringify(d.body)).not.toMatch(/token_digest|password_hash/);
  expect((await invite(u,'issue',1)).status).toBe(409);
  const durable=(await pool.query(`SELECT row_to_json(a) v FROM audit_log a UNION ALL
    SELECT row_to_json(o) FROM outbox_events o UNION ALL SELECT row_to_json(i) FROM idempotency_records i`)).rows;
  expect(JSON.stringify(durable)).not.toContain(i.token);
  expect(JSON.stringify(durable)).not.toContain(password);
});
test('ENROLL-06 reissue cancels old bearer, revoke cancels current, stale version conflicts',async()=>{
  const {u,i}=await pending();const fresh=await invite(u,'issue',2);expect(fresh.status).toBe(200);
  expect((await accept(i.token)).status).toBe(401);
  expect((await invite(u,'revoke',2)).status).toBe(409);
  expect((await invite(u,'revoke',3)).status).toBe(200);
  expect((await accept(fresh.body.token)).status).toBe(401);
  expect((await pool.query('SELECT is_active FROM app_users WHERE id=$1',[u.id])).rows[0].is_active).toBe(false);
});
test('ENROLL-07 expired/unknown tokens and weak passwords do not consume enrollment',async()=>{
  const {u,i}=await pending();
  expect((await accept(i.token,'short')).status).toBe(422);
  expect((await accept(randomBytes(32).toString('base64url'))).status).toBe(401);
  await pool.query("UPDATE user_enrollments SET expires_at=now()-interval '1 second' WHERE user_id=$1",[u.id]);
  const r=await accept(i.token);expect(r.status).toBe(401);expect(r.headers['cache-control']).toBe('no-store');
});
test('ENROLL-08 concurrent acceptance once, no session or implicit grants, ordinary personal login succeeds',async()=>{
  const {u,i}=await pending();const [a,b]=await Promise.all([accept(i.token),accept(i.token)]);
  expect([a.status,b.status].sort()).toEqual([200,401]);
  expect((a.status===200?a:b).headers['set-cookie']).toBeUndefined();
  expect((await pool.query('SELECT 1 FROM sessions WHERE user_id=$1',[u.id])).rowCount).toBe(0);
  const s=await login(u.login,password);
  const me=await authed(s).get('/api/v1/me');expect(me.status).toBe(200);expect(me.body.grants).toEqual([]);
  expect((await authed(s).get('/api/v1/access/directory')).status).toBe(403);
  expect((await authed(s).get('/api/v1/work-items')).body.items??[]).toEqual([]);
  expect((await invite(u,'issue',3)).status).toBe(409);
  const e=(await pool.query('SELECT * FROM user_enrollments WHERE user_id=$1',[u.id])).rows[0];
  expect(e.token_digest).toBeNull();expect(e.expires_at).toBeNull();expect(e.completed_at).not.toBeNull();
  expect((await pool.query("SELECT 1 FROM audit_log WHERE aggregate_id=$1 AND action='ENROLLMENT_COMPLETED'",[u.id])).rowCount).toBe(1);
});
test('ENROLL-09 existing active/disabled users cannot be enrolled or reset by this API',async()=>{
  expect((await invite({id:rf.userId})).status).toBe(409);
  await pool.query('UPDATE app_users SET is_active=false WHERE id=$1',[rf.userId]);
  try {expect((await invite({id:rf.userId})).status).toBe(409);}
  finally {await pool.query('UPDATE app_users SET is_active=true WHERE id=$1',[rf.userId]);}
});
test('ENROLL-10 current rights rechecked on creation replay and issuing',async()=>{
  const b=data(),key=idemKey('reauth'),c=await create(b,admin,key);
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='user.create'");
  try {expect((await create(b,admin,key)).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','user.create')");}
  await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='user.enrollment.manage'");
  try {expect((await invite(c.body)).status).toBe(403);}
  finally {await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','user.enrollment.manage')");}
});
test('ENROLL-11 audit failure rolls back account creation and acceptance; secret is not logged',async()=>{
  const {u,i}=await pending(),b=data();
  await pool.query(`CREATE FUNCTION enrollment_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.action IN ('PERSONAL_USER_CREATED','ENROLLMENT_COMPLETED') THEN RAISE EXCEPTION 'synthetic audit unavailable'; END IF; RETURN NEW; END $$;
    CREATE TRIGGER enrollment_test_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION enrollment_test_fail()`);
  try {
    expect((await create(b)).status).toBe(503);
    expect((await pool.query('SELECT 1 FROM app_users WHERE login=$1',[b.login])).rowCount).toBe(0);
    expect((await accept(i.token)).status).toBe(503);
    expect((await pool.query('SELECT is_active FROM app_users WHERE id=$1',[u.id])).rows[0].is_active).toBe(false);
  } finally {await pool.query('DROP TRIGGER enrollment_test_fail ON audit_log; DROP FUNCTION enrollment_test_fail()');}
  expect((await accept(i.token)).status).toBe(200);
});
test('ENROLL-12 bounded attempts and malformed command',async()=>{
  for(let n=0;n<5;n++)expect((await accept('x'.repeat(43))).status).toBe(401);
  expect((await accept('x'.repeat(43))).status).toBe(429);
  expect((await invite({id:'-'.repeat(36)})).status).toBe(422);
});
test('ENROLL-13 new personal RM and RF receive explicit real-branch scope and complete a task without demo access',async()=>{
  const branch=randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
    VALUES($1,$2,'ORG_UNIT','ACTIVE','2020-01-01')`,[branch,'ENROLL_'+branch.replace(/-/g,'')]);
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason)
    VALUES($1,'Synthetic onboarding branch','2020-01-01','Synthetic integration test')`,[branch]);
  await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason)
    VALUES($1,'10000000-0000-4000-8000-000000000004','2020-01-01','Synthetic integration test')`,[branch]);
  const people:Session[]=[];
  for(const role of ['REGIONAL_MANAGER','RF']) {
    const {u,i}=await pending();expect((await accept(i.token)).status).toBe(200);
    const session=await login(u.login,password);people.push(session);
    const b='/api/v1/access/proposals';
    const d=await authed(admin).post(b).set('Idempotency-Key',idemKey('grant')).send({change:{
      operation:'GRANT_ROLE',user_id:u.id,role_code:role,org_unit_id:branch,valid_from:'NOW',valid_until:null,
      reason:'Synthetic approved onboarding assignment'}});
    expect(d.status).toBe(200);
    const p=await authed(admin).post(`${b}/${d.body.id}/preview`).set('Idempotency-Key',idemKey('preview')).send({expected_version:d.body.version});
    expect(p.body.preview_summary.issues).toEqual([]);
    const a=await authed(admin).post(`${b}/${p.body.id}/apply`).set('Idempotency-Key',idemKey('apply'))
      .send({expected_version:p.body.version,preview_token:p.body.preview_token});
    expect(a.status).toBe(200);
    expect((await authed(session).get('/api/v1/me')).body.grants.map((g:any)=>g.org_unit_id)).toEqual([branch]);
  }
  const [manager,executor]=people,b='/api/v1/work-items';
  const c=await authed(manager).post(b).set('Idempotency-Key',idemKey('task')).send({
    org_unit_id:branch,template_code:'pilot_task_v1',title:'Synthetic first operational task',due_at:new Date(Date.now()+86400000).toISOString()});
  expect(c.status).toBe(201);let w=c.body;
  async function command(s:Session,action:string,extra:any={}) {
    const r=await authed(s).post(`${b}/${w.id}/${action}`).set('Idempotency-Key',idemKey(action))
      .send({expected_entity_version:w.entity_version,...extra});
    expect(r.status).toBe(200);w=r.body;
  }
  await command(manager,'assign',{assignee_user_id:executor.userId});
  await command(executor,'start');
  const patch=await authed(executor).patch(`${b}/${w.id}/fields`).set('Idempotency-Key',idemKey('field'))
    .send({changes:[{field_path:'completion_summary',expected_version:1,new_value:'Synthetic verified result'}]});
  expect(patch.status).toBe(200);
  w=(await authed(executor).get(`${b}/${w.id}`)).body;
  await command(executor,'submit');
  await command(manager,'accept',{submission_id:w.current_submission.id,submission_revision:w.current_submission.revision});
  expect(w.status).toBe('COMPLETED');
  expect((await authed(rf).get(`${b}/${w.id}`)).status).toBe(404);
});
