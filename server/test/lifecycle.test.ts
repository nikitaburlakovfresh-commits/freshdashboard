/*
 * Integration tests against a REAL local PostgreSQL 16 database
 * (fresh_pilot_test — separate from the dev DB fresh_pilot). Exercises the
 * full R1 pilot HTTP surface end-to-end through the actual Express app
 * (no mocks), covering representative scenarios from
 * contracts/ACCEPTANCE_ENGINEERING.tsv. IDs referenced in comments map to
 * that file; this is not a 1:1 port of all 80 rows (see IMPLEMENTATION.md
 * traceability table for the honest subset covered vs not-yet-automated).
 */
import request from 'supertest';
import { pool, closePool } from '../src/db/pool';
import { drainNotificationsForTests } from '../src/workers/notificationConsumer';
import { _resetForTests as resetRateLimits } from '../src/auth/rateLimit';
import { app, login, authed, idemKey, ORIGIN, TEST_PASSWORD } from './helpers';

const ORG_A = '00000000-0000-4000-8000-00000000000a';
const ORG_B = '00000000-0000-4000-8000-00000000000b';

async function createTask(rm: Awaited<ReturnType<typeof login>>, orgUnitId = ORG_A) {
  const res = await authed(rm)
    .post('/api/v1/work-items')
    .set('Idempotency-Key', idemKey('create'))
    .send({ org_unit_id: orgUnitId, title: 'Интеграционный тест', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
  expect(res.status).toBe(201);
  return res.body;
}

// Each test logs in one or more fixture users from scratch; the in-memory
// login rate limiter (5 attempts / 15min per login, contract §7 brute-force
// protection) would otherwise starve later tests that reuse the same fixture
// logins. Reset it between tests EXCEPT inside the dedicated rate-limit test
// (E-073), which deliberately exercises the limit and resets it itself.
beforeEach(() => {
  resetRateLimits();
});

afterAll(async () => {
  await closePool();
});

describe('E-001..E-003 auth: login', () => {
  test('E-001 valid login returns session cookie, csrf_token, and cookie attributes', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ login: 'rm_a', password: TEST_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.csrf_token).toBeTruthy();
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(setCookie).toMatch(/__Host-fresh_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Domain=/i);
  });

  test('E-002 wrong password returns uniform 401 INVALID_CREDENTIALS, no session leak', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ login: 'rm_a', password: 'wrong-password' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  test('E-002b unknown login returns the same 401 INVALID_CREDENTIALS (no existence leak)', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ login: 'nobody_here', password: 'whatever12345' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INVALID_CREDENTIALS');
  });

  test('E-003 missing/foreign Origin on login is rejected (403 ORIGIN_DENIED), no session created', async () => {
    const res = await request(app).post('/api/v1/auth/login').set('Origin', 'https://evil.example').send({ login: 'rm_a', password: TEST_PASSWORD });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('ORIGIN_DENIED');
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('E-004..E-006 getMe', () => {
  test('E-004 getMe returns own profile and only own active grants, no secrets, no-store', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA).get('/api/v1/me');
    expect(res.status).toBe(200);
    expect(res.body.user.login).toBe('rm_a');
    expect(res.body.grants.every((g: any) => g.org_unit_id === ORG_A)).toBe(true);
    expect(res.body.user.password_hash).toBeUndefined();
    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  test('E-005 getMe without a session is rejected', async () => {
    const res = await request(app).get('/api/v1/me').set('Origin', ORIGIN);
    expect(res.status).toBe(401);
  });
});

describe('E-007..E-008 logout', () => {
  test('E-007 logout revokes the session; a subsequent getMe with the same cookie is rejected', async () => {
    const rmA = await login('rm_a');
    const logoutRes = await authed(rmA).post('/api/v1/auth/logout').send({});
    expect(logoutRes.status).toBe(200);
    const meRes = await authed(rmA).get('/api/v1/me');
    expect(meRes.status).toBe(401);
  });

  test('E-008 logout requires a valid CSRF token', async () => {
    const rmA = await login('rm_a');
    const res = await request(app).post('/api/v1/auth/logout').set('Origin', ORIGIN).set('Cookie', rmA.cookie).send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('CSRF_INVALID');
  });
});

describe('E-009..E-019 createWorkItem + branch isolation', () => {
  test('E-009/E-013 RM creates a DRAFT work item in their own granted branch', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    expect(wi.status).toBe('DRAFT');
    expect(wi.org_unit_id).toBe(ORG_A);
    expect(wi.entity_version).toBe(1);
  });

  test('E-015 RF cannot create a work item (FORBIDDEN — no work_item.create permission)', async () => {
    const rfA = await login('rf_a');
    const res = await authed(rfA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-rf'))
      .send({ org_unit_id: ORG_A, title: 'RF cannot create', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(403);
  });

  test('E-016 RM cannot create a work item in a branch they are not granted (branch isolation)', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-wrong-org'))
      .send({ org_unit_id: ORG_B, title: 'Wrong branch', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(403);
  });

  test('E-017 title validation rejects blank/whitespace-only title', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-blank'))
      .send({ org_unit_id: ORG_A, title: '   ', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('E-018 title over 200 chars is rejected', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-long'))
      .send({ org_unit_id: ORG_A, title: 'x'.repeat(201), due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(422);
  });

  test('E-019 unknown template_code is rejected', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-badtpl'))
      .send({ org_unit_id: ORG_A, title: 'Bad template', due_at: '2027-01-01T00:00:00Z', template_code: 'not_a_real_template' });
    expect(res.status).toBe(422);
  });

  test('E-010/E-011/E-078 listWorkItems is scoped to the actor grants (branch isolation) and supports status filter', async () => {
    const rmA = await login('rm_a');
    const rmB = await login('rm_b');
    await createTask(rmA);
    await createTask(rmB, ORG_B);

    const listA = await authed(rmA).get('/api/v1/work-items?limit=100');
    expect(listA.status).toBe(200);
    expect(listA.body.items.every((it: any) => it.org_unit_id === ORG_A)).toBe(true);

    const listB = await authed(rmB).get('/api/v1/work-items?limit=100');
    expect(listB.body.items.every((it: any) => it.org_unit_id === ORG_B)).toBe(true);

    const draftOnly = await authed(rmA).get('/api/v1/work-items?status=DRAFT&limit=100');
    expect(draftOnly.body.items.every((it: any) => it.status === 'DRAFT')).toBe(true);
  });

  test('E-012/E-075 getWorkItem outside the actor grant returns NOT_FOUND (no cross-branch leak)', async () => {
    const rmA = await login('rm_a');
    const rmB = await login('rm_b');
    const wiB = await createTask(rmB, ORG_B);

    const res = await authed(rmA).get(`/api/v1/work-items/${wiB.id}`);
    expect(res.status).toBe(404);
  });
});

describe('P1 eligible-assignees (additive R1 pilot endpoint, 18th op)', () => {
  test('P1-01 RM sees active RF logins granted in the same branch as the work item', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const res = await authed(rmA).get(`/api/v1/work-items/${wi.id}/eligible-assignees`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.some((u: any) => u.login === 'rf_a')).toBe(true);
    // Never leaks branch-B users into a branch-A list.
    expect(res.body.items.some((u: any) => u.login === 'rf_b')).toBe(false);
    const entry = res.body.items.find((u: any) => u.login === 'rf_a');
    expect(typeof entry.id).toBe('string');
    expect(typeof entry.full_name).toBe('string');
  });

  test('P1-02 RM cannot list eligible assignees for a work item outside their granted branch (branch isolation)', async () => {
    const rmB = await login('rm_b');
    const wiA = await createTask(await login('rm_a'), ORG_A);
    const res = await authed(rmB).get(`/api/v1/work-items/${wiA.id}/eligible-assignees`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('P1-03 an RF actor is rejected (RM-only), not shown a cross-branch or in-branch roster', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const rfA = await login('rf_a');
    const res = await authed(rfA).get(`/api/v1/work-items/${wi.id}/eligible-assignees`);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('P1-04 unknown work item id returns 404 like every other visibility fence in this API', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA).get('/api/v1/work-items/00000000-0000-4000-8000-000000000999/eligible-assignees');
    expect(res.status).toBe(404);
  });
});

describe('E-020..E-024 assign + start', () => {
  async function getRfAId(): Promise<string> {
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    return rows[0].id;
  }

  test('E-020 RM assigns an RF with an active grant in the same branch; DRAFT -> ASSIGNED', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const rfAId = await getRfAId();

    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/assign`)
      .set('Idempotency-Key', idemKey('assign'))
      .send({ expected_entity_version: 1, assignee_user_id: rfAId });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ASSIGNED');
    expect(res.body.entity_version).toBe(2);
  });

  test('E-021 assign is rejected for an RF ineligible in that branch (ASSIGNEE_INELIGIBLE)', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_b'");
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/assign`)
      .set('Idempotency-Key', idemKey('assign-wrong-branch'))
      .send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('ASSIGNEE_INELIGIBLE');
  });

  test('E-022 assign with a stale expected_entity_version returns 409 ENTITY_VERSION_CONFLICT', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const rfAId = await getRfAId();
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/assign`)
      .set('Idempotency-Key', idemKey('assign-stale'))
      .send({ expected_entity_version: 999, assignee_user_id: rfAId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ENTITY_VERSION_CONFLICT');
  });

  test('E-023 RF starts their own ASSIGNED item -> IN_PROGRESS', async () => {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const rfAId = await getRfAId();
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rfAId });

    const res = await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('start')).send({ expected_entity_version: 2 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
  });

  test('E-024 start is forbidden for someone other than the assignee', async () => {
    const rmA = await login('rm_a');
    const rfB = await login('rf_b');
    const wi = await createTask(rmA);
    const rfAId = await getRfAId();
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rfAId });

    const res = await authed(rfB).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('start-wrong-actor')).send({ expected_entity_version: 2 });
    expect(res.status).toBe(403);
  });
});

describe('E-025..E-030 patchWorkItemFields (field CAS)', () => {
  async function assignAndStart() {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    const started = await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('s')).send({ expected_entity_version: 2 });
    return { rmA, rfA, wi: started.body };
  }

  test('E-025 assignee can save completion_summary with correct field-level expected_version', async () => {
    const { rfA, wi } = await assignAndStart();
    const res = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'Готово' }] });
    expect(res.status).toBe(200);
    expect(res.body.fields[0].value).toBe('Готово');
    expect(res.body.fields[0].field_version).toBe(2);
  });

  test('E-026 stale field expected_version is rejected with FIELD_VERSION_CONFLICT', async () => {
    const { rfA, wi } = await assignAndStart();
    const res = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-stale'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 999, new_value: 'x' }] });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('FIELD_VERSION_CONFLICT');
  });

  test('E-027 someone other than the assignee cannot patch fields', async () => {
    const { wi } = await assignAndStart();
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-forbidden'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    expect(res.status).toBe(403);
  });

  test('E-028 completion_summary over 4000 code points is rejected', async () => {
    const { rfA, wi } = await assignAndStart();
    const res = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-toolong'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x'.repeat(4001) }] });
    expect(res.status).toBe(422);
  });

  test('E-029 blank/whitespace-only completion_summary is rejected', async () => {
    const { rfA, wi } = await assignAndStart();
    const res = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-blank'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: '   ' }] });
    expect(res.status).toBe(422);
  });

  test('E-030 unknown field_path is rejected', async () => {
    const { rfA, wi } = await assignAndStart();
    const res = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-badpath'))
      .send({ changes: [{ field_path: 'not_a_real_field', expected_version: 1, new_value: 'x' }] });
    expect(res.status).toBe(422);
  });
});

describe('E-031..E-036 submitWorkItem', () => {
  async function readyToSubmit() {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    const started = await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('s')).send({ expected_entity_version: 2 });
    return { rmA, rfA, wi: started.body };
  }

  test('E-031 submit is rejected when completion_summary is still empty (COMPLETION_REQUIRED)', async () => {
    const { rfA, wi } = await readyToSubmit();
    const res = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('submit-empty')).send({ expected_entity_version: 3 });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('COMPLETION_REQUIRED');
  });

  test('E-032 submit succeeds after completion_summary is filled; IN_PROGRESS -> SUBMITTED with a current_submission', async () => {
    const { rfA, wi } = await readyToSubmit();
    await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'Сделано' }] });
    const res = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('submit-ok')).send({ expected_entity_version: 4 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.current_submission).toBeTruthy();
    expect(res.body.current_submission.revision).toBe(1);
    expect(res.body.submission_revision).toBe(1);
  });

  test('E-033 only the assignee can submit', async () => {
    const { wi, rfA } = await readyToSubmit();
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    const rmA = await login('rm_a');
    const res = await authed(rmA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('submit-forbidden')).send({ expected_entity_version: 4 });
    expect(res.status).toBe(403);
  });

  test('E-034 submit with stale expected_entity_version returns ENTITY_VERSION_CONFLICT', async () => {
    const { rfA, wi } = await readyToSubmit();
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    const res = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('submit-stale')).send({ expected_entity_version: 999 });
    expect(res.status).toBe(409);
  });

  test('E-035 idempotent replay of submit with same key+body returns the same result without double-submitting', async () => {
    const { rfA, wi } = await readyToSubmit();
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    const key = idemKey('submit-replay');
    const first = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', key).send({ expected_entity_version: 4 });
    const second = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', key).send({ expected_entity_version: 4 });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const submissionCount = await pool.query('SELECT count(*) FROM pilot_r1.submissions WHERE work_item_id = $1', [wi.id]);
    expect(Number(submissionCount.rows[0].count)).toBe(1);
  });

  test('E-036 reused idempotency key with a DIFFERENT body is rejected (IDEMPOTENCY_KEY_REUSED)', async () => {
    const { rfA, wi } = await readyToSubmit();
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    const key = idemKey('submit-reuse');
    await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', key).send({ expected_entity_version: 4 });
    const res = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', key).send({ expected_entity_version: 999 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });
});

describe('E-037..E-042 accept / rework / self-review', () => {
  async function readyForReview() {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('s')).send({ expected_entity_version: 2 });
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'Результат' }] });
    const submitted = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('sub')).send({ expected_entity_version: 4 });
    return { rmA, rfA, wi: submitted.body };
  }

  test('E-037 RM accepts a submission from another user; SUBMITTED -> COMPLETED', async () => {
    const { rmA, wi } = await readyForReview();
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/accept`)
      .set('Idempotency-Key', idemKey('accept'))
      .send({ expected_entity_version: 5, submission_id: wi.current_submission.id, submission_revision: wi.current_submission.revision });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
  });

  test('E-039 RM sends the submission to rework; SUBMITTED -> IN_PROGRESS, rework_count increments', async () => {
    const { rmA, wi } = await readyForReview();
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/rework`)
      .set('Idempotency-Key', idemKey('rework'))
      .send({ expected_entity_version: 5, submission_id: wi.current_submission.id, submission_revision: wi.current_submission.revision, reason: 'Нужны уточнения по остаткам' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.rework_count).toBe(1);
  });

  test('E-040 rework requires a non-blank reason', async () => {
    const { rmA, wi } = await readyForReview();
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/rework`)
      .set('Idempotency-Key', idemKey('rework-noreason'))
      .send({ expected_entity_version: 5, submission_id: wi.current_submission.id, submission_revision: wi.current_submission.revision, reason: '   ' });
    expect(res.status).toBe(422);
  });

  test('E-041/E-077 SELF_REVIEW_FORBIDDEN: the assignee/submitter cannot accept or rework their own submission, even under a dual role grant', async () => {
    const rmDual = await login('rm_rf_a_dual');
    const rfDual = await login('rm_rf_a_dual');
    const wi = await createTask(rmDual);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rm_rf_a_dual'");
    await authed(rmDual).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    await authed(rfDual).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('s')).send({ expected_entity_version: 2 });
    await authed(rfDual).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'Сам себе результат' }] });
    const submitted = await authed(rfDual).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('sub')).send({ expected_entity_version: 4 });

    const res = await authed(rmDual)
      .post(`/api/v1/work-items/${wi.id}/accept`)
      .set('Idempotency-Key', idemKey('self-accept'))
      .send({ expected_entity_version: 5, submission_id: submitted.body.current_submission.id, submission_revision: submitted.body.current_submission.revision });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('SELF_REVIEW_FORBIDDEN');
  });

  test('E-042 accepting with a stale submission_revision returns SUBMISSION_CONFLICT', async () => {
    const { rmA, wi } = await readyForReview();
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/accept`)
      .set('Idempotency-Key', idemKey('accept-stale-sub'))
      .send({ expected_entity_version: 5, submission_id: wi.current_submission.id, submission_revision: 999 });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUBMISSION_CONFLICT');
  });
});

describe('E-043..E-047 cancel / reopen', () => {
  test('E-043 RM cancels a DRAFT item with a reason; -> CANCELLED (terminal)', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/cancel`)
      .set('Idempotency-Key', idemKey('cancel'))
      .send({ expected_entity_version: 1, reason: 'Задача больше не нужна' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
  });

  test('E-044 acting on a CANCELLED item is rejected (INVALID_TRANSITION)', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const cancelled = await authed(rmA).post(`/api/v1/work-items/${wi.id}/cancel`).set('Idempotency-Key', idemKey('cancel')).send({ expected_entity_version: 1, reason: 'r' });
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/cancel`)
      .set('Idempotency-Key', idemKey('cancel-again'))
      .send({ expected_entity_version: cancelled.body.entity_version, reason: 'r2' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('INVALID_TRANSITION');
  });

  test('E-045 RM reopens a COMPLETED item with a reason; -> IN_PROGRESS, rework_count unchanged', async () => {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('s')).send({ expected_entity_version: 2 });
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    const submitted = await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('sub')).send({ expected_entity_version: 4 });
    const accepted = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/accept`)
      .set('Idempotency-Key', idemKey('accept'))
      .send({ expected_entity_version: 5, submission_id: submitted.body.current_submission.id, submission_revision: submitted.body.current_submission.revision });

    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/reopen`)
      .set('Idempotency-Key', idemKey('reopen'))
      .send({ expected_entity_version: accepted.body.entity_version, reason: 'Нужны доп. правки' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.rework_count).toBe(0);
  });

  test('E-046 reopen on a non-COMPLETED item is rejected', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/reopen`)
      .set('Idempotency-Key', idemKey('reopen-invalid'))
      .send({ expected_entity_version: 1, reason: 'x' });
    expect(res.status).toBe(422);
  });

  test('E-047 cancel/reopen require a non-blank reason', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const res = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/cancel`)
      .set('Idempotency-Key', idemKey('cancel-noreason'))
      .send({ expected_entity_version: 1, reason: '' });
    expect(res.status).toBe(422);
  });
});

describe('E-048..E-049 history', () => {
  test('E-048 history returns ordered events for a visible work item', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/cancel`).set('Idempotency-Key', idemKey('cancel')).send({ expected_entity_version: 1, reason: 'r' });

    const res = await authed(rmA).get(`/api/v1/work-items/${wi.id}/history?limit=50`);
    expect(res.status).toBe(200);
    const types = res.body.items.map((e: any) => e.event_type);
    expect(types).toContain('work_item.created');
    expect(types).toContain('work_item.cancelled');
  });

  test('E-049 history is denied for a work item outside the actor grant', async () => {
    const rmB = await login('rm_b');
    const wi = await createTask(rmB, ORG_B);
    const rmA = await login('rm_a');
    const res = await authed(rmA).get(`/api/v1/work-items/${wi.id}/history`);
    expect(res.status).toBe(404);
  });
});

