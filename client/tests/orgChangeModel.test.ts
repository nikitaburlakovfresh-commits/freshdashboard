import test from 'node:test';
import assert from 'node:assert/strict';
import { canApplyOrgProposal } from '../src/components/orgChangeModel';
import type { OrgProposal } from '../src/api/orgChanges';
const now=Date.now();
const p={status:'PREVIEW',preview_token:'synthetic-token',preview_actor:'actor',preview_expires_at:new Date(now+60000).toISOString(),
  preview_summary:{valid:true}} as OrgProposal;
test('editor valid current actor-bound preview enables apply',()=>assert.equal(canApplyOrgProposal(p,false,'actor',true,now),true));
test('editor local edits immediately disable apply',()=>assert.equal(canApplyOrgProposal(p,true,'actor',true,now),false));
test('editor expired preview disables apply',()=>assert.equal(canApplyOrgProposal(p,false,'actor',true,now+61000),false));
test('editor other actor and absent permission disable apply',()=>{
  assert.equal(canApplyOrgProposal(p,false,'other',true,now),false);assert.equal(canApplyOrgProposal(p,false,'actor',false,now),false);
});
test('editor draft, applied, invalid, absent preview disable apply',()=>{
  for(const value of [null,{...p,status:'DRAFT'},{...p,status:'APPLIED'},{...p,preview_token:null},{...p,preview_summary:{valid:false}}])
    assert.equal(canApplyOrgProposal(value as OrgProposal|null,false,'actor',true,now),false);
});
