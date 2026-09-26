import argon2 from 'argon2';
import { PoolClient } from 'pg';
import { withTransaction } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';

// Самостоятельная регистрация сотрудника с подтверждением владельцем платформы.
//
// Решение владельца (21.09.2026): человек сам заполняет форму при первом
// входе, владелец платформы подтверждает активацию.
//
// Пароль сотрудник задаёт сам и он сразу хранится хешем. Так после
// подтверждения никому не нужно передавать пароль — правило проекта прямо
// запрещает пароли в переписке.
//
// До подтверждения человека нет ни в app_users, ни в оргструктуре: незакрытая
// заявка не должна выглядеть действующим сотрудником филиала.

const LOGIN_RE = /^[a-z][a-z0-9._-]{2,63}$/;

async function assertPlatformOwner(c: PoolClient, user: AuthedUser): Promise<void> {
  if (user.viewAs) {
    throw new ApiError('VIEW_AS_READ_ONLY', 'Включён просмотр глазами роли — решения по заявкам недоступны.');
  }
  const res = await c.query(
    `SELECT 1 FROM role_grants
     WHERE user_id = $1 AND role_code = 'SUPER_ADMIN' AND scope_kind = 'NETWORK'
       AND revoked_at IS NULL AND valid_from <= now()
       AND (valid_until IS NULL OR valid_until > now())`,
    [user.userId],
  );
  if (res.rowCount === 0) {
    throw new ApiError('FORBIDDEN', 'Решения по заявкам принимает владелец платформы.');
  }
}

/** Справочник для формы регистрации. Открыт без входа: человек ещё не в портале.
 *  Наружу отдаются только названия ролей и филиалов — ни людей, ни показателей. */
export async function registrationDirectory() {
  return withTransaction(async (c) => {
    const roles = (await c.query(
      `SELECT code, display_name,
              CASE WHEN code IN ('REGIONAL_MANAGER','DIVISION_MANAGER') THEN 'NETWORK' ELSE scope_kind END AS scope_kind FROM roles
        WHERE code NOT IN ('SUPER_ADMIN','SHARED_LOGIN') AND NOT hidden_in_registration
        ORDER BY display_name`,
    )).rows;
    const branches = (await c.query(
      `SELECT u.id, n.display_name
         FROM org_directory_units u
         JOIN org_directory_name_history n
           ON n.org_unit_id = u.id AND n.effective_to IS NULL
        WHERE u.kind = 'ORG_UNIT' AND NOT u.is_demo
        ORDER BY n.display_name`,
    )).rows;
    return { roles, branches };
  });
}

/** Значение выбора «ГК Fresh, управляющая компания» в поле подразделения. */
export const UC_CHOICE = 'FRESH_UC';
/** Должности УК, которые закрепляются за зоной РМ или дивизионом, а не за одним филиалом. */
export const ZONE_ROLES = new Set(['REGIONAL_MANAGER', 'DIVISION_MANAGER']);

