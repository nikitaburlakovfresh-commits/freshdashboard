// Read-only candidate verification. Run inside the candidate image against
// the REHEARSAL DB first. No migration, grant, user or publication is created.
const fs=require('node:fs');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..');
async function main(){
  const checks=[];
  const c=new Client();
  await c.connect();
  try{
    await c.query('BEGIN READ ONLY');
    const v=(await c.query("SELECT current_setting('server_version_num')::int v")).rows[0].v;
    if(v<160000||v>=170000)throw Error('POSTGRES_16_REQUIRED');
    const ledger=(await c.query('SELECT version,checksum FROM pilot_r1.schema_migrations ORDER BY version')).rows;
    const dir=path.join(root,'server/migrations');
    const files=fs.readdirSync(dir).filter(f=>/^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
    if(ledger.length!==files.length)throw Error('MIGRATION_COUNT_MISMATCH');
    for(const [i,file] of files.entries()){
      if(ledger[i].version!==file||ledger[i].checksum!==createHash('sha256').update(fs.readFileSync(path.join(dir,file))).digest('hex'))
        throw Error('MIGRATION_CHECKSUM_MISMATCH');
    }
    checks.push('POSTGRES_16','MIGRATIONS_AND_CHECKSUMS');
    await c.query('COMMIT');
  }finally{await c.end();}
  const storage=process.env.REPORT_STORAGE_DIR||'/var/lib/fresh/report-quarantine';
  const stat=fs.lstatSync(storage);
  if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||
      (process.getuid&&stat.uid!==process.getuid()))throw Error('QUARANTINE_OWNER_OR_MODE_INVALID');
  checks.push('PRIVATE_QUARANTINE_OWNER_AND_0700');
  execFileSync(process.execPath,[path.join(root,'ops/av/check-signatures.cjs')],{stdio:'pipe',timeout:15000});
  checks.push('FRESH_AV_SIGNATURES');
  if(!fs.existsSync(path.join(root,'client/dist/index.html')))throw Error('CLIENT_BUNDLE_MISSING');
  checks.push('CLIENT_BUNDLE');
  console.log(JSON.stringify({status:'PASS_READ_ONLY_PREFLIGHT',checks,
    still_required:['real AV smoke','closed-writer backup/restore drill','business users/roles/metric approvals','explicit deployment approval']}));
}
main().catch(e=>{console.error('PREFLIGHT_FAILED',e.code||e.message);process.exitCode=1;});
