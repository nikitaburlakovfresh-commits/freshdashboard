/*
 * Covers the generalized template/field engine added in migration 007
 * (ТЗ §13.13.1): templates beyond the single hardcoded pilot_task_v1 text
 * field, with type-aware field validation (number/url/date) added in the
 * same phase. Exercises the full HTTP surface (create -> assign -> start
 * -> patch fields -> submit) exactly like lifecycle.test.ts, just against
 * new single-field templates instead of pilot_task_v1. Also covers the
 * multi-field / select / repeatable_group extensions added for the real
 * per-role daily-log catalog: createWorkItem no longer rejects multi-field
 * templates, since submitWorkItem already locked and validated every field
 * row together before this change -- only the artificial single-field gate
 * in createWorkItem was removed.
 */
import { pool, closePool } from '../src/db/pool';
import { _resetForTests as resetRateLimits } from '../src/auth/rateLimit';
import { app, login, authed, idemKey } from './helpers';

const ORG_A = '00000000-0000-4000-8000-00000000000a';

const METRIC_TEMPLATE_ID = '00000000-0000-4000-8000-000000000201';
const LINK_TEMPLATE_ID = '00000000-0000-4000-8000-000000000202';
const DATE_TEMPLATE_ID = '00000000-0000-4000-8000-000000000203';
const MULTI_FIELD_TEMPLATE_ID = '00000000-0000-4000-8000-000000000204';
const SELECT_TEMPLATE_ID = '00000000-0000-4000-8000-000000000205';
const GROUP_TEMPLATE_ID = '00000000-0000-4000-8000-000000000206';
const ROP_TEMPLATE_ID = '00000000-0000-4000-8000-000000000207';

