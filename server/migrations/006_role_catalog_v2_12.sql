-- TZ v2.12 §3.2A: role catalog is data seeded once, not a closed pilot enum.
-- Additive only. Corrects pilot display names and adds catalog rows that
-- currently have a supported scope_kind (ORG_UNIT or NETWORK). УК-level
-- roles whose §3.2A default scope is DIVISION (REGIONAL_MANAGER,
-- DIVISION_MANAGER) are intentionally NOT reassigned to a DIVISION
-- scope_kind here: no DIVISION-kind org node exists yet in role_grants'
-- reachable scope (org_directory_units is not bridged to role_grants).
-- Adding a DIVISION scope_kind before that bridge exists would let the
-- admin UI offer a grant kind that cannot resolve to real data — exactly
-- the kind of unimplemented-behavior-as-real that the project forbids.
-- Service/cross-scope roles (REPORT_ADMIN, REPORT_EXECUTOR,
-- AUDIT_TEMPLATE_ADMIN, METRIC_ADMIN) are also deferred: §3.2A does not
-- state their scope_kind, and it must not be guessed.
SET LOCAL search_path = pilot_r1, pg_catalog;

-- §3.2A.6: system roles (is_system=true) — code and scope_kind become
-- immutable; display_name and permissions may still change through the
-- admin panel. Custom roles created later (is_system=false) are free.
ALTER TABLE roles ADD COLUMN is_system boolean NOT NULL DEFAULT false;

CREATE FUNCTION protect_system_role() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'System role catalog entries cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.is_system AND (NEW.code <> OLD.code OR NEW.scope_kind <> OLD.scope_kind OR NEW.is_system <> OLD.is_system) THEN
    RAISE EXCEPTION 'System role code/scope_kind is immutable (TZ 3.2A.6)' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER roles_system_guard BEFORE UPDATE OR DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION protect_system_role();

-- Correct the two pilot-era rows to their real TZ 3.2A identity and freeze them.
UPDATE roles SET display_name = 'Региональный менеджер (РМ)', is_system = true WHERE code = 'REGIONAL_MANAGER';
UPDATE roles SET display_name = 'Руководитель филиала (операционный)', is_system = true WHERE code = 'RF';
UPDATE roles SET is_system = true WHERE code = 'SUPER_ADMIN';

-- TZ 3.2A: Филиал — ORG_UNIT scope (RF already present above).
INSERT INTO roles (code, display_name, scope_kind, is_system) VALUES
  ('BH', 'Собственник / CEO франчайзи', 'ORG_UNIT', true),
  ('ACTING_BH', 'Замещающий BH (по доверенности)', 'ORG_UNIT', true),
  ('ACTING_RF', 'Замещающий RF', 'ORG_UNIT', true),
  ('ROP', 'Руководитель отдела продаж', 'ORG_UNIT', true),
  ('ROO', 'Руководитель отдела оценки', 'ORG_UNIT', true),
  ('RKSO', 'Руководитель КСО филиала', 'ORG_UNIT', true),
  ('STOCK', 'Сток', 'ORG_UNIT', true),
  ('MARKETING', 'Маркетолог', 'ORG_UNIT', true),
  ('LEGAL_BRANCH', 'Юрист филиала', 'ORG_UNIT', true),
  ('HR_BRANCH', 'HR филиала', 'ORG_UNIT', true),
  ('ACCOUNTANT', 'Бухгалтер', 'ORG_UNIT', true),
  ('SHARED_LOGIN', 'Общий логин филиала (склад/ресепшн)', 'ORG_UNIT', true);

-- TZ 3.2A: УК — roles whose default scope_kind is already supported (NETWORK).
-- OWNER_REP is "ORG_UNIT (union)" per TZ — a delegate scoped per branch, like BH.
INSERT INTO roles (code, display_name, scope_kind, is_system) VALUES
  ('FINANCE_HEAD', 'Руководитель финблока', 'NETWORK', true),
  ('COMMERCIAL_DIRECTOR', 'Коммерческий директор', 'NETWORK', true),
  ('KSO_HEAD', 'Руководитель блока КСО', 'NETWORK', true),
  ('FRESH_ACADEMY', 'Фреш-академия', 'NETWORK', true),
  ('HR_UC', 'HR управляющей компании', 'NETWORK', true),
  ('LAUNCH_TEAM', 'Команда запуска', 'NETWORK', true),
  ('TECHNICAL_COORDINATOR', 'Технический координатор', 'NETWORK', true),
  ('QUALITY_CONTROL', 'Контроль качества', 'NETWORK', true),
  ('LEGAL_UC', 'Юрист УК', 'NETWORK', true),
  ('OWNER_REP', 'Представитель собственника (делегат BH)', 'ORG_UNIT', true);

-- TZ 3.2A.5: SHARED_LOGIN carries no approve/publish/rotate permission by
-- default; only a base daily-log-creation right, granted explicitly later
-- once the daily-log template exists. No permission rows added here.
