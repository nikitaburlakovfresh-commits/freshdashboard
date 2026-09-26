import argon2 from 'argon2';
import { withTransaction } from '../db/pool';
import { AuthedUser } from '../auth/session';
import { ApiError } from '../util/errors';
import { writeAuditAndOutbox } from './auditOutbox';

// Восстановление пароля (решение владельца 26.09.2026). Почты в портале нет:
// человек сам задаёт новый пароль, он сразу хранится хешем, администратор
// портала подтверждает заявку, убедившись, что просит именно этот сотрудник.
// Ответ на заявку одинаков для существующего и несуществующего логина —
// форма не подсказывает, есть ли такая учётная запись.

const DONE = 'Заявка передана администратору портала. После подтверждения войдите с новым паролем.';

async function assertOwner(c: any, user: AuthedUser) {
  const r = await c.query(`SELECT 1 FROM role_grants WHERE user_id=$1 AND role_code='SUPER_ADMIN'
    AND scope_kind='NETWORK' AND revoked_at IS NULL`, [user.viewAs ? user.viewAs.adminUserId : user.userId]);
  if (!r.rowCount) throw new ApiError('FORBIDDEN', 'Решения по заявкам принимает владелец платформы.');
}

export async function submitPasswordReset(raw: unknown) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const login = typeof b.login === 'string' ? b.login.trim().toLowerCase() : '';
  const password = typeof b.password === 'string' ? b.password : '';
  const comment = typeof b.comment === 'string' && b.comment.trim() ? b.comment.trim().slice(0, 500) : null;
  if (!login) throw new ApiError('VALIDATION_ERROR', 'Укажите логин.');
  if (password.length < 12 || password.length > 200) throw new ApiError('VALIDATION_ERROR', 'Пароль должен быть не короче 12 знаков.');
  const hash = await argon2.hash(password, { type: argon2.argon2id });
  await withTransaction(async c => {
    const u = (await c.query(`SELECT id FROM app_users WHERE lower(login)=$1 AND is_active
      AND user_kind='INDIVIDUAL' AND NOT password_last_shared_indicator`, [login])).rows[0];
    if (!u) return;
    await c.query(`INSERT INTO password_reset_requests(user_id,password_hash,comment) VALUES($1,$2,$3)
      ON CONFLICT (user_id) WHERE status='PENDING'
      DO UPDATE SET password_hash=EXCLUDED.password_hash, comment=EXCLUDED.comment, created_at=now()`,
      [u.id, hash, comment]);
  });
  return { ok: true as const, message: DONE };
}

export async function listPasswordResets(user: AuthedUser) {
  return withTransaction(async c => {
    await assertOwner(c, user);
    const items = (await c.query(`SELECT r.id, u.login, u.full_name, u.primary_email, r.comment,
        to_char(r.created_at AT TIME ZONE 'Europe/Moscow','YYYY-MM-DD HH24:MI') created_at
      FROM password_reset_requests r JOIN app_users u ON u.id=r.user_id
      WHERE r.status='PENDING' ORDER BY r.created_at DESC LIMIT 200`)).rows;
    return { items };
  });
}

export async function decidePasswordReset(user: AuthedUser, id: string, action: 'approve' | 'reject', raw: unknown, requestId: string) {
  const b = (raw ?? {}) as Record<string, unknown>;
  const reason = typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, 500) : null;
  if (action === 'reject' && !reason) throw new ApiError('VALIDATION_ERROR', 'Укажите причину отказа.');
  return withTransaction(async c => {
    await assertOwner(c, user);
    const r = (await c.query(`SELECT * FROM password_reset_requests WHERE id=$1 FOR UPDATE`, [id])).rows[0];
    if (!r) throw new ApiError('NOT_FOUND', 'Заявка не найдена.');
    if (r.status !== 'PENDING') throw new ApiError('INVALID_TRANSITION', 'Заявка уже рассмотрена.');
    const actor = user.viewAs ? user.viewAs.adminUserId : user.userId;
    await c.query(`UPDATE password_reset_requests SET status=$2, decided_by=$3, decided_at=now(), decision_reason=$4
      WHERE id=$1`, [id, action === 'approve' ? 'APPROVED' : 'REJECTED', actor, reason]);
    if (action === 'approve') {
      // Новый пароль и отзыв всех прежних сессий: сменился секрет — старые входы недействительны.
      const u = (await c.query(`UPDATE app_users SET password_hash=$2, password_hash_updated_at=now(),
        auth_epoch=auth_epoch+1 WHERE id=$1 RETURNING auth_epoch`, [r.user_id, r.password_hash])).rows[0];
      await c.query(`UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL`, [r.user_id]);
      await writeAuditAndOutbox(c, { actorUserId: actor, actorRole: 'SUPER_ADMIN', orgUnitId: null, workItemId: null,
        action: 'PASSWORD_RESET_APPROVED', aggregateType: 'access', aggregateId: r.user_id, aggregateVersion: Math.max(1, u.auth_epoch),
        requestId, beforeState: null, afterState: { user_id: r.user_id, request_id: id }, reason, resolution: 'APPLIED',
        retentionClass: 'SECURITY_5Y' });
    }
    return { ok: true as const, status: action === 'approve' ? 'APPROVED' : 'REJECTED' };
  });
}

export async function pendingPasswordResetCount(user: AuthedUser) {
  return withTransaction(async c => {
    const owner = await c.query(`SELECT 1 FROM role_grants WHERE user_id=$1 AND role_code='SUPER_ADMIN'
      AND scope_kind='NETWORK' AND revoked_at IS NULL`, [user.viewAs ? user.viewAs.adminUserId : user.userId]);
    if (!owner.rowCount) return 0;
    return (await c.query(`SELECT count(*)::int n FROM password_reset_requests WHERE status='PENDING'`)).rows[0].n as number;
  });
}
