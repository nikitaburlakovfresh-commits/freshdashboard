import request from 'supertest';
import { Client } from 'pg';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pool, closePool } from '../src/db/pool';
import { applyVersionedMigrations, migrationDirectory } from '../src/db/migrations';
import { assertLocalTestDatabase } from './testDatabaseGuard';
import { _resetForTests as resetRateLimits } from '../src/auth/rateLimit';
import { app, login, authed, ORIGIN } from './helpers';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const NETWORK = '10000000-0000-4000-8000-000000000001';
const DIVISION = '10000000-0000-4000-8000-000000000002';
const CLUSTER = '10000000-0000-4000-8000-000000000003';
beforeEach(resetRateLimits);
afterAll(closePool);

describe('ORG-API: exact current scope, no administration', () => {
  test('ORG-API-01 anonymous tree, history and admin review require authentication', async () => {
    for (const route of ['/tree', `/units/${A}/history`, '/admin-review']) {
      expect((await request(app).get(`/api/v1/organization${route}`)).status).toBe(401);
    }
  });
  test.each(['rm_a','rf_a','rm_b','rf_b'])('ORG-API-02 %s sees only its current exact branch and no ancestor metadata', async name => {
    const session = await login(name);
    const res = await authed(session).get('/api/v1/organization/tree?as_of=2026-09-15');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.scope_mode).toBe('CURRENT_EXACT_PILOT_GRANTS');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].id).toBe(name.endsWith('a') ? A : B);
    expect(res.body.items[0].parent_id).toBeNull();
    expect(JSON.stringify(res.body)).not.toMatch(/Синтетическая скрытая|legal_entity_id|contract_id|password|login|full_name/);
    expect(res.body.admin_review.authorized).toBe(false);
  });
  test('ORG-API-03 unknown and hidden histories use the same 404 response shape', async () => {
    const session = await login('rm_a');
    for (const id of [B,NETWORK,'ffffffff-ffff-4fff-8fff-ffffffffffff','not-a-uuid']) {
      const res = await authed(session).get(`/api/v1/organization/units/${id}/history`);
      expect(res.status).toBe(404); expect(res.body.code).toBe('NOT_FOUND');
      expect(res.body.message).toBe('Организационная единица не найдена.');
      expect(Object.keys(res.body).sort()).toEqual(['code','details','message','request_id']);
    }
  });
  test('ORG-API-04 as_of boundary selects exactly one name and affiliation without changing UUID', async () => {
    const session = await login('rm_a');
    const old = await authed(session).get('/api/v1/organization/tree?as_of=2025-12-31');
    const next = await authed(session).get('/api/v1/organization/tree?as_of=2026-01-01');
    expect(old.body.items[0]).toMatchObject({ id:A,display_name:'Прежнее имя A (тест)',business_model:'FRANCHISE' });
    expect(next.body.items[0]).toMatchObject({ id:A,business_model:'OWN_OPERATION',affiliation_effective_from:'2026-01-01' });
    expect(next.body.items[0].display_name).not.toBe(old.body.items[0].display_name);
    expect((await authed(session).get('/api/v1/organization/tree?as_of=2019-12-31')).body.items).toEqual([]);
    const history = await authed(session).get(`/api/v1/organization/units/${A}/history`);
    expect(history.body.names).toHaveLength(2);
    expect(history.body.names[0].effective_to).toBe(history.body.names[1].effective_from);
    expect(history.body.affiliations.map((r: any) => r.parent_id)).toEqual([null,null]);
  });
  test.each(['2026-02-30','2026-13-01','2026-9-1','1899-12-31','not-a-date','2026-01-01&as_of=2027-01-01'])('ORG-API-05 invalid date %s is rejected', async value => {
    const session = await login('rm_a');
    expect((await authed(session).get(`/api/v1/organization/tree?as_of=${value}`)).status).toBe(422);
  });
  test('ORG-API-06 forged scope is rejected; dual role does not imply a network grant', async () => {
    const session = await login('rm_rf_a_dual');
    expect((await authed(session).get('/api/v1/organization/tree?scope=NETWORK&role=SUPER_ADMIN')).status).toBe(422);
    expect((await authed(session).get('/api/v1/organization/tree')).body.items.map((r: any) => r.id)).toEqual([A]);
  });
  test('ORG-API-07 revoke and expiry apply to old dates and already known IDs immediately on the next request', async () => {
    const session = await login('rm_a');
    const before = await pool.query('SELECT * FROM role_grants WHERE user_id=$1', [session.userId]);
    try {
      await pool.query('UPDATE role_grants SET revoked_at=now() WHERE user_id=$1', [session.userId]);
      expect((await authed(session).get('/api/v1/organization/tree?as_of=2025-12-31')).body.items).toEqual([]);
      expect((await authed(session).get(`/api/v1/organization/units/${A}/history`)).status).toBe(404);
      await pool.query("UPDATE role_grants SET revoked_at=NULL,valid_from=now()-interval '2 days',valid_until=now()-interval '1 day' WHERE user_id=$1", [session.userId]);
      expect((await authed(session).get('/api/v1/organization/tree')).body.items).toEqual([]);
      await pool.query("UPDATE role_grants SET valid_until=NULL,valid_from=now()+interval '1 day' WHERE user_id=$1", [session.userId]);
      expect((await authed(session).get('/api/v1/organization/tree?as_of=2030-01-01')).body.items).toEqual([]);
    } finally {
      for (const g of before.rows) await pool.query('UPDATE role_grants SET revoked_at=$2,valid_from=$3,valid_until=$4 WHERE id=$1',[g.id,g.revoked_at,g.valid_from,g.valid_until]);
    }
  });
  test('ORG-API-08 multi-branch UNION includes only explicitly granted IDs, never parents', async () => {
    const session = await login('rm_a');
    const grant = await pool.query("INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from) VALUES ($1,'RF',$2,now()) RETURNING id",[session.userId,B]);
    try {
      expect((await authed(session).get('/api/v1/organization/tree')).body.items.map((r: any) => r.id)).toEqual([A,B]);
    } finally { await pool.query('DELETE FROM role_grants WHERE id=$1',[grant.rows[0].id]); }
  });
  test('ORG-API-09 pilot administration and guessed write routes always deny; no changes or grants', async () => {
    const session = await login('rm_a');
    const count = await pool.query('SELECT (SELECT count(*) FROM role_grants) grants,(SELECT count(*) FROM org_directory_units) units');
    expect((await authed(session).get('/api/v1/organization/admin-review')).status).toBe(403);
    for (const action of ['proposals','proposals/approve','units','grants','import/commit']) {
      const res = await authed(session).post(`/api/v1/organization/${action}`).send({ approved:true,role:'SUPER_ADMIN',user_id:session.userId });
      expect(res.status).toBe(403); expect(res.body.code).toBe('FORBIDDEN');
    }
    const after = await pool.query('SELECT (SELECT count(*) FROM role_grants) grants,(SELECT count(*) FROM org_directory_units) units');
    expect(after.rows).toEqual(count.rows);
    const me = await authed(session).get('/api/v1/me');
    expect(me.body.grants.map((g: any) => g.role)).toEqual(['REGIONAL_MANAGER']);
  });
  test('ORG-API-10 unauthorized write still enforces Origin and CSRF', async () => {
    const session = await login('rm_a');
    expect((await request(app).post('/api/v1/organization/proposals').set('Cookie',session.cookie).set('Origin',ORIGIN).send({})).body.code).toBe('CSRF_INVALID');
    expect((await authed(session).post('/api/v1/organization/proposals').set('Origin','https://invalid.example').send({})).body.code).toBe('ORIGIN_DENIED');
  });
  test('ORG-API-11 a role name without the read permission does not authorize metadata', async () => {
    const session = await login('rm_a');
    await pool.query("DELETE FROM role_permissions WHERE role_code='REGIONAL_MANAGER' AND permission_code='work_item.read'");
    try {
      expect((await authed(session).get('/api/v1/organization/tree')).body.items).toEqual([]);
      expect((await authed(session).get(`/api/v1/organization/units/${A}/history`)).status).toBe(404);
    } finally {
      await pool.query("INSERT INTO role_permissions(role_code,permission_code) VALUES('REGIONAL_MANAGER','work_item.read')");
    }
  });
  test('ORG-API-12 deactivation terminates directory access for an already authenticated user', async () => {
    const session = await login('rf_a');
    await pool.query('UPDATE app_users SET is_active=false WHERE id=$1',[session.userId]);
    try {
      expect((await authed(session).get('/api/v1/organization/tree')).status).toBe(401);
      expect((await authed(session).get(`/api/v1/organization/units/${A}/history`)).status).toBe(401);
    } finally { await pool.query('UPDATE app_users SET is_active=true WHERE id=$1',[session.userId]); }
  });
});

