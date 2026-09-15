-- Private, non-authoritative report staging only. No business snapshot tables.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO permissions(code,description) VALUES
 ('data_source.probe','Proposed bounded capability: private aggregate quarantine/preview; never commit');
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('report.staging.recorded','NONE'),('report.staging.provisioned','NONE');
ALTER TABLE audit_log DROP CONSTRAINT audit_log_aggregate_type_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage'));
ALTER TABLE outbox_events DROP CONSTRAINT outbox_events_aggregate_type_check;
ALTER TABLE outbox_events ADD CONSTRAINT outbox_events_aggregate_type_check
 CHECK(aggregate_type IN ('work_item','session','notification','access','org_change','report_stage'));

-- Grant-bound capability, NOT a new role, NETWORK business grant or role-wide
-- permission. Migration grants nothing. Explicit audited operator CLI only.
CREATE TABLE report_staging_access (
 grant_id uuid PRIMARY KEY REFERENCES role_grants(id),
 permission_code text NOT NULL DEFAULT 'data_source.probe'
   REFERENCES permissions(code) CHECK(permission_code='data_source.probe'),
 valid_from timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz,
 revoked_at timestamptz,
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 16 AND 500),
 CHECK(valid_until IS NULL OR valid_until>valid_from)
);
CREATE TABLE report_staging_batches (
 id uuid PRIMARY KEY,
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 network_id uuid NOT NULL REFERENCES org_directory_units(id),
 source_code text NOT NULL CHECK(source_code='QLIK_AGGREGATE_MANUAL'),
 period jsonb NOT NULL CHECK(jsonb_typeof(period)='object'),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 status text NOT NULL CHECK(status IN ('QUARANTINE','NEEDS_MAPPING','REJECTED')),
 storage_state text NOT NULL CHECK(storage_state IN ('WRITING','READY')),
 parser_version text NOT NULL,
 mapping_version text NOT NULL CHECK(mapping_version='UNRESOLVED_V1'),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 preview jsonb,
 preview_hash text CHECK(preview_hash IS NULL OR preview_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(actor_user_id,source_code,network_id,fingerprint),
 CHECK((preview IS NULL)=(preview_hash IS NULL)),
 CHECK(status='QUARANTINE' OR (storage_state='READY' AND preview IS NOT NULL))
);
CREATE TABLE report_staging_files (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES report_staging_batches(id),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120),
 content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'),
 byte_size integer NOT NULL CHECK(byte_size BETWEEN 1 AND 8388608),
 UNIQUE(batch_id,content_hash)
);
CREATE INDEX report_staging_actor_created ON report_staging_batches(actor_user_id,created_at DESC,id);
CREATE FUNCTION protect_report_staging() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Staging has no deletion workflow'; END IF;
 IF TG_TABLE_NAME='report_staging_files' THEN RAISE EXCEPTION 'Source provenance is immutable'; END IF;
 IF OLD.id<>NEW.id OR OLD.actor_user_id<>NEW.actor_user_id OR OLD.grant_id<>NEW.grant_id
  OR OLD.network_id<>NEW.network_id OR OLD.source_code<>NEW.source_code OR OLD.period<>NEW.period
  OR OLD.fingerprint<>NEW.fingerprint OR OLD.parser_version<>NEW.parser_version
  OR OLD.mapping_version<>NEW.mapping_version OR OLD.created_at<>NEW.created_at
  OR NEW.version<>OLD.version+1 OR OLD.status<>'QUARANTINE'
  OR (OLD.storage_state='READY' AND NEW.storage_state<>'READY') THEN
  RAISE EXCEPTION 'Immutable staging identity or invalid transition';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER report_staging_batch_guard BEFORE UPDATE OR DELETE ON report_staging_batches
 FOR EACH ROW EXECUTE FUNCTION protect_report_staging();
CREATE TRIGGER report_staging_file_guard BEFORE UPDATE OR DELETE ON report_staging_files
 FOR EACH ROW EXECUTE FUNCTION protect_report_staging();
