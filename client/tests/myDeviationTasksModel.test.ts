import test from 'node:test';
import assert from 'node:assert/strict';
import { DUE_LABELS,dueTone,basisLabel } from '../src/components/myDeviationTasksModel';

test('подписи и тон срока соответствуют состоянию',()=>{
  assert.equal(DUE_LABELS.OVERDUE,'Срок истёк');
  assert.equal(dueTone('OVERDUE'),'bad');
  assert.equal(dueTone('DUE_SOON'),'warn');
  assert.equal(dueTone('ON_TRACK'),'neutral');
  assert.equal(dueTone('CLOSED'),'neutral');
});

test('скрытые значения не подменяются нулём',()=>{
  const hidden={values_visible:false,observed_value:null,basis_value:null,unit:null,basis:'ABSOLUTE'};
  assert.match(basisLabel(hidden),/нет допуска/);
  assert.doesNotMatch(basisLabel(hidden),/0/);
  // Сервер может раскрыть флаг, но не значения — цифры всё равно не показываются.
  assert.match(basisLabel({...hidden,values_visible:true}),/нет допуска/);
});

test('раскрытое основание показывает значение и порог',()=>{
  const v=basisLabel({values_visible:true,observed_value:40,basis_value:80,unit:'COUNT',basis:'ABSOLUTE'});
  assert.match(v,/40 шт\./);
  assert.match(v,/против/);
  assert.match(v,/80 шт\./);
});
