import fs from 'fs';
import { bootstrapFirstAdministrator } from '../src/domain/firstAdministrator';
import { closePool } from '../src/db/pool';

async function main() {
  // No password in argv/environment/logs. Operator mounts a root-private JSON.
  const file = process.env.BOOTSTRAP_INPUT_FILE;
  if (!file || !file.startsWith('/')) throw new Error('Private input file required');
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 ||
      (info.uid !== 0 && info.uid !== process.getuid?.())) throw new Error('Private file permissions required');
  const result = await bootstrapFirstAdministrator(JSON.parse(fs.readFileSync(file,'utf8')));
  console.log(JSON.stringify({ status:'CREATED', ...result }));
}
main().catch(() => {
  // Deliberately suppress raw DB/error/input details on a credential-bearing path.
  console.error('First administrator bootstrap refused or failed; no credentials logged. Check private operator evidence.');
  process.exitCode=1;
}).finally(closePool);
