import test from 'node:test';
import assert from 'node:assert/strict';
import { focusOrder,managerLabel,missingLabel } from '../src/components/divisionSummaryModel';

const row=(p:Partial<Parameters<typeof focusOrder>[0]>)=>
  ({red:0,amber:0,deviations_without_task:0,tasks_overdue:0,...p});

test('красные отклонения поднимаются выше жёлтых', () => {
  const list=[row({amber:5}),row({red:1}),row({amber:2})].sort(focusOrder);
  assert.equal(list[0].red,1);
  assert.equal(list[1].amber,5);
});

test('при равной остроте выше тот, где задача не поставлена', () => {
  const list=[row({red:1,tasks_overdue:3}),row({red:1,deviations_without_task:1})].sort(focusOrder);
  assert.equal(list[0].deviations_without_task,1);
});

test('вакансия названа вакансией, а не пустой строкой', () => {
  assert.equal(managerLabel({full_name:null,is_vacant:true}),'Вакансия регионального менеджера');
  assert.equal(managerLabel({full_name:'Иванов И. И.',is_vacant:false}),'Иванов И. И.');
  assert.equal(managerLabel({full_name:null,is_vacant:false}),'Вакансия регионального менеджера');
});

test('отсутствие данных подписано именно как отсутствие, а не как ноль', () => {
  assert.equal(missingLabel([],{}),'');
  assert.equal(missingLabel(['aged','sales'],{aged:'Сток свыше 90 дней',sales:'Продажи'}),
    'Нет опубликованных данных: Сток свыше 90 дней, Продажи');
  assert.equal(missingLabel(['unknown'],{}),'Нет опубликованных данных: unknown');
});
