/** BETA-01. Ограниченный первый выпуск без антивирусного контура.
 * Запрет обеспечивает сервер, а не скрытие кнопок в интерфейсе, и он не
 * подменяет права, scope, CSRF и проверку Origin. Чтение ранее опубликованных
 * значений, задачи и ежедневники ограничением не затрагиваются. */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomBytes } from 'crypto';
import { closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { provisionReportStaging } from '../src/reporting/provisioning';
import { login, authed, type Session } from './helpers';
import { config } from '../src/config';

const BATCH = '11111111-1111-4111-8111-111111111111';
const password = randomBytes(32).toString('base64url');
let admin: Session, rm: Session;

beforeAll(async () => {
  process.env.REPORT_STORAGE_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'fresh-beta-gate-'));
  await bootstrapFirstAdministrator({
    login: 'beta_gate_test',
    fullName: 'Synthetic beta gate administrator',
    password,
    reason: 'Isolated synthetic beta release gate test',
    approvalReference: 'SYNTHETIC_LOCAL_TEST_ONLY',
  });
  await provisionOrganizationEditor('beta_gate_test', 'SYNTHETIC_LOCAL_EDITOR_APPROVAL');
  await provisionReportStaging('beta_gate_test', 'SYNTHETIC_LOCAL_STAGING_APPROVAL');
  admin = await login('beta_gate_test', password);
  rm = await login('rm_a');
});
afterAll(async () => {
  await closePool();
});
afterEach(() => {
  config.reportIntakeEnabled = true;
});

test('disabled release refuses report intake writes for an authorized administrator', async () => {
  config.reportIntakeEnabled = false;
  for (const url of [
    '/api/v1/report-batches',
    `/api/v1/report-batches/${BATCH}/probe`,
    `/api/v1/report-batches/${BATCH}/review`,
  ]) {
    const res = await authed(admin).post(url).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('TEMPORARILY_UNAVAILABLE');
    expect(res.body.message).toContain('отключены в этом выпуске');
  }
});

test('disabled release refuses scanning, preview and publication', async () => {
  config.reportIntakeEnabled = false;
  for (const step of ['scan', 'preview', 'publish']) {
    const res = await authed(rm).post(`/api/v1/report-facts/${BATCH}/${step}`).send({});
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('TEMPORARILY_UNAVAILABLE');
  }
});

test('release stop never replaces authentication, CSRF or origin checks', async () => {
  config.reportIntakeEnabled = false;
  const anon = await authed({ cookie: 'fresh_session=invalid', csrf: 'x' } as Session)
    .post(`/api/v1/report-facts/${BATCH}/publish`)
    .send({});
  expect(anon.status).toBe(401);
  const foreign = await authed(rm)
    .post(`/api/v1/report-facts/${BATCH}/publish`)
    .set('Origin', 'https://attacker.example')
    .send({});
  expect(foreign.status).toBe(403);
});

test('reading published facts is unaffected by the release stop', async () => {
  const url = '/api/v1/report-facts?start=2026-09-01&end=2026-09-30';
  const enabled = await authed(rm).get(url);
  config.reportIntakeEnabled = false;
  const disabled = await authed(rm).get(url);
  expect(disabled.status).toBe(enabled.status);
  expect(disabled.status).not.toBe(503);
});

test('the session reports the release state honestly in both directions', async () => {
  const on = await authed(rm).get('/api/v1/me');
  expect(on.status).toBe(200);
  expect(on.body.features.report_intake).toBe(true);
  config.reportIntakeEnabled = false;
  const off = await authed(rm).get('/api/v1/me');
  expect(off.body.features.report_intake).toBe(false);
});
