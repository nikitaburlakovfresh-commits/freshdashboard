-- PostgreSQL 16 draft / R1 НА СОГЛАСОВАНИЕ. Not production-ready.
-- Run only as a reviewed migration in a disposable database; NOT deployed here.
-- One-time schema creation, intentionally not an idempotent migration runner.
-- Server obligations and omitted operational grants/RLS: ENGINEERING_PILOT.md §8.
BEGIN;
CREATE SCHEMA pilot_r1;
SET LOCAL search_path = pilot_r1, pg_catalog;
SET LOCAL TIME ZONE 'UTC';

CREATE TABLE org_units (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE CHECK (code IN ('A', 'B')),
    display_name text NOT NULL,
    is_synthetic boolean NOT NULL DEFAULT true CHECK (is_synthetic)
);

-- Reference mapping to the EXISTING identity store; do not duplicate credentials.
-- No seeded users or passwords. Real integration requires an approved adapter.
CREATE TABLE app_users (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    login text NOT NULL UNIQUE CHECK (char_length(login) BETWEEN 1 AND 200),
    full_name text NOT NULL CHECK (full_name ~ '[^[:space:]]'),
    user_kind text NOT NULL DEFAULT 'INDIVIDUAL' CHECK (user_kind = 'INDIVIDUAL'),
    password_hash text NOT NULL CHECK (char_length(password_hash) > 0),
    password_hash_updated_at timestamptz NOT NULL,
    password_last_shared_indicator boolean NOT NULL DEFAULT false,
    is_active boolean NOT NULL DEFAULT true,
    auth_epoch bigint NOT NULL DEFAULT 1 CHECK (auth_epoch >= 1),
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
    code text PRIMARY KEY CHECK (code IN ('REGIONAL_MANAGER', 'RF')),
    display_name text NOT NULL,
    scope_kind text NOT NULL DEFAULT 'ORG_UNIT' CHECK (scope_kind = 'ORG_UNIT')
);

CREATE TABLE permissions (
    code text PRIMARY KEY,
    description text NOT NULL
);

CREATE TABLE role_permissions (
    role_code text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
    permission_code text NOT NULL REFERENCES permissions(code) ON DELETE RESTRICT,
    PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE role_grants (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    role_code text NOT NULL REFERENCES roles(code) ON DELETE RESTRICT,
    org_unit_id uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
    valid_from timestamptz NOT NULL,
    valid_until timestamptz,
    revoked_at timestamptz,
    grant_version bigint NOT NULL DEFAULT 1 CHECK (grant_version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (valid_until IS NULL OR valid_until > valid_from)
);
-- This disallows overlapping unrevoked grants of the SAME user/role/org by
-- allowing only one unrevoked row, including expired rows. Renew/revoke old
-- row transactionally; other roles/orgs remain independent. Not network scope.
CREATE UNIQUE INDEX one_unrevoked_grant
    ON role_grants(user_id, role_code, org_unit_id) WHERE revoked_at IS NULL;
CREATE INDEX grants_scope ON role_grants(org_unit_id, role_code, user_id);

CREATE TABLE sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest) = 32),
    csrf_digest bytea NOT NULL CHECK (octet_length(csrf_digest) = 32),
    captured_auth_epoch bigint NOT NULL CHECK (captured_auth_epoch >= 1),
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    CHECK (expires_at > created_at),
    CHECK (last_seen_at >= created_at),
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX sessions_user ON sessions(user_id) WHERE revoked_at IS NULL;

CREATE TABLE templates (
    id uuid PRIMARY KEY,
    code text NOT NULL UNIQUE CHECK (code = 'pilot_task_v1'),
    version integer NOT NULL CHECK (version = 1),
    requires_acceptance boolean NOT NULL DEFAULT true CHECK (requires_acceptance),
    field_schema_version integer NOT NULL DEFAULT 1 CHECK (field_schema_version = 1),
    field_path text NOT NULL DEFAULT 'completion_summary'
        CHECK (field_path = 'completion_summary'),
    max_field_chars integer NOT NULL DEFAULT 4000 CHECK (max_field_chars = 4000),
    UNIQUE (id, requires_acceptance)
);

