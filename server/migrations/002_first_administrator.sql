-- Additive first-administrator foundation. Never modify migration 001/baseline.
SET LOCAL search_path = pilot_r1, pg_catalog;

-- TZ 3.2A/45.1: a catalog is data, not a closed two-role enum. New catalog
-- entries grant nothing without an implemented permission and live assignment.
ALTER TABLE roles DROP CONSTRAINT roles_code_check;
ALTER TABLE roles ADD CONSTRAINT roles_code_format CHECK (code ~ '^[A-Z][A-Z0-9_]{1,79}$');
ALTER TABLE roles DROP CONSTRAINT roles_scope_kind_check;
ALTER TABLE roles ADD CONSTRAINT roles_supported_scope CHECK (scope_kind IN ('ORG_UNIT','NETWORK'));
ALTER TABLE roles ADD CONSTRAINT roles_code_scope UNIQUE (code,scope_kind);
INSERT INTO roles(code,display_name,scope_kind) VALUES ('SUPER_ADMIN','Владелец платформы','NETWORK');
INSERT INTO permissions(code,description) VALUES
  ('organization.directory.review','Read organizational directory metadata and history across NETWORK; no people, finance, tasks or writes');
INSERT INTO role_permissions(role_code,permission_code) VALUES ('SUPER_ADMIN','organization.directory.review');
INSERT INTO event_catalog(event_type,notification_policy) VALUES ('access.first_administrator_bootstrapped','NONE');

ALTER TABLE role_grants ALTER COLUMN org_unit_id DROP NOT NULL;
ALTER TABLE role_grants ADD COLUMN scope_kind text NOT NULL DEFAULT 'ORG_UNIT';
ALTER TABLE role_grants ADD CONSTRAINT grant_role_scope FOREIGN KEY (role_code,scope_kind) REFERENCES roles(code,scope_kind);
ALTER TABLE role_grants ADD CONSTRAINT grant_scope_reference CHECK (
  (scope_kind='ORG_UNIT' AND org_unit_id IS NOT NULL) OR
  (scope_kind='NETWORK' AND org_unit_id IS NULL)
);
CREATE UNIQUE INDEX one_unrevoked_network_grant ON role_grants(user_id,role_code)
  WHERE revoked_at IS NULL AND scope_kind='NETWORK';

-- A permanently journaled one-shot operation, not an HTTP provisioning route.
CREATE TABLE administrator_bootstrap (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  user_id uuid NOT NULL REFERENCES app_users(id),
  grant_id uuid NOT NULL REFERENCES role_grants(id),
  audit_id uuid NOT NULL REFERENCES audit_log(id),
  reason text NOT NULL CHECK (length(trim(reason)) >= 16),
  approval_reference text NOT NULL CHECK (length(trim(approval_reference)) >= 16),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION protect_administrator_bootstrap() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Administrator bootstrap journal is immutable' USING ERRCODE='23514';
END $$;
CREATE TRIGGER administrator_bootstrap_immutable BEFORE UPDATE OR DELETE ON administrator_bootstrap
  FOR EACH ROW EXECUTE FUNCTION protect_administrator_bootstrap();
