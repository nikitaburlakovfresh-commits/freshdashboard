-- Published SOURCE AGGREGATES, not a substitute for TZ §8 Metric Engine.
-- No grants, periods, source priorities or business facts are seeded.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
CREATE TABLE report_fact_access (
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 capability text NOT NULL CHECK(capability IN('PUBLISH','READ')),
 metrics text[] NOT NULL CHECK(cardinality(metrics) BETWEEN 1 AND 8 AND
   metrics <@ ARRAY['sales','margin','stock','aged','plan','revenue','baseMargin','kso']),
 valid_from timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz,
 revoked_at timestamptz,
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 16 AND 500),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 PRIMARY KEY(grant_id,capability),
 CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE TABLE report_source_scans (
 id uuid PRIMARY KEY,
 file_id uuid NOT NULL REFERENCES report_staging_files(id),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 scanner text NOT NULL,
 result text NOT NULL CHECK(result IN('CLEAN','INFECTED')),
 scanned_at timestamptz NOT NULL DEFAULT now(),
 actor_user_id uuid NOT NULL REFERENCES app_users(id)
);
CREATE TABLE report_fact_previews (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES report_staging_batches(id),
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 review_version bigint NOT NULL,
 review_hash text NOT NULL,
 command jsonb NOT NULL,
 proposal jsonb NOT NULL,
 proposal_hash text NOT NULL CHECK(proposal_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE report_fact_publications (
 id uuid PRIMARY KEY,
 preview_id uuid NOT NULL UNIQUE REFERENCES report_fact_previews(id),
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE report_fact_snapshots (
 id uuid PRIMARY KEY,
 publication_id uuid NOT NULL REFERENCES report_fact_publications(id),
 org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
 metric text NOT NULL CHECK(metric IN('sales','margin','stock','aged','plan','revenue','baseMargin','kso')),
 period_start date NOT NULL,
 period_end date NOT NULL CHECK(period_end>=period_start),
 value numeric NOT NULL,
 unit text NOT NULL CHECK(unit IN('COUNT','RUB')),
 revision int NOT NULL CHECK(revision>0),
 replaces uuid UNIQUE REFERENCES report_fact_snapshots(id),
 provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(org_unit_id,metric,period_start,period_end,revision)
);
-- Current revision is a projection; immutable evidence remains above.
CREATE TABLE report_fact_current (
 org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
 metric text NOT NULL,
 period_start date NOT NULL,
 period_end date NOT NULL,
 snapshot_id uuid NOT NULL UNIQUE REFERENCES report_fact_snapshots(id),
 PRIMARY KEY(org_unit_id,metric,period_start,period_end)
);
CREATE TRIGGER report_source_scans_immutable BEFORE UPDATE OR DELETE ON report_source_scans
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER report_fact_previews_immutable BEFORE UPDATE OR DELETE ON report_fact_previews
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER report_fact_publications_immutable BEFORE UPDATE OR DELETE ON report_fact_publications
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER report_fact_snapshots_immutable BEFORE UPDATE OR DELETE ON report_fact_snapshots
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('report.facts.published','NONE'),('report.source.scanned','NONE'),('report.facts.access','NONE');
ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_operation_check CHECK(operation IN
 ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields','submitWorkItem',
 'acceptWorkItem','reworkWorkItem','cancelWorkItem','reopenWorkItem','readNotification',
 'orgChangeCreate','orgChangeEdit','orgChangePreview','orgChangeApply','reportReviewDraft',
 'accessChangeCreate','accessChangePreview','accessChangeApply','userCreate','reportFactPublish'));
