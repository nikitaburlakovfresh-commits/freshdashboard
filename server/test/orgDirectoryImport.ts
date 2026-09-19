// Separately executed isolated suite: --testMatch '**/test/orgDirectoryImport.ts'.
// Shares the guarded fresh_pilot_test global setup, never a production restore.
import { randomBytes, randomUUID } from 'crypto';
import { pool, closePool } from '../src/db/pool';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { provisionOrganizationEditor } from '../src/domain/orgEditorProvisioning';
import { importOrgDirectory, ImportPlan } from '../src/domain/orgDirectoryImport';

const password = randomBytes(32).toString('base64url');
const today = new Date().toISOString().slice(0, 10);
const suffix = randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase();
const N = `NET_${suffix}`, D = `DIV_${suffix}`, C = `RM_${suffix}`, B1 = `BR1_${suffix}`, B2 = `BR2_${suffix}`;
const reason = 'Изолированный синтетический тест переноса подтверждённых привязок';
const plan = (units: any[]): ImportPlan => ({ network_code: N, reason, units });
const unit = (code: string, kind: any, parent_code: string, extra: any = {}) =>
  ({ code, kind, display_name: `Синтетическая единица ${code}`, parent_code, ...extra });

beforeAll(async () => {
  await bootstrapFirstAdministrator({
    login: 'org_import_test', fullName: 'Synthetic transfer operator', password,
    reason: 'Isolated approved directory transfer tests', approvalReference: 'SYNTHETIC_IMPORT_TEST_APPROVAL',
  });
  await provisionOrganizationEditor('org_import_test', 'SYNTHETIC_IMPORT_TEST_APPROVAL');
  await pool.query(`INSERT INTO org_directory_units(code,kind,lifecycle_state,effective_from) VALUES($1,'NETWORK','PRE_LAUNCH',$2)`, [N, today]);
  const root = (await pool.query('SELECT id FROM org_directory_units WHERE code=$1', [N])).rows[0].id;
  await pool.query(`INSERT INTO org_directory_name_history(org_unit_id,display_name,effective_from,change_reason) VALUES($1,$2,$3,$4)`, [root, N, today, reason]);
  await pool.query(`INSERT INTO org_directory_affiliation_history(org_unit_id,parent_id,effective_from,change_reason) VALUES($1,NULL,$2,$3)`, [root, today, reason]);
});
afterAll(closePool);

test('IMPORT-01 refuses a set without explicit approval, reason or units', async () => {
  await expect(importOrgDirectory(plan([unit(D, 'DIVISION', N)]), 'short', false)).rejects.toThrow();
  await expect(importOrgDirectory({ ...plan([unit(D, 'DIVISION', N)]), reason: 'мало' }, 'SYNTHETIC_IMPORT_APPROVAL', false)).rejects.toThrow();
  await expect(importOrgDirectory(plan([]), 'SYNTHETIC_IMPORT_APPROVAL', false)).rejects.toThrow();
  await expect(importOrgDirectory({ ...plan([unit(D, 'DIVISION', N)]), network_code: `ABSENT_${suffix}` }, 'SYNTHETIC_IMPORT_APPROVAL', false)).rejects.toThrow();
  await expect(importOrgDirectory(plan([unit(D, 'NETWORK' as any, N)]), 'SYNTHETIC_IMPORT_APPROVAL', false)).rejects.toThrow();
  expect((await pool.query('SELECT count(*)::int n FROM org_directory_units WHERE code=$1', [D])).rows[0].n).toBe(0);
});

test('IMPORT-02 dry run validates the whole set without creating a unit', async () => {
  const result = await importOrgDirectory(plan([
    unit(B1, 'ORG_UNIT', C, { business_model: 'FRANCHISE' }), unit(C, 'CLUSTER', D), unit(D, 'DIVISION', N),
  ]), 'SYNTHETIC_IMPORT_APPROVAL', true);
  expect(result.mode).toBe('DRY_RUN');
  expect(result.effective_from).toBe(today);
  // Children are ordered after their parent, yet nothing is written in a dry run,
  // so a child whose parent is only planned is reported instead of invented.
  expect(result.outcomes.map(o => o.code)).toEqual([D, C, B1]);
  expect(result.created).toBe(1);
  expect(result.rejected).toBe(2);
  expect((await pool.query('SELECT count(*)::int n FROM org_directory_units WHERE code=ANY($1)', [[D, C, B1]])).rows[0].n).toBe(0);
});

