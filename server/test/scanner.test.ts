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
