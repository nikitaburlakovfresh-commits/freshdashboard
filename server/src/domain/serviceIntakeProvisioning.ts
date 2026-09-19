// Явное создание сервисного субъекта приёма и публикации агрегатов.
// Создаётся только оператором, только с ссылкой на утверждение, только с
// закрытым перечнем публикуемых показателей и только от имени действующего
// администратора NETWORK. Никаких прав ролям целиком не выдаётся.
import { randomUUID } from 'crypto';
import { withTransaction } from '../db/pool';
import { writeAuditAndOutbox } from './auditOutbox';
import { METRIC_NAMES } from '../reporting/shared/reportModel';

const CODE = /^[a-z][a-z0-9_]{2,60}$/;

export async function provisionServiceIntakeActor(
  code: string,
  displayName: string,
  purpose: string,
  metrics: string[],
  approval: string,
  authorizedByLogin: string,
) {
  const clean = approval.trim();
  if (!CODE.test(code) || displayName.trim().length < 3 || displayName.length > 200 ||
      purpose.trim().length < 16 || purpose.length > 1000 ||
      clean.length < 16 || clean.length > 500 || !authorizedByLogin.trim())
    throw new Error('Explicit code, display name, purpose, approval reference and authorizing administrator login required');
  if (!metrics.length || metrics.length > 8 || new Set(metrics).size !== metrics.length ||
      metrics.some(m => !Object.keys(METRIC_NAMES).includes(m)))
    throw new Error('Closed metric allowlist of 1..8 known aggregate metrics required');

  return withTransaction(async c => {
    await c.query(`LOCK TABLE app_users,role_grants,roles,role_permissions,report_staging_access,
      report_fact_access,service_intake_actors,service_intake_authorizations IN SHARE ROW EXCLUSIVE MODE`);

    // Утверждающий администратор обязан существовать как живая личная учётная
    // запись с действующим NETWORK-грантом. Сервисный субъект не создаёт себя сам.
    const admin = (await c.query(
      `SELECT u.id, g.id grant_id FROM app_users u
         JOIN role_grants g ON g.user_id=u.id
        WHERE lower(u.login)=lower($1) AND u.is_active AND u.user_kind='INDIVIDUAL'
          AND NOT u.password_last_shared_indicator
          AND g.role_code='SUPER_ADMIN' AND g.scope_kind='NETWORK' AND g.org_unit_id IS NULL
          AND g.revoked_at IS NULL AND g.valid_from<=now()
          AND (g.valid_until IS NULL OR g.valid_until>now())`, [authorizedByLogin.trim()])).rows[0];
    if (!admin) throw new Error('Authorizing administrator with active NETWORK grant not found');

    if ((await c.query('SELECT 1 FROM service_intake_actors WHERE code=$1', [code])).rowCount)
      throw new Error('Service actor code already exists; revoke instead of overwriting');

    const userId = randomUUID();
    const login = `service.${code}`;
    // Пароля у сервисного субъекта нет. Значение-маркер не является хэшем
    // какого-либо пароля, а вход в портал для user_kind='SERVICE' невозможен.
    await c.query(
      `INSERT INTO app_users(id,login,full_name,user_kind,password_hash,password_hash_updated_at,is_active)
       VALUES($1,$2,$3,'SERVICE',$4,now(),true)`,
      [userId, login, displayName.trim(), `service-actor-no-password:${randomUUID()}`]);

    const grantId = randomUUID();
    await c.query(
      `INSERT INTO role_grants(id,user_id,role_code,scope_kind,org_unit_id,valid_from)
       VALUES($1,$2,'SUPER_ADMIN','NETWORK',NULL,now())`, [grantId, userId]);

    const eventId = randomUUID();
    const audit = await writeAuditAndOutbox(c, {
      actorUserId: admin.id, actorRole: 'SUPER_ADMIN', orgUnitId: null, workItemId: null,
      action: 'SERVICE_INTAKE_ACTOR_PROVISIONED', aggregateType: 'service_intake',
      aggregateId: eventId, aggregateVersion: 1, requestId: eventId,
      beforeState: null,
      afterState: { code, login, grant_id: grantId, metrics, approval_reference: clean, purpose: purpose.trim() },
      reason: clean, resolution: 'APPLIED', retentionClass: 'SECURITY_5Y',
      eventType: 'service_intake.actor_provisioned', payload: { code, grant_id: grantId },
    });

    // Право выдаётся роли явно и идемпотентно: перечень прав SUPER_ADMIN
    // остаётся наблюдаемым, скрытого расширения полномочий нет.
    await c.query(
      `INSERT INTO role_permissions(role_code,permission_code) VALUES('SUPER_ADMIN','service_intake.execute')
       ON CONFLICT DO NOTHING`);
    await c.query(
      `INSERT INTO service_intake_actors(user_id,code,display_name,purpose,approval_reference,created_by,audit_id)
       VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [userId, code, displayName.trim(), purpose.trim(), clean, admin.id, audit]);
    for (const capability of ['INTAKE', 'PUBLISH', 'CONFIGURE'] as const)
      await c.query(
        `INSERT INTO service_intake_authorizations(id,actor_user_id,grant_id,capability,approval_reference,audit_id)
         VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), userId, grantId, capability, clean, audit]);

    // Право на приём и закрытый перечень публикуемых показателей живут в тех же
    // таблицах, что и у людей: сервисный контур не создаёт второго источника прав.
    await c.query(
      `INSERT INTO report_staging_access(grant_id,permission_code,audit_id,approval_reference)
       VALUES($1,'data_source.probe',$2,$3)`, [grantId, audit, clean]);
    await c.query(
      `INSERT INTO report_fact_access(grant_id,capability,metrics,approval_reference,audit_id)
       VALUES($1,'PUBLISH',$2,$3,$4)`, [grantId, metrics, clean, audit]);

    return { code, login, user_id: userId, grant_id: grantId, metrics, status: 'PROVISIONED' };
  });
}

export async function revokeServiceIntakeActor(code: string, reason: string) {
  const clean = reason.trim();
  if (!CODE.test(code) || clean.length < 16 || clean.length > 500)
    throw new Error('Explicit actor code and revocation reason required');
  return withTransaction(async c => {
    await c.query(`LOCK TABLE service_intake_actors,service_intake_authorizations,
      report_staging_access,report_fact_access,role_grants,app_users IN SHARE ROW EXCLUSIVE MODE`);
    const actor = (await c.query(
      'SELECT user_id FROM service_intake_actors WHERE code=$1 AND revoked_at IS NULL', [code])).rows[0];
    if (!actor) throw new Error('Active service actor not found');
    await c.query('UPDATE service_intake_actors SET revoked_at=now(), revoke_reason=$2 WHERE user_id=$1',
      [actor.user_id, clean]);
    await c.query('UPDATE service_intake_authorizations SET revoked_at=now() WHERE actor_user_id=$1 AND revoked_at IS NULL',
      [actor.user_id]);
    await c.query(`UPDATE report_fact_access a SET revoked_at=now()
      FROM role_grants g WHERE g.id=a.grant_id AND g.user_id=$1 AND a.revoked_at IS NULL`, [actor.user_id]);
    await c.query(`UPDATE report_staging_access p SET revoked_at=now()
      FROM role_grants g WHERE g.id=p.grant_id AND g.user_id=$1 AND p.revoked_at IS NULL`, [actor.user_id]);
    await c.query('UPDATE role_grants SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [actor.user_id]);
    await c.query('UPDATE app_users SET is_active=false WHERE id=$1', [actor.user_id]);
    return { code, status: 'REVOKED' };
  });
}
