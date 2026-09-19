-- Детальный контур: построчные выгрузки уровня автомобиля и уровня сотрудника.
-- Контур отделён от агрегатного: свои права, свои лимиты, своя политика
-- персональных данных. Миграция не выдаёт ни одного гранта и не создаёт данных.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
INSERT INTO permissions(code,description) VALUES
 ('report_detail.read','Чтение опубликованных детальных строк склада и скидок в пределах области видимости'),
 ('report_detail.publish','Публикация детальных строк из проверенного пакета; отдельно от публикации показателей');
INSERT INTO event_catalog(event_type,notification_policy) VALUES
 ('report.detail.published','NONE');

-- Право на детальный контур выдаётся на конкретный грант, а не роли целиком.
CREATE TABLE report_detail_access (
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 permission_code text NOT NULL REFERENCES permissions(code)
   CHECK(permission_code IN('report_detail.read','report_detail.publish')),
 kinds text[] NOT NULL CHECK(cardinality(kinds) BETWEEN 1 AND 2 AND
   kinds <@ ARRAY['vinInventory','managerDiscounts']),
 valid_from timestamptz NOT NULL DEFAULT now(),
 valid_until timestamptz,
 revoked_at timestamptz,
 approval_reference text NOT NULL CHECK(length(approval_reference) BETWEEN 16 AND 500),
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 PRIMARY KEY(grant_id,permission_code),
 CHECK(valid_until IS NULL OR valid_until>valid_from)
);

