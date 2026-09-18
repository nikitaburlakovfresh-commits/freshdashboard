-- Initial personal enrollment only. Existing credentials and grants untouched.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
ALTER TABLE app_users ADD COLUMN primary_email text
 CHECK(primary_email IS NULL OR (length(primary_email) BETWEEN 3 AND 254 AND primary_email=lower(btrim(primary_email))));
CREATE UNIQUE INDEX personal_email_unique ON app_users(lower(primary_email)) WHERE primary_email IS NOT NULL;
-- Preflight duplicates abort migration, never silently merge identities.
CREATE UNIQUE INDEX personal_login_casefold_unique ON app_users(lower(login));
INSERT INTO permissions(code,description) VALUES
 ('user.create','Create an inactive individual with no grants'),
 ('user.enrollment.manage','Issue, replace or revoke initial enrollment, never reset an existing account');
INSERT INTO event_catalog(event_type,notification_policy) VALUES ('user.enrollment.recorded','NONE');
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_operation_check CHECK(operation IN
 ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields','submitWorkItem',
 'acceptWorkItem','reworkWorkItem','cancelWorkItem','reopenWorkItem','readNotification',
 'orgChangeCreate','orgChangeEdit','orgChangePreview','orgChangeApply','reportReviewDraft',
 'accessChangeCreate','accessChangePreview','accessChangeApply','userCreate'));
CREATE TABLE user_enrollments (
 user_id uuid PRIMARY KEY REFERENCES app_users(id),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 token_digest bytea UNIQUE CHECK(token_digest IS NULL OR octet_length(token_digest)=32),
 expires_at timestamptz,
 completed_at timestamptz,
 CHECK((token_digest IS NULL) = (expires_at IS NULL)),
 CHECK(completed_at IS NULL OR token_digest IS NULL)
);
-- No role_permissions insert: enabling these two rights needs separate approval.
