import { unzipSync, strFromU8 } from 'fflate';
import { MAX_FILE_BYTES } from './storage';

const bad=()=>new Error('Неподдерживаемый или небезопасный XLSX. Макросы, формулы и внешние ссылки запрещены.');
const crcTable=Uint32Array.from({length:256},(_,i)=>{
  for(let b=0;b<8;b++) i=(i&1)?0xedb88320^(i>>>1):i>>>1;
  return i>>>0;
});
function crc32(bytes:Uint8Array) {
  let crc=0xffffffff;
  for(const byte of bytes) crc=crcTable[(crc^byte)&255]^(crc>>>8);
  return (crc^0xffffffff)>>>0;
}
/** Closed ZIP envelope, not extraction. Reject ambiguous headers, ZIP64,
 * encryption, path tricks and dishonest output sizes before the XLSX reader. */
export function validateXlsx(bytes:Buffer) {
  if(bytes.length<22 || bytes.length>MAX_FILE_BYTES || bytes.readUInt32LE(0)!==0x04034b50) throw bad();
  let end=-1;
  for(let n=bytes.length-22;n>=Math.max(0,bytes.length-65557);n--)
    if(bytes.readUInt32LE(n)===0x06054b50 && n+22+bytes.readUInt16LE(n+20)===bytes.length){end=n;break;}
  if(end<0 || bytes.readUInt16LE(end+4)!==0 || bytes.readUInt16LE(end+6)!==0) throw bad();
  const count=bytes.readUInt16LE(end+10),size=bytes.readUInt32LE(end+12),start=bytes.readUInt32LE(end+16);
  if(!count || count>100 || bytes.readUInt16LE(end+8)!==count || start+size!==end) throw bad();
  let pos=start,expanded=0,compressed=0;
  const entries=new Map<string,{size:number;crc:number}>();
  const ranges:{start:number;end:number}[]=[];
  for(let i=0;i<count;i++) {
    if(pos+46>end || bytes.readUInt32LE(pos)!==0x02014b50) throw bad();
    const flags=bytes.readUInt16LE(pos+8),method=bytes.readUInt16LE(pos+10);
    const crc=bytes.readUInt32LE(pos+16),packed=bytes.readUInt32LE(pos+20),unpacked=bytes.readUInt32LE(pos+24);
    const len=bytes.readUInt16LE(pos+28),extra=bytes.readUInt16LE(pos+30),comment=bytes.readUInt16LE(pos+32);
    const offset=bytes.readUInt32LE(pos+42),next=pos+46+len+extra+comment;
    if(next>end || !len || len>200 || flags&~0x0808 || ![0,8].includes(method) || bytes.readUInt16LE(pos+34)!==0) throw bad();
    const name=bytes.subarray(pos+46,pos+46+len).toString('utf8');
    if(entries.has(name) || !/^[A-Za-z0-9_[\]./-]+$/.test(name) || name.includes('..') || name.startsWith('/') ||
      !/^(\[Content_Types\]\.xml|_rels\/\.rels|docProps\/[a-zA-Z]+\.xml|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/styles\.xml|xl\/sharedStrings\.xml|xl\/theme\/theme\d+\.xml|xl\/worksheets\/sheet1\.xml)$/.test(name)) throw bad();
    if(offset+30>start || bytes.readUInt32LE(offset)!==0x04034b50 ||
      bytes.readUInt16LE(offset+6)!==flags || bytes.readUInt16LE(offset+8)!==method) throw bad();
    const localLen=bytes.readUInt16LE(offset+26),localExtra=bytes.readUInt16LE(offset+28),dataStart=offset+30+localLen+localExtra;
    if(dataStart>start || localLen!==len || bytes.subarray(offset+30,offset+30+len).toString('utf8')!==name || dataStart+packed>start) throw bad();
    if(!(flags&8) && (bytes.readUInt32LE(offset+14)!==crc || bytes.readUInt32LE(offset+18)!==packed || bytes.readUInt32LE(offset+22)!==unpacked)) throw bad();
    let rangeEnd=dataStart+packed;
    if(flags&8) {
      let descriptor=rangeEnd;
      if(descriptor+4>start) throw bad();
      if(bytes.readUInt32LE(descriptor)===0x08074b50) descriptor+=4;
      if(descriptor+12>start || bytes.readUInt32LE(descriptor)!==crc || bytes.readUInt32LE(descriptor+4)!==packed || bytes.readUInt32LE(descriptor+8)!==unpacked) throw bad();
      rangeEnd=descriptor+12;
    }
    expanded+=unpacked;compressed+=packed;
    if(unpacked>8*1024*1024 || expanded>16*1024*1024 || unpacked>Math.max(1024*1024,packed*100)) throw bad();
    entries.set(name,{size:unpacked,crc});ranges.push({start:offset,end:rangeEnd});pos=next;
  }
  if(pos!==end || !entries.has('[Content_Types].xml') || !entries.has('xl/workbook.xml') ||
     !entries.has('xl/worksheets/sheet1.xml') || expanded>Math.max(1024*1024,compressed*100)) throw bad();
  ranges.sort((a,b)=>a.start-b.start);
  if(ranges[0].start!==0 || ranges.at(-1)!.end!==start || ranges.some((r,i)=>i>0 && ranges[i-1].end!==r.start)) throw bad();
  const decoded=unzipSync(bytes);
  if(Object.keys(decoded).length!==entries.size) throw bad();
  for(const [name,part] of Object.entries(decoded)) {
    const expected=entries.get(name);
    if(!expected || part.length!==expected.size || crc32(part)!==expected.crc) throw bad();
    const xml=strFromU8(part);
    if(/<!DOCTYPE|<!ENTITY|<\s*(?:[^\s<>/:]+:)?f(?:\s|>|\/)|TargetMode\s*=\s*["']External["']|macroEnabled|vbaProject|oleObject|<\s*(?:[^\s<>/:]+:)?externalReference\b/i.test(xml)) throw bad();
    if(name.endsWith('.rels')) {
      // Closed internal relationship destinations. Entity-encoded external
      // modes/URLs cannot bypass a lexical denylist and reach the XLSX reader.
      if(/<[A-Za-z][\w.-]*:|TargetMode\s*=/i.test(xml)) throw bad();
      const allowed=name==='_rels/.rels'
        ? ['xl/workbook.xml','docProps/core.xml','docProps/app.xml','docProps/custom.xml']
        : ['worksheets/sheet1.xml','styles.xml','sharedStrings.xml','theme/theme1.xml'];
      for(const target of xml.matchAll(/\bTarget\s*=\s*["']([^"']*)["']/g)) if(!allowed.includes(target[1])) throw bad();
    }
  }
}
