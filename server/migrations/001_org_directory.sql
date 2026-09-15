-- Org directory V1: additive only. No identity, role, permission or task writes.
-- Run through scripts/migrate.ts; its transaction and checksum ledger own this file.
CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA public;
SET LOCAL search_path = pilot_r1, public, pg_catalog;

CREATE TABLE org_directory_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE CHECK (char_length(code) BETWEEN 1 AND 100 AND code ~ '^[A-Za-z0-9_-]+$'),
    kind text NOT NULL CHECK (kind IN ('NETWORK','DIVISION','CLUSTER','ORG_UNIT')),
    -- Nullable until business confirmation. Never inferred from a name.
    type_code text CHECK (type_code IN ('CITY_FLAG','EXPRESS','FULL_SERVICE','PICKUP_POINT','OUTLET')),
    lifecycle_state text NOT NULL CHECK (lifecycle_state IN ('PRE_LAUNCH','ACTIVE','PAUSED','CLOSED')),
    is_demo boolean NOT NULL DEFAULT false,
    demo_locked boolean NOT NULL DEFAULT false,
    aliases text[] NOT NULL DEFAULT '{}',
    effective_from date NOT NULL CHECK (isfinite(effective_from)),
    effective_to date CHECK (isfinite(effective_to) AND effective_to > effective_from),
    created_at timestamptz NOT NULL DEFAULT now(),
    -- Bridge only, never a new scope grant. Preserve A/B UUIDs and task FKs.
    pilot_org_unit_id uuid UNIQUE REFERENCES org_units(id) ON DELETE RESTRICT,
    CHECK (pilot_org_unit_id IS NULL OR (pilot_org_unit_id = id AND kind = 'ORG_UNIT' AND is_demo)),
    CHECK (kind = 'ORG_UNIT' OR type_code IS NULL),
    CHECK (NOT demo_locked OR is_demo)
);

CREATE TABLE org_directory_name_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_unit_id uuid NOT NULL REFERENCES org_directory_units(id) ON DELETE RESTRICT,
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200 AND display_name ~ '[^[:space:]]'),
    legal_name text CHECK (char_length(legal_name) BETWEEN 1 AND 500),
    effective_from date NOT NULL CHECK (isfinite(effective_from)),
    effective_to date CHECK (isfinite(effective_to) AND effective_to > effective_from),
    change_reason text NOT NULL CHECK (char_length(change_reason) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    EXCLUDE USING gist (org_unit_id WITH =, daterange(effective_from,effective_to,'[)') WITH &&)
);

CREATE TABLE org_directory_affiliation_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_unit_id uuid NOT NULL REFERENCES org_directory_units(id) ON DELETE RESTRICT,
    parent_id uuid REFERENCES org_directory_units(id) ON DELETE RESTRICT,
    business_model text CHECK (business_model IN ('FRANCHISE','OWN_OPERATION','UC')),
    -- Reserved references only: legal/contract registries are NOT implemented.
    -- Never exposed by the pilot directory endpoint.
    legal_entity_id uuid,
    contract_id uuid,
    effective_from date NOT NULL CHECK (isfinite(effective_from)),
    effective_to date CHECK (isfinite(effective_to) AND effective_to > effective_from),
    change_reason text NOT NULL CHECK (char_length(change_reason) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (parent_id IS DISTINCT FROM org_unit_id),
    EXCLUDE USING gist (org_unit_id WITH =, daterange(effective_from,effective_to,'[)') WITH &&)
);
CREATE INDEX org_directory_affiliation_parent ON org_directory_affiliation_history(parent_id);

-- Fixed kinds plus strictly increasing rank prevent cycles, including concurrent
-- opposite edges. Missing affiliation is allowed, never guessed for pilot A/B.
CREATE FUNCTION org_directory_check_parent() RETURNS trigger LANGUAGE plpgsql
SET search_path = pilot_r1, pg_catalog AS $$
DECLARE child_kind text; parent_kind text; child_demo boolean; parent_demo boolean;
BEGIN
    SELECT kind, is_demo INTO child_kind, child_demo FROM org_directory_units WHERE id = NEW.org_unit_id;
    IF NEW.parent_id IS NOT NULL THEN
        SELECT kind, is_demo INTO parent_kind, parent_demo FROM org_directory_units WHERE id = NEW.parent_id;
        IF parent_kind IS NULL OR child_demo IS DISTINCT FROM parent_demo OR
           NOT ((child_kind = 'DIVISION' AND parent_kind = 'NETWORK') OR
                (child_kind = 'CLUSTER' AND parent_kind = 'DIVISION') OR
                (child_kind = 'ORG_UNIT' AND parent_kind IN ('NETWORK','DIVISION','CLUSTER'))) THEN
            RAISE EXCEPTION 'Invalid directory hierarchy or demo boundary' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER org_directory_parent_check BEFORE INSERT OR UPDATE ON org_directory_affiliation_history
FOR EACH ROW EXECUTE FUNCTION org_directory_check_parent();

-- Corrections require a reviewed successor interval, not rewriting the past.
-- V1 intentionally offers no write API. Closure of an open interval is the only
-- allowed update; earlier closed records and identity rows are immutable.
CREATE FUNCTION org_directory_protect_history() RETURNS trigger LANGUAGE plpgsql
SET search_path = pilot_r1, pg_catalog AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
           AND (to_jsonb(OLD) - 'effective_to') = (to_jsonb(NEW) - 'effective_to') THEN
            RETURN NEW;
        END IF;
    END IF;
    RAISE EXCEPTION 'Directory history is append-only except closing an open interval' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER org_directory_names_immutable BEFORE UPDATE OR DELETE ON org_directory_name_history
FOR EACH ROW EXECUTE FUNCTION org_directory_protect_history();
CREATE TRIGGER org_directory_affiliations_immutable BEFORE UPDATE OR DELETE ON org_directory_affiliation_history
FOR EACH ROW EXECUTE FUNCTION org_directory_protect_history();

CREATE FUNCTION org_directory_protect_identity() RETURNS trigger LANGUAGE plpgsql
SET search_path = pilot_r1, pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'Directory identity changes require a separately reviewed migration' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER org_directory_identity_immutable BEFORE UPDATE OR DELETE ON org_directory_units
FOR EACH ROW EXECUTE FUNCTION org_directory_protect_identity();

INSERT INTO org_directory_units
    (id,code,kind,lifecycle_state,is_demo,demo_locked,effective_from,pilot_org_unit_id)
SELECT id,code,'ORG_UNIT','ACTIVE',true,true,CURRENT_DATE,id
FROM org_units WHERE code IN ('A','B') AND is_synthetic;
INSERT INTO org_directory_name_history (org_unit_id,display_name,effective_from,change_reason)
SELECT id,display_name,CURRENT_DATE,'Synthetic pilot identity bridge; no historical facts inferred'
FROM org_units WHERE code IN ('A','B') AND is_synthetic;
INSERT INTO org_directory_affiliation_history (org_unit_id,effective_from,change_reason)
SELECT id,CURRENT_DATE,'Affiliation and business model await confirmation; no parent inferred'
FROM org_units WHERE code IN ('A','B') AND is_synthetic;