test('IMPORT-03 applies hierarchy through draft, preview and apply; history and lifecycle stay correct', async () => {
  const result = await importOrgDirectory(plan([
    unit(B2, 'ORG_UNIT', C, { business_model: 'FRANCHISE' }), unit(B1, 'ORG_UNIT', C, { business_model: 'FRANCHISE' }),
    unit(C, 'CLUSTER', D), unit(D, 'DIVISION', N),
  ]), 'SYNTHETIC_IMPORT_APPROVAL', false);
  expect(result.mode).toBe('APPLIED');
  expect([result.created, result.rejected, result.already_present]).toEqual([4, 0, 0]);
  const rows = (await pool.query(`SELECT u.code,u.kind,u.lifecycle_state,n.display_name,n.effective_from name_from,
    p.code parent_code,a.business_model FROM org_directory_units u
    JOIN org_directory_name_history n ON n.org_unit_id=u.id
    JOIN org_directory_affiliation_history a ON a.org_unit_id=u.id
    LEFT JOIN org_directory_units p ON p.id=a.parent_id
    WHERE u.code=ANY($1) ORDER BY u.code`, [[B1, B2, C, D]])).rows;
  expect(rows.map(r => [r.code, r.kind, r.parent_code, r.lifecycle_state])).toEqual([
    [B1, 'ORG_UNIT', C, 'PRE_LAUNCH'], [B2, 'ORG_UNIT', C, 'PRE_LAUNCH'],
    [D, 'DIVISION', N, 'PRE_LAUNCH'], [C, 'CLUSTER', D, 'PRE_LAUNCH'],
  ]);
  expect(rows.every(r => r.name_from.toISOString().slice(0, 10) === today)).toBe(true);
  expect(rows.filter(r => r.kind === 'ORG_UNIT').every(r => r.business_model === 'FRANCHISE')).toBe(true);
  // Transfer creates no account, assignment, task or measurement.
  expect((await pool.query('SELECT count(*)::int n FROM org_branch_activations')).rows[0].n).toBe(0);
  const audits = (await pool.query(`SELECT count(*)::int n FROM audit_log
    WHERE aggregate_type='org_change' AND reason LIKE '%Оператор: SYNTHETIC_IMPORT_APPROVAL%'`)).rows[0].n;
  expect(audits).toBeGreaterThanOrEqual(12);
});

test('IMPORT-04 replay is idempotent and never rewrites an existing unit', async () => {
  const before = (await pool.query('SELECT id,code FROM org_directory_units WHERE code=ANY($1) ORDER BY code', [[B1, B2, C, D]])).rows;
  const result = await importOrgDirectory(plan([
    unit(D, 'DIVISION', N), unit(C, 'CLUSTER', D),
    { ...unit(B1, 'ORG_UNIT', C), display_name: 'Попытка переименования при повторе' },
  ]), 'SYNTHETIC_IMPORT_APPROVAL', false);
  expect([result.created, result.already_present]).toEqual([0, 3]);
  expect((await pool.query('SELECT id,code FROM org_directory_units WHERE code=ANY($1) ORDER BY code', [[B1, B2, C, D]])).rows).toEqual(before);
  expect((await pool.query('SELECT count(*)::int n FROM org_directory_name_history WHERE display_name=$1', ['Попытка переименования при повторе'])).rows[0].n).toBe(0);
});

test('IMPORT-05 rename and activation run through the same stages; activation needs its own permission', async () => {
  const { provisionBranchActivation } = await import('../src/domain/branchActivationProvisioning');
  const renameOnly = { network_code: N, reason, units: [], renames: [{ code: C, display_name: 'Зона РМ Синтетическая переименованная' }] };
  expect((await importOrgDirectory(renameOnly as any, 'SYNTHETIC_IMPORT_APPROVAL', false)).renamed).toBe(1);
  expect((await importOrgDirectory(renameOnly as any, 'SYNTHETIC_IMPORT_APPROVAL', false)).outcomes[0].status).toBe('UNCHANGED');
  // Activation is refused while the separate permission is absent.
  const activate = { network_code: N, reason, units: [], activations: [{ code: B1, reason: 'Синтетический явный запуск филиала' }] };
  await expect(importOrgDirectory(activate as any, 'SYNTHETIC_IMPORT_APPROVAL', false)).rejects.toThrow();
  expect((await provisionBranchActivation('org_import_test', 'SYNTHETIC_IMPORT_TEST_APPROVAL')).status).toBe('PROVISIONED');
  expect((await provisionBranchActivation('org_import_test', 'SYNTHETIC_IMPORT_TEST_APPROVAL')).status).toBe('ALREADY_PROVISIONED');
  const done = await importOrgDirectory(activate as any, 'SYNTHETIC_IMPORT_APPROVAL', false);
  expect([done.activated, done.rejected]).toEqual([1, 0]);
  expect((await importOrgDirectory(activate as any, 'SYNTHETIC_IMPORT_APPROVAL', false)).outcomes[0].status).toBe('ALREADY_ACTIVE');
  const st = (await pool.query(`SELECT org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date) s FROM org_directory_units WHERE code=$1`, [B1])).rows[0].s;
  expect(st).toBe('ACTIVE');
  // A short activation reason is refused without touching the branch.
  const bad = await importOrgDirectory({ network_code: N, reason, units: [], activations: [{ code: B2, reason: 'коротко' }] } as any, 'SYNTHETIC_IMPORT_APPROVAL', false);
  expect(bad.rejected).toBe(1);
  expect((await pool.query(`SELECT org_lifecycle_at(id,(now() AT TIME ZONE 'UTC')::date) s FROM org_directory_units WHERE code=$1`, [B2])).rows[0].s).toBe('PRE_LAUNCH');
});
