jest.mock('child_process',()=>({spawn:jest.fn()}));
import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { scanBytes } from '../src/reporting/scanner';
const version=()=>`ClamAV 1.4.3/28000/${new Date().toUTCString()}\n`;
function responses(queue:{code?:number;output?:string;error?:boolean}[]) {
  (spawn as jest.Mock).mockImplementation(()=>{
    const next=queue.shift()!,child:any=new EventEmitter();
    child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
    child.kill=jest.fn();child.stdin.end=jest.fn(()=>{
      process.nextTick(()=>{if(next.error)child.emit('error',new Error('missing'));
        else {child.stdout.emit('data',Buffer.from(next.output??''));child.emit('close',next.code??0);}});
    });return child;
  });
}
beforeEach(()=>jest.clearAllMocks());
afterEach(()=>jest.useRealTimers());
test('scanner requires matching fresh database versions around clean scan',async()=>{
  const v=version();responses([{output:v},{output:'stdin: OK\n'},{output:v}]);
  expect((await scanBytes(Buffer.from('synthetic bytes'))).result).toBe('CLEAN');
  expect((spawn as jest.Mock).mock.calls[1][0]).toBe('/usr/bin/clamscan');
  expect((spawn as jest.Mock).mock.calls[1][1]).toContain('--alert-encrypted=yes');
});
test('scanner treats exit one as infected without exposing scanner output',async()=>{
  const v=version();responses([{output:v},{code:1,output:'stdin: threat FOUND'},{output:v}]);
  expect((await scanBytes(Buffer.from('synthetic bytes'))).result).toBe('INFECTED');
});
test('missing scanner fails closed',async()=>{
  responses([{error:true}]);await expect(scanBytes(Buffer.from('fixture'))).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
});
test('old signatures fail before source bytes are scanned',async()=>{
  responses([{output:'ClamAV 1.4.3/28000/Mon, 01 Jan 2024 00:00:00 GMT'}]);
  await expect(scanBytes(Buffer.from('fixture'))).rejects.toThrow();expect(spawn).toHaveBeenCalledTimes(1);
});
test('changed database version is not accepted as clean',async()=>{
  responses([{output:version()},{code:0},{output:version().replace('/28000/','/28001/')}]);
  await expect(scanBytes(Buffer.from('fixture'))).rejects.toThrow();
});
test('scanner operational error exit two never produces clean receipt',async()=>{
  const v=version();responses([{output:v},{code:2},{output:v}]);
  await expect(scanBytes(Buffer.from('fixture'))).rejects.toThrow();
});
test('future or malformed signature dates fail closed',async()=>{
  for(const date of ['not-a-date',new Date(Date.now()+86400000).toUTCString()]) {
    responses([{output:`ClamAV 1.4.3/28000/${date}`}]);
    await expect(scanBytes(Buffer.from('fixture'))).rejects.toThrow();
  }
});
test('empty and oversize files never spawn a scanner',async()=>{
  for(const b of [Buffer.alloc(0),Buffer.alloc(8*1024*1024+1)])
    await expect(scanBytes(b)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  expect(spawn).not.toHaveBeenCalled();
});
test('parallel scan is refused rather than multiplying scanner memory',async()=>{
  const v=version();responses([{output:v},{code:0},{output:v}]);
  const first=scanBytes(Buffer.from('fixture'));
  await expect(scanBytes(Buffer.from('fixture2'))).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
  expect((await first).result).toBe('CLEAN');
});
test('oversized scanner output is killed and the slot is released',async()=>{
  responses([{output:'x'.repeat(8193)}]);
  await expect(scanBytes(Buffer.from('fixture'))).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
  const child=(spawn as jest.Mock).mock.results[0].value;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  const v=version();responses([{output:v},{code:0},{output:v}]);
  expect((await scanBytes(Buffer.from('fixture'))).result).toBe('CLEAN');
});
test('hung scanner is killed at 30 seconds, never clean',async()=>{
  jest.useFakeTimers();
  const child:any=new EventEmitter();
  child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.stdin=new EventEmitter();
  child.stdin.end=jest.fn();child.kill=jest.fn();
  (spawn as jest.Mock).mockReturnValue(child);
  const pending=expect(scanBytes(Buffer.from('fixture'))).rejects.toMatchObject({code:'TEMPORARILY_UNAVAILABLE'});
  await jest.advanceTimersByTimeAsync(30000);await pending;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});
test('scan process receives explicit resource limits and stable locale',async()=>{
  const v=version();responses([{output:v},{code:0},{output:v}]);
  await scanBytes(Buffer.from('fixture'));
  expect((spawn as jest.Mock).mock.calls[1][1]).toEqual(expect.arrayContaining([
    '--max-filesize=8M','--max-scansize=64M','--max-files=2048','--max-recursion=16']));
  expect((spawn as jest.Mock).mock.calls[1][2].env).toMatchObject({LC_ALL:'C',TZ:'UTC'});
});
