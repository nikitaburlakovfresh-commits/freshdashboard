SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- Штатный сервисный контур приёма и публикации агрегатов QLIK.
-- Назначение: ежемесячная загрузка и публикация проверенного среза может
-- выполняться автономно, без живой человеческой сессии, но НЕ в обход контроля:
-- субъект действия существует явно, имеет отдельное разрешение с ссылкой на
-- утверждение, ограниченный перечень возможностей и собственный журнал запусков.
--
-- Важные инварианты, которые эта миграция НЕ ослабляет:
--  * сервисный субъект имеет user_kind='SERVICE' и поэтому не проходит ни одну
--    человеческую проверку (вход в портал, ежедневники, изменения оргструктуры,
--    изменения прав) — все они требуют user_kind='INDIVIDUAL';
--  * перечень публикуемых показателей по-прежнему берётся из report_fact_access,
--    а право на приём — из report_staging_access; сервисный контур не создаёт
--    второго источника прав;
--  * отсутствие данных остаётся отсутствием: контур ничего не досчитывает.

ALTER TABLE app_users DROP CONSTRAINT app_users_user_kind_check;
ALTER TABLE app_users ADD CONSTRAINT app_users_user_kind_check
  CHECK (user_kind IN ('INDIVIDUAL','SERVICE'));

INSERT INTO permissions(code,description) VALUES
 ('service_intake.execute','Выполнять приём и публикацию агрегатов сервисным контуром без человеческой сессии');
INSERT INTO role_permissions(role_code,permission_code) VALUES
 ('SUPER_ADMIN','service_intake.execute') ON CONFLICT DO NOTHING;

ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus',
   'service_intake'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage',
   'metric_threshold','metric_deviation','notification_policy','portal_setting','metric_scoring','metric_focus',
   'service_intake'));
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('service_intake.actor_provisioned','NONE'),
 ('service_intake.run_recorded','NONE');

-- Реестр сервисных субъектов. Создаётся только явно, с ссылкой на утверждение
-- и указанием человека, который его создал.
CREATE TABLE service_intake_actors (
 user_id uuid PRIMARY KEY REFERENCES app_users(id),
 code text NOT NULL UNIQUE CHECK(code ~ '^[a-z][a-z0-9_]{2,60}$'),
 display_name text NOT NULL CHECK(char_length(display_name) BETWEEN 3 AND 200),
 purpose text NOT NULL CHECK(char_length(purpose) BETWEEN 16 AND 1000),
 approval_reference text NOT NULL CHECK(char_length(approval_reference) BETWEEN 16 AND 500),
 created_by uuid NOT NULL REFERENCES app_users(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 revoked_at timestamptz,
 revoke_reason text CHECK(revoke_reason IS NULL OR char_length(revoke_reason) BETWEEN 16 AND 500),
 CHECK(revoked_at IS NULL OR revoke_reason IS NOT NULL)
);

-- Возможности сервисного субъекта. INTAKE — загрузка, проверка структуры и
-- сверка; PUBLISH — публикация уже проверенного среза. Перечень показателей
-- сервисный контур не расширяет: он берётся из report_fact_access того же гранта.
CREATE TABLE service_intake_authorizations (
 id uuid PRIMARY KEY,
 actor_user_id uuid NOT NULL REFERENCES service_intake_actors(user_id),
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 capability text NOT NULL CHECK(capability IN ('INTAKE','PUBLISH')),
 valid_from timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz,
 revoked_at timestamptz,
 approval_reference text NOT NULL CHECK(char_length(approval_reference) BETWEEN 16 AND 500),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE UNIQUE INDEX service_intake_one_active_capability
 ON service_intake_authorizations(actor_user_id,capability) WHERE revoked_at IS NULL;

-- Журнал автономных запусков: что именно контур сделал с каким пакетом и чем
-- закончил. BLOCKED — штатный отказ (нет привязок, нет канала, нет разрешения),
-- FAILED — сбой выполнения. Публикация без записи в этот журнал невозможна.
CREATE TABLE service_intake_runs (
 id uuid PRIMARY KEY,
 actor_user_id uuid NOT NULL REFERENCES service_intake_actors(user_id),
 batch_id uuid REFERENCES report_staging_batches(id),
 stage text NOT NULL CHECK(stage IN ('UPLOAD','PROBE','REVIEW','SCAN','PREVIEW','COMMIT')),
 outcome text NOT NULL CHECK(outcome IN ('OK','BLOCKED','FAILED')),
 detail jsonb NOT NULL,
 started_at timestamptz NOT NULL,
 finished_at timestamptz NOT NULL DEFAULT now(),
 CHECK(finished_at>=started_at)
);
CREATE INDEX service_intake_runs_batch ON service_intake_runs(batch_id,finished_at DESC);
