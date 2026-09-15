import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryRows } from '../src/components/orgDirectoryModel';
import type { DirectoryUnit } from '../src/api/organization';

const unit = (id: string, parent: string | null, name: string): DirectoryUnit => ({
  id, parent_id:parent, display_name:name, code:id, kind:parent ? 'ORG_UNIT' : 'NETWORK',
  type_code:null,lifecycle_state:'ACTIVE',is_demo:true,demo_locked:true,business_model:null,
  name_effective_from:'2026-01-01',name_effective_to:null,affiliation_effective_from:'2026-01-01',affiliation_effective_to:null,
});
const tree = [unit('net',null,'Учебная сеть'),unit('north','net','Север (тест)'),unit('a','north','Филиал Альфа (тест)'),unit('b','net','Филиал Бета (тест)')];
test('ORG-UI-01 hierarchy uses stable IDs and indentation, never invents rows', () => {
  assert.deepEqual(directoryRows(tree,'',new Set()).map(r=>[r.unit.id,r.depth]),[['net',0],['north',1],['a',2],['b',1]]);
});
test('ORG-UI-02 expand/collapse is reversible; search reveals an accessible match and ancestors only', () => {
  assert.deepEqual(directoryRows(tree,'',new Set(['north'])).map(r=>r.unit.id),['net','north','b']);
  assert.deepEqual(directoryRows(tree,'  аЛьФа ',new Set(['net','north'])).map(r=>r.unit.id),['net','north','a']);
  assert.equal(directoryRows(tree,'',new Set()).length,4);
});
test('ORG-UI-03 an inaccessible/missing parent stays absent, while own branch is navigable', () => {
  assert.deepEqual(directoryRows([tree[2]],'',new Set()).map(r=>[r.unit.id,r.depth]),[['a',0]]);
});
test('ORG-UI-04 empty and no-match results contain no fabricated units', () => {
  assert.deepEqual(directoryRows([],'',new Set()),[]);
  assert.deepEqual(directoryRows(tree,'nonexistent',new Set()),[]);
});
test('ORG-UI-05 malformed cyclic input cannot recurse forever or reveal foreign rows', () => {
  assert.deepEqual(directoryRows([unit('a','b','A'),unit('b','a','B')],'A',new Set()),[]);
});