describe('ORG-DB: PostgreSQL 16 effective history constraints', () => {
  async function rejected(sql: string, params: unknown[], code = '23514') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await expect(client.query(sql,params)).rejects.toMatchObject({ code });
    } finally { await client.query('ROLLBACK'); client.release(); }
  }
  test('ORG-DB-01 existing pilot identities still have exact A/B IDs and restricted roles', async () => {
    expect((await pool.query('SELECT id FROM org_units ORDER BY code')).rows.map(r=>r.id)).toEqual([A,B]);
    expect((await pool.query('SELECT code FROM roles ORDER BY code')).rows.map(r=>r.code)).toEqual(['REGIONAL_MANAGER','RF','SUPER_ADMIN']);
  });
  test('ORG-DB-02 overlapping name/affiliation intervals are rejected by exclusion constraints', async () => {
    await rejected("INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason) VALUES($1,'Overlap','2025-01-01','Test')",[A],'23P01');
    await rejected("INSERT INTO org_directory_affiliation_history(org_unit_id,effective_from,change_reason) VALUES($1,'2025-01-01','Test')",[A],'23P01');
  });
  test('ORG-DB-03 committed history cannot be renamed, reparented, deleted or reopened', async () => {
    await rejected("UPDATE org_directory_name_history SET display_name='Changed' WHERE org_unit_id=$1",[A]);
    await rejected('UPDATE org_directory_affiliation_history SET parent_id=NULL WHERE org_unit_id=$1',[A]);
    await rejected('DELETE FROM org_directory_name_history WHERE org_unit_id=$1',[A]);
    await rejected("UPDATE org_directory_name_history SET effective_to=NULL WHERE org_unit_id=$1 AND effective_to IS NOT NULL",[A]);
  });
  test('ORG-DB-04 one closure and an adjacent successor preserve past and UUID', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE org_directory_name_history SET effective_to='2027-01-01' WHERE org_unit_id=$1 AND effective_to IS NULL",[A]);
      await client.query("INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason) VALUES($1,'Будущее имя A (тест)','2027-01-01','Test successor')",[A]);
      const rows = await client.query("SELECT display_name FROM org_directory_name_history WHERE org_unit_id=$1 AND '2027-01-01'::date>=effective_from AND (effective_to IS NULL OR '2027-01-01'::date<effective_to)",[A]);
      expect(rows.rows.map(r=>r.display_name)).toEqual(['Будущее имя A (тест)']);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  test('ORG-DB-05 identity, demo flag and pilot bridge cannot be rewritten', async () => {
    await rejected("UPDATE org_directory_units SET kind='NETWORK' WHERE id=$1",[A]);
    await rejected('UPDATE org_directory_units SET is_demo=false WHERE id=$1',[A]);
    await rejected("INSERT INTO org_directory_units(id,code,kind,lifecycle_state,is_demo,effective_from,pilot_org_unit_id) VALUES(gen_random_uuid(),'BAD_BRIDGE','ORG_UNIT','ACTIVE',true,'2020-01-01',$1)",[A]);
  });
  test('ORG-DB-06 hierarchy supports NETWORK/DIVISION/CLUSTER/ORG_UNIT and rejects cycles, inverted levels and demo mixing', async () => {
    expect((await pool.query('SELECT parent_id FROM org_directory_affiliation_history WHERE org_unit_id=$1',[CLUSTER])).rows[0].parent_id).toBe(DIVISION);
    for (const [child,parent] of [[NETWORK,A],[DIVISION,CLUSTER],[A,A],[A,'10000000-0000-4000-8000-000000000004']]) {
      await rejected("INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,effective_to,change_reason) VALUES($1,$2,'2010-01-01','2011-01-01','Invalid edge')",[child,parent]);
    }
  });
  test('ORG-DB-07 invalid business model, type, state and zero-length interval reject', async () => {
    await rejected("INSERT INTO org_directory_affiliation_history(org_unit_id,business_model,effective_from,effective_to,change_reason) VALUES($1,'INFER_FROM_NAME','2010-01-01','2011-01-01','Invalid model')",[A]);
    await rejected("INSERT INTO org_directory_units(code,kind,type_code,lifecycle_state,effective_from) VALUES('BAD_TYPE','ORG_UNIT','AUTO','ACTIVE','2020-01-01')",[]);
    await rejected("INSERT INTO org_directory_units(code,kind,lifecycle_state,effective_from) VALUES('BAD_STATE','ORG_UNIT','SUSPENDED','2020-01-01')",[]);
    await rejected("INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,effective_to,change_reason) VALUES($1,'Empty','2010-01-01','2010-01-01','Test')",[A]);
  });
});

