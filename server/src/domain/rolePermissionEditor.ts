import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';

// Настройка наборов прав галочками.
//
// Стратегическая цель проекта — не менять код при обычном изменении полномочий.
// Поэтому наборы правятся в портале, но каждое изменение попадает в
// role_permission_changes: полномочия не должны меняться бесследно.
//
// Права ролей не совпадают с областью видимости. Набор отвечает «что можно
// делать», грант роли — «где». Этот экран меняет только первое.

async function assertPlatformOwner(c: PoolClient, user: AuthedUser): Promise<void> {
  if (user.viewAs) {
    throw new ApiError('VIEW_AS_READ_ONLY', 'Включён просмотр глазами роли — изменять права нельзя.');
  }
  const res = await c.query(
    `SELECT 1 FROM role_grants
     WHERE user_id = $1 AND role_code = 'SUPER_ADMIN' AND scope_kind = 'NETWORK'
       AND revoked_at IS NULL AND valid_from <= now()
       AND (valid_until IS NULL OR valid_until > now())`,
    [user.userId],
  );
  if (res.rowCount === 0) {
    throw new ApiError('FORBIDDEN', 'Настройка прав ролей доступна только владельцу платформы.');
  }
}

export async function readRoleMatrix(user: AuthedUser) {
  return withTransaction(async (c) => {
    await assertPlatformOwner(c, user);
    const permissions = (await c.query(
      `SELECT code, description FROM permissions ORDER BY code`,
    )).rows;
    const roles = (await c.query(
      `SELECT r.code, r.display_name, r.scope_kind, r.is_system,
              coalesce(array_agg(rp.permission_code ORDER BY rp.permission_code)
                       FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions,
              (SELECT count(*) FROM role_grants g
                WHERE g.role_code = r.code AND g.revoked_at IS NULL)::int AS grants
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_code = r.code
       GROUP BY r.code, r.display_name, r.scope_kind, r.is_system
       ORDER BY r.display_name`,
    )).rows;
    const history = (await c.query(
      `SELECT role_code, permission_code, action, actor_login, reason,
              to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at
       FROM role_permission_changes ORDER BY created_at DESC LIMIT 100`,
    )).rows;
    return { permissions, roles, history };
  });
}

export async function updateRolePermissions(user: AuthedUser, roleCode: string, raw: unknown) {
  const body = (raw ?? {}) as { permission_codes?: unknown; reason?: unknown };
  if (!Array.isArray(body.permission_codes) || body.permission_codes.some(v => typeof v !== 'string')) {
    throw new ApiError('VALIDATION_ERROR', 'Передайте перечень прав роли.');
  }
  const wanted = [...new Set(body.permission_codes as string[])];
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  return withTransaction(async (c) => {
    await assertPlatformOwner(c, user);

    const role = await c.query(`SELECT code, display_name FROM roles WHERE code = $1 FOR UPDATE`, [roleCode]);
    if (role.rowCount === 0) throw new ApiError('NOT_FOUND', 'Роль не найдена.');

    const known = (await c.query(`SELECT code FROM permissions`)).rows.map((r: { code: string }) => r.code);
    const unknown = wanted.filter(p => !known.includes(p));
    if (unknown.length) {
      throw new ApiError('VALIDATION_ERROR', `Портал не знает таких прав: ${unknown.join(', ')}.`);
    }

    // Роль владельца платформы через этот экран не урезается: иначе можно
    // одним снятием галочки лишить портал единственного администратора.
    if (roleCode === 'SUPER_ADMIN') {
      throw new ApiError('FORBIDDEN', 'Набор прав владельца платформы через этот экран не меняется.');
    }

    const current = (await c.query(
      `SELECT permission_code FROM role_permissions WHERE role_code = $1`, [roleCode],
    )).rows.map((r: { permission_code: string }) => r.permission_code);

    const granted = wanted.filter(p => !current.includes(p));
    const revoked = current.filter(p => !wanted.includes(p));

    for (const p of granted) {
      await c.query(
        `INSERT INTO role_permissions (role_code, permission_code) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`, [roleCode, p],
      );
    }
    if (revoked.length) {
      await c.query(
        `DELETE FROM role_permissions WHERE role_code = $1 AND permission_code = ANY($2::text[])`,
        [roleCode, revoked],
      );
    }
    for (const [action, list] of [['GRANTED', granted], ['REVOKED', revoked]] as const) {
      for (const p of list) {
        await c.query(
          `INSERT INTO role_permission_changes
             (role_code, permission_code, action, actor_user_id, actor_login, reason)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [roleCode, p, action, user.userId, user.login, reason],
        );
      }
    }

    // Пользователи с этой ролью должны увидеть новые полномочия без
    // перезахода: сессии сверяются с эпохой прав.
    if (granted.length || revoked.length) {
      await c.query(
        `UPDATE app_users SET auth_epoch = auth_epoch + 1
          WHERE id IN (SELECT user_id FROM role_grants
                       WHERE role_code = $1 AND revoked_at IS NULL)`,
        [roleCode],
      );
    }

    return {
      role_code: roleCode,
      granted, revoked,
      permissions: wanted.sort(),
    };
  });
}
