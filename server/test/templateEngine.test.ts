/*
 * Covers the generalized template/field engine added in migration 007
 * (ТЗ §13.13.1): templates beyond the single hardcoded pilot_task_v1 text
 * field, with type-aware field validation (number/url/date) added in the
 * same phase. Exercises the full HTTP surface (create -> assign -> start
 * -> patch fields -> submit) exactly like lifecycle.test.ts, just against
 * new single-field templates instead of pilot_task_v1, since createWorkItem
 * still only accepts single-field templates this release.
 */
import { pool, closePool } from '../src/db/pool';
import { _resetForTests as resetRateLimits } from '../src/auth/rateLimit';
import { app, login, authed, idemKey } from './helpers';

const ORG_A = '00000000-0000-4000-8000-00000000000a';

const METRIC_TEMPLATE_ID = '00000000-0000-4000-8000-000000000201';
const LINK_TEMPLATE_ID = '00000000-0000-4000-8000-000000000202';
const DATE_TEMPLATE_ID = '00000000-0000-4000-8000-000000000203';
const MULTI_FIELD_TEMPLATE_ID = '00000000-0000-4000-8000-000000000204';

beforeAll(async () => {
  await pool.query(
    `INSERT INTO templates (id, code, version, display_name, is_system, field_schema, field_ownership_rules, field_visibility_rules)
     VALUES
     ($1, 'metric_task_v1', 1, 'KPI-задача (тест)', false,
       '[{"field_path":"kpi_value","label":"Значение KPI","type":"number","required":true,"min_value":0,"max_value":100}]'::jsonb,
       '{"kpi_value":"RF"}'::jsonb, '{}'::jsonb),
     ($2, 'link_task_v1', 1, 'Задача со ссылкой (тест)', false,
       '[{"field_path":"result_link","label":"Ссылка на результат","type":"url","required":true,"max_chars":500}]'::jsonb,
       '{"result_link":"RF"}'::jsonb, '{}'::jsonb),
     ($3, 'date_task_v1', 1, 'Задача с датой (тест)', false,
       '[{"field_path":"next_event_date","label":"Дата следующего события","type":"date","required":true}]'::jsonb,
       '{"next_event_date":"RF"}'::jsonb, '{}'::jsonb),
     ($4, 'multi_field_v1', 1, 'Мультиполевой шаблон (тест)', false,
       '[{"field_path":"field_a","label":"A","type":"text","required":true,"min_chars":1,"max_chars":100},
         {"field_path":"field_b","label":"B","type":"text","required":true,"min_chars":1,"max_chars":100}]'::jsonb,
       '{"field_a":"RF","field_b":"RF"}'::jsonb, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [METRIC_TEMPLATE_ID, LINK_TEMPLATE_ID, DATE_TEMPLATE_ID, MULTI_FIELD_TEMPLATE_ID],
  );
});

afterAll(async () => {
  await closePool();
});

beforeEach(() => {
  resetRateLimits();
});

async function createTask(templateCode: string) {
  const rmA = await login('rm_a');
  const rfA = await login('rf_a');
  const created = await authed(rmA)
    .post('/api/v1/work-items')
    .set('Idempotency-Key', idemKey('create'))
    .send({ org_unit_id: ORG_A, title: 'Тест движка шаблонов', due_at: '2027-01-01T00:00:00Z', template_code: templateCode });
  expect(created.status).toBe(201);
  const wi = created.body;
  const { rows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");
  await authed(rmA).post(`/api/v1/work-items/${wi.id}/assign`).set('Idempotency-Key', idemKey('assign')).send({ expected_entity_version: 1, assignee_user_id: rows[0].id });
  const started = await authed(rfA).post(`/api/v1/work-items/${wi.id}/start`).set('Idempotency-Key', idemKey('start')).send({ expected_entity_version: 2 });
  expect(started.status).toBe(200);
  return { rmA, rfA, wi: started.body };
}

describe('TE-01..TE-03 templates beyond pilot_task_v1 (§13.13.1)', () => {
  test('TE-01 a template with a single number field creates/patches/submits end to end', async () => {
    const { rfA, wi } = await createTask('metric_task_v1');
    const ok = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch'))
      .send({ changes: [{ field_path: 'kpi_value', expected_version: 1, new_value: '42.5' }] });
    expect(ok.status).toBe(200);
    expect(ok.body.fields[0].value).toBe('42.5');
    expect(ok.body.template_code).toBe('metric_task_v1');

    const submitted = await authed(rfA)
      .post(`/api/v1/work-items/${wi.id}/submit`)
      .set('Idempotency-Key', idemKey('submit'))
      .send({ expected_entity_version: 4 });
    expect(submitted.status).toBe(200);
    expect(submitted.body.current_submission.field_values).toEqual({ kpi_value: '42.5' });
  });

  test('TE-02 a non-numeric or out-of-range value for a number field is rejected', async () => {
    const { rfA, wi } = await createTask('metric_task_v1');
    const notANumber = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-nan'))
      .send({ changes: [{ field_path: 'kpi_value', expected_version: 1, new_value: 'not-a-number' }] });
    expect(notANumber.status).toBe(422);

    const outOfRange = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-range'))
      .send({ changes: [{ field_path: 'kpi_value', expected_version: 1, new_value: '150' }] });
    expect(outOfRange.status).toBe(422);
  });

  test('TE-03 a valid http(s) URL is accepted for a url field; a non-URL string is rejected', async () => {
    const { rfA, wi } = await createTask('link_task_v1');
    const badUrl = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-badurl'))
      .send({ changes: [{ field_path: 'result_link', expected_version: 1, new_value: 'not a url' }] });
    expect(badUrl.status).toBe(422);

    const goodUrl = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-goodurl'))
      .send({ changes: [{ field_path: 'result_link', expected_version: 1, new_value: 'https://example.com/report/42' }] });
    expect(goodUrl.status).toBe(200);
    expect(goodUrl.body.fields[0].value).toBe('https://example.com/report/42');
  });

  test('TE-04 a YYYY-MM-DD date is accepted for a date field; an invalid calendar date is rejected', async () => {
    const { rfA, wi } = await createTask('date_task_v1');
    const badDate = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-baddate'))
      .send({ changes: [{ field_path: 'next_event_date', expected_version: 1, new_value: '2026-02-30' }] });
    expect(badDate.status).toBe(422);

    const goodDate = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-gooddate'))
      .send({ changes: [{ field_path: 'next_event_date', expected_version: 1, new_value: '2026-12-01' }] });
    expect(goodDate.status).toBe(200);
    expect(goodDate.body.fields[0].value).toBe('2026-12-01');
  });

  test('TE-05 createWorkItem rejects a multi-field template (submissions storage not built for it yet)', async () => {
    const rmA = await login('rm_a');
    const res = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('create-multi'))
      .send({ org_unit_id: ORG_A, title: 'Тест мультиполя', due_at: '2027-01-01T00:00:00Z', template_code: 'multi_field_v1' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });
});
