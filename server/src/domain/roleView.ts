import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { AuthedUser, VIEW_AS_TTL_MS } from '../auth/session';
import { ApiError } from '../util/errors';

// Просмотр «глазами роли» для владельца платформы.
//
// Образец — старый портал (/opt/fresh-rbac/server.cjs): вход на 30 минут,
// журнал входов и выходов, запрет вложенности, запрет входа под другим
// администратором, баннер с таймером и возвратом.
//
// Отличие от старого портала: режим только для чтения. Атрибуция в аудите
// должна оставаться честной.

interface ViewCandidate {
  user_id: string;
  login: string;
  full_name: string;
  role_code: string;
  role_name: string;
  scope_kind: string;
  org_unit_id: string | null;
  org_unit_name: string | null;
}

// Право входа — только у действующего владельца платформы. Проверяется сам
// грант роли, а не производное право: режим просмотра показывает чужие
// экраны и не должен открываться по частичному набору прав.
async function assertPlatformOwner(c: PoolClient, user: AuthedUser): Promise<void> {
  const res = await c.query(
    `SELECT 1 FROM role_grants
     WHERE user_id = $1 AND role_code = 'SUPER_ADMIN' AND scope_kind = 'NETWORK'
       AND revoked_at IS NULL AND valid_from <= now()
       AND (valid_until IS NULL OR valid_until > now())`,
    [user.viewAs ? user.viewAs.adminUserId : user.userId],
  );
  if (res.rowCount === 0) {
    throw new ApiError('FORBIDDEN', 'Просмотр глазами роли доступен только владельцу платформы.');
  }
}

// Кого можно посмотреть: действующие персональные учётные записи с
// действующим грантом, кроме владельцев платформы и самого себя. Сгруппировано
// по роли, чтобы в интерфейсе был выбор именно роли.
export async function listViewCandidates(user: AuthedUser): Promise<{
  roles: { role_code: string; role_name: string; scope_kind: string; candidates: ViewCandidate[] }[];
}> {
  return withTransaction(async (c) => {
    await assertPlatformOwner(c, user);
    const adminId = user.viewAs ? user.viewAs.adminUserId : user.userId;
    const res = await c.query(
      `SELECT DISTINCT u.id AS user_id, u.login, u.full_name,
              r.code AS role_code, r.display_name AS role_name, g.scope_kind,
              g.org_unit_id, n.display_name AS org_unit_name
       FROM role_grants g
       JOIN app_users u ON u.id = g.user_id
       JOIN roles r ON r.code = g.role_code
       LEFT JOIN org_directory_name_history n
         ON n.org_unit_id = g.org_unit_id AND n.effective_to IS NULL
       WHERE g.revoked_at IS NULL AND g.valid_from <= now()
         AND (g.valid_until IS NULL OR g.valid_until > now())
         AND u.is_active AND u.user_kind = 'INDIVIDUAL'
         AND NOT u.password_last_shared_indicator
         AND u.id <> $1
         AND g.role_code <> 'SUPER_ADMIN'
       ORDER BY r.display_name, u.full_name, n.display_name`,
      [adminId],
    );
    const byRole = new Map<string, { role_code: string; role_name: string; scope_kind: string; candidates: ViewCandidate[] }>();
    for (const row of res.rows as ViewCandidate[]) {
      if (!byRole.has(row.role_code)) {
        byRole.set(row.role_code, {
          role_code: row.role_code,
          role_name: row.role_name,
          scope_kind: row.scope_kind,
          candidates: [],
        });
      }
      byRole.get(row.role_code)!.candidates.push(row);
    }
    return { roles: [...byRole.values()] };
  });
}

