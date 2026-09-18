// Isolated suite: run with --testMatch '**/test/canonicalOrg.scope.ts'.
// These NON-DEMO branches exercise production-shaped metadata but are entirely
// synthetic fixtures in guarded localhost/fresh_pilot_test. Never business seed.
import { randomUUID } from 'crypto';
import { pool, closePool } from '../src/db/pool';
import { _resetForTests as resetLimits } from '../src/auth/rateLimit';
import { login, authed, idemKey, Session } from './helpers';
import { drainNotificationsForTests } from '../src/workers/notificationConsumer';

const branch = randomUUID(), sibling = randomUUID();
const root = '10000000-0000-4000-8000-000000000004';
const pilotA = '00000000-0000-4000-8000-00000000000a';
let rm: Session, rf: Session, rmGrant: string;
const closed: string[] = [];
const body = (id: string) => ({
  org_unit_id: id, template_code: 'pilot_task_v1',
  title: 'Synthetic canonical branch task', due_at: '2031-01-01T00:00:00Z',
});
const create = (id: string, key = idemKey('canonical-create'), actor = rm) =>
  authed(actor).post('/api/v1/work-items').set('Idempotency-Key', key).send(body(id));
const step = (s: Session, id: string, action: string, payload: object) =>
  authed(s).post(`/api/v1/work-items/${id}/${action}`).set('Idempotency-Key', idemKey(action)).send(payload);

beforeAll(async () => {
  for (const [id, label] of [[branch, 'CANONICAL_TEST'], [sibling, 'SIBLING_TEST']]) {
    await pool.query(`INSERT INTO org_directory_units
      (id,code,kind,lifecycle_state,is_demo,effective_from)
      VALUES($1,$2,'ORG_UNIT','ACTIVE',false,'2020-01-01')`, [id, label]);
    await pool.query(`INSERT INTO org_directory_name_history
      (org_unit_id,display_name,effective_from,effective_to,change_reason) VALUES
      ($1,'Synthetic old name','2020-01-01','2026-01-01','Test fixture'),
      ($1,'Synthetic current name','2026-01-01',NULL,'Test fixture')`, [id]);
    await pool.query(`INSERT INTO org_directory_affiliation_history
      (org_unit_id,parent_id,effective_from,change_reason)
      VALUES($1,$2,'2020-01-01','Synthetic fixture, not a real assignment')`, [id, root]);
  }
  for (const name of ['canonical_rm', 'canonical_rf']) {
    await pool.query(`INSERT INTO app_users(login,full_name,password_hash,password_hash_updated_at)
      SELECT $1,'Synthetic canonical test user',password_hash,now() FROM app_users WHERE login='rf_a'`, [name]);
  }
  rm = await login('canonical_rm'); rf = await login('canonical_rf');
  for (const [user, role] of [[rm.userId, 'REGIONAL_MANAGER'], [rf.userId, 'RF']]) {
    const g = await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
      VALUES($1,$2,$3,now()) RETURNING id`, [user, role, branch]);
    if (role === 'REGIONAL_MANAGER') rmGrant = g.rows[0].id;
  }
  for (const [state, start, end] of [
    ['PRE_LAUNCH', '2020-01-01', null], ['PAUSED', '2020-01-01', null],
    ['CLOSED', '2020-01-01', null], ['ACTIVE', '2999-01-01', null],
    ['ACTIVE', '2020-01-01', '2021-01-01'],
  ]) {
    const id = randomUUID(); closed.push(id);
    await pool.query(`INSERT INTO org_directory_units
      (id,code,kind,lifecycle_state,is_demo,effective_from,effective_to)
      VALUES($1,$2,'ORG_UNIT',$3,false,$4,$5)`, [id, `TEST_${closed.length}`, state, start, end]);
    await pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
      VALUES($1,'REGIONAL_MANAGER',$2,now())`, [rm.userId, id]);
  }
});
beforeEach(resetLimits);
afterAll(closePool);

test('CANON-01 all four operational FKs target the directory, pilot data stays A/B', async () => {
  const refs = await pool.query(`SELECT conrelid::regclass::text AS relation FROM pg_constraint
    WHERE contype='f' AND confrelid='pilot_r1.org_directory_units'::regclass
      AND conname IN ('role_grants_org_unit_id_fkey','work_items_org_unit_id_fkey',
        'audit_log_org_unit_id_fkey','outbox_events_org_unit_id_fkey')`);
  expect(refs.rowCount).toBe(4);
  expect((await pool.query('SELECT code FROM org_units ORDER BY code')).rows).toEqual([{ code: 'A' }, { code: 'B' }]);
  expect((await pool.query('SELECT id FROM org_units WHERE id=$1', [branch])).rowCount).toBe(0);
  await expect(pool.query("UPDATE org_units SET display_name='reassigned' WHERE id=$1", [pilotA]))
    .rejects.toMatchObject({ code: '23514' });
});

