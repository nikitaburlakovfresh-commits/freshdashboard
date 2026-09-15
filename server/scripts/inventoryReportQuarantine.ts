import fs from 'fs/promises';
import path from 'path';
import { pool,closePool } from '../src/db/pool';
import { storageRoot,readSource,uuid } from '../src/reporting/storage';

/** Read-only operator inventory. No deletion, repair, raw names or source data. */
async function run() {
  const root=storageRoot();
  const rows=(await pool.query(`SELECT b.id,b.storage_state,b.status,
    coalesce(jsonb_agg(jsonb_build_object('id',f.id,'byte_size',f.byte_size,'content_hash',f.content_hash))
      FILTER(WHERE f.id IS NOT NULL),'[]') files
    FROM report_staging_batches b LEFT JOIN report_staging_files f ON f.batch_id=b.id
    GROUP BY b.id ORDER BY b.id`)).rows;
  const entries=await fs.readdir(root,{withFileTypes:true});
  const known=new Set(rows.map(r=>r.id));
  const issues:{batch_id?:string;issue:string}[]=[];
  for(const entry of entries) {
    if(!uuid.test(entry.name) || !known.has(entry.name) || !entry.isDirectory()) issues.push({issue:'UNREFERENCED_OR_UNSAFE_STORAGE_ENTRY'});
  }
  for(const row of rows) {
    if(row.storage_state==='WRITING')issues.push({batch_id:row.id,issue:'INCOMPLETE_INTENT'});
    for(const file of row.files) {
      try {await readSource(row.id,file);} catch {issues.push({batch_id:row.id,issue:'MISSING_OR_INVALID_ORIGINAL'});}
    }
    try {
      const files=await fs.readdir(path.join(root,row.id));
      const allowed=new Set(row.files.map((f:any)=>f.id+'.blob'));
      if(files.some(f=>!allowed.has(f)))issues.push({batch_id:row.id,issue:'UNREFERENCED_FILE'});
    } catch {issues.push({batch_id:row.id,issue:'MISSING_DIRECTORY'});}
  }
  console.log(JSON.stringify({mode:'READ_ONLY_NO_DELETION',batch_count:rows.length,issues},null,2));
  if(issues.length)process.exitCode=2;
}
run().catch(()=>{console.error('Private quarantine inventory unavailable; no changes made.');process.exitCode=1;}).finally(closePool);
