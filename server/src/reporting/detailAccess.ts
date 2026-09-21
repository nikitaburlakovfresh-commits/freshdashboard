import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { liveFence } from '../domain/dailyLogs';
import { isServiceActor, serviceAuthorization } from '../domain/serviceActor';
import type { DetailKind } from './shared/detailModel';

// Детальный контур — отдельное право. Доступ к агрегатам его не даёт,
// операторского обхода нет: грант выдаётся человеку и проверяется на живой сессии.
export async function detailAccess(c:PoolClient,auth:AuthedUser,permission:'report_detail.publish'|'report_detail.read') {
  // Сервисный субъект приёма: сессии у него нет и быть не может, поэтому
  // проверяется явная возможность PUBLISH и то же разрешение на детальный
  // контур, выданное его гранту. Реестр склада приходит ежедневно, и его приём
  // не должен зависеть от того, зашёл ли человек в портал. Человеческие правила
  // при этом не ослабляются.
  if(await isServiceActor(c,auth.userId)) {
    if(permission!=='report_detail.publish')
      throw new ApiError('FORBIDDEN','Сервисный субъект читает только через публикацию.');
    const service=await serviceAuthorization(c,auth.userId,'PUBLISH');
    if(!service)throw new ApiError('FORBIDDEN','Сервисному субъекту не выдана действующая возможность PUBLISH.');
    await c.query('LOCK TABLE report_detail_access IN SHARE MODE');
    const rows=(await c.query(`SELECT a.grant_id,NULL::uuid org_unit_id,a.kinds FROM report_detail_access a
      WHERE a.grant_id=$1 AND a.permission_code='report_detail.publish' AND a.revoked_at IS NULL
        AND a.valid_from<=clock_timestamp()
        AND (a.valid_until IS NULL OR clock_timestamp()<a.valid_until)`,[service.grantId])).rows;
    return rows as {grant_id:string;org_unit_id:string|null;kinds:DetailKind[]}[];
  }
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
