-- Bounded administration of existing personal users, exact ORG_UNIT scope.
-- Catalog only: operator approval is required separately to enable the UI.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO permissions(code,description) VALUES
 ('access.directory.read','Read safe user and assignment metadata with an explicit NETWORK grant'),
 ('access.change.draft','Persist exact branch assignment proposals'),
 ('access.change.preview','Preview assignment effects without applying'),
 ('access.change.apply','Apply a current actor-bound assignment preview'),
 ('user.assign_role','Grant or revoke an implemented operational role on one real branch');
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('access.change.recorded','NONE'),('access.administration.provisioned','NONE');
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_operation_check CHECK(operation IN
 ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields','submitWorkItem',
 'acceptWorkItem','reworkWorkItem','cancelWorkItem','reopenWorkItem','readNotification',
 'orgChangeCreate','orgChangeEdit','orgChangePreview','orgChangeApply','reportReviewDraft',
 'accessChangeCreate','accessChangePreview','accessChangeApply'));

-- Permit consecutive intervals, never overlapping unrevoked intervals.
-- Existing rows and their UUIDs, dates and versions remain untouched.
DROP INDEX one_unrevoked_grant;
ALTER TABLE role_grants ADD CONSTRAINT nonoverlapping_branch_grants EXCLUDE USING gist
 (user_id WITH =,role_code WITH =,org_unit_id WITH =,
  tstzrange(valid_from,valid_until,'[)') WITH &&)
 WHERE (revoked_at IS NULL AND scope_kind='ORG_UNIT');

CREATE TABLE access_change_proposals (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 target_id uuid NOT NULL,
 created_by uuid NOT NULL REFERENCES app_users(id),
 updated_by uuid NOT NULL REFERENCES app_users(id),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 status text NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','PREVIEW','APPLIED')),
 change jsonb NOT NULL CHECK(jsonb_typeof(change)='object'),
 preview_summary jsonb,
 preview_token uuid,
 preview_actor uuid REFERENCES app_users(id),
 preview_hash bytea,
 preview_expires_at timestamptz,
 applied_by uuid REFERENCES app_users(id),
 applied_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((status='PREVIEW' AND preview_token IS NOT NULL AND preview_actor IS NOT NULL
   AND preview_hash IS NOT NULL AND preview_expires_at IS NOT NULL)
   OR (status IN ('DRAFT','APPLIED') AND preview_token IS NULL)),
 CHECK((status='APPLIED') = (applied_at IS NOT NULL AND applied_by IS NOT NULL))
);
CREATE TRIGGER access_change_proposals_guard BEFORE UPDATE OR DELETE ON access_change_proposals
 FOR EACH ROW EXECUTE FUNCTION protect_org_change_proposal();
CREATE TABLE access_administration_provisioning (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 user_id uuid NOT NULL REFERENCES app_users(id),
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 16 AND 500),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER access_administration_provisioning_immutable BEFORE UPDATE OR DELETE ON access_administration_provisioning
 FOR EACH ROW EXECUTE FUNCTION protect_administrator_bootstrap();
