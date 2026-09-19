import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { liveFence } from '../domain/dailyLogs';
import type { DetailKind } from './shared/detailModel';

// Детальный контур — отдельное право. Доступ к агрегатам его не даёт,
// операторского обхода нет: грант выдаётся человеку и проверяется на живой сессии.
export async function detailAccess(c:PoolClient,auth:AuthedUser,permission:'report_detail.publish'|'report_detail.read') {
  await liveFence(c,{authUser:auth,requestId:'detail-access',ip:null,userAgent:null});
  await c.query('LOCK TABLE report_detail_access IN SHARE MODE');
  return (await c.query(`SELECT g.id grant_id,g.org_unit_id,a.kinds FROM report_detail_access a
    JOIN role_grants g ON g.id=a.grant_id
    WHERE g.user_id=$1 AND a.permission_code=$2 AND a.revoked_at IS NULL AND a.valid_from<=now()
      AND (a.valid_until IS NULL OR a.valid_until>now()) AND g.revoked_at IS NULL
      AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
      AND (($2='report_detail.publish' AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL)
        OR ($2='report_detail.read' AND g.scope_kind='ORG_UNIT' AND g.org_unit_id IS NOT NULL))`,
  [auth.userId,permission])).rows as {grant_id:string;org_unit_id:string|null;kinds:DetailKind[]}[];
}
export async function detailPublisher(c:PoolClient,auth:AuthedUser,kind:DetailKind) {
  const grants=await detailAccess(c,auth,'report_detail.publish');
  if(grants.length!==1)throw new ApiError('FORBIDDEN','Нужно отдельное разрешение на публикацию детальных строк.');
  if(!grants[0].kinds.includes(kind))throw new ApiError('FORBIDDEN','Разрешение не покрывает этот вид детальной выгрузки.');
  return grants[0];
}
