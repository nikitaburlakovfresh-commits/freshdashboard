SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Самостоятельная регистрация сотрудников и настройка прав галочками.
--
-- Решение владельца (21.09.2026): сотрудник сам заполняет форму при первом
-- входе, владелец платформы подтверждает активацию и получает уведомление;
-- наборы прав ролей владелец правит галочками внутри портала.
--
-- Почему заявка, а не сразу учётная запись: до подтверждения человек не должен
-- существовать в оргструктуре. Иначе незакрытая заявка выглядела бы как
-- действующий сотрудник филиала и попадала в отчётность по людям.
--
-- Пароль сотрудник задаёт сам при подаче заявки и он сразу хранится хешем.
-- Так после подтверждения не нужно передавать пароль по переписке — ровно то,
-- чего требует правило проекта о запрете паролей в переписке.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- UPDATE registration_requests SET status = 'REJECTED' WHERE status = 'PENDING';
-- DROP TABLE IF EXISTS role_permission_changes;

CREATE TABLE IF NOT EXISTS registration_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL,
  full_name text NOT NULL,
  primary_email text NULL,
  phone text NULL,
  requested_role_code text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  requested_org_unit_id uuid NULL REFERENCES org_directory_units(id) ON DELETE RESTRICT,
  comment text NULL,
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  decided_at timestamptz NULL,
  decision_reason text NULL,
  created_user_id uuid NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  CONSTRAINT registration_requests_login_shape CHECK (
    char_length(btrim(login)) BETWEEN 3 AND 64
    AND login ~ '^[a-z0-9._-]+$'
  ),
  CONSTRAINT registration_requests_name_shape CHECK (char_length(btrim(full_name)) BETWEEN 3 AND 200),
  -- Решение обязано иметь автора и время: иначе в истории доступов появится
  -- активация без ответственного.
  CONSTRAINT registration_requests_decision_shape CHECK (
    (status = 'PENDING' AND decided_by IS NULL AND decided_at IS NULL)
    OR (status <> 'PENDING' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
  ),
  -- Учётная запись появляется только у подтверждённой заявки.
  CONSTRAINT registration_requests_created_user_shape CHECK (
    created_user_id IS NULL OR status = 'APPROVED'
  )
);

-- Один логин может ждать рассмотрения только в одной заявке. Отклонённые не
-- мешают подать новую: человек мог ошибиться в филиале или роли.
CREATE UNIQUE INDEX IF NOT EXISTS registration_requests_pending_login
  ON registration_requests (login) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS registration_requests_status_idx
  ON registration_requests (status, created_at DESC);

-- История изменения наборов прав. Без неё настройка галочками превращается в
-- бесследное изменение полномочий: завтра никто не объяснит, почему роль
-- получила доступ и кто его дал.
CREATE TABLE IF NOT EXISTS role_permission_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
  permission_code text NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('GRANTED','REVOKED')),
  actor_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  actor_login text NOT NULL,
  reason text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS role_permission_changes_role_idx
  ON role_permission_changes (role_code, created_at DESC);

-- Тип события для уведомления сюда намеренно не добавляется: справочник
-- event_catalog допускает только политики NONE, REVIEWERS и ASSIGNEE, а
-- расширять аудируемый контур событий ради одной заявки — лишнее усложнение.
-- Владелец платформы видит счётчик ожидающих заявок на колокольчике и в
-- разделе уведомлений; решение по заявке пишется в саму заявку.
