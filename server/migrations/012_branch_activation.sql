-- Explicit first activation only. Identity rows and the legacy A/B registry
-- remain immutable. This overlay preserves the original lifecycle baseline.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO permissions(code,description) VALUES
 ('org_unit.activate','Explicit first activation of an editor-created real branch; separate NETWORK permission');
-- No role receives this permission through a migration.
CREATE TABLE org_branch_activations (
 org_unit_id uuid PRIMARY KEY REFERENCES org_directory_units(id),
 proposal_id uuid UNIQUE NOT NULL REFERENCES org_change_proposals(id),
 effective_from date NOT NULL CHECK(isfinite(effective_from)),
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 10 AND 500),
 recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE FUNCTION guard_branch_activation() RETURNS trigger LANGUAGE plpgsql
SET search_path=pilot_r1,pg_catalog AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN
   RAISE EXCEPTION 'Activation history is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.effective_from<>(now() AT TIME ZONE 'UTC')::date
   OR NEW.recorded_at<>now()
   OR NOT EXISTS(SELECT 1 FROM org_directory_units d
     WHERE d.id=NEW.org_unit_id AND d.kind='ORG_UNIT'
       AND d.lifecycle_state='PRE_LAUNCH' AND NOT d.is_demo AND NOT d.demo_locked
       AND d.pilot_org_unit_id IS NULL AND d.effective_from<=NEW.effective_from AND d.effective_to IS NULL)
   OR NOT EXISTS(SELECT 1 FROM org_change_proposals p WHERE p.target_id=NEW.org_unit_id
     AND p.status='APPLIED' AND p.change->>'operation'='ORG_UNIT_CREATE')
   OR NOT EXISTS(SELECT 1 FROM org_change_proposals p WHERE p.id=NEW.proposal_id
     AND p.target_id=NEW.org_unit_id AND p.status='PREVIEW'
     AND p.change->>'operation'='ORG_UNIT_ACTIVATE'
     AND p.change->>'effective_from'=to_char(NEW.effective_from,'YYYY-MM-DD')
     AND btrim(p.change->>'reason')=NEW.reason AND p.preview_actor=NEW.actor_user_id
     AND p.preview_expires_at>now()
     AND p.preview_base_version=(SELECT version FROM org_directory_revision WHERE singleton)) THEN
   RAISE EXCEPTION 'Invalid explicit activation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER branch_activation_guard BEFORE INSERT OR UPDATE OR DELETE ON org_branch_activations
 FOR EACH ROW EXECUTE FUNCTION guard_branch_activation();
CREATE FUNCTION require_applied_activation_proposal() RETURNS trigger LANGUAGE plpgsql
SET search_path=pilot_r1,pg_catalog AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM org_change_proposals p WHERE p.id=NEW.proposal_id
   AND p.status='APPLIED' AND p.applied_by=NEW.actor_user_id) THEN
   RAISE EXCEPTION 'Activation must commit with its applied proposal' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER branch_activation_applied AFTER INSERT ON org_branch_activations
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_applied_activation_proposal();
CREATE TRIGGER branch_activation_revision AFTER INSERT ON org_branch_activations
 FOR EACH STATEMENT EXECUTE FUNCTION bump_org_directory_revision();

CREATE FUNCTION org_lifecycle_at(unit_id uuid,as_of date) RETURNS text
LANGUAGE sql STABLE SET search_path=pilot_r1,pg_catalog AS $$
 SELECT CASE WHEN EXISTS(SELECT 1 FROM org_branch_activations a
   WHERE a.org_unit_id=d.id AND a.effective_from<=as_of) THEN 'ACTIVE' ELSE d.lifecycle_state END
 FROM org_directory_units d WHERE d.id=unit_id;
$$;
CREATE OR REPLACE FUNCTION org_accepts_new_work(branch_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pilot_r1,pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM org_directory_units d
   WHERE d.id=branch_id AND d.kind='ORG_UNIT'
     AND org_lifecycle_at(d.id,(now() AT TIME ZONE 'UTC')::date)='ACTIVE'
     AND (NOT d.is_demo OR d.pilot_org_unit_id=d.id)
     AND d.effective_from<=(now() AT TIME ZONE 'UTC')::date
     AND (d.effective_to IS NULL OR (now() AT TIME ZONE 'UTC')::date<d.effective_to));
$$;
