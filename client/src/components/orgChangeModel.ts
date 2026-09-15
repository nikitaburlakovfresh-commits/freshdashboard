import type { OrgProposal } from '../api/orgChanges';
export function canApplyOrgProposal(p:OrgProposal|null,dirty:boolean,actor:string,allowed:boolean,now=Date.now()) {
  return !!(allowed && !dirty && p?.status==='PREVIEW' && p.preview_summary?.valid &&
    p.preview_token && p.preview_actor===actor && p.preview_expires_at && Date.parse(p.preview_expires_at)>now);
}
