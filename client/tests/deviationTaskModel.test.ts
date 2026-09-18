import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenTask,defaultTitle,draftError,dueIso } from '../src/components/deviationTaskModel';

const cell=(patch:any={})=>({rag:'RED',threshold_id:'t1',deviation_task:null,
  metric_name:'Продажи',value:40,unit:'COUNT',...patch});

test('переход открыт только для отклонения без уже поставленной задачи',()=>{
  assert.equal(canOpenTask(cell() as any),true);
  assert.equal(canOpenTask(cell({rag:'AMBER'}) as any),true);
  assert.equal(canOpenTask(cell({rag:'GREEN'}) as any),false);
  assert.equal(canOpenTask(cell({rag:'NONE'}) as any),false);
  assert.equal(canOpenTask(cell({threshold_id:null}) as any),false);
  assert.equal(canOpenTask(cell({deviation_task:{id:'d'}}) as any),false);
});

test('название задачи не превышает лимит сервера',()=>{
  const title=defaultTitle('Ф'.repeat(300),cell() as any);
  assert.equal(Array.from(title).length<=200,true);
  assert.match(defaultTitle('Филиал',cell() as any),/Продажи/);
});

test('срок переводится из московской даты в UTC RFC3339',()=>{
  assert.equal(dueIso('2026-09-30'),'2026-09-30T15:00:00Z');
  assert.equal(dueIso('2026-02-30'),null);
  assert.equal(dueIso('30.09.2026'),null);
});

test('черновик проверяется до отправки команды',()=>{
  const ok={template_code:'pilot_task_v1',title:'Разобрать отклонение',due_date:'2026-09-30',
    reason:'Отклонение продаж за август, нужен разбор причин'};
  assert.equal(draftError(ok),null);
  assert.match(draftError({...ok,template_code:''})!,/шаблон/i);
  assert.match(draftError({...ok,title:'  '})!,/название/i);
  assert.match(draftError({...ok,title:'x'.repeat(201)})!,/200/);
  assert.match(draftError({...ok,due_date:''})!,/срок/i);
  assert.match(draftError({...ok,reason:'коротко'})!,/16/);
  assert.match(draftError({...ok,reason:'x'.repeat(501)})!,/500/);
});
