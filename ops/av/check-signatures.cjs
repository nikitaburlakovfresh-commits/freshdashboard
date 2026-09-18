// Readiness probe only: it does NOT issue a CLEAN scan receipt.
const { execFileSync } = require('node:child_process');
try {
  const version = execFileSync('/usr/bin/clamscan', ['--version'], {
    encoding: 'utf8', timeout: 10000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
  }).trim();
  const date = Date.parse(version.split('/').slice(2).join('/'));
  if (!/^ClamAV [\w.+-]+\/\d+\//.test(version) || !Number.isFinite(date) ||
      Date.now() - date > 48 * 3600000 || date > Date.now() + 3600000) throw Error();
  console.log(JSON.stringify({ status: 'SIGNATURES_FRESH', scanner: version }));
} catch {
  console.error('AV_NOT_READY: missing scanner, missing/invalid signatures or signatures older than 48h');
  process.exitCode = 1;
}
