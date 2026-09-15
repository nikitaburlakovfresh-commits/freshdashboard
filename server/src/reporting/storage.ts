import fs from 'fs/promises';
import { constants } from 'fs';
import path from 'path';
import { createHash } from 'crypto';

export const MAX_FILE_BYTES=8*1024*1024;
export const hash=(data:Buffer|string)=>createHash('sha256').update(data).digest('hex');
export const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SourceFile { id:string; display_name:string; content_hash:string; byte_size:number }
export interface UploadFile {name:string;bytes:Buffer}
export function safeName(name:string) {
  const leaf=name.replace(/\\/g,'/').split('/').pop() ?? '';
  const result=leaf.normalize('NFKC').replace(/[^a-zA-Zа-яА-ЯёЁ0-9 ._-]/g,'_').replace(/^[. ]+/,'').slice(0,115);
  return (result.replace(/\.xlsx$/i,'') || 'report')+'.xlsx';
}
export function storageRoot() {
  const env=process.env.REPORT_STORAGE_DIR;
  if(!env || !path.isAbsolute(env)) throw new Error('Private REPORT_STORAGE_DIR required');
  const root=path.resolve(env),web=process.env.CLIENT_DIST && path.resolve(process.env.CLIENT_DIST);
  if(root==='/' || (web && (root===web || root.startsWith(web+path.sep)))) throw new Error('Storage must be outside webroot');
  return root;
}
async function directory(batchId:string,create=false) {
  if(!uuid.test(batchId)) throw new Error('Invalid storage identifier');
  const root=storageRoot();
  if(create) await fs.mkdir(root,{recursive:true,mode:0o700});
  const rootStat=await fs.lstat(root);
  if(!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode&0o077)) throw new Error('Private storage requires directory mode 0700');
  const dir=path.join(root,batchId);
  if(create) await fs.mkdir(dir,{mode:0o700});
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode&0o077)) throw new Error('Unsafe storage directory');
  return dir;
}
/** Durable intent exists in DB first. No unlink on ambiguous commit.
 * Each path is exclusively created once; never uses a submitted filename. */
export async function persistSources(batchId:string,files:{meta:SourceFile;bytes:Buffer}[]) {
  const dir=await directory(batchId,true);
  for(const file of files) {
    if(!uuid.test(file.meta.id)) throw new Error('Invalid storage identifier');
    const handle=await fs.open(path.join(dir,file.meta.id+'.blob'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
    try { await handle.writeFile(file.bytes);await handle.sync(); } finally { await handle.close(); }
  }
  const handle=await fs.open(dir,'r');
  try {await handle.sync();} finally {await handle.close();}
  const root=await fs.open(storageRoot(),'r');
  try {await root.sync();} finally {await root.close();}
}
export async function readSource(batchId:string,file:SourceFile) {
  if(!uuid.test(file.id)) throw new Error('Invalid storage identifier');
  const dir=await directory(batchId);
  const handle=await fs.open(path.join(dir,file.id+'.blob'),constants.O_RDONLY|constants.O_NOFOLLOW);
  try {
    const stat=await handle.stat();
    if(!stat.isFile() || stat.nlink!==1 || (stat.mode&0o077) || stat.size!==file.byte_size || stat.size>MAX_FILE_BYTES) throw new Error('Source integrity failure');
    const bytes=await handle.readFile();
    if(hash(bytes)!==file.content_hash) throw new Error('Source integrity failure');
    return bytes;
  } finally { await handle.close(); }
}