beforeAll(async () => {
  // TE-09 fixture: a template owned by ROP (not RF), plus a dedicated
  // rop_a user holding ONLY the ROP grant in org A -- proves the
  // 2026-09-18 authorization generalization actually works end to end for
  // a role other than RF, not just that RF still works.
  const rfARow = await pool.query("SELECT password_hash FROM app_users WHERE login = 'rf_a'");
  await pool.query(
    `INSERT INTO app_users (login, full_name, password_hash, password_hash_updated_at)
     VALUES ('rop_a', 'Тестовый РОП A', $1, now())
     ON CONFLICT (login) DO NOTHING`,
    [rfARow.rows[0].password_hash],
  );
  const ropUser = await pool.query("SELECT id FROM app_users WHERE login = 'rop_a'");
  await pool.query(
    `INSERT INTO role_grants (user_id, role_code, org_unit_id, valid_from)
     SELECT $1, 'ROP', '00000000-0000-4000-8000-00000000000a', now()
     WHERE NOT EXISTS (
       SELECT 1 FROM role_grants WHERE user_id = $1 AND role_code = 'ROP' AND org_unit_id = '00000000-0000-4000-8000-00000000000a' AND revoked_at IS NULL
     )`,
    [ropUser.rows[0].id],
  );
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
       '{"field_a":"RF","field_b":"RF"}'::jsonb, '{}'::jsonb),
     ($5, 'select_task_v1', 1, 'Задача с выбором (тест)', false,
       '[{"field_path":"call_outcome","label":"Результат звонка","type":"select","required":true,"options":["Дозвон","Отказ","Перенос","Выдача"]}]'::jsonb,
       '{"call_outcome":"RF"}'::jsonb, '{}'::jsonb),
     ($6, 'group_task_v1', 1, 'Задача со списком ТС (тест)', false,
       '[{"field_path":"vehicles","label":"Решения по ТС","type":"repeatable_group","required":true,"min_items":2,"max_items":10,
          "child_fields":[
            {"field_path":"crm_link","label":"Ссылка на ТС в CRM","type":"url","required":true,"max_chars":500},
            {"field_path":"comment","label":"Решение по ТС","type":"text","required":true,"min_chars":1,"max_chars":1000}
          ]}]'::jsonb,
       '{"vehicles":"RF"}'::jsonb, '{}'::jsonb),
     ($7, 'rop_task_v1', 1, 'Задача РОП (тест)', false,
       '[{"field_path":"rop_result","label":"Результат РОП","type":"text","required":true,"min_chars":1,"max_chars":500}]'::jsonb,
       '{"rop_result":"ROP"}'::jsonb, '{}'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [METRIC_TEMPLATE_ID, LINK_TEMPLATE_ID, DATE_TEMPLATE_ID, MULTI_FIELD_TEMPLATE_ID, SELECT_TEMPLATE_ID, GROUP_TEMPLATE_ID, ROP_TEMPLATE_ID],
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

  test('TE-05 a multi-field template creates/patches/submits end to end with every field required', async () => {
    const { rfA, wi } = await createTask('multi_field_v1');

    const missingSecond = await authed(rfA)
      .post(`/api/v1/work-items/${wi.id}/submit`)
      .set('Idempotency-Key', idemKey('submit-multi-early'))
      .send({ expected_entity_version: 3 });
    expect(missingSecond.status).toBe(422);
    expect(missingSecond.body.code).toBe('COMPLETION_REQUIRED');

    const patchA = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-a'))
      .send({ changes: [{ field_path: 'field_a', expected_version: 1, new_value: 'Значение A' }] });
    expect(patchA.status).toBe(200);

    const patchB = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-b'))
      .send({ changes: [{ field_path: 'field_b', expected_version: 1, new_value: 'Значение B' }] });
    expect(patchB.status).toBe(200);

    const submitted = await authed(rfA)
      .post(`/api/v1/work-items/${wi.id}/submit`)
      .set('Idempotency-Key', idemKey('submit-multi'))
      .send({ expected_entity_version: 5 });
    expect(submitted.status).toBe(200);
    expect(submitted.body.current_submission.field_values).toEqual({ field_a: 'Значение A', field_b: 'Значение B' });
  });

  test('TE-06 a select field only accepts one of its declared options', async () => {
    const { rfA, wi } = await createTask('select_task_v1');
    const badOption = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-badselect'))
      .send({ changes: [{ field_path: 'call_outcome', expected_version: 1, new_value: 'Неизвестный вариант' }] });
    expect(badOption.status).toBe(422);

    const goodOption = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-goodselect'))
      .send({ changes: [{ field_path: 'call_outcome', expected_version: 1, new_value: 'Дозвон' }] });
    expect(goodOption.status).toBe(200);
    expect(goodOption.body.fields[0].value).toBe('Дозвон');
  });

  test('TE-07 a repeatable_group field validates min_items and each item against child_fields', async () => {
    const { rfA, wi } = await createTask('group_task_v1');

    const tooFew = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-toofew'))
      .send({
        changes: [{
          field_path: 'vehicles',
          expected_version: 1,
          new_value: JSON.stringify([{ crm_link: 'https://crm.freshauto.ru/1', comment: 'Переоценка' }]),
        }],
      });
    expect(tooFew.status).toBe(422);

    const missingRequiredChild = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-missingchild'))
      .send({
        changes: [{
          field_path: 'vehicles',
          expected_version: 1,
          new_value: JSON.stringify([
            { comment: 'Нет ссылки' },
            { crm_link: 'https://crm.freshauto.ru/2', comment: 'Вывод в рекламу' },
          ]),
        }],
      });
    expect(missingRequiredChild.status).toBe(422);

    const ok = await authed(rfA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('patch-groupok'))
      .send({
        changes: [{
          field_path: 'vehicles',
          expected_version: 1,
          new_value: JSON.stringify([
            { crm_link: 'https://crm.freshauto.ru/1', comment: 'Переоценка' },
            { crm_link: 'https://crm.freshauto.ru/2', comment: 'Вывод в рекламу' },
          ]),
        }],
      });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body.fields[0].value)).toEqual([
      { crm_link: 'https://crm.freshauto.ru/1', comment: 'Переоценка' },
      { crm_link: 'https://crm.freshauto.ru/2', comment: 'Вывод в рекламу' },
    ]);

    const submitted = await authed(rfA)
      .post(`/api/v1/work-items/${wi.id}/submit`)
      .set('Idempotency-Key', idemKey('submit-group'))
      .send({ expected_entity_version: 4 });
     expect(submitted.status).toBe(200);
  });

  test('TE-08 migration 008 RF daily-log templates (Task 1/3/4/5/6) load with the captured field shape', async () => {
    const expected: Record<string, { fieldCount: number; allOwnedByRf: boolean }> = {
      rf_planning_meeting_v1: { fieldCount: 6, allOwnedByRf: true },
      rf_share_45plus_analysis_v1: { fieldCount: 5, allOwnedByRf: true },
      rf_traffic_analysis_v1: { fieldCount: 6, allOwnedByRf: true },
      rf_warehouse_analysis_v1: { fieldCount: 22, allOwnedByRf: true },
      rf_kso_analysis_v1: { fieldCount: 9, allOwnedByRf: true },
    };

    const { rows } = await pool.query(
      `SELECT code, field_schema, field_ownership_rules, field_visibility_rules, is_system
       FROM templates WHERE code = ANY($1)`,
      [Object.keys(expected)],
    );
    expect(rows).toHaveLength(5);

    for (const row of rows) {
      const want = expected[row.code];
      expect(row.field_schema).toHaveLength(want.fieldCount);
      expect(row.is_system).toBe(false);
      // Every captured field is RF-owned per the source screenshots; no
      // field on these five templates is attributed to any other role.
      const ownerValues = Object.values(row.field_ownership_rules as Record<string, string>);
      expect(ownerValues.every(v => v === 'RF')).toBe(want.allOwnedByRf);
      expect(Object.keys(row.field_ownership_rules)).toHaveLength(want.fieldCount);
      // field_visibility_rules is intentionally empty: not read by any
      // server code yet (see migration 008 header), so no extra-role
      // visibility should be silently implied by this data.
      expect(row.field_visibility_rules).toEqual({});
    }
  });

  test('TE-09 a template owned by ROP (not RF) authorizes rop_a end to end; rf_a is ineligible for it', async () => {
    const rmA = await login('rm_a');
    const ropA = await login('rop_a');
    const { rows: ropRows } = await pool.query("SELECT id FROM app_users WHERE login = 'rop_a'");
    const { rows: rfRows } = await pool.query("SELECT id FROM app_users WHERE login = 'rf_a'");

    const created = await authed(rmA)
      .post('/api/v1/work-items')
      .set('Idempotency-Key', idemKey('rop-create'))
      .send({ org_unit_id: ORG_A, title: 'Задача РОП', due_at: '2027-01-01T00:00:00Z', template_code: 'rop_task_v1' });
    expect(created.status).toBe(201);
    const wi = created.body;

    // eligible-assignees for a ROP-owned template must list rop_a, not rf_a.
    const eligible = await authed(rmA).get(`/api/v1/work-items/${wi.id}/eligible-assignees`);
    expect(eligible.status).toBe(200);
    const eligibleIds = eligible.body.items.map((u: { id: string }) => u.id);
    expect(eligibleIds).toContain(ropRows[0].id);
    expect(eligibleIds).not.toContain(rfRows[0].id);

    // Assigning the RF-only user to a ROP-owned template is ineligible.
    const badAssign = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/assign`)
      .set('Idempotency-Key', idemKey('rop-assign-wrong'))
      .send({ expected_entity_version: 1, assignee_user_id: rfRows[0].id });
    expect(badAssign.status).toBe(422);
    expect(badAssign.body.code).toBe('ASSIGNEE_INELIGIBLE');

    // Assigning the ROP-grant holder succeeds, and they can start/patch/submit.
    const assign = await authed(rmA)
      .post(`/api/v1/work-items/${wi.id}/assign`)
      .set('Idempotency-Key', idemKey('rop-assign'))
      .send({ expected_entity_version: 1, assignee_user_id: ropRows[0].id });
    expect(assign.status).toBe(200);

    const started = await authed(ropA)
      .post(`/api/v1/work-items/${wi.id}/start`)
      .set('Idempotency-Key', idemKey('rop-start'))
      .send({ expected_entity_version: 2 });
    expect(started.status).toBe(200);

    const patched = await authed(ropA)
      .patch(`/api/v1/work-items/${wi.id}/fields`)
      .set('Idempotency-Key', idemKey('rop-patch'))
      .send({ changes: [{ field_path: 'rop_result', expected_version: 1, new_value: 'Готово' }] });
    expect(patched.status).toBe(200);
    expect(patched.body.fields[0].value).toBe('Готово');

    const submitted = await authed(ropA)
      .post(`/api/v1/work-items/${wi.id}/submit`)
      .set('Idempotency-Key', idemKey('rop-submit'))
      .send({ expected_entity_version: 4 });
    expect(submitted.status).toBe(200);
    expect(submitted.body.current_submission.field_values).toEqual({ rop_result: 'Готово' });

    // Audit trail records the actual role that acted, not a hardcoded 'RF'.
    const audit = await pool.query(
      `SELECT action, actor_role FROM audit_log WHERE aggregate_id = $1 AND action IN ('START','FIELDS_PATCH','SUBMIT') ORDER BY occurred_at`,
      [wi.id],
    );
    expect(audit.rows.every((r) => r.actor_role === 'ROP')).toBe(true);
  });
});