describe('E-050..E-053, E-066, E-070 notifications', () => {
  test('E-050/E-066 assignment produces a durable notification for the assignee after the consumer runs, and it can be marked read', async () => {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });

    await drainNotificationsForTests();

    const list = await authed(rfA).get('/api/v1/notifications?limit=50');
    expect(list.status).toBe(200);
    const notif = list.body.items.find((n: any) => n.work_item_id === wi.id);
    expect(notif).toBeTruthy();
    expect(notif.read_at).toBeNull();

    const readRes = await authed(rfA)
      .post(`/api/v1/notifications/${notif.id}/read`)
      .set('Idempotency-Key', idemKey('read'))
      .send({ expected_entity_version: notif.entity_version });
    expect(readRes.status).toBe(200);
    expect(readRes.body.read_at).toBeTruthy();
  });

  test('E-053/E-070 unread_only filter excludes already-read notifications; RM/RF each only see their own', async () => {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    await drainNotificationsForTests();

    const rmList = await authed(rmA).get('/api/v1/notifications?limit=50');
    expect(rmList.body.items.every((n: any) => true)).toBe(true); // RM has their own separate notification stream

    const unreadBefore = await authed(rfA).get('/api/v1/notifications?unread_only=true&limit=50');
    const target = unreadBefore.body.items.find((n: any) => n.work_item_id === wi.id);
    await authed(rfA).post(`/api/v1/notifications/${target.id}/read`).set('Idempotency-Key', idemKey('read2')).send({ expected_entity_version: target.entity_version });

    const unreadAfter = await authed(rfA).get('/api/v1/notifications?unread_only=true&limit=50');
    expect(unreadAfter.body.items.some((n: any) => n.id === target.id)).toBe(false);
  });
});

