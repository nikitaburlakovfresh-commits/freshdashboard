import { AccessProposal } from '../api/access';
import { Grant } from '../api/types';
export function accessPermissions(grants:Grant[]) {
  return new Set(grants.filter(g=>g.scope_kind==='NETWORK'&&g.org_unit_id===null).flatMap(g=>g.permissions));
}
export function canApplyAccess(p:AccessProposal|null,actor:string,allowed:boolean,now=Date.now()) {
  return !!(allowed&&p?.status==='PREVIEW'&&p.preview_summary?.valid&&p.preview_token&&
    p.preview_actor===actor&&p.preview_expires_at&&Date.parse(p.preview_expires_at)>now);
}
