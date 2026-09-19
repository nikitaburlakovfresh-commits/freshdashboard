import test from 'node:test';
import assert from 'node:assert/strict';
import { focusOrder,managerLabel,missingLabel,riskScore,deviationAction,RISK_WEIGHT_LABELS,
  type RiskWeights } from '../src/components/divisionSummaryModel';

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

const W:RiskWeights={risk_weight_red:100,risk_weight_amber:40,
  risk_weight_deviation_without_task:25,risk_weight_task_overdue:60,
  risk_weight_branch_without_data:15};

test('оценка риска складывается ровно из утверждённых весов', () => {
  assert.equal(riskScore(W,{red:1,amber:2,deviations_without_task:3,
    tasks_overdue:1,branches_without_data:1}),100+80+75+60+15);
  assert.equal(riskScore(W,{red:0,amber:0,deviations_without_task:0,
    tasks_overdue:0,branches_without_data:0}),0);
});

test('нулевой вес убирает признак из приоритетности, не меняя показатель', () => {
  const zeroRed={...W,risk_weight_red:0};
  const x={red:5,amber:0,deviations_without_task:0,tasks_overdue:0,branches_without_data:1};
  assert.equal(riskScore(zeroRed,x),15);
  assert.ok(riskScore(W,x)>riskScore(zeroRed,x));
});

test('отсутствие данных может стать важнее цвета по решению руководителя', () => {
  const byData={risk_weight_red:0,risk_weight_amber:0,risk_weight_deviation_without_task:0,
    risk_weight_task_overdue:0,risk_weight_branch_without_data:1000};
  const coloured={red:2,amber:1,deviations_without_task:3,tasks_overdue:1,branches_without_data:0};
  const silent={red:0,amber:0,deviations_without_task:0,tasks_overdue:0,branches_without_data:1};
  assert.ok(riskScore(W,coloured)>riskScore(W,silent));
  assert.ok(riskScore(byData,silent)>riskScore(byData,coloured));
});

test('действие по отклонению различает поставленную и непоставленную задачу', () => {
  assert.deepEqual(deviationAction({has_task:false,task_status:null}),
    {label:'Поставить задачу',actionable:true});
  const done=deviationAction({has_task:true,task_status:'ASSIGNED'});
  assert.equal(done.actionable,false);
  assert.match(done.label,/Задача поставлена/);
  assert.match(done.label,/ASSIGNED/);
  assert.equal(deviationAction({has_task:true,task_status:null}).label,'Задача поставлена');
});

test('каждый вес приоритетности назван по-русски для экрана настроек', () => {
  const keys=Object.keys(W) as (keyof RiskWeights)[];
  for(const k of keys)assert.ok(RISK_WEIGHT_LABELS[k].length>3,k);
  assert.equal(keys.length,Object.keys(RISK_WEIGHT_LABELS).length);
});