CREATE TABLE work_items (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_unit_id uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
    template_version_id uuid NOT NULL,
    requires_acceptance boolean NOT NULL DEFAULT true CHECK (requires_acceptance),
    title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200
                              AND title ~ '[^[:space:]]'),
    due_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'DRAFT'
        CHECK (status IN ('DRAFT','ASSIGNED','IN_PROGRESS','SUBMITTED','COMPLETED','CANCELLED')),
    assignee_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    is_blocked boolean NOT NULL DEFAULT false,
    blocked_reason text,
    current_submission_id uuid,
    submission_revision integer NOT NULL DEFAULT 0 CHECK (submission_revision >= 0),
    rework_count integer NOT NULL DEFAULT 0 CHECK (rework_count >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, org_unit_id),
    FOREIGN KEY (template_version_id, requires_acceptance)
        REFERENCES templates(id, requires_acceptance) ON DELETE RESTRICT,
    CHECK (updated_at >= created_at),
    CHECK ((status = 'DRAFT' AND assignee_user_id IS NULL)
        OR status = 'CANCELLED'
        OR (status IN ('ASSIGNED','IN_PROGRESS','SUBMITTED','COMPLETED')
            AND assignee_user_id IS NOT NULL)),
    CHECK ((NOT is_blocked AND blocked_reason IS NULL)
        OR (is_blocked AND status IN ('ASSIGNED','IN_PROGRESS')
            AND blocked_reason IS NOT NULL
            AND char_length(blocked_reason) BETWEEN 1 AND 500
            AND blocked_reason ~ '[^[:space:]]')),
    CHECK ((current_submission_id IS NULL AND submission_revision = 0)
        OR (current_submission_id IS NOT NULL AND submission_revision >= 1)),
    CHECK (status NOT IN ('SUBMITTED','COMPLETED') OR current_submission_id IS NOT NULL)
);
CREATE INDEX work_items_scope_page ON work_items(org_unit_id, created_at, id);
CREATE INDEX work_items_assignee ON work_items(assignee_user_id, org_unit_id, status);

CREATE TABLE work_item_fields (
    work_item_id uuid PRIMARY KEY,
    org_unit_id uuid NOT NULL,
    field_path text NOT NULL DEFAULT 'completion_summary'
        CHECK (field_path = 'completion_summary'),
    value text,
    field_version bigint NOT NULL DEFAULT 1 CHECK (field_version >= 1),
    updated_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (work_item_id, org_unit_id)
        REFERENCES work_items(id, org_unit_id) ON DELETE RESTRICT,
    CHECK (value IS NULL OR (char_length(value) BETWEEN 1 AND 4000
                            AND value ~ '[^[:space:]]'))
);

CREATE TABLE submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    work_item_id uuid NOT NULL,
    org_unit_id uuid NOT NULL,
    revision integer NOT NULL CHECK (revision >= 1),
    completion_summary text NOT NULL
        CHECK (char_length(completion_summary) BETWEEN 1 AND 4000
               AND completion_summary ~ '[^[:space:]]'),
    field_version bigint NOT NULL CHECK (field_version >= 1),
    entity_version bigint NOT NULL CHECK (entity_version >= 1),
    template_version_id uuid NOT NULL REFERENCES templates(id) ON DELETE RESTRICT,
    due_at timestamptz NOT NULL,
    submitted_at timestamptz NOT NULL DEFAULT now(),
    submitted_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    submission_marker text NOT NULL CHECK (submission_marker IN ('ON_TIME','LATE')),
    UNIQUE (work_item_id, revision),
    UNIQUE (work_item_id, org_unit_id, id, revision),
    FOREIGN KEY (work_item_id, org_unit_id)
        REFERENCES work_items(id, org_unit_id) ON DELETE RESTRICT,
    CHECK ((submitted_at <= due_at AND submission_marker = 'ON_TIME')
        OR (submitted_at > due_at AND submission_marker = 'LATE'))
);
ALTER TABLE work_items ADD CONSTRAINT current_submission_same_item
    FOREIGN KEY (id, org_unit_id, current_submission_id, submission_revision)
    REFERENCES submissions(work_item_id, org_unit_id, id, revision)
    ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;
-- Circular pointer is deferred to allow INSERT snapshot + UPDATE pointer in
-- one transaction. Snapshot must already belong to an existing work_item.

