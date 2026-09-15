-- Bounded directory change sets; no business import, identity rewrite or task FK change.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO permissions(code,description) VALUES
 ('organization.change.draft','Persist a bounded organization change set; NETWORK assignment required'),
 ('organization.change.preview','Validate and preview a versioned organization change set; no application'),
 ('organization.change.apply','Explicitly apply a current actor-bound preview; no lifecycle, grants or import'),
 ('org_unit.create','Create a PRE_LAUNCH directory identity through an explicit change set'),
 ('org_unit.rename','Append name history for editor-created directory identities'),
 ('org_unit.move','Append affiliation history for editor-created directory identities');
-- Catalog entries alone confer no rights. Operator provisioning is separate,
-- journaled, additive, and tied to the existing first-administrator grant.
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('organization.change.recorded','NONE'),
 ('organization.editor.provisioned','NONE');
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change'));
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_operation_check CHECK(operation IN
 ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields','submitWorkItem',
 'acceptWorkItem','reworkWorkItem','cancelWorkItem','reopenWorkItem','readNotification',
 'orgChangeCreate','orgChangeEdit','orgChangePreview','orgChangeApply'));

CREATE TABLE organization_editor_provisioning (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 user_id uuid NOT NULL REFERENCES app_users(id),
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 approval_reference text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER organization_editor_provisioning_immutable BEFORE UPDATE OR DELETE ON organization_editor_provisioning
 FOR EACH ROW EXECUTE FUNCTION protect_administrator_bootstrap();

CREATE TABLE org_directory_revision (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0)
);
INSERT INTO org_directory_revision DEFAULT VALUES;
CREATE FUNCTION bump_org_directory_revision() RETURNS trigger LANGUAGE plpgsql
SET search_path=pilot_r1,pg_catalog AS $$
BEGIN
 UPDATE org_directory_revision SET version=version+1 WHERE singleton;
 RETURN NULL;
END $$;
CREATE TRIGGER org_units_revision AFTER INSERT OR UPDATE OR DELETE ON org_directory_units
 FOR EACH STATEMENT EXECUTE FUNCTION bump_org_directory_revision();
CREATE TRIGGER org_names_revision AFTER INSERT OR UPDATE OR DELETE ON org_directory_name_history
 FOR EACH STATEMENT EXECUTE FUNCTION bump_org_directory_revision();
CREATE TRIGGER org_affiliations_revision AFTER INSERT OR UPDATE OR DELETE ON org_directory_affiliation_history
 FOR EACH STATEMENT EXECUTE FUNCTION bump_org_directory_revision();

CREATE TABLE org_change_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 target_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 updated_by uuid NOT NULL REFERENCES app_users(id),
 version bigint NOT NULL DEFAULT 1 CHECK(version > 0),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PREVIEW','APPLIED')),
 change jsonb NOT NULL CHECK(jsonb_typeof(change)='object'),
 preview_summary jsonb,
 preview_token uuid,
 preview_actor uuid REFERENCES app_users(id),
 preview_hash bytea,
 preview_base_version bigint,
 preview_expires_at timestamptz,
 applied_by uuid REFERENCES app_users(id),
 applied_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='PREVIEW' AND preview_token IS NOT NULL AND preview_actor IS NOT NULL
   AND preview_hash IS NOT NULL AND preview_base_version > 0 AND preview_expires_at IS NOT NULL)
   OR (status IN ('DRAFT','APPLIED') AND preview_token IS NULL)),
 CHECK((status='APPLIED') = (applied_at IS NOT NULL AND applied_by IS NOT NULL))
);
CREATE FUNCTION protect_org_change_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Change sets cannot be deleted' USING ERRCODE='23514'; END IF;
 IF OLD.status='APPLIED' OR NEW.id<>OLD.id OR NEW.target_id<>OLD.target_id
   OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at
   OR NEW.version<>OLD.version+1
   OR (NEW.status='APPLIED' AND OLD.status<>'PREVIEW') THEN
   RAISE EXCEPTION 'Invalid change set transition or immutable identity' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER org_change_proposals_guard BEFORE UPDATE OR DELETE ON org_change_proposals
 FOR EACH ROW EXECUTE FUNCTION protect_org_change_proposal();
