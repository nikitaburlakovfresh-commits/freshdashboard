// Synthetic local PG16 only. Проверяется сервисный контур приёма и публикации:
// отдельный субъект, явные полномочия, честный канал происхождения, журнал
// прогонов и невозможность входа сервисной учётной записью в портал.
jest.mock('../src/reporting/scanner',()=>{
  const scanBytes=jest.fn(async(_bytes?:Buffer)=>({scanner:'SYNTHETIC_TEST_SCANNER',result:'CLEAN'}));
  const scanSource=(bytes:Buffer)=>require('../src/config').config.reportScanMode==='off'
    ? Promise.resolve({scanner:'NOT_SCANNED/REPORT_SCAN_MODE=off',result:'NOT_SCANNED'})
    : scanBytes(bytes);
  return {scanBytes,scanSource};
});
import request from 'supertest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { pool,closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionServiceIntakeActor,revokeServiceIntakeActor } from '../src/domain/serviceIntakeProvisioning';
import { runServiceIntake,normalizeBranchName,type RunPlan } from '../src/domain/serviceIntakeRun';
import { app,ORIGIN,TEST_PASSWORD } from './helpers';
import { makeWorkbook,summaryRows } from './reportFixtures';

const root='10000000-0000-4000-8000-000000000004';
const alpha=randomUUID(),beta=randomUUID();
const adminPassword=TEST_PASSWORD+'-SyntheticServiceAdmin2026';
const APPROVAL='SYNTHETIC_LOCAL_SERVICE_APPROVAL_2026';
let dir:string,networkCode:string;
const count=async(table:string)=>(await pool.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
const plan=():RunPlan=>({
  actor_code:'synthetic_intake',
  network_code:networkCode,
  period:{start:'2030-04-01',end:'2030-04-08',planStart:'2030-04-01',planEnd:'2030-04-30',
    confirmation:'Синтетический период согласован только для локального теста',
    basis:'Синтетическое основание сопоставления только для локального теста'},
  mapping_reason:'Синтетическое автосопоставление по точному названию филиала',
  batches:[{files:['synthetic-service.xlsx'],reason:'Синтетическая публикация только для локального теста',
    choices:[
      {metric:'sales',source:'summary',methodology:'Synthetic fixture counts, all rows included, units COUNT.'},
      {metric:'margin',source:'summary',methodology:'Synthetic fixture RUB, negative values preserved, no recalculation.'}]}],
});

beforeAll(async()=>{
  process.env.REPORT_STORAGE_DIR=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-service-intake-'));
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-service-src-'));
  await fs.writeFile(path.join(dir,'synthetic-service.xlsx'),Buffer.from(makeWorkbook(summaryRows())));
  await bootstrapFirstAdministrator({login:'service_test_admin',fullName:'Synthetic service administrator',
    password:adminPassword,reason:'Synthetic isolated service intake test',approvalReference:APPROVAL});
  networkCode=(await pool.query(`SELECT code FROM org_directory_units WHERE id=$1`,[root])).rows[0].code;
  for(const [id,code,name] of [[alpha,'SVC_A_SYNTHETIC','Филиал Альфа (тест)'],[beta,'SVC_B_SYNTHETIC','Филиал Бета (тест)']]) {
    await pool.query(`INSERT INTO org_directory_units(id,code,kind,lifecycle_state,effective_from) VALUES($1,$2,'ORG_UNIT','PRE_LAUNCH','2020-01-01')`,[id,code]);
    await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic local fixture')`,[id,name]);
    await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason) VALUES($1,$2,'2020-01-01','Synthetic local fixture')`,[id,root]);
  }
});
afterAll(closePool);

test('SVC-01 нормализация сопоставляет только точные названия',()=>{
  expect(normalizeBranchName('Филиал Альфа (тест)')).toBe(normalizeBranchName('альфа  ТЕСТ'));
  expect(normalizeBranchName('Альфа')).not.toBe(normalizeBranchName('Альфа 2'));
});

test('SVC-02 провижининг требует живого администратора и выдаёт явные полномочия',async()=>{
  await expect(provisionServiceIntakeActor('synthetic_intake','Synthetic intake actor',
    'Синтетический приём и публикация только для локального теста',['sales','margin'],APPROVAL,'missing_admin')).rejects.toThrow();
  const actor=await provisionServiceIntakeActor('synthetic_intake','Synthetic intake actor',
    'Синтетический приём и публикация только для локального теста',['sales','margin'],APPROVAL,'service_test_admin');
  expect(actor.code).toBe('synthetic_intake');
  expect(await count(`service_intake_authorizations WHERE revoked_at IS NULL`)).toBe(3);
  expect((await pool.query(`SELECT user_kind FROM app_users WHERE id=$1`,[actor.user_id])).rows[0].user_kind).toBe('SERVICE');
});

test('SVC-03 сервисной учётной записью нельзя войти в портал',async()=>{
  for(const password of [adminPassword,TEST_PASSWORD,'service-actor-no-password']) {
    const r=await request(app).post('/api/v1/auth/login').set('Origin',ORIGIN)
      .send({login:'service.synthetic_intake',password});
    expect(r.status).not.toBe(200);
  }
});

test('SVC-04 прогон публикует срез и помечает канал SERVICE_INTAKE',async()=>{
  const r=await runServiceIntake(plan(),dir);
  const first:any=r.results[0];
  expect(first.outcome).toBe('OK');
  expect(await count('report_fact_current')).toBeGreaterThan(0);
  const channels=(await pool.query(`SELECT DISTINCT provenance->>'channel' channel FROM report_fact_snapshots`)).rows;
  expect(channels).toEqual([{channel:'SERVICE_INTAKE'}]);
  const stages=(await pool.query(`SELECT stage,outcome FROM service_intake_runs ORDER BY started_at,stage`)).rows;
  expect(stages.some(s=>s.stage==='COMMIT'&&s.outcome==='OK')).toBe(true);
  expect(stages.every(s=>s.outcome!=='FAILED')).toBe(true);
});

test('SVC-04a сервисная настройка ограничена порогами, баллом и фокусами',async()=>{
  const { authorizeNetworkPermissions }=require('../src/domain/accessChanges');
  const { serviceAuthedUser }=require('../src/domain/serviceActor');
  const { pool:p }=require('../src/db/pool');
  const userId=(await p.query(`SELECT id FROM app_users WHERE login='service.synthetic_intake'`)).rows[0].id;
  const auth=serviceAuthedUser(userId,'synthetic_intake');
  // В боевой базе право роли создаётся миграциями 020/027; локальный прогон их очищает.
  await p.query(`INSERT INTO role_permissions(role_code,permission_code)
    VALUES('SUPER_ADMIN','metric.threshold.manage') ON CONFLICT DO NOTHING`);
  const client=await p.connect();
  try {
    await client.query('BEGIN');
    await expect(authorizeNetworkPermissions(client,auth,['metric.threshold.manage'])).resolves.toBeUndefined();
    await client.query('ROLLBACK');
    await client.query('BEGIN');
    await expect(authorizeNetworkPermissions(client,auth,['user.assign_role'])).rejects.toThrow();
    await client.query('ROLLBACK');
  } finally { client.release(); }
});

test('SVC-05 после отзыва полномочий прогон невозможен',async()=>{
  await revokeServiceIntakeActor('synthetic_intake','Синтетический отзыв полномочий для локального теста');
  const r=await runServiceIntake({...plan(),batches:[{...plan().batches[0]}]},dir).catch(e=>({error:String(e)}));
  expect(JSON.stringify(r)).toMatch(/not found|FAILED|error/i);
  expect(await count(`service_intake_authorizations WHERE revoked_at IS NULL`)).toBe(0);
  expect((await pool.query(`SELECT is_active FROM app_users WHERE login='service.synthetic_intake'`)).rows[0].is_active).toBe(false);
});
