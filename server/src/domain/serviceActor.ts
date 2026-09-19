// Авторизация сервисного субъекта приёма и публикации агрегатов.
// Сервисный субъект не имеет и не может иметь сессии: вход в портал требует
// user_kind='INDIVIDUAL'. Поэтому здесь проверяется не сессия, а явная
// возможность (INTAKE/PUBLISH) с ссылкой на утверждение и действующий
// NETWORK-грант. Перечень показателей сервисный контур не расширяет.
import type { PoolClient } from 'pg';
import type { AuthedUser } from '../auth/session';

export type ServiceCapability = 'INTAKE' | 'PUBLISH' | 'CONFIGURE';

export interface ServiceAuthorization {
  actorUserId: string;
  actorCode: string;
  grantId: string;
  capability: ServiceCapability;
  approvalReference: string;
}

/** Действующая возможность сервисного субъекта или null, если субъект не
 * сервисный. Отсутствие возможности у сервисного субъекта — это null, а не
 * молчаливое расширение прав: вызывающий код обязан отказать. */
export async function serviceAuthorization(
  client: PoolClient,
  userId: string,
  capability: ServiceCapability,
): Promise<ServiceAuthorization | null> {
  await client.query(
    'LOCK TABLE app_users, role_grants, roles, role_permissions, service_intake_actors, service_intake_authorizations IN SHARE MODE',
  );
  const res = await client.query(
    `SELECT a.user_id, a.code, z.grant_id, z.capability, z.approval_reference
       FROM service_intake_actors a
       JOIN app_users u ON u.id=a.user_id
       JOIN service_intake_authorizations z ON z.actor_user_id=a.user_id
       JOIN role_grants g ON g.id=z.grant_id AND g.user_id=a.user_id
       JOIN roles r ON r.code=g.role_code AND r.scope_kind=g.scope_kind
       JOIN role_permissions rp ON rp.role_code=r.code AND rp.permission_code='service_intake.execute'
      WHERE a.user_id=$1 AND a.revoked_at IS NULL
        AND u.is_active AND u.user_kind='SERVICE'
        AND z.capability=$2 AND z.revoked_at IS NULL
        AND z.valid_from<=clock_timestamp()
        AND (z.valid_until IS NULL OR clock_timestamp()<z.valid_until)
        AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
        AND g.revoked_at IS NULL AND g.valid_from<=clock_timestamp()
        AND (g.valid_until IS NULL OR clock_timestamp()<g.valid_until)`,
    [userId, capability],
  );
  if (res.rowCount !== 1) return null;
  const row = res.rows[0];
  return {
    actorUserId: row.user_id as string,
    actorCode: row.code as string,
    grantId: row.grant_id as string,
    capability: row.capability as ServiceCapability,
    approvalReference: row.approval_reference as string,
  };
}

/** Является ли субъект сервисным (независимо от наличия возможностей).
 * Нужен, чтобы человеческие проверки сессии не применялись к сервисному
 * субъекту, а отказ формулировался по его собственным правилам. */
export async function isServiceActor(client: PoolClient, userId: string): Promise<boolean> {
  const res = await client.query(
    `SELECT 1 FROM app_users u JOIN service_intake_actors a ON a.user_id=u.id
      WHERE u.id=$1 AND u.user_kind='SERVICE'`,
    [userId],
  );
  return res.rowCount === 1;
}

/** Контекст сервисного субъекта в форме, которую принимают существующие
 * функции приёма. sessionId намеренно пустой: сессии у сервисного субъекта
 * нет, и ни одна человеческая проверка её не найдёт. */
export function serviceAuthedUser(userId: string, code: string): AuthedUser {
  return {
    sessionId: '00000000-0000-0000-0000-000000000000',
    userId,
    login: `service:${code}`,
    fullName: `Сервисный контур приёма (${code})`,
    csrfToken: '',
    rawToken: '',
  };
}