export async function submitRegistration(raw: unknown) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' ? v.trim() : '';
  const login = text(b.login).toLowerCase();
  const fullName = text(b.full_name);
  const email = text(b.primary_email).toLowerCase();
  const phone = text(b.phone);
  const roleCode = text(b.requested_role_code);
  // Подразделение: идентификатор филиала из справочника либо признак УК.
  // Роль сетевого уровня работает без филиала (role_grants: NETWORK + NULL),
  // роль уровня филиала без филиала не имеет области видимости.
  const unitChoice = text(b.requested_org_unit_id);
  const isHeadOffice = unitChoice === UC_CHOICE;
  const orgUnitId = isHeadOffice ? null : (unitChoice || null);
  const comment = text(b.comment) || null;
  const password = typeof b.password === 'string' ? b.password : '';

  if (!LOGIN_RE.test(login)) {
    throw new ApiError('VALIDATION_ERROR', 'Логин: от 3 до 64 знаков, строчные латинские буквы, цифры, точка, дефис или подчёркивание.');
  }
  if (fullName.length < 3 || fullName.length > 200) {
    throw new ApiError('VALIDATION_ERROR', 'Укажите фамилию и имя: от 3 до 200 знаков.');
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError('VALIDATION_ERROR', 'Проверьте адрес рабочей почты.');
  }
  if (password.length < 12 || password.length > 200) {
    throw new ApiError('VALIDATION_ERROR', 'Пароль должен быть не короче 12 знаков.');
  }
  if (!roleCode) {
    throw new ApiError('VALIDATION_ERROR', 'Выберите должность.');
  }

  const hash = await argon2.hash(password, { type: argon2.argon2id });

  return withTransaction(async (c) => {
    const role = await c.query(`SELECT code, scope_kind FROM roles WHERE code = $1`, [roleCode]);
    if (role.rowCount === 0 || roleCode === 'SUPER_ADMIN') {
      throw new ApiError('VALIDATION_ERROR', 'Выберите должность из списка.');
    }
    const scopeKind = role.rows[0].scope_kind as string;
    if (scopeKind === 'NETWORK' && !isHeadOffice) {
      throw new ApiError('VALIDATION_ERROR', 'Для этой должности подразделение — ГК Fresh (управляющая компания).');
    }
    // РМ и дивизиональный руководитель — должности управляющей компании (решение
    // владельца 26.09.2026): при регистрации выбирают «ГК Fresh», зону филиалов
    // администратор закрепляет при подтверждении.
    const zoneRole = ZONE_ROLES.has(roleCode);
    if (zoneRole && !isHeadOffice) {
      throw new ApiError('VALIDATION_ERROR', 'Эта должность относится к управляющей компании: выберите «ГК Fresh · управляющая компания».');
    }
    if (scopeKind === 'ORG_UNIT' && !zoneRole) {
      if (isHeadOffice || !orgUnitId) {
        throw new ApiError('VALIDATION_ERROR', 'Для этой должности выберите филиал из списка.');
      }
      const unit = await c.query(`SELECT 1 FROM org_directory_units WHERE id = $1 AND kind = 'ORG_UNIT'`, [orgUnitId]);
      if (unit.rowCount === 0) throw new ApiError('VALIDATION_ERROR', 'Выберите филиал из списка.');
    }

    // Занятый логин не подсказывает, существует ли учётная запись: сообщение
    // одинаково и для занятого логина, и для уже поданной заявки.
    const taken = await c.query(
      `SELECT 1 FROM app_users WHERE lower(login) = $1
       UNION ALL SELECT 1 FROM registration_requests WHERE login = $1 AND status = 'PENDING'`,
      [login],
    );
    if (taken.rowCount) {
      throw new ApiError('SUBMISSION_CONFLICT', 'Этот логин занят или заявка на него уже рассматривается. Выберите другой логин или обратитесь к администратору портала.');
    }

    const row = (await c.query(
      `INSERT INTO registration_requests
         (login, full_name, primary_email, phone, requested_role_code,
          requested_org_unit_id, comment, password_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, to_char(created_at,'YYYY-MM-DD HH24:MI') AS created_at`,
      [login, fullName, email || null, phone || null, roleCode, orgUnitId, comment, hash],
    )).rows[0];

    return {
      ok: true as const,
      request_id: row.id,
      created_at: row.created_at,
      message: 'Заявка отправлена. Доступ появится после подтверждения администратором портала — войдите тем же логином и паролем после подтверждения.',
    };
  });
}

/** Счётчик для колокольчика. Отдельно от списка: его дёргают часто. */
export async function pendingRegistrationCount(user: AuthedUser) {
  return withTransaction(async (c) => {
    const owner = await c.query(
      `SELECT 1 FROM role_grants
       WHERE user_id = $1 AND role_code = 'SUPER_ADMIN' AND scope_kind = 'NETWORK'
         AND revoked_at IS NULL`,
      [user.viewAs ? user.viewAs.adminUserId : user.userId],
    );
    if (owner.rowCount === 0) return { pending: 0 };
    const res = await c.query(`SELECT count(*)::int AS pending FROM registration_requests WHERE status = 'PENDING'`);
    return { pending: res.rows[0].pending as number };
  });
}