describe('ORG-MIG: safe additive migration runner', () => {
  test('ORG-MIG-01 replay does not alter users, grants, task identities or directory history', async () => {
    const client = new Client();
    await client.connect();
    try {
      const snapshot = async () => (await client.query(`SELECT
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pilot_r1.org_units t) AS org,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pilot_r1.role_grants t) AS grants,
        (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM pilot_r1.org_directory_name_history t) AS history,
        (SELECT count(*) FROM pilot_r1.app_users) AS users`)).rows;
      const before = await snapshot();
      expect(await applyVersionedMigrations(client)).toEqual([]);
      expect(await snapshot()).toEqual(before);
    } finally { await client.end(); }
  });
  test('ORG-MIG-02 modified applied migration is rejected; failed migration has no partial table or ledger record', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(),'fresh-org-migrations-'));
    const name = '001_org_directory.sql';
    fs.writeFileSync(path.join(directory,name), fs.readFileSync(path.join(migrationDirectory(),name),'utf8')+'\n-- Tampered test copy');
    const client = new Client(); await client.connect();
    try {
      await expect(applyVersionedMigrations(client,directory)).rejects.toThrow('checksum mismatch');
      const failure = fs.mkdtempSync(path.join(os.tmpdir(),'fresh-org-failure-'));
      fs.writeFileSync(path.join(failure,'998_test_failure.sql'),'CREATE TABLE pilot_r1.org_failure_probe(id int); SELECT 1/0;');
      await expect(applyVersionedMigrations(client,failure)).rejects.toMatchObject({ code:'22012' });
      expect((await client.query("SELECT to_regclass('pilot_r1.org_failure_probe') AS table")).rows[0].table).toBeNull();
      expect((await client.query("SELECT count(*)::int AS n FROM pilot_r1.schema_migrations WHERE version='998_test_failure.sql'")).rows[0].n).toBe(0);
    } finally { await client.end(); }
  });
  test('ORG-MIG-03 destructive test setup refuses a non-test database or remote host', () => {
    const db = process.env.PGDATABASE, host = process.env.PGHOST;
    try {
      process.env.PGDATABASE='fresh_pilot'; expect(assertLocalTestDatabase).toThrow('refusing');
      process.env.PGDATABASE='fresh_pilot_test'; process.env.PGHOST='remote.example'; expect(assertLocalTestDatabase).toThrow('remote');
    } finally { process.env.PGDATABASE=db; process.env.PGHOST=host; }
  });
});
