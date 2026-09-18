SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- Catalog entry only: no role/user receives this security-sensitive right.
INSERT INTO permissions(code,description) VALUES
 ('report.fact_access.manage','Управлять явными допусками к метрикам через проверку и подтверждение');
CREATE TABLE fact_access_previews (
 id uuid PRIMARY KEY,
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 command jsonb NOT NULL,
 state_hash text NOT NULL,
 summary jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TABLE fact_access_receipts (
 preview_id uuid PRIMARY KEY REFERENCES fact_access_previews(id),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER fact_access_previews_immutable BEFORE UPDATE OR DELETE ON fact_access_previews
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER fact_access_receipts_immutable BEFORE UPDATE OR DELETE ON fact_access_receipts
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
