// Isolated real PostgreSQL suite, synthetic identities/branches only.
import request from 'supertest';
import { randomUUID,randomBytes } from 'crypto';
import { pool,closePool,withTransaction } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { factAccess } from '../src/reporting/factAccess';
import { provisionFactAdministrator } from '../src/reporting/factAdminProvisioning';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { app,authed,login,Session,ORIGIN } from './helpers';
let admin:Session,rf:Session,grant:string,branch:string,adminGrant:string;
const base='/api/v1/access/metrics',password=randomBytes(32).toString('base64url');
const command=(patch:any={})=>({operation:'GRANT',grant_id:grant,capability:'READ',metrics:['sales','margin'],
 valid_from:'NOW',valid_until:null,reason:'Synthetic approved metric access',...patch});
const preview=(body:any,s=admin)=>authed(s).post(`${base}/preview`).send(body);
const apply=(id:string,s=admin)=>authed(s).post(`${base}/apply`).send({preview_id:id,confirmed:true});
async function ready(body:any){const r=await preview(body);expect(r.status).toBe(200);expect(r.body.issues).toEqual([]);return r.body.id;}
async function revoke(){return apply(await ready({operation:'REVOKE',grant_id:grant,capability:'READ',reason:'Synthetic approved immediate revocation'}));}
beforeAll(async()=>{
 const b=await bootstrapFirstAdministrator({login:'metric_admin',fullName:'Администратор beta · тест',password,
   reason:'Synthetic isolated metric administration',approvalReference:'SYNTHETIC_METRIC_APPROVAL'});
 adminGrant=b.grantId;admin=await login('metric_admin',password);rf=await login('rf_a');
 branch=randomUUID();
 await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from)
   VALUES($1,'METRIC_BETA','ORG_UNIT','ACTIVE','2020-01-01')`,[branch]);
 grant=(await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,scope_kind,valid_from)
   VALUES($1,'RF',$2,'ORG_UNIT','2020-01-01') RETURNING id`,[rf.userId,branch])).rows[0].id;
});
beforeEach(resetLimits);afterAll(closePool);
test('MA-01 migration grants nobody; explicit permission AND directory permission needed',async()=>{
 expect((await pool.query("SELECT count(*)::int n FROM role_permissions WHERE permission_code='report.fact_access.manage'")).rows[0].n).toBe(0);
 expect((await authed(admin).get(base)).status).toBe(403);
 await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','report.fact_access.manage')");
 expect((await authed(admin).get(base)).status).toBe(403);
 await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','access.directory.read')");
 expect((await authed(admin).get(base)).status).toBe(200);
});
test('MA-02 no anonymous/branch-role access; CSRF and Origin enforced',async()=>{
 expect((await request(app).get(base)).status).toBe(401);
 for(const s of [rf]) {
   expect((await authed(s).get(base)).status).toBe(403);
   expect((await preview(command(),s)).status).toBe(403);
   expect((await apply(randomUUID(),s)).status).toBe(403);
 }
 expect((await request(app).post(`${base}/preview`).set('Cookie',admin.cookie).set('Origin',ORIGIN).send(command())).status).toBe(403);
 expect((await request(app).post(`${base}/apply`).set('Cookie',admin.cookie).set('X-CSRF-Token',admin.csrf).set('Origin','https://evil.example').send({})).status).toBe(403);
});
test.each([
 {metrics:[]},{metrics:['sales','sales']},{metrics:['__proto__']},{scope_kind:'NETWORK'},
 {valid_from:'2026-02-30T00:00:00.000Z'},{valid_until:'bad'},{reason:'short'},
])('MA-03 malformed command fails closed %j',async patch=>expect((await preview(command(patch))).status).toBe(422));
test('MA-04 own grant, network READ, branch PUBLISH and demo branch blocked',async()=>{
 for(const patch of [{grant_id:adminGrant},{capability:'PUBLISH'},
   {grant_id:(await pool.query("SELECT id FROM role_grants WHERE user_id=$1 AND org_unit_id<>$2",[rf.userId,branch])).rows[0].id}]) {
   const p=await preview(command(patch));expect(p.status).toBe(200);expect(p.body.id).toBeNull();expect(p.body.valid).toBe(false);
 }
});
test('MA-05 preview has no effect, directory excludes secrets, cancel needs no write',async()=>{
 const id=await ready(command());expect(id).toBeTruthy();
 expect((await pool.query('SELECT count(*)::int n FROM report_fact_access')).rows[0].n).toBe(0);
 const r=await authed(admin).get(base);expect(r.headers['cache-control']).toBe('no-store');
 expect(JSON.stringify(r.body)).not.toMatch(/password|csrf|auth_epoch|token_digest/);
 expect(r.body.grants.filter((g:any)=>g.readable_branch).map((g:any)=>g.branch_code)).toEqual(['METRIC_BETA']);
});
test('MA-06 concurrent replay writes exactly one access, audit and receipt',async()=>{
 const id=await ready(command()),before=(await pool.query('SELECT * FROM role_grants ORDER BY id')).rows;
 const [a,b]=await Promise.all([apply(id),apply(id)]);
 expect(a.status).toBe(200);expect(b.body).toEqual(a.body);
 expect((await pool.query('SELECT count(*)::int n FROM fact_access_receipts WHERE preview_id=$1',[id])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM audit_log WHERE aggregate_id=$1',[id])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT count(*)::int n FROM outbox_events WHERE aggregate_id=$1',[id])).rows[0].n).toBe(1);
 expect((await pool.query('SELECT * FROM role_grants ORDER BY id')).rows).toEqual(before);
});
test('MA-07 cannot overwrite; revoke/regrant preserves complete before/after history',async()=>{
 expect((await preview(command({metrics:['stock']}))).body.valid).toBe(false);
 expect((await revoke()).status).toBe(200);
 expect((await apply(await ready(command({metrics:['sales']})))).status).toBe(200);
 const r=await authed(admin).get(base);
 expect(r.body.history).toHaveLength(3);
 expect(r.body.history[0].before_state.revoked_at).toBeTruthy();
 expect(r.body.history[1].before_state.metrics.sort()).toEqual(['margin','sales']);
 expect(r.body.access[0].metrics).toEqual(['sales']);
});
test('MA-08 changed target after preview and competing previews are rejected',async()=>{
 await revoke();
 const p=await ready(command()),q=await ready(command({metrics:['stock']}));
 expect((await apply(p)).status).toBe(200);expect((await apply(q)).status).toBe(409);
 const r=await ready({operation:'REVOKE',grant_id:grant,capability:'READ',reason:'Synthetic revoke after target changed'});
 await pool.query('UPDATE role_grants SET grant_version=grant_version+1 WHERE id=$1',[grant]);
 expect((await apply(r)).status).toBe(409);
});
test('MA-09 future grant is inactive, ending date bounded by role, no backdating',async()=>{
 await revoke();
 const end=new Date(Date.now()+86400000*3).toISOString();
 await pool.query('UPDATE role_grants SET valid_until=$2 WHERE id=$1',[grant,end]);
 expect((await preview(command())).body.valid).toBe(false);
 expect((await preview(command({valid_from:'2020-01-01T00:00:00.000Z',valid_until:end}))).body.valid).toBe(false);
 const start=new Date(Date.now()+86400000).toISOString();
 expect((await apply(await ready(command({valid_from:start,valid_until:end})))).status).toBe(200);
 // Resolve cookie-token session through /me isn't needed: DB identifies synthetic session.
 const session=(await pool.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[rf.userId])).rows[0].id;
 const read=await withTransaction(c=>factAccess(c,{userId:rf.userId,sessionId:session} as any,'READ'));
 expect(read).toHaveLength(0);
 await revoke();await pool.query('UPDATE role_grants SET valid_until=NULL WHERE id=$1',[grant]);
});
test('MA-10 revoke invalidates reader immediately but keeps published data untouched',async()=>{
 await apply(await ready(command()));
 const session=(await pool.query('SELECT id FROM sessions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1',[rf.userId])).rows[0].id;
 const read=()=>withTransaction(c=>factAccess(c,{userId:rf.userId,sessionId:session} as any,'READ'));
 expect(await read()).toHaveLength(1);await revoke();expect(await read()).toHaveLength(0);
 expect((await pool.query('SELECT count(*)::int n FROM report_fact_snapshots')).rows[0].n).toBe(0);
});
test('MA-11 expired, fabricated, wrong actor and missing confirmation cannot apply',async()=>{
 const id=await ready(command());
 expect((await apply(randomUUID())).status).toBe(409);
 expect((await authed(admin).post(`${base}/apply`).send({preview_id:id,confirmed:false})).status).toBe(422);
 const row=(await pool.query('SELECT * FROM fact_access_previews WHERE id=$1',[id])).rows[0],expired=randomUUID();
 await pool.query(`INSERT INTO fact_access_previews(id,actor_user_id,command,state_hash,summary,expires_at)
   VALUES($1,$2,$3,$4,$5,now()-interval '1 second')`,[expired,admin.userId,row.command,row.state_hash,row.summary]);
 expect((await apply(expired)).status).toBe(409);
 const alien=randomUUID();
 await pool.query(`INSERT INTO fact_access_previews(id,actor_user_id,command,state_hash,summary)
   VALUES($1,$2,$3,$4,$5)`,[alien,rf.userId,row.command,row.state_hash,row.summary]);
 expect((await apply(alien)).status).toBe(409);
 await expect(pool.query('UPDATE fact_access_previews SET expires_at=now() WHERE id=$1',[id])).rejects.toThrow();
});
test('MA-12 permission removal blocks even successful replay',async()=>{
 const id=await ready(command());expect((await apply(id)).status).toBe(200);
 await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='report.fact_access.manage'");
 try{expect((await apply(id)).status).toBe(403);expect((await authed(admin).get(base)).status).toBe(403);}
 finally{await pool.query("INSERT INTO role_permissions VALUES('SUPER_ADMIN','report.fact_access.manage')");}
});
test('MA-13 audit failure rolls back receipt and permission change',async()=>{
 const id=await ready({operation:'REVOKE',grant_id:grant,capability:'READ',reason:'Synthetic audit failure rollback test'});
 await pool.query(`CREATE FUNCTION metric_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$;
 CREATE TRIGGER metric_test_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION metric_test_fail()`);
 try{expect((await apply(id)).status).toBe(503);}
 finally{await pool.query('DROP TRIGGER metric_test_fail ON audit_log; DROP FUNCTION metric_test_fail()');}
 expect((await pool.query('SELECT revoked_at FROM report_fact_access WHERE grant_id=$1',[grant])).rows[0].revoked_at).toBeNull();
 expect((await pool.query('SELECT count(*)::int n FROM fact_access_receipts WHERE preview_id=$1',[id])).rows[0].n).toBe(0);
});
test('MA-14 publishing requires another authorized actor and valid staging, not mere network role',async()=>{
 const second=await login('rf_b');
 const acting=(await pool.query(`INSERT INTO role_grants(user_id,role_code,scope_kind,org_unit_id,valid_from)
   VALUES($1,'SUPER_ADMIN','NETWORK',NULL,now()) RETURNING id`,[second.userId])).rows[0].id;
 try{
   const c=command({grant_id:adminGrant,capability:'PUBLISH',metrics:['sales']});
   expect((await preview(c,second)).body.valid).toBe(false);
   await pool.query(`INSERT INTO report_staging_access(grant_id,audit_id,approval_reference)
     SELECT grant_id,audit_id,'SYNTHETIC_PUBLISH_APPROVAL' FROM administrator_bootstrap`);
   const p=await preview(c,second);expect(p.body.issues).toEqual([]);
   expect((await apply(p.body.id,second)).status).toBe(200);
   expect((await pool.query("SELECT metrics FROM report_fact_access WHERE grant_id=$1 AND capability='PUBLISH'",[adminGrant])).rows[0].metrics).toEqual(['sales']);
   const r=await preview({operation:'REVOKE',grant_id:adminGrant,capability:'PUBLISH',reason:'Synthetic revoke publication access'},second);
   expect((await apply(r.body.id,second)).status).toBe(200);
 }finally{await pool.query('DELETE FROM role_grants WHERE id=$1',[acting]);}
});
test('MA-15 disabled target can be revoked; stale session cannot change access',async()=>{
 await pool.query('UPDATE app_users SET is_active=false WHERE id=$1',[rf.userId]);
 try{expect((await revoke()).status).toBe(200);expect((await preview(command())).body.valid).toBe(false);}
 finally{await pool.query('UPDATE app_users SET is_active=true WHERE id=$1',[rf.userId]);}
 await pool.query('UPDATE app_users SET auth_epoch=auth_epoch+1 WHERE id=$1',[admin.userId]);
 expect([401,403]).toContain((await authed(admin).get(base)).status);
});
test('MA-16 operator opt-in is singleton, audited, idempotent and never silently regrants',async()=>{
 await expect(provisionFactAdministrator('rf_a','SYNTHETIC_ADMIN_APPROVAL')).rejects.toThrow();
 await expect(provisionFactAdministrator('metric_admin','short')).rejects.toThrow();
 await expect(provisionFactAdministrator('metric_admin','SYNTHETIC_ADMIN_APPROVAL')).rejects.toThrow();
 await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='report.fact_access.manage'");
 expect((await provisionFactAdministrator('metric_admin','SYNTHETIC_ADMIN_APPROVAL')).status).toBe('PROVISIONED');
 expect((await provisionFactAdministrator('metric_admin','SYNTHETIC_ADMIN_APPROVAL')).status).toBe('ALREADY_PROVISIONED');
 expect((await pool.query("SELECT count(*)::int n FROM audit_log WHERE action='REPORT_FACT_ADMIN_PROVISIONED'")).rows[0].n).toBe(1);
 await pool.query("DELETE FROM role_permissions WHERE role_code='SUPER_ADMIN' AND permission_code='report.fact_access.manage'");
 await expect(provisionFactAdministrator('metric_admin','SYNTHETIC_ADMIN_APPROVAL')).rejects.toThrow();
});
