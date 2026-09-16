-- Separate immutable draft revisions; source probe and business ledger unchanged.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_operation_check CHECK(operation IN
 ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields','submitWorkItem',
 'acceptWorkItem','reworkWorkItem','cancelWorkItem','reopenWorkItem','readNotification',
 'orgChangeCreate','orgChangeEdit','orgChangePreview','orgChangeApply','reportReviewDraft'));
INSERT INTO event_catalog(event_type,notification_policy) VALUES ('report.review.drafted','NONE');
CREATE TABLE report_review_revisions (
 batch_id uuid NOT NULL REFERENCES report_staging_batches(id) ON DELETE RESTRICT,
 version bigint NOT NULL CHECK(version BETWEEN 1 AND 1000),
 stream_id uuid NOT NULL,
 actor_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
 grant_id uuid NOT NULL REFERENCES role_grants(id) ON DELETE RESTRICT,
 preview_hash text NOT NULL CHECK(preview_hash ~ '^[a-f0-9]{64}$'),
 period jsonb CHECK(period IS NULL OR jsonb_typeof(period)='object'),
 mappings jsonb NOT NULL CHECK(jsonb_typeof(mappings)='array' AND jsonb_array_length(mappings)<=1000),
 reason text NOT NULL CHECK(length(reason) BETWEEN 10 AND 500),
 revision_hash text NOT NULL CHECK(revision_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(batch_id,version),
 UNIQUE(stream_id,version)
);
CREATE FUNCTION protect_report_review_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'Report review revisions are append-only';
END $$;
CREATE TRIGGER report_review_immutable BEFORE UPDATE OR DELETE ON report_review_revisions
 FOR EACH ROW EXECUTE FUNCTION protect_report_review_revision();