-- Идентичность автомобиля. Номер кузова не выдаётся за VIN: вид ключа хранится.
CREATE TABLE vehicle_identity (
 id uuid PRIMARY KEY,
 vehicle_key text NOT NULL UNIQUE CHECK(vehicle_key ~ '^[A-Z0-9-]{8,20}$'),
 key_kind text NOT NULL CHECK(key_kind IN('VIN','FRAME')),
 CHECK(key_kind<>'VIN' OR vehicle_key ~ '^[A-HJ-NPR-Z0-9]{17}$'),
 first_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE report_detail_previews (
 id uuid PRIMARY KEY,
 batch_id uuid NOT NULL REFERENCES report_staging_batches(id),
 file_id uuid NOT NULL REFERENCES report_staging_files(id),
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 kind text NOT NULL CHECK(kind IN('vinInventory','managerDiscounts')),
 command jsonb NOT NULL,
 proposal jsonb NOT NULL,
 proposal_hash text NOT NULL CHECK(proposal_hash ~ '^[a-f0-9]{64}$'),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE TRIGGER report_detail_previews_immutable BEFORE UPDATE OR DELETE ON report_detail_previews
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();

CREATE TABLE report_detail_publications (
 id uuid PRIMARY KEY,
 preview_id uuid NOT NULL UNIQUE REFERENCES report_detail_previews(id),
 batch_id uuid NOT NULL REFERENCES report_staging_batches(id),
 kind text NOT NULL CHECK(kind IN('vinInventory','managerDiscounts')),
 actor_user_id uuid NOT NULL REFERENCES app_users(id),
 grant_id uuid NOT NULL REFERENCES role_grants(id),
 -- Дата среза объявляется публикатором: источник её не содержит.
 observed_on date NOT NULL,
 declaration text NOT NULL CHECK(length(declaration) BETWEEN 10 AND 500),
 source_rows int NOT NULL CHECK(source_rows>0),
 accepted_rows int NOT NULL CHECK(accepted_rows>0),
 excluded_rows int NOT NULL CHECK(excluded_rows>=0),
 conflicts jsonb NOT NULL,
 provenance jsonb NOT NULL,
 audit_id uuid NOT NULL REFERENCES audit_log(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(batch_id,kind,observed_on)
);

-- Склад по автомобилям. Строка источника сохраняет свой номер: повторный
-- идентификатор в одной выгрузке не сливается и не удаляется молча.
CREATE TABLE vehicle_stock_rows (
 id uuid PRIMARY KEY,
 publication_id uuid NOT NULL REFERENCES report_detail_publications(id),
 vehicle_id uuid NOT NULL REFERENCES vehicle_identity(id),
 org_unit_id uuid NOT NULL REFERENCES org_directory_units(id),
 source_row int NOT NULL CHECK(source_row>1),
 observed_on date NOT NULL,
 supply_type text CHECK(supply_type IS NULL OR length(supply_type) BETWEEN 1 AND 80),
 days_on_stock int CHECK(days_on_stock IS NULL OR days_on_stock>=0),
 margin_rub numeric,
 profitability numeric,
 cost_rub numeric,
 sale_price_rub numeric,
 market_price_rub numeric,
 leads int CHECK(leads IS NULL OR leads>=0),
 not_advertised_share numeric CHECK(not_advertised_share IS NULL OR not_advertised_share BETWEEN 0 AND 1),
 arrival_date date,
 advertised_date date,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(publication_id,source_row)
);
CREATE INDEX vehicle_stock_rows_scope ON vehicle_stock_rows(org_unit_id,observed_on);
CREATE INDEX vehicle_stock_rows_vehicle ON vehicle_stock_rows(vehicle_id,observed_on);

-- Скидки по сотрудникам. Филиал в источнике отсутствует, поэтому org_unit_id
-- остаётся пустым до подтверждённой привязки: выдумывать филиал нельзя.
-- Имя сотрудника — персональные данные: хранится срок удаления по 152-ФЗ.
CREATE TABLE manager_discount_rows (
 id uuid PRIMARY KEY,
 publication_id uuid NOT NULL REFERENCES report_detail_publications(id),
 source_row int NOT NULL CHECK(source_row>1),
 source_manager_name text NOT NULL CHECK(length(source_manager_name) BETWEEN 1 AND 160),
 manager_user_id uuid REFERENCES app_users(id),
 org_unit_id uuid REFERENCES org_directory_units(id),
 vehicle_id uuid REFERENCES vehicle_identity(id),
 observed_on date NOT NULL,
 cars_issued int CHECK(cars_issued IS NULL OR cars_issued>=0),
 discount_count int CHECK(discount_count IS NULL OR discount_count>=0),
 discount_share numeric,
 discount_sum_rub numeric,
 unit_discount_rub numeric,
 sale_price_rub numeric,
 discount_of_price numeric,
 retention_class text NOT NULL DEFAULT 'STANDARD_5Y' CHECK(retention_class='STANDARD_5Y'),
 purge_after date NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(publication_id,source_row),
 CHECK(purge_after>observed_on)
);
CREATE INDEX manager_discount_rows_person ON manager_discount_rows(source_manager_name,observed_on);

-- Опубликованная детальная строка — доказательство, а не черновик.
CREATE TRIGGER report_detail_publications_immutable BEFORE UPDATE OR DELETE ON report_detail_publications
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER vehicle_stock_rows_immutable BEFORE UPDATE OR DELETE ON vehicle_stock_rows
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER vehicle_identity_immutable BEFORE UPDATE OR DELETE ON vehicle_identity
 FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
-- Строки скидок допускают ровно одно последующее изменение — подтверждённую
-- привязку к сотруднику и филиалу; сами величины и имя источника неизменны.
CREATE FUNCTION manager_discount_rows_guard() RETURNS trigger AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Опубликованные строки скидок не удаляются.'; END IF;
 IF NEW.publication_id<>OLD.publication_id OR NEW.source_row<>OLD.source_row
    OR NEW.source_manager_name<>OLD.source_manager_name OR NEW.observed_on<>OLD.observed_on
    OR NEW.cars_issued IS DISTINCT FROM OLD.cars_issued
    OR NEW.discount_count IS DISTINCT FROM OLD.discount_count
    OR NEW.discount_share IS DISTINCT FROM OLD.discount_share
    OR NEW.discount_sum_rub IS DISTINCT FROM OLD.discount_sum_rub
    OR NEW.unit_discount_rub IS DISTINCT FROM OLD.unit_discount_rub
    OR NEW.sale_price_rub IS DISTINCT FROM OLD.sale_price_rub
    OR NEW.discount_of_price IS DISTINCT FROM OLD.discount_of_price
    OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
    OR NEW.retention_class<>OLD.retention_class THEN
  RAISE EXCEPTION 'Опубликованные величины и имя источника не изменяются; допустима только привязка сотрудника и филиала.';
 END IF;
 IF OLD.manager_user_id IS NOT NULL AND NEW.manager_user_id IS DISTINCT FROM OLD.manager_user_id THEN
  RAISE EXCEPTION 'Подтверждённая привязка сотрудника не переписывается.';
 END IF;
 IF OLD.org_unit_id IS NOT NULL AND NEW.org_unit_id IS DISTINCT FROM OLD.org_unit_id THEN
  RAISE EXCEPTION 'Подтверждённая привязка филиала не переписывается.';
 END IF;
 RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER manager_discount_rows_guarded BEFORE UPDATE OR DELETE ON manager_discount_rows
 FOR EACH ROW EXECUTE FUNCTION manager_discount_rows_guard();

ALTER TABLE idempotency_records DROP CONSTRAINT idempotency_records_operation_check;
ALTER TABLE idempotency_records ADD CONSTRAINT idempotency_records_operation_check CHECK(operation IN
 ('createWorkItem','assignWorkItem','startWorkItem','patchWorkItemFields','submitWorkItem',
 'acceptWorkItem','reworkWorkItem','cancelWorkItem','reopenWorkItem','readNotification',
 'orgChangeCreate','orgChangeEdit','orgChangePreview','orgChangeApply','reportReviewDraft',
 'accessChangeCreate','accessChangePreview','accessChangeApply','userCreate','reportFactPublish',
 'reportDetailPublish'));
