import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { liveFence } from '../domain/dailyLogs';

export async function factAccess(c:PoolClient,auth:AuthedUser,capability:'PUBLISH'|'READ') {
  await liveFence(c,{authUser:auth,requestId:'fact-access',ip:null,userAgent:null});
  await c.query('LOCK TABLE report_fact_access IN SHARE MODE');
  return (await c.query(`SELECT g.id grant_id,g.org_unit_id,a.metrics FROM report_fact_access a
    JOIN role_grants g ON g.id=a.grant_id
    WHERE g.user_id=$1 AND a.capability=$2 AND a.revoked_at IS NULL AND a.valid_from<=now()
      AND (a.valid_until IS NULL OR a.valid_until>now()) AND g.revoked_at IS NULL
      AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
      AND (($2='PUBLISH' AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL)
        OR ($2='READ' AND g.scope_kind='ORG_UNIT' AND g.org_unit_id IS NOT NULL))`,
  [auth.userId,capability])).rows as {grant_id:string;org_unit_id:string|null;metrics:string[]}[];
}
export async function publisher(c:PoolClient,auth:AuthedUser) {
  const grants=await factAccess(c,auth,'PUBLISH');
  if(grants.length!==1)throw new ApiError('FORBIDDEN','Нужно отдельное разрешение на публикацию агрегатов. Доступ к черновикам его не даёт.');
  return grants[0];
}
