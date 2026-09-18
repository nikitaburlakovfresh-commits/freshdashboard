import test from 'node:test';
import assert from 'node:assert/strict';
import { formatValue,ragReason,thresholdOrderValid,RAG_LABELS } from '../src/components/metricThresholdModel';
test('статусы подписаны по-русски, «нет данных» не выдаётся за выполнение',()=>{
  assert.equal(RAG_LABELS.NONE,'Нет данных');
  assert.equal(RAG_LABELS.GREEN,'Зелёный');
});
test('значение форматируется с единицей и не подставляет ноль',()=>{
  assert.match(formatValue(1234567.5,'RUB'),/руб\.$/);
  assert.match(formatValue(12,'COUNT'),/^12 шт\.$/);
});
test('обоснование статуса различает отсутствие порога и отсутствие плана',()=>{
  assert.equal(ragReason({rag:'NONE',basis:null,basis_value:null,threshold_id:null}),
    'Порог не настроен — статус не рассчитывается.');
  assert.equal(ragReason({rag:'NONE',basis:'PLAN_PERCENT',basis_value:null,threshold_id:'t'}),
    'Порог задан от плана, но план за период не опубликован.');
  assert.match(ragReason({rag:'GREEN',basis:'PLAN_PERCENT',basis_value:104.25,threshold_id:'t'}),
    /Исполнение плана/);
});
test('порядок порогов зависит от направления показателя',()=>{
  assert.equal(thresholdOrderValid('HIGHER_IS_BETTER',100,90),true);
  assert.equal(thresholdOrderValid('HIGHER_IS_BETTER',90,100),false);
  assert.equal(thresholdOrderValid('LOWER_IS_BETTER',5,10),true);
  assert.equal(thresholdOrderValid('LOWER_IS_BETTER',Number.NaN,10),false);
});
