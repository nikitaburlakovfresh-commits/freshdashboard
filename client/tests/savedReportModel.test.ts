import {test} from 'node:test';
import assert from 'node:assert/strict';
import {draftPeriodLabel,mappingLabel,metricUnit,reportNumber,reviewCommand} from '../src/components/savedReportModel';
import type {ReviewView} from '../src/api/reportReview';
const view={batch_id:'batch',preview_hash:'hash',current:{version:4},rows:[
  {item_id:'alpha',org_unit_id:'uuid-a'},{item_id:'beta',org_unit_id:null}]} as ReviewView;
test('unknown period stays unknown, explicit draft never labelled confirmed',()=>{
  assert.match(draftPeriodLabel(null),/не подтверждён/);
  assert.match(draftPeriodLabel({start:'2030-01-01',end:'2030-01-02',planStart:'',planEnd:'',basis:'Synthetic date proposal'}),/предложенный/);
});
test('null differs from zero, negative money preserved and units are source units',()=>{
  assert.equal(reportNumber(null),'Нет данных');assert.equal(reportNumber(0),'0');assert.match(reportNumber(-20),/-20/);
  assert.equal(metricUnit('stock'),'шт.');assert.equal(metricUnit('kso'),'руб.');
});
test('sparse changes preserve source IDs, clear explicitly, never send computed values',()=>{
  const command=reviewCommand(view,null,{alpha:'',beta:'uuid-b'},'Synthetic review reason');
  assert.deepEqual(command.edits,[{item_id:'alpha',org_unit_id:null},{item_id:'beta',org_unit_id:'uuid-b'}]);
  assert.equal(command.expected_version,4);assert.equal(command.preview_hash,'hash');
  assert.equal(command.period,null);assert.ok(!('metrics' in command));
});
test('unchanged mapping sends no edits; more than 100 and incomplete period refused',()=>{
  assert.deepEqual(reviewCommand(view,null,{alpha:'uuid-a'},'Synthetic review reason').edits,[]);
  assert.throws(()=>reviewCommand(view,{start:'2030-01-01',end:'2030-01-02',planStart:'2030-01-01',planEnd:'',basis:'Synthetic period basis'}, {},'Synthetic review reason'));
  assert.throws(()=>reviewCommand({...view,rows:Array.from({length:101},(_,i)=>({item_id:`${i}`,org_unit_id:'old'}))} as ReviewView,null,{},'Synthetic review reason'));
});
test('draft labels separate unresolved, proposed and stale mapping',()=>{
  assert.equal(mappingLabel({status:'UNRESOLVED'} as any),'Нет привязки');
  assert.equal(mappingLabel({status:'PROPOSED'} as any),'Привязка предложена');
  assert.equal(mappingLabel({status:'STALE'} as any),'Привязка устарела');
});