test('CANON-02 exact directory access and historical names, no hidden parent/sibling', async () => {
  const past = await authed(rm).get('/api/v1/organization/tree?as_of=2025-12-31');
  expect(past.status).toBe(200);
  expect(past.body.items).toHaveLength(1);
  expect(past.body.items[0]).toMatchObject({ id: branch, display_name: 'Synthetic old name', parent_id: null, is_demo: false });
  const now = await authed(rm).get('/api/v1/organization/tree?as_of=2026-01-01');
  expect(now.body.items[0]).toMatchObject({ id: branch, display_name: 'Synthetic current name' });
  for (const id of [sibling, root, pilotA]) {
    expect((await authed(rm).get(`/api/v1/organization/units/${id}/history`)).status).toBe(404);
  }
});

test('CANON-03 non-pilot branch completes task, snapshots, audit, notifications and idempotent replay', async () => {
  const key = idemKey('canonical-replay');
  const made = await create(branch, key);
  expect(made.status).toBe(201);
  const id = made.body.id;
  expect((await create(branch, key)).body.id).toBe(id);
  const assigned = await step(rm, id, 'assign', { expected_entity_version: 1, assignee_user_id: rf.userId });
  expect(assigned.status).toBe(200);
  await drainNotificationsForTests();
  const notifications = await authed(rf).get('/api/v1/notifications');
  expect(notifications.body.items.some((n: any) => n.work_item_id === id)).toBe(true);
  expect((await step(rf, id, 'start', { expected_entity_version: 2 })).status).toBe(200);
  const patched = await authed(rf).patch(`/api/v1/work-items/${id}/fields`)
    .set('Idempotency-Key', idemKey('canonical-patch')).send({
      changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'Synthetic result only' }],
    });
  expect(patched.status).toBe(200);
  const submitted = await step(rf, id, 'submit', { expected_entity_version: patched.body.entity_version });
  expect(submitted.status).toBe(200);
  const accepted = await step(rm, id, 'accept', {
    expected_entity_version: submitted.body.entity_version,
    submission_id: submitted.body.current_submission.id,
    submission_revision: submitted.body.current_submission.revision,
  });
  expect(accepted.status).toBe(200);
  expect(accepted.body.status).toBe('COMPLETED');
  for (const table of ['work_item_fields', 'submissions', 'audit_log']) {
    const rows = await pool.query(`SELECT org_unit_id FROM ${table} WHERE work_item_id=$1`, [id]);
    expect(rows.rowCount).toBeGreaterThan(0);
    expect(rows.rows.every(r => r.org_unit_id === branch)).toBe(true);
  }
  const events = await pool.query('SELECT org_unit_id FROM outbox_events WHERE aggregate_id=$1', [id]);
  expect(events.rows.every(r => r.org_unit_id === branch)).toBe(true);
  const stranger = await login('rm_a');
  expect((await authed(stranger).get(`/api/v1/work-items/${id}`)).status).toBe(404);
  expect((await create(branch, idemKey('no-scope'), stranger)).status).toBe(403);
});

test('CANON-04 a network, division, cluster or new demo cannot be a branch grant', async () => {
  const demo = randomUUID();
  await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,is_demo,effective_from)
    VALUES($1,'UNSUPPORTED_DEMO','ORG_UNIT','ACTIVE',true,'2020-01-01')`, [demo]);
  for (const id of [root, '10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000003', demo]) {
    await expect(pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
      VALUES($1,'RF',$2,now())`, [rf.userId, id])).rejects.toMatchObject({ code: '23514' });
  }
  await expect(pool.query(`INSERT INTO role_grants(user_id,role_code,org_unit_id,valid_from)
    VALUES($1,'RF',$2,now())`, [rf.userId, randomUUID()])).rejects.toMatchObject({ code: '23503' });
});

test.each([0, 1, 2, 3, 4])('CANON-05 closed-to-new-work case %i refuses API and direct SQL with no evidence', async index => {
  const res = await create(closed[index]);
  expect(res.status).toBe(422);
  expect(res.body.details.issues).toEqual([{ path: 'org_unit_id', issue: 'ORG_UNIT_NOT_OPERATIONAL' }]);
  await expect(pool.query(`INSERT INTO work_items(org_unit_id,template_version_id,title,due_at,created_by)
    SELECT $1,id,'Must reject',now()+interval '1 day',$2 FROM templates WHERE code='pilot_task_v1'`,
  [closed[index], rm.userId])).rejects.toMatchObject({ code: '23514' });
  expect((await pool.query('SELECT 1 FROM work_items WHERE org_unit_id=$1', [closed[index]])).rowCount).toBe(0);
});

test('CANON-06 revoke denies historical metadata, while scope cannot be rewritten in place', async () => {
  await expect(pool.query('UPDATE role_grants SET org_unit_id=$2 WHERE id=$1', [rmGrant, sibling]))
    .rejects.toMatchObject({ code: '23514' });
  try {
    await pool.query('UPDATE role_grants SET revoked_at=now() WHERE id=$1', [rmGrant]);
    expect((await authed(rm).get('/api/v1/organization/tree?as_of=2025-12-31')).body.items).toEqual([]);
    expect((await authed(rm).get(`/api/v1/organization/units/${branch}/history`)).status).toBe(404);
    expect((await create(branch)).status).toBe(403);
  } finally {
    await pool.query('UPDATE role_grants SET revoked_at=NULL WHERE id=$1', [rmGrant]);
  }
});
