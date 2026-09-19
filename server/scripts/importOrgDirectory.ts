import { readFileSync } from 'fs';
import { importOrgDirectory } from '../src/domain/orgDirectoryImport';
import { closePool } from '../src/db/pool';

/** Operator command, never HTTP. Reads a confirmed transfer set from a local
 * file; no business measurements, no credentials and no activation involved. */
const path = process.env.ORG_IMPORT_FILE ?? '';
const approval = process.env.ORG_IMPORT_APPROVAL ?? '';
const dryRun = process.env.ORG_IMPORT_APPLY !== 'yes';

(async () => {
  if (!path) throw new Error('ORG_IMPORT_FILE required');
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  const result = await importOrgDirectory(plan, approval, dryRun);
  console.log(JSON.stringify(result, null, 1));
})()
  .catch(err => { console.error(`Organization directory transfer refused: ${err.message}`); process.exitCode = 1; })
  .finally(closePool);
