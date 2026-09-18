import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeSavedFields, hasUnsavedFields, parseGroup, requiredFieldsPresent } from '../src/domain/taskForm';
import type { SavedField, FieldDef } from '../src/api/types';
const field = (path:string,value:string|null,version=1) => ({field_path:path,value,field_version:version,updated_at:'2026-01-01',updated_by:'synthetic'} satisfies SavedField);
test('saving one field preserves another dirty field and its original CAS version', () => {
  const old = mergeSavedFields({},[field('a','one'),field('b','two')]);
  old.a.value='edited a'; old.b.value='edited b';
  const next = mergeSavedFields(old,[field('a','edited a',2),field('b','remote edit',3)],'a');
  assert.equal(next.a.baseValue,'edited a');
  assert.equal(next.a.version,2);
  assert.deepEqual(next.b,old.b);
  assert.equal(hasUnsavedFields(next),true);
});
test('clean fields follow server, explicit reload discards all drafts', () => {
  const old=mergeSavedFields({},[field('a',null)]);
  assert.equal(hasUnsavedFields(old),false);
  assert.equal(mergeSavedFields(old,[field('a','remote',2)]).a.value,'remote');
  old.a.value='draft';
  assert.equal(mergeSavedFields({},[field('a','remote',2)]).a.value,'remote');
});
test('group parser rejects malformed objects and preserves zero-like strings', () => {
  for (const value of ['{}','null','[null]','[1]','[{"value":3}]','bad']) assert.equal(parseGroup(value),null);
  assert.deepEqual(parseGroup(''),[]);
  assert.deepEqual(parseGroup('[{"value":"0"}]'),[{value:'0'}]);
});
test('required field checks cover all fields, not first alphabetical field', () => {
  const schema:FieldDef[]=[{field_path:'a',label:'A',type:'number',required:true},{field_path:'b',label:'B',type:'text',required:true}];
  assert.equal(requiredFieldsPresent(schema,[field('a','0'),field('b',null)]),false);
  assert.equal(requiredFieldsPresent(schema,[field('a','0'),field('b','done')]),true);
});
test('repeatable required children and minimum count must be present before submit', () => {
  const schema:FieldDef[]=[{field_path:'rows',label:'Rows',type:'repeatable_group',required:true,min_items:1,
    child_fields:[{field_path:'url',label:'URL',type:'url',required:true}]}];
  for(const value of [null,'[]','[{}]','[{"url":""}]']) assert.equal(requiredFieldsPresent(schema,[field('rows',value)]),false);
  assert.equal(requiredFieldsPresent(schema,[field('rows','[{"url":"https://example.com"}]')]),true);
});
