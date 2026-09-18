import test from 'node:test';
import assert from 'node:assert/strict';
import { accessPermissions,canApplyAccess } from '../src/components/accessChangeModel';
import type { AccessProposal } from '../src/api/access';
import type { Grant } from '../src/api/types';
const now=Date.now(),p={status:'PREVIEW',preview_token:'test',preview_actor:'actor',
  preview_expires_at:new Date(now+60000).toISOString(),preview_summary:{valid:true}} as AccessProposal;
test('access valid actor-bound preview enables apply',()=>assert.equal(canApplyAccess(p,'actor',true,now),true));
test('access stale, foreign actor and missing permission disable apply',()=>{
  assert.equal(canApplyAccess(p,'actor',true,now+60001),false);
  assert.equal(canApplyAccess(p,'other',true,now),false);assert.equal(canApplyAccess(p,'actor',false,now),false);
});
test('access invalid, applied, draft and absent previews cannot apply',()=>{
  for(const value of [null,{...p,status:'DRAFT'},{...p,status:'APPLIED'},{...p,preview_token:null},{...p,preview_summary:{valid:false}}])
    assert.equal(canApplyAccess(value as AccessProposal|null,'actor',true,now),false);
});
test('access navigation needs explicit NETWORK permission; role name and ORG_UNIT are insufficient',()=>{
  const g={role:'SUPER_ADMIN',permissions:['access.directory.read'],scope_kind:'ORG_UNIT',org_unit_id:'branch'} as Grant;
  assert.equal(accessPermissions([g]).size,0);
  assert.equal(accessPermissions([{...g,scope_kind:'NETWORK',org_unit_id:null} as Grant]).has('access.directory.read'),true);
  assert.equal(accessPermissions([{...g,scope_kind:'NETWORK',org_unit_id:null,permissions:[]} as Grant]).size,0);
});
