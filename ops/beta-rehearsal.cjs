// Local metadata/synthetic rehearsal ONLY. Never connects to production.
// Production schema-only SQL may be supplied by the operator; NO business rows.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {execFileSync}=require('node:child_process');
const {Client}=require('pg');
const root=path.resolve(__dirname,'..');
const old=path.resolve(process.argv[2]||'');
const schema=path.resolve(process.argv[3]||'');
const names=['fresh_beta_legacy','fresh_beta_upgrade','fresh_beta_restore'];
if(process.env.NODE_ENV!=='test'||process.env.PGHOST!=='127.0.0.1'||process.env.PGPORT!=='5433'||
   !old.endsWith('/fresh-beta-old')||!fs.existsSync(schema))throw Error('Explicit local rehearsal paths/environment required');
const pg='/usr/lib/postgresql/16/bin/';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'fresh-beta-rehearsal-'));
fs.chmodSync(tmp,0o700);
const env=db=>({...process.env,PGDATABASE:db,SCHEMA_FILE:path.join(old,'contracts/schema.sql'),
  SEED_FIXTURE_PASSWORD:'Synthetic#RehearsalOnly2026',CLIENT_DIST:''});
const run=(file,args,db,extra={})=>execFileSync(file,args,{env:env(db),cwd:root,stdio:'pipe',...extra});
async function connect(db){const c=new Client({connectionString:undefined,database:db});await c.connect();return c;}
async function snapshot(db){
  const c=await connect(db);
  try{
    const tables=(await c.query("SELECT tablename FROM pg_tables WHERE schemaname='pilot_r1' ORDER BY tablename")).rows;
    const result={};
    for(const {tablename:t} of tables){
      assert(/^[a-z_]+$/.test(t));
      result[t]=(await c.query(`SELECT to_jsonb(t) row FROM pilot_r1."${t}" t`)).rows.map(x=>x.row);
    }return result;
  }finally{await c.end();}
}
const canonical=x=>Array.isArray(x)?x.map(canonical):x&&typeof x==='object'
  ?Object.fromEntries(Object.keys(x).sort().map(k=>[k,canonical(x[k])])):x;
const stable=x=>JSON.stringify(canonical(x));
function preserved(before,after){
  for(const [table,rows] of Object.entries(before)){
    if(table==='schema_migrations')continue;
    const oldKeys=rows.length?Object.keys(rows[0]):[];
    const current=new Set(after[table].map(r=>stable(Object.fromEntries(oldKeys.map(k=>[k,r[k]])))));
    for(const r of rows)assert(current.has(stable(r)),`Existing row changed: ${table}`);
    if(!['permissions','event_catalog','templates'].includes(table))
      assert.equal(after[table].length,rows.length,`Unexpected new rows: ${table}`);
  }
}
async function main(){
  const started=Date.now(),admin=new Client({database:'postgres',user:process.env.PGADMINUSER||'postgres'});
  await admin.connect();
  try{
    const v=(await admin.query("SELECT current_setting('server_version_num')::int v")).rows[0].v;
    assert(v>=160000&&v<170000);
    for(const name of names){
      assert.equal((await admin.query('SELECT 1 FROM pg_database WHERE datname=$1',[name])).rowCount,0,
        'Refusing to replace any existing rehearsal DB');
      assert.equal(process.env.PGUSER,'fresh_app');
      await admin.query(`CREATE DATABASE "${name}" OWNER fresh_app`);
    }
  }finally{await admin.end();}
  run(process.execPath,[path.join(old,'server/dist/scripts/migrate.js')],names[0]);
  run(process.execPath,[path.join(old,'server/dist/scripts/seed.js')],names[0]);
  // Small synthetic task/evidence; no real identities or business records.
  const fixture=await connect(names[0]);
  try{
    await fixture.query("SET search_path=pilot_r1,public,pg_catalog");
    const u=(await fixture.query("SELECT id FROM app_users WHERE login='rm_a'")).rows[0];
    assert(u);
    await fixture.query("UPDATE app_users SET full_name='Synthetic backup invariant' WHERE id=$1",[u.id]);
  }finally{await fixture.end();}
  // Restore actual production schema metadata and ONLY synthetic rows from old release.
  run(pg+'psql',['-v','ON_ERROR_STOP=1','-c','CREATE EXTENSION IF NOT EXISTS pgcrypto; CREATE EXTENSION IF NOT EXISTS btree_gist;'],names[1]);
  run(pg+'psql',['-v','ON_ERROR_STOP=1','-f',schema],names[1]);
  const data=run(pg+'pg_dump',['--data-only','--schema=pilot_r1','--no-owner','--no-privileges'],names[0]);
  run(pg+'psql',['-v','ON_ERROR_STOP=1'],names[1],{input:data});
  const before=await snapshot(names[1]);
  const dump=path.join(tmp,'synthetic-before.dump');
  run(pg+'pg_dump',['-Fc','--no-owner','-f',dump],names[1]);
  const migrate=run(process.execPath,[path.join(root,'server/dist/scripts/migrate.js')],names[1]).toString();
  assert(migrate.includes('011_access_changes.sql')&&migrate.includes('018_fact_access_admin.sql'));
  const after=await snapshot(names[1]);preserved(before,after);
  assert.equal(after.schema_migrations.length,18);
  assert.equal(after.report_fact_access.length,0);
  assert.equal(after.fact_access_receipts.length,0);
  const replay=run(process.execPath,[path.join(root,'server/dist/scripts/migrate.js')],names[1]).toString();
  assert(replay.includes('All versioned migrations already applied'));
  run(pg+'pg_restore',['--exit-on-error','--no-owner','-d',names[2],dump],names[2]);
  const restored=await snapshot(names[2]);
  // Restoration is into a different DB; upgraded DB is never overwritten.
  for(const [t,rows] of Object.entries(before))
    assert.deepEqual(restored[t].map(stable).sort(),rows.map(stable).sort(),`Restore mismatch: ${t}`);
  // Preserve a private synthetic original across archive/restore.
  const originals=path.join(tmp,'quarantine'),recovered=path.join(tmp,'restored-quarantine');
  fs.mkdirSync(originals,{mode:0o700});fs.mkdirSync(recovered,{mode:0o700});
  fs.writeFileSync(path.join(originals,'synthetic-source'),Buffer.from('Synthetic private original'),{mode:0o600});
  run('/bin/tar',['-czf',path.join(tmp,'quarantine.tar.gz'),'-C',originals,'.'],names[0]);
  run('/bin/tar',['-xzf',path.join(tmp,'quarantine.tar.gz'),'-C',recovered],names[0]);
  assert.deepEqual(fs.readFileSync(path.join(originals,'synthetic-source')),fs.readFileSync(path.join(recovered,'synthetic-source')));
  assert.equal(fs.statSync(path.join(recovered,'synthetic-source')).mode&0o777,0o600);
  console.log(JSON.stringify({status:'PASS_LOCAL_METADATA_AND_SYNTHETIC',
    schema:'production schema-only; no production rows',
    migrations:'010 -> 018, repeat is no-op',existingRows:'preserved',
    restore:'new database matches all original tables',privateOriginal:'bytes and 0600 preserved',
    elapsed_seconds:Math.round((Date.now()-started)/1000),databases:names}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
