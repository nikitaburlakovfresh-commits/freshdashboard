SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Режим просмотра «глазами роли» для владельца платформы.
--
-- Требование владельца (20.09.2026): при разработке и разборе ошибок нужно
-- видеть экран так, как его видит конкретная роль. На старом портале это
-- сделано в /opt/fresh-rbac: клейм imp_by в cookie, срок 30 минут, журнал
-- входов и выходов, запрет вложенности и входа под другим администратором,
-- баннер с таймером и кнопкой возврата.
--
-- Почему подменяется личность, а не набор прав: в портале нет единой проверки
-- прав, они разбросаны отдельными запросами по доменным файлам (accessChanges,
-- orgDirectory, detailAccess, serviceActor и далее). Любая из них ключуется на
-- user_id. Подмена личности в сессии заставляет все эти проверки работать без
-- изменений; подмена набора прав потребовала бы правки каждой.
--
-- Настоящий владелец сессии остаётся в sessions.user_id и не теряется. Роль
-- просмотра живёт в отдельных колонках, выход — обнуление этих колонок.
--
-- Режим только для чтения: изменяющие запросы в нём отклоняются на уровне
-- приложения. Это не бюрократия, а защита атрибуции: сдача задачи или правка
-- показателя не должна попасть в аудит от имени человека, который её не делал.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- ALTER TABLE sessions DROP COLUMN IF EXISTS view_as_user_id, DROP COLUMN IF EXISTS view_as_expires_at;
-- DROP TABLE IF EXISTS role_view_log;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS view_as_user_id uuid NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS view_as_expires_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS view_as_started_at timestamptz NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sessions_view_as_shape') THEN
    ALTER TABLE sessions ADD CONSTRAINT sessions_view_as_shape CHECK (
      (view_as_user_id IS NULL AND view_as_expires_at IS NULL AND view_as_started_at IS NULL)
      OR (view_as_user_id IS NOT NULL AND view_as_expires_at IS NOT NULL AND view_as_started_at IS NOT NULL)
    );
  END IF;
END $$;

-- Журнал: кто, под кем, когда, откуда. Append-only по смыслу.
CREATE TABLE IF NOT EXISTS role_view_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  admin_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  admin_login text NOT NULL,
  target_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  target_login text NOT NULL,
  target_role_code text NULL REFERENCES roles(code) ON DELETE RESTRICT,
  target_org_unit_id uuid NULL REFERENCES org_directory_units(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK (action IN ('ENTER','EXIT','EXPIRE')),
  ip text NULL,
  user_agent text NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS role_view_log_admin_idx ON role_view_log(admin_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS role_view_log_session_idx ON role_view_log(session_id, created_at DESC);
