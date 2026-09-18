import request from 'supertest';
import { pool, closePool } from '../src/db/pool';
import { _resetForTests as resetRateLimits } from '../src/auth/rateLimit';
import { app, login, authed, idemKey, Session } from './helpers';

const A = '00000000-0000-4000-8000-00000000000a';
let rm: Session, rf: Session, other: Session;
beforeAll(async () => { rm = await login('rm_a'); rf = await login('rf_a'); other = await login('rf_b'); });
beforeEach(resetRateLimits);
afterAll(closePool);
async function assigned(template = 'pilot_task_v1', userId = rf.userId) {
  const created = await authed(rm).post('/api/v1/work-items').set('Idempotency-Key', idemKey('personal-create'))
    .send({org_unit_id:A,template_code:template,title:'Личная синтетическая задача',due_at:'2025-01-01T00:00:00Z'});
  expect(created.status).toBe(201);
  const response = await authed(rm).post(`/api/v1/work-items/${created.body.id}/assign`).set('Idempotency-Key',idemKey('personal-assign'))
    .send({expected_entity_version:created.body.entity_version,assignee_user_id:userId});
  expect(response.status).toBe(200);
  return response.body;
}
test('catalog requires authentication and an RM grant, not an executor grant', async () => {
  expect((await request(app).get('/api/v1/work-items/templates')).status).toBe(401);
  expect((await authed(rf).get('/api/v1/work-items/templates')).status).toBe(403);
  const response = await authed(rm).get('/api/v1/work-items/templates');
  expect(response.status).toBe(200);
  for (const role of ['ROP','ROO']) expect(response.body.items).toEqual(expect.arrayContaining([
    expect.objectContaining({code:`personal_${role.toLowerCase()}_task_v1`,owner_role:role,requires_acceptance:true}),
  ]));
});
test('task card exposes the pinned full schema and exact owner', async () => {
  const task = await assigned('rf_planning_meeting_v1');
  expect(task.owner_role).toBe('RF');
  expect(task.field_schema.length).toBeGreaterThan(1);
  expect(task.field_schema.map((f: any) => f.field_path).sort()).toEqual(task.fields.map((f: any) => f.field_path).sort());
});
test('personal view retains overdue item identity/deadline and does not write on read', async () => {
  const task = await assigned();
  const before = await pool.query('SELECT count(*) FROM audit_log');
  for (let i = 0; i < 2; i++) {
    const response = await authed(rf).get('/api/v1/work-items?mine=true&role=RF&limit=100');
    expect(response.status).toBe(200);
    expect(response.body.current_business_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(response.body.items.find((t:any) => t.id === task.id)).toMatchObject({
      due_at:task.due_at,entity_version:task.entity_version,created_at:task.created_at,status:'ASSIGNED',
    });
  }
  expect((await pool.query('SELECT count(*) FROM audit_log')).rows).toEqual(before.rows);
});
test('personal view isolates assignee, branch and role', async () => {
  const task = await assigned();
  for (const [session, role] of [[other,'RF'],[rm,'RF'],[rf,'ROP']] as const) {
    const response = await authed(session).get(`/api/v1/work-items?mine=true&role=${role}&limit=100`);
    expect(response.status).toBe(200);
    expect(response.body.items.some((t:any) => t.id === task.id)).toBe(false);
  }
});
test('cursor cannot be reused between personal roles or the general list', async () => {
  await assigned(); await assigned();
  const page = await authed(rf).get('/api/v1/work-items?mine=true&role=RF&limit=1');
  expect(page.body.next_cursor).toBeTruthy();
  const cursor = encodeURIComponent(page.body.next_cursor);
  for (const query of ['mine=true&role=ROP','']) {
    const response = await authed(rf).get(`/api/v1/work-items?${query}&limit=1&cursor=${cursor}`);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe('INVALID_CURSOR');
  }
});
test('SUBMITTED remains open until manager accepts; cancelled never appears', async () => {
  const task = await assigned();
  const patch = await authed(rf).patch(`/api/v1/work-items/${task.id}/fields`).set('Idempotency-Key',idemKey('personal-field'))
    .send({changes:[{field_path:'completion_summary',expected_version:1,new_value:'Выполнено, требуется проверка результата.'}]});
  const submitted = await authed(rf).post(`/api/v1/work-items/${task.id}/submit`).set('Idempotency-Key',idemKey('personal-submit'))
    .send({expected_entity_version:patch.body.entity_version});
  expect(submitted.status).toBe(200);
  expect((await authed(rf).get('/api/v1/work-items?mine=true&limit=100')).body.items)
    .toEqual(expect.arrayContaining([expect.objectContaining({id:task.id,status:'SUBMITTED'})]));
  const accepted = await authed(rm).post(`/api/v1/work-items/${task.id}/accept`).set('Idempotency-Key',idemKey('personal-accept'))
    .send({expected_entity_version:submitted.body.entity_version,submission_id:submitted.body.current_submission.id,submission_revision:1});
  expect(accepted.status).toBe(200);
  expect((await authed(rf).get('/api/v1/work-items?mine=true&limit=100')).body.items.some((t:any) => t.id === task.id)).toBe(false);
  const cancelledTask = await assigned();
  expect((await authed(rm).post(`/api/v1/work-items/${cancelledTask.id}/cancel`).set('Idempotency-Key',idemKey('personal-cancel'))
    .send({expected_entity_version:cancelledTask.entity_version,reason:'Синтетическая проверка отмены'})).status).toBe(200);
  expect((await authed(rf).get('/api/v1/work-items?mine=true&limit=100')).body.items.some((t:any) => t.id === cancelledTask.id)).toBe(false);
});
test('ROP/ROO own tasks work, and revoking RF excludes RF even if ROP remains', async () => {
  const data = await pool.query(`INSERT INTO app_users(login,full_name,password_hash,password_hash_updated_at)
    SELECT 'personal_dual','Синтетический сотрудник',password_hash,now() FROM app_users WHERE id=$1 RETURNING id`,[rf.userId]);
  const id = data.rows[0].id;
  await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
    SELECT $1,role,$2,now() FROM (VALUES('RF'),('ROP'),('ROO')) roles(role)`,[id,A]);
  const user = await login('personal_dual');
  const rfTask = await assigned('pilot_task_v1',id);
  for (const role of ['ROP','ROO']) {
    const task = await assigned(`personal_${role.toLowerCase()}_task_v1`,id);
    const response = await authed(user).get(`/api/v1/work-items?mine=true&role=${role}`);
    expect(response.body.items.map((t:any) => t.id)).toContain(task.id);
    expect(response.body.items.map((t:any) => t.id)).not.toContain(rfTask.id);
    const patched = await authed(user).patch(`/api/v1/work-items/${task.id}/fields`).set('Idempotency-Key',idemKey('personal-role'))
      .send({changes:[{field_path:'completion_summary',expected_version:1,new_value:`Результат ${role}`}]});
    expect(patched.status).toBe(200);
  }
  await pool.query("UPDATE role_grants SET revoked_at=now() WHERE user_id=$1 AND role_code='RF'",[id]);
  const revoked = await authed(user).get('/api/v1/work-items?mine=true&role=RF');
  expect(revoked.body.items).toEqual([]);
  expect((await authed(user).patch(`/api/v1/work-items/${rfTask.id}/fields`).set('Idempotency-Key',idemKey('personal-deny'))
    .send({changes:[{field_path:'completion_summary',expected_version:1,new_value:'Недопустимое изменение'}]})).status).toBe(403);
});
test('personal filters reject malformed input', async () => {
  for (const query of ['mine=false','role=RF','mine=true&role[]=RF','mine=true&role=RF%27']) {
    expect((await authed(rf).get(`/api/v1/work-items?${query}`)).status).toBe(422);
  }
});
