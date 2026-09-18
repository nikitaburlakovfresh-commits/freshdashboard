-- Canonical branch identity, TZ v2.12 §§2,3. Local release candidate only.
-- No real branches, users, assignments, activation or historical data are seeded.
-- org_units remains the immutable A/B compatibility registry, NOT a second
-- production directory. Existing UUIDs and evidence rows are never rewritten.
SET LOCAL search_path = pilot_r1, pg_catalog;
SET LOCAL lock_timeout = '5s';

-- Fail atomically on an incomplete or mismatched pilot bridge. Do not infer
-- a mapping from display names or silently create missing directory entries.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM org_units p
    LEFT JOIN org_directory_units d ON d.id=p.id
    WHERE d.id IS NULL OR d.kind<>'ORG_UNIT' OR NOT d.is_demo
      OR NOT d.demo_locked OR d.code<>p.code
      OR d.pilot_org_unit_id IS DISTINCT FROM p.id
  ) THEN
    RAISE EXCEPTION 'Canonical scope migration requires an intact pilot bridge'
      USING ERRCODE='23514';
  END IF;
END $$;

-- Constraint replacement and validation happen in the migration runner's ONE
-- transaction. Composite task/field/submission/notification FKs stay unchanged.
ALTER TABLE role_grants DROP CONSTRAINT role_grants_org_unit_id_fkey;
ALTER TABLE role_grants ADD CONSTRAINT role_grants_org_unit_id_fkey
  FOREIGN KEY (org_unit_id) REFERENCES org_directory_units(id) ON DELETE RESTRICT;
ALTER TABLE work_items DROP CONSTRAINT work_items_org_unit_id_fkey;
ALTER TABLE work_items ADD CONSTRAINT work_items_org_unit_id_fkey
  FOREIGN KEY (org_unit_id) REFERENCES org_directory_units(id) ON DELETE RESTRICT;
ALTER TABLE audit_log DROP CONSTRAINT audit_log_org_unit_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_org_unit_id_fkey
  FOREIGN KEY (org_unit_id) REFERENCES org_directory_units(id) ON DELETE RESTRICT;
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_org_unit_id_fkey;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_org_unit_id_fkey
  FOREIGN KEY (org_unit_id) REFERENCES org_directory_units(id) ON DELETE RESTRICT;

-- UUID existence is insufficient: NETWORK/DIVISION/CLUSTER never mean a
-- branch grant. Directory identities (including kind/demo) are immutable.
-- New demo identities await an explicit demo-user/tenancy implementation;
-- the already-supported A/B training scenario remains available.
CREATE FUNCTION check_canonical_branch_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pilot_r1, pg_catalog AS $$
DECLARE d org_directory_units%ROWTYPE;
BEGIN
  IF NEW.org_unit_id IS NULL THEN RETURN NEW; END IF;
  SELECT * INTO d FROM org_directory_units WHERE id=NEW.org_unit_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown canonical branch' USING ERRCODE='23503';
  END IF;
  IF d.kind<>'ORG_UNIT' OR (d.is_demo AND d.pilot_org_unit_id IS DISTINCT FROM d.id) THEN
    RAISE EXCEPTION 'Expected a supported exact branch scope' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grants_canonical_branch BEFORE INSERT OR UPDATE OF org_unit_id ON role_grants
  FOR EACH ROW EXECUTE FUNCTION check_canonical_branch_scope();
CREATE TRIGGER tasks_canonical_branch BEFORE INSERT OR UPDATE OF org_unit_id ON work_items
  FOR EACH ROW EXECUTE FUNCTION check_canonical_branch_scope();
CREATE TRIGGER audit_canonical_branch BEFORE INSERT OR UPDATE OF org_unit_id ON audit_log
  FOR EACH ROW EXECUTE FUNCTION check_canonical_branch_scope();
CREATE TRIGGER outbox_canonical_branch BEFORE INSERT OR UPDATE OF org_unit_id ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION check_canonical_branch_scope();

-- A reassignment is a successor grant, never mutation of the branch carried
-- by an existing grant ID. Revocation/expiry remains possible. Full temporal
-- assignment administration is a separate slice, not claimed by this migration.
CREATE FUNCTION protect_grant_scope_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pilot_r1, pg_catalog AS $$
BEGIN
  IF ROW(NEW.user_id,NEW.role_code,NEW.scope_kind,NEW.org_unit_id)
     IS DISTINCT FROM ROW(OLD.user_id,OLD.role_code,OLD.scope_kind,OLD.org_unit_id) THEN
    RAISE EXCEPTION 'Grant identity is immutable; revoke and create a successor'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER grant_scope_identity BEFORE UPDATE ON role_grants
  FOR EACH ROW EXECUTE FUNCTION protect_grant_scope_identity();
CREATE TRIGGER pilot_registry_immutable BEFORE UPDATE OR DELETE ON org_units
  FOR EACH ROW EXECUTE FUNCTION org_directory_protect_identity();

-- Release admission fence, not the complete lifecycle engine: new tasks
-- require ACTIVE and a currently effective branch. Metadata grants may exist
-- before opening, but do not activate work. Historical reads are NOT filtered
-- by lifecycle, so closure cannot erase evidence. Date convention stays UTC.
CREATE FUNCTION org_accepts_new_work(branch_id uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pilot_r1, pg_catalog AS $$
  SELECT EXISTS (
    SELECT 1 FROM org_directory_units d
    WHERE d.id=branch_id AND d.kind='ORG_UNIT' AND d.lifecycle_state='ACTIVE'
      AND (NOT d.is_demo OR d.pilot_org_unit_id=d.id)
      AND d.effective_from <= (now() AT TIME ZONE 'UTC')::date
      AND (d.effective_to IS NULL OR (now() AT TIME ZONE 'UTC')::date < d.effective_to)
  );
$$;
CREATE FUNCTION check_new_work_branch() RETURNS trigger
LANGUAGE plpgsql SET search_path = pilot_r1, pg_catalog AS $$
BEGIN
  IF NOT org_accepts_new_work(NEW.org_unit_id) THEN
    RAISE EXCEPTION 'Branch does not accept new work' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_item_branch_admission BEFORE INSERT ON work_items
  FOR EACH ROW EXECUTE FUNCTION check_new_work_branch();