CREATE TABLE audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    actor_role text REFERENCES roles(code) ON DELETE RESTRICT,
    org_unit_id uuid REFERENCES org_units(id) ON DELETE RESTRICT,
    work_item_id uuid,
    action text NOT NULL,
    aggregate_type text NOT NULL CHECK (aggregate_type IN ('work_item','session','notification','access')),
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL CHECK (aggregate_version >= 1),
    request_id uuid NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    before_state jsonb,
    after_state jsonb,
    reason text CHECK (reason IS NULL OR (char_length(reason) BETWEEN 1 AND 500
                                         AND reason ~ '[^[:space:]]')),
    resolution text CHECK (resolution IN ('APPLIED','REJECTED')),
    ip inet,
    user_agent text CHECK (user_agent IS NULL OR char_length(user_agent) <= 1000),
    retention_class text NOT NULL
        CHECK (retention_class IN ('WORK_ITEM_STANDARD','SECURITY_5Y','ACCESS_RESOLUTION_90D')),
    FOREIGN KEY (work_item_id, org_unit_id)
        REFERENCES work_items(id, org_unit_id) ON DELETE RESTRICT,
    CHECK (work_item_id IS NULL OR org_unit_id IS NOT NULL),
    CHECK (before_state IS NULL OR jsonb_typeof(before_state) = 'object'),
    CHECK (after_state IS NULL OR jsonb_typeof(after_state) = 'object')
);
CREATE INDEX audit_history ON audit_log(work_item_id, aggregate_version, id)
    WHERE aggregate_type = 'work_item' AND resolution = 'APPLIED';

CREATE TABLE event_catalog (
    event_type text PRIMARY KEY,
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    consumer_name text NOT NULL DEFAULT 'in_app_v1',
    notification_policy text NOT NULL
        CHECK (notification_policy IN ('NONE','ASSIGNEE','REVIEWERS')),
    audit_policy text NOT NULL DEFAULT 'REQUIRED' CHECK (audit_policy = 'REQUIRED')
);

CREATE TABLE outbox_events (
    event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_type text NOT NULL REFERENCES event_catalog(event_type) ON DELETE RESTRICT,
    aggregate_type text NOT NULL CHECK (aggregate_type IN ('work_item','session','notification','access')),
    aggregate_id uuid NOT NULL,
    aggregate_version bigint NOT NULL CHECK (aggregate_version >= 1),
    org_unit_id uuid REFERENCES org_units(id) ON DELETE RESTRICT,
    actor_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version = 1),
    correlation_id uuid NOT NULL,
    audit_id uuid NOT NULL UNIQUE REFERENCES audit_log(id) ON DELETE RESTRICT,
    payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
    delivery_status text NOT NULL DEFAULT 'PENDING'
        CHECK (delivery_status IN ('PENDING','PROCESSING','PROCESSED','RETRY')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz,
    UNIQUE (aggregate_type, aggregate_id, aggregate_version),
    UNIQUE (event_id, org_unit_id)
);
CREATE INDEX outbox_pending ON outbox_events(next_attempt_at, occurred_at)
    WHERE delivery_status IN ('PENDING','RETRY');

CREATE TABLE consumer_receipts (
    consumer text NOT NULL,
    event_id uuid NOT NULL REFERENCES outbox_events(event_id) ON DELETE RESTRICT,
    outcome text NOT NULL CHECK (outcome IN ('APPLIED','SKIPPED_ACCESS_REVOKED')),
    processed_at timestamptz NOT NULL DEFAULT now(),
    reason text,
    PRIMARY KEY (consumer, event_id),
    CHECK (outcome <> 'SKIPPED_ACCESS_REVOKED' OR reason IS NOT NULL)
);

CREATE TABLE notifications (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    org_unit_id uuid NOT NULL,
    work_item_id uuid NOT NULL,
    channel text NOT NULL DEFAULT 'IN_APP' CHECK (channel = 'IN_APP'),
    message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 300),
    entity_version bigint NOT NULL DEFAULT 1 CHECK (entity_version >= 1),
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at timestamptz,
    UNIQUE (event_id, recipient_user_id),
    FOREIGN KEY (work_item_id, org_unit_id)
        REFERENCES work_items(id, org_unit_id) ON DELETE RESTRICT,
    FOREIGN KEY (event_id, org_unit_id)
        REFERENCES outbox_events(event_id, org_unit_id) ON DELETE RESTRICT,
    CHECK (read_at IS NULL OR read_at >= created_at)
);
CREATE INDEX notifications_inbox ON notifications(recipient_user_id, created_at, id);

