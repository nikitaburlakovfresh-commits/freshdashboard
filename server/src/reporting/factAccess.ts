import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { liveFence } from '../domain/dailyLogs';
import { isServiceActor, serviceAuthorization } from '../domain/serviceActor';

export async function factAccess(c:PoolClient,auth:AuthedUser,capability:'PUBLISH'|'READ') {
  // Сервисный субъект не имеет сессии и не получает READ: чтение показателей
  // остаётся за людьми с областью видимости. Ему доступна только публикация
  // проверенного среза в пределах перечня показателей из report_fact_access.
  if(await isServiceActor(c,auth.userId)) {
    if(capability!=='PUBLISH')
      throw new ApiError('FORBIDDEN','Сервисный субъект не имеет доступа на чтение опубликованных показателей.');
    const service=await serviceAuthorization(c,auth.userId,'PUBLISH');
    if(!service) throw new ApiError('FORBIDDEN','Сервисному субъекту не выдана действующая возможность PUBLISH.');
    await c.query('LOCK TABLE report_fact_access IN SHARE MODE');
    return (await c.query(`SELECT g.id grant_id,g.org_unit_id,a.metrics FROM report_fact_access a
      JOIN role_grants g ON g.id=a.grant_id
      WHERE a.grant_id=$1 AND a.capability='PUBLISH' AND a.revoked_at IS NULL
        AND a.valid_from<=now() AND (a.valid_until IS NULL OR a.valid_until>now())`,
    [service.grantId])).rows as {grant_id:string;org_unit_id:string|null;metrics:string[]}[];
  }
  await liveFence(c,{authUser:auth,requestId:'fact-access',ip:null,userAgent:null});
  await c.query('LOCK TABLE report_fact_access IN SHARE MODE');
  const rows=(await c.query(`SELECT g.id grant_id,g.org_unit_id,g.scope_kind,a.metrics FROM report_fact_access a
    JOIN role_grants g ON g.id=a.grant_id
    WHERE g.user_id=$1 AND a.capability=$2 AND a.revoked_at IS NULL AND a.valid_from<=now()
      AND (a.valid_until IS NULL OR a.valid_until>now()) AND g.revoked_at IS NULL
      AND g.valid_from<=now() AND (g.valid_until IS NULL OR g.valid_until>now())
      AND (($2='PUBLISH' AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL)
        OR ($2='READ' AND g.scope_kind='ORG_UNIT' AND g.org_unit_id IS NOT NULL))`,
  [auth.userId,capability])).rows as Grant[];
  // Неявного сетевого читателя нет: чтение выдаётся допуском на конкретный
  // филиал. Сетевая область видимости собирается из перечня таких допусков.
  return rows.map(stripScope);
}
interface Grant {grant_id:string;org_unit_id:string|null;scope_kind:string;metrics:string[]}
const stripScope=(g:Grant)=>({grant_id:g.grant_id,org_unit_id:g.org_unit_id,metrics:g.metrics});
export async function publisher(c:PoolClient,auth:AuthedUser) {
  const grants=await factAccess(c,auth,'PUBLISH');
  if(grants.length!==1)throw new ApiError('FORBIDDEN','Нужно отдельное разрешение на публикацию агрегатов. Доступ к черновикам его не даёт.');
  return grants[0];
}

/**
 * Просмотр всей сети без управления (право metric.network.peer_view, решение
 * владельца 26.09.2026). Возвращает null, если права нет. Иначе — допуск на
 * чтение всех незакрытых филиалов по всем опубликованным показателям и список
 * собственных филиалов пользователя (для большой плитки «мой филиал»).
 * Задачи, фамилии и изменения этим правом не открываются — это решают
 * вызывающие функции.
 */
export async function peerAccess(c:PoolClient,auth:AuthedUser) {
  const own=(await c.query(`SELECT DISTINCT g.org_unit_id FROM role_grants g
    JOIN role_permissions rp ON rp.role_code=g.role_code AND rp.permission_code='metric.network.peer_view'
    WHERE g.user_id=$1 AND g.org_unit_id IS NOT NULL AND g.revoked_at IS NULL AND g.valid_from<=now()
      AND (g.valid_until IS NULL OR g.valid_until>now())`,[auth.userId])).rows.map((r:any)=>r.org_unit_id as string);
  if(!own.length) return null;
  const metrics=(await c.query(`SELECT DISTINCT metric FROM report_fact_current`)).rows.map((r:any)=>r.metric as string);
  const orgs=(await c.query(`SELECT id FROM org_directory_units
    WHERE kind='ORG_UNIT' AND lifecycle_state<>'CLOSED' AND NOT is_demo`)).rows.map((r:any)=>r.id as string);
  return {own_org_unit_ids:own,
    grants:orgs.map(org_unit_id=>({grant_id:'peer',org_unit_id,metrics}))};
}