export async function enterRoleView(
  user: AuthedUser,
  body: unknown,
  ip: string | null,
  userAgent: string | null,
): Promise<{ ok: true; viewing: { login: string; full_name: string }; expires_at: string }> {
  const targetUserId = (body as { user_id?: unknown } | null)?.user_id;
  if (typeof targetUserId !== 'string' || !targetUserId) {
    throw new ApiError('VALIDATION_ERROR', 'Укажите учётную запись для просмотра.');
  }
  if (user.viewAs) {
    throw new ApiError('INVALID_TRANSITION', 'Просмотр уже включён. Сначала вернитесь к своей учётной записи.');
  }

  return withTransaction(async (c) => {
    await assertPlatformOwner(c, user);

    const target = await c.query(
      `SELECT u.id, u.login, u.full_name, u.is_active, u.user_kind,
              u.password_last_shared_indicator,
              EXISTS(SELECT 1 FROM role_grants g WHERE g.user_id = u.id
                     AND g.role_code = 'SUPER_ADMIN' AND g.revoked_at IS NULL) AS is_owner
       FROM app_users u WHERE u.id = $1 FOR UPDATE`,
      [targetUserId],
    );
    if (target.rowCount === 0) {
      throw new ApiError('NOT_FOUND', 'Учётная запись не найдена.');
    }
    const t = target.rows[0];
    if (!t.is_active || t.user_kind !== 'INDIVIDUAL' || t.password_last_shared_indicator) {
      throw new ApiError('VALIDATION_ERROR', 'Учётная запись недоступна для просмотра.');
    }
    if (t.is_owner) {
      throw new ApiError('FORBIDDEN', 'Нельзя смотреть глазами другого владельца платформы.');
    }
    if (t.id === user.userId) {
      throw new ApiError('VALIDATION_ERROR', 'Это ваша собственная учётная запись.');
    }

    const expiresAt = new Date(Date.now() + VIEW_AS_TTL_MS);
    const upd = await c.query(
      `UPDATE sessions
          SET view_as_user_id = $2, view_as_expires_at = $3, view_as_started_at = now()
        WHERE id = $1 AND revoked_at IS NULL AND view_as_user_id IS NULL
        RETURNING id`,
      [user.sessionId, targetUserId, expiresAt],
    );
    if (upd.rowCount === 0) {
      throw new ApiError('INVALID_TRANSITION', 'Сессия недоступна или просмотр уже включён.');
    }

    // Роль и филиал в журнал пишем как первый действующий грант цели: журнал
    // должен отвечать на вопрос «чьими глазами смотрели», а не только «под кем».
    const grant = await c.query(
      `SELECT role_code, org_unit_id FROM role_grants
       WHERE user_id = $1 AND revoked_at IS NULL AND valid_from <= now()
         AND (valid_until IS NULL OR valid_until > now())
       ORDER BY valid_from LIMIT 1`,
      [targetUserId],
    );
    await c.query(
      `INSERT INTO role_view_log(session_id, admin_user_id, admin_login, target_user_id,
           target_login, target_role_code, target_org_unit_id, action, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ENTER',$8,$9)`,
      [
        user.sessionId, user.userId, user.login, targetUserId, t.login,
        grant.rows[0]?.role_code ?? null, grant.rows[0]?.org_unit_id ?? null,
        ip, userAgent ? userAgent.slice(0, 500) : null,
      ],
    );

    return {
      ok: true as const,
      viewing: { login: t.login, full_name: t.full_name },
      expires_at: expiresAt.toISOString(),
    };
  });
}

export async function exitRoleView(
  user: AuthedUser,
  ip: string | null,
  userAgent: string | null,
): Promise<{ ok: true; restored_as: { login: string; full_name: string } }> {
  if (!user.viewAs) {
    throw new ApiError('INVALID_TRANSITION', 'Просмотр глазами роли не включён.');
  }
  const admin = user.viewAs;
  return withTransaction(async (c) => {
    await c.query(
      `UPDATE sessions SET view_as_user_id = NULL, view_as_expires_at = NULL,
              view_as_started_at = NULL
        WHERE id = $1`,
      [user.sessionId],
    );
    await c.query(
      `INSERT INTO role_view_log(session_id, admin_user_id, admin_login, target_user_id,
           target_login, action, ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,'EXIT',$6,$7)`,
      [
        user.sessionId, admin.adminUserId, admin.adminLogin, user.userId, user.login,
        ip, userAgent ? userAgent.slice(0, 500) : null,
      ],
    );
    return {
      ok: true as const,
      restored_as: { login: admin.adminLogin, full_name: admin.adminFullName },
    };
  });
}

export function roleViewStatus(user: AuthedUser): {
  viewing: boolean;
  as: { login: string; full_name: string } | null;
  admin: { login: string; full_name: string } | null;
  expires_at: string | null;
} {
  if (!user.viewAs) {
    return { viewing: false, as: null, admin: null, expires_at: null };
  }
  return {
    viewing: true,
    as: { login: user.login, full_name: user.fullName },
    admin: { login: user.viewAs.adminLogin, full_name: user.viewAs.adminFullName },
    expires_at: user.viewAs.expiresAt,
  };
}