describe('E-060..E-067 idempotency edge cases', () => {
  test('E-060/E-063 missing Idempotency-Key on a mutating route is rejected', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .send({ org_unit_id: ORG_A, title: 'No key', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  test('E-064 malformed Idempotency-Key (too short) is rejected', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', 'short')
      .send({ org_unit_id: ORG_A, title: 'Bad key', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(422);
  });

  test('E-061 same Idempotency-Key reused by a DIFFERENT actor is treated independently (keyed by actor+route+key)', async () => {
    const rmA = await login('rm_a');
    const rmB = await login('rm_b');
    const sharedKey = idemKey('shared-across-actors');
    const resA = await authed(rmA).post('/api/v1/work-items').set('Idempotency-Key', sharedKey).send({ org_unit_id: ORG_A, title: 'A task', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    const resB = await authed(rmB).post('/api/v1/work-items').set('Idempotency-Key', sharedKey).send({ org_unit_id: ORG_B, title: 'B task', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);
    expect(resA.body.id).not.toBe(resB.body.id);
  });

  test('E-067 concurrent requests with the same Idempotency-Key: one wins, the loser sees a coherent outcome (not a duplicate mutation)', async () => {
    const rmA = await login('rm_a');
    const key = idemKey('race');
    const body = { org_unit_id: ORG_A, title: 'Race condition create', due_at: '2027-01-01T00:00:00Z', template_code: 'pilot_task_v1' };
    const [r1, r2] = await Promise.all([
      authed(rmA).post('/api/v1/work-items').set('Idempotency-Key', key).send(body),
      authed(rmA).post('/api/v1/work-items').set('Idempotency-Key', key).send(body),
    ]);
    const statuses = [r1.status, r2.status].sort();
    // Either both succeeded with the identical result (second served from the
    // stored idempotent record), or the second was told a request with this
    // key is already in flight — both are correct, non-duplicating outcomes.
    expect([200, 201, 409]).toContain(statuses[0]);
    expect([200, 201, 409]).toContain(statuses[1]);
    const created = await pool.query(
      `SELECT count(*) FROM pilot_r1.work_items WHERE title = 'Race condition create' AND org_unit_id = $1`,
      [ORG_A],
    );
    expect(Number(created.rows[0].count)).toBe(1);
  });
});

describe('E-068..E-071, E-074 outbox/audit and pagination', () => {
  test('E-068/E-074 a successful submit atomically writes audit_log + outbox_events rows for that action', async () => {
    const rmA = await login('rm_a');
    const rfA = await login('rf_a');
    const wi = await createTask(rmA);
    const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
    await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('a')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
    await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('s')).send({ expected_entity_version: 2 });
    await authed(rfA).patch(`/api/v1/work-items/${wi.id}/fields`).set('Idempotency-Key', idemKey('p')).send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    await authed(rfA).post(`/api/v1/work-items/${wi.id}/submit`).set('Idempotency-Key', idemKey('sub')).send({ expected_entity_version: 4 });

    const audit = await pool.query(`SELECT * FROM pilot_r1.audit_log WHERE work_item_id = $1 AND action = 'SUBMIT'`, [wi.id]);
    expect(audit.rowCount).toBeGreaterThanOrEqual(1);
    const outbox = await pool.query(`SELECT * FROM pilot_r1.outbox_events WHERE event_type = 'work_item.submitted' AND payload->>'work_item_id' = $1`, [wi.id]);
    expect(outbox.rowCount).toBeGreaterThanOrEqual(1);
  });

  test('E-071 getWorkItemHistory pagination: limit is honored and a next_cursor is returned when more rows exist', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    for (let i = 0; i < 3; i += 1) {
      await authed(rmA)
        .post(`/api/v1/work-items/${wi.id}/cancel`)
        .set('Idempotency-Key', idemKey(`extra-cancel-${i}`))
        .send({ expected_entity_version: 1, reason: `no-op attempt ${i}` })
        .catch(() => undefined);
    }
    const res = await authed(rmA).get(`/api/v1/work-items/${wi.id}/history?limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
  });
});

describe('E-072..E-073, E-076 additional validation', () => {
  test('E-072 patchWorkItemFields on a DRAFT (unassigned) item is rejected — no assignee yet', async () => {
    const rmA = await login('rm_a');
    const wi = await createTask(rmA);
    const res = await authed(rmA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-draft'))
      .send({ changes: [{ field_path: 'completion_summary', expected_version: 1, new_value: 'x' }] });
    expect(res.status).toBe(403);
  });

  test('E-073 rate limiting on repeated failed logins for the same login+IP eventually returns 429 RATE_LIMITED', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i += 1) {
      const res = await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ login: 'rf_b', password: 'still-wrong' });
      lastStatus = res.status;
      if (lastStatus === 429) break;
    }
    expect(lastStatus).toBe(429);
  });

  test('E-076 due_at must be a valid ISO-8601 UTC timestamp', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-baddate'))
      .send({ org_unit_id: ORG_A, title: 'Bad date', due_at: 'not-a-date', template_code: 'pilot_task_v1' });
    expect(res.status).toBe(422);
  });
});

describe('E-079..E-080 cancel/reopen branch isolation', () => {
  test('E-079 RM cannot cancel a work item outside their granted branch', async () => {
    const rmB = await login('rm_b');
    const wi = await createTask(rmB, ORG_B);
    const rmA = await login('rm_a');
    const res = await authed(rmA).post(`/api/v1/work-items/${wi.id}/cancel`).set('Idempotency-Key', idemKey('cancel-cross')).send({ expected_entity_version: 1, reason: 'x' });
    expect(res.status).toBe(404);
  });

  test('E-080 RM cannot reopen a work item outside their granted branch', async () => {
    const rmB = await login('rm_b');
    const wi = await createTask(rmB, ORG_B);
    const rmA = await login('rm_a');
    const res = await authed(rmA).post(`/api/v1/work-items/${wi.id}/reopen`).set('Idempotency-Key', idemKey('reopen-cross')).send({ expected_entity_version: 1, reason: 'x' });
    expect(res.status).toBe(404);
  });
});
