SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- 070. Восстановление пароля зарегистрированного сотрудника (решение владельца 26.09.2026).
-- Почты в портале нет, поэтому схема как у регистрации: человек сам задаёт новый
-- пароль (хранится только хешем), администратор портала подтверждает заявку.
-- Пароль никому не передаётся. После подтверждения прежние сессии отзываются.
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат: не показывать раздел;
-- таблица хранит историю заявок.
CREATE TABLE IF NOT EXISTS password_reset_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  password_hash text NOT NULL,
  comment text NULL CHECK (comment IS NULL OR char_length(comment) <= 500),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  decided_at timestamptz NULL,
  decision_reason text NULL CHECK (decision_reason IS NULL OR char_length(decision_reason) <= 500),
  CONSTRAINT password_reset_decision_shape CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status <> 'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL))
);
-- Одна ожидающая заявка на человека: повторная заменяет пароль в ней.
CREATE UNIQUE INDEX IF NOT EXISTS password_reset_pending_user
  ON password_reset_requests (user_id) WHERE status = 'PENDING';