CREATE TABLE idempotency_records (
    actor_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    operation text NOT NULL CHECK (operation IN
        ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields',
         'submitWorkItem','acceptWorkItem','reworkWorkItem','cancelWorkItem',
         'reopenWorkItem','readNotification')),
    key text NOT NULL CHECK (char_length(key) BETWEEN 16 AND 128
                             AND key ~ '^[A-Za-z0-9._:-]+$'),
    target_id uuid, -- null for create; fingerprint includes path + body org
    payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
    status text NOT NULL CHECK (status IN ('IN_PROGRESS','SUCCEEDED')),
    response_status smallint,
    response_body jsonb, -- only authorized business response, never auth tokens
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    PRIMARY KEY (actor_id, operation, key),
    CHECK (expires_at >= created_at + interval '30 days'),
    CHECK ((status = 'IN_PROGRESS' AND response_status IS NULL AND response_body IS NULL)
        OR (status = 'SUCCEEDED' AND response_status IN (200,201)
            AND response_body IS NOT NULL AND jsonb_typeof(response_body) = 'object'))
);
CREATE INDEX idempotency_expiry ON idempotency_records(expires_at);

CREATE FUNCTION reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'immutable pilot evidence: %', TG_TABLE_NAME
        USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER submissions_immutable BEFORE UPDATE OR DELETE ON submissions
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER templates_immutable BEFORE UPDATE OR DELETE ON templates
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE FUNCTION reject_org_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id THEN
        RAISE EXCEPTION 'work_item org_unit_id is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER work_item_org_immutable BEFORE UPDATE ON work_items
    FOR EACH ROW EXECUTE FUNCTION reject_org_change();

INSERT INTO org_units(id, code, display_name) VALUES
('00000000-0000-4000-8000-00000000000a', 'A', 'Синтетический филиал A'),
('00000000-0000-4000-8000-00000000000b', 'B', 'Синтетический филиал B');
INSERT INTO roles(code, display_name) VALUES
('REGIONAL_MANAGER', 'Региональный менеджер пилота'),
('RF', 'Исполнитель филиала пилота');
INSERT INTO permissions(code, description) VALUES
('work_item.read','Read visible work items'),
('work_item.create','Create in granted branch'),
('work_item.assign','Assign active branch RF from DRAFT'),
('work_item.start','Start own assigned work item'),
('work_item.fields.write','CAS own completion_summary'),
('work_item.submit','Submit own saved snapshot'),
('work_item.accept','Review another executor in granted branch'),
('work_item.rework','Return another executor to rework'),
('work_item.cancel','Cancel in granted branch'),
('work_item.reopen','Reopen completed in granted branch'),
('work_item.history.read','Read visible work item history'),
('notification.read','Read own currently authorized notifications');
INSERT INTO role_permissions(role_code, permission_code)
SELECT 'REGIONAL_MANAGER', code FROM permissions WHERE code IN
('work_item.read','work_item.create','work_item.assign','work_item.accept',
 'work_item.rework','work_item.cancel','work_item.reopen',
 'work_item.history.read','notification.read');
INSERT INTO role_permissions(role_code, permission_code)
SELECT 'RF', code FROM permissions WHERE code IN
('work_item.read','work_item.start','work_item.fields.write','work_item.submit',
 'work_item.history.read','notification.read');
INSERT INTO templates(id, code, version) VALUES
('00000000-0000-4000-8000-000000000101','pilot_task_v1',1);
INSERT INTO event_catalog(event_type, notification_policy) VALUES
('auth.logged_in','NONE'),
('auth.logged_out','NONE'),
('permission.revoked','NONE'),
('work_item.created','NONE'),
('work_item.assigned','ASSIGNEE'),
('work_item.started','NONE'),
('work_item.fields_patched','NONE'),
('work_item.submitted','REVIEWERS'),
('work_item.accepted','ASSIGNEE'),
('work_item.rework_requested','ASSIGNEE'),
('work_item.cancelled','ASSIGNEE'),
('work_item.reopened','ASSIGNEE'),
('notification.created','NONE'),
('notification.read','NONE');

COMMENT ON SCHEMA pilot_r1 IS
    'R1 contract draft: synthetic only; API authorization and transaction guards not implemented.';
COMMENT ON TABLE submissions IS
    'Immutable saved snapshot; reviewer decision belongs in audit/history, never overwrite snapshot.';
COMMENT ON TABLE audit_log IS
    'Append-only at ordinary SQL privilege level; privileged retention/hold process needs signoff.';
COMMENT ON TABLE idempotency_records IS
    'Successful response + business mutation + audit + outbox must commit atomically in server.';
COMMIT;
