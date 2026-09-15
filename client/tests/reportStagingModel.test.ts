import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStagingFiles,periodMetadata,periodLabel,stagingStatus,blockerLabel } from '../src/components/reportStagingModel';
const empty={start:'',end:'',planStart:'',planEnd:''};
test('unknown period never infers dates or carries unconfirmed input',()=>{
  assert.deepEqual(periodMetadata(false,{...empty,start:'2030-04-01'},'ignored'),{state:'REQUIRES_CONFIRMATION'});
  assert.equal(periodLabel({state:'REQUIRES_CONFIRMATION'}),'Период не подтверждён');
});
test('confirmed period requires valid dates and explicit basis',()=>{
  assert.throws(()=>periodMetadata(true,empty,'Synthetic confirmation'));
  assert.throws(()=>periodMetadata(true,{...empty,start:'2030-04-01',end:'2030-04-03'},''));
  assert.equal(periodMetadata(true,{...empty,start:'2030-04-01',end:'2030-04-03'},'Synthetic confirmation').state,'CONFIRMED');
});
test('only bounded original XLSX selection accepted client-side; server still validates',()=>{
  for(const files of [[],[{name:'a.xlsm',size:4}],[{name:'a.xlsx',size:0}],[{name:'a.xlsx',size:8388609}],Array(3).fill({name:'a.xlsx',size:100})])
    assert.throws(()=>checkStagingFiles(files));
  checkStagingFiles([{name:'a.xlsx',size:100}]);
});
test('stage labels never claim canonical import or clean malware scan',()=>{
  assert.equal(stagingStatus({status:'QUARANTINE',storage_state:'WRITING'}),'Загрузка не завершена');
  assert.equal(stagingStatus({status:'NEEDS_MAPPING',storage_state:'READY'}),'Нужна привязка филиалов');
  assert.match(blockerLabel('MALWARE_SCAN_REQUIRED'),/не подключена/);
  assert.match(blockerLabel('NEEDS_MAPPING'),/не сопоставлены/);
});