export async function listRegistrationRequests(user: AuthedUser, status: string) {
  const wanted = ['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : 'PENDING';
  return withTransaction(async (c) => {
    await assertPlatformOwner(c, user);
    const rows = (await c.query(
      `SELECT r.id, r.login, r.full_name, r.primary_email, r.phone, r.comment,
              r.requested_role_code, ro.display_name AS role_name,
              r.requested_org_unit_id, n.display_name AS org_unit_name,
              r.status, r.decision_reason,
              to_char(r.created_at,'YYYY-MM-DD HH24:MI') AS created_at,
              to_char(r.decided_at,'YYYY-MM-DD HH24:MI') AS decided_at,
              d.login AS decided_by_login
         FROM registration_requests r
         JOIN roles ro ON ro.code = r.requested_role_code
         LEFT JOIN org_directory_name_history n
           ON n.org_unit_id = r.requested_org_unit_id AND n.effective_to IS NULL
         LEFT JOIN app_users d ON d.id = r.decided_by
        WHERE r.status = $1
        ORDER BY r.created_at DESC LIMIT 200`,
      [wanted],
    )).rows;
    // Зоны РМ и дивизионы с действующими филиалами: РМ и дивизиональный руководитель
    // закрепляются за зоной целиком, а не за одним филиалом (решение владельца 26.09.2026).
    const zones = (await c.query(
      `WITH RECURSIVE tree AS (
         SELECT a.parent_id AS top_id, a.org_unit_id FROM org_directory_affiliation_history a
          WHERE a.effective_to IS NULL
         UNION ALL
         SELECT t.top_id, a.org_unit_id FROM tree t JOIN org_directory_affiliation_history a
           ON a.parent_id = t.org_unit_id AND a.effective_to IS NULL)
       SELECT z.id, z.kind, zn.display_name,
              json_agg(json_build_object('id', b.id, 'display_name', bn.display_name) ORDER BY bn.display_name) AS branches
         FROM org_directory_units z
         JOIN org_directory_name_history zn ON zn.org_unit_id = z.id AND zn.effective_to IS NULL
         JOIN tree t ON t.top_id = z.id
         JOIN org_directory_units b ON b.id = t.org_unit_id AND b.kind = 'ORG_UNIT' AND NOT b.is_demo
         JOIN org_directory_name_history bn ON bn.org_unit_id = b.id AND bn.effective_to IS NULL
        WHERE z.kind IN ('CLUSTER','DIVISION')
        GROUP BY z.id, z.kind, zn.display_name ORDER BY z.kind, zn.display_name`,
    )).rows;
    return { status: wanted, items: rows, zones };
  });
}

export async function decideRegistration(
  user: AuthedUser, id: string, action: 'approve' | 'reject', raw: unknown,
) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  // Роль и филиал администратор может поправить при подтверждении: сотрудник
  // мог указать их неточно, а переспрашивать через отклонение — лишний круг.
  const roleOverride = typeof b.role_code === 'string' && b.role_code.trim() ? b.role_code.trim() : null;
  const unitOverride = typeof b.org_unit_id === 'string' && b.org_unit_id.trim() ? b.org_unit_id.trim() : null;

  if (action === 'reject' && !reason) {
    throw new ApiError('VALIDATION_ERROR', 'Укажите причину отказа — человек должен понимать, что исправить.');
  }

  return withTransaction(async (c) => {
    await assertPlatformOwner(c, user);
    const req = (await c.query(
      `SELECT * FROM registration_requests WHERE id = $1 FOR UPDATE`, [id],
    )).rows[0];
    if (!req) throw new ApiError('NOT_FOUND', 'Заявка не найдена.');
    if (req.status !== 'PENDING') {
      throw new ApiError('INVALID_TRANSITION', `Заявка уже рассмотрена: ${req.status === 'APPROVED' ? 'подтверждена' : 'отклонена'}.`);
    }

    if (action === 'reject') {
      await c.query(
        `UPDATE registration_requests
            SET status='REJECTED', decided_by=$2, decided_at=now(), decision_reason=$3
          WHERE id=$1`,
        [id, user.userId, reason],
      );
      return { ok: true as const, status: 'REJECTED' as const };
    }

    const roleCode = roleOverride ?? req.requested_role_code;
    // Администратор может сменить подразделение при подтверждении: выбор УК
    // означает именно «без филиала», а не «взять из заявки».
    const orgUnitId = unitOverride === UC_CHOICE ? null
      : unitOverride ?? req.requested_org_unit_id;

    const role = await c.query(`SELECT scope_kind FROM roles WHERE code = $1`, [roleCode]);
    if (role.rowCount === 0 || roleCode === 'SUPER_ADMIN') {
      throw new ApiError('VALIDATION_ERROR', 'Роль недопустима для подтверждения заявки.');
    }
    const approveScope = role.rows[0].scope_kind as string;
    if (approveScope === 'ORG_UNIT' && !orgUnitId) {
      throw new ApiError('VALIDATION_ERROR', ZONE_ROLES.has(roleCode)
        ? 'Выберите зону РМ или дивизион: без них сотрудник не увидит ни одного филиала.'
        : 'Укажите филиал: без области видимости сотрудник не увидит ни одного показателя.');
    }
    if (approveScope === 'NETWORK' && orgUnitId) {
      throw new ApiError('VALIDATION_ERROR', 'Должность уровня управляющей компании не закрепляется за филиалом.');
    }
    // РМ и дивизиональный руководитель: выбранная зона разворачивается в список
    // её действующих филиалов, по каждому — отдельное назначение.
    const unitKind = orgUnitId ? (await c.query(`SELECT kind FROM org_directory_units WHERE id=$1`, [orgUnitId])).rows[0]?.kind : null;
    let grantUnits: (string | null)[] = [approveScope === 'NETWORK' ? null : orgUnitId];
    if (unitKind === 'CLUSTER' || unitKind === 'DIVISION') {
      if (!['REGIONAL_MANAGER', 'DIVISION_MANAGER'].includes(roleCode)) {
        throw new ApiError('VALIDATION_ERROR', 'Зону целиком можно закрепить только за региональным менеджером или дивизиональным руководителем.');
      }
      grantUnits = (await c.query(
        `WITH RECURSIVE tree AS (
           SELECT org_unit_id FROM org_directory_affiliation_history WHERE parent_id=$1 AND effective_to IS NULL
           UNION ALL
           SELECT a.org_unit_id FROM tree t JOIN org_directory_affiliation_history a
             ON a.parent_id=t.org_unit_id AND a.effective_to IS NULL)
         SELECT u.id FROM tree t JOIN org_directory_units u ON u.id=t.org_unit_id
          WHERE u.kind='ORG_UNIT' AND NOT u.is_demo AND org_lifecycle_at(u.id,(now() AT TIME ZONE 'UTC')::date)='ACTIVE'`,
        [orgUnitId],
      )).rows.map(r => r.id);
      if (!grantUnits.length) throw new ApiError('VALIDATION_ERROR', 'В выбранной зоне нет действующих филиалов.');
    } else if (unitKind && unitKind !== 'ORG_UNIT') {
      throw new ApiError('VALIDATION_ERROR', 'Выберите филиал или зону из списка.');
    }
    if ((await c.query(`SELECT 1 FROM app_users WHERE lower(login) = $1`, [req.login])).rowCount) {
      throw new ApiError('SUBMISSION_CONFLICT', 'Логин уже занят действующей учётной записью. Заявку нужно отклонить.');
    }

    // Пароль переносится тем же хешем, что человек задал при регистрации:
    // никакой новый секрет не создаётся и никому не передаётся.
    const created = (await c.query(
      `INSERT INTO app_users
         (login, full_name, primary_email, user_kind, password_hash, password_hash_updated_at, is_active)
       VALUES ($1,$2,$3,'INDIVIDUAL',$4,now(),true)
       RETURNING id, login, full_name`,
      [req.login, req.full_name, req.primary_email, req.password_hash],
    )).rows[0];

    for (const unit of grantUnits) {
      await c.query(
        `INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
         VALUES ($1,$2,$3,$4,now())`,
        [created.id, roleCode, approveScope, unit],
      );
    }

    await c.query(
      `UPDATE registration_requests
          SET status='APPROVED', decided_by=$2, decided_at=now(), decision_reason=$3,
              created_user_id=$4, requested_role_code=$5, requested_org_unit_id=$6
        WHERE id=$1`,
      [id, user.userId, reason, created.id, roleCode, orgUnitId],
    );

    return {
      ok: true as const,
      status: 'APPROVED' as const,
      user: { id: created.id, login: created.login, full_name: created.full_name },
      role_code: roleCode,
      org_unit_id: orgUnitId,
    };
  });
}
