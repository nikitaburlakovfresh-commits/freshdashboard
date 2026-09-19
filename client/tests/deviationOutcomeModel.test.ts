import test from 'node:test';
import assert from 'node:assert/strict';
import { OUTCOME_LABELS,outcomeTone,deltaLabel } from '../src/components/deviationOutcomeModel';

test('отсутствие новой публикации не подписывается как улучшение',()=>{
  assert.match(OUTCOME_LABELS.NOT_REPUBLISHED,/не подтверждён/);
  assert.match(OUTCOME_LABELS.NO_PUBLISHED_VALUE,/Нет опубликованного значения/);
  assert.equal(outcomeTone('NOT_REPUBLISHED'),'neutral');
  assert.equal(outcomeTone('NO_PUBLISHED_VALUE'),'neutral');
  assert.equal(outcomeTone('STATUS_UNKNOWN'),'neutral');
});

test('улучшение и ухудшение различаются тоном',()=>{
  assert.equal(outcomeTone('STATUS_IMPROVED'),'good');
  assert.equal(outcomeTone('VALUE_IMPROVED'),'good');
  assert.equal(outcomeTone('STATUS_WORSENED'),'bad');
  assert.equal(outcomeTone('VALUE_WORSENED'),'bad');
  assert.equal(outcomeTone('UNCHANGED'),'neutral');
});

test('изменение показывается только при наличии нового значения',()=>{
  assert.equal(deltaLabel(null,'COUNT'),'—');
  assert.match(deltaLabel(110,'COUNT'),/^\+110 шт\./);
  assert.match(deltaLabel(-15,'COUNT'),/^−15 шт\./);
  assert.match(deltaLabel(1000,'RUB'),/руб\.$/);
  assert.equal(deltaLabel(0,'COUNT').startsWith('0'),true);
});
