-- 053. МБО региональных менеджеров, делегирование, подзадачи и перенос задач.
--
-- Что было в старом портале (/opt/fresh-dashboard-src/mbo/server.cjs):
--   mbo_forms   — карточка МБО на РМ и период, четыре фиксированные колонки
--                 фокусов (focus_stock, focus_team, focus_kso, focus_turnover);
--   mbo_kpi     — KPI по РМ × период × горизонт (monthly|annual) × филиал,
--                 четыре показателя с весами 40/30/15/15: валовая прибыль
--                 (маржа + КСО), продажи АСП, оборачиваемость комиссии,
--                 висяки 45+; план вводится руками, факт подставляется из BI;
--   mbo_tasks   — СВОЯ таблица задач с весом, сроком, соисполнителем,
--                 прогрессом и комментарием филиала;
--   branch_tasks — ОТДЕЛЬНАЯ таблица задач основного дашборда.
--
-- Из-за двух таблиц руководитель филиала видел два независимых списка задач
-- («tasks» и «dashTasks»), с разными полями и разными правилами закрытия. Одна и
-- та же работа существовала в портале дважды, и ни один список не был полным.
--
-- Здесь МБО своей таблицы задач НЕ получает. Задача остаётся одна — work_items,
-- со своим жизненным циклом, версиями, приёмкой и журналом. МБО ссылается на
-- задачу, а не копирует её. Поэтому задача из карточки филиала попадает и в
-- задачи филиала, и в МБО регионала, оставаясь одной записью: закрыли в одном
-- месте — закрыта везде.
--
-- Откат неразрушающий: удаление добавленных таблиц и колонок. Существующие
-- задачи не меняются.

SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- ─────────────────────────── структура задач ───────────────────────────

-- Подзадачи. Блок работ из карточки филиала — это одна задача-родитель и
-- несколько подзадач под ней. Раньше иерархии не было, и блок распадался на
-- несвязанные задачи.
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS parent_work_item_id uuid
  REFERENCES work_items(id) ON DELETE RESTRICT;
-- Подзадача живёт в том же филиале, что и родитель: иначе право видеть родителя
-- не совпадает с правом видеть подзадачу.
CREATE INDEX IF NOT EXISTS idx_work_items_parent ON work_items(parent_work_item_id)
  WHERE parent_work_item_id IS NOT NULL;

-- Ответственный за результат. Делегирование меняет исполнителя, но не снимает
-- ответственность с того, кому задачу поставили: в сводке о просрочке должны
-- быть видны оба.
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS accountable_user_id uuid
  REFERENCES app_users(id) ON DELETE RESTRICT;

-- Сколько раз задача переносилась. Значение поддерживается вставкой в
-- work_item_migrations и нужно для сводок: «перенесена третий раз» — это другой
-- разговор с ответственным, чем «перенесена впервые».
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS migration_count integer NOT NULL DEFAULT 0
  CONSTRAINT work_items_migration_count_nonneg CHECK (migration_count >= 0);

-- История делегирования. Отдельной таблицей, а не перезаписью исполнителя:
-- кто, кому, когда и почему передал задачу, должно оставаться видимым.
CREATE TABLE IF NOT EXISTS work_item_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  org_unit_id uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  from_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  to_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  -- Причина обязательна: делегирование без причины не отличить от сброса задачи.
  reason text NOT NULL CONSTRAINT work_item_delegations_reason_text
    CHECK (char_length(reason) BETWEEN 3 AND 2000 AND reason ~ '[^[:space:]]'),
  delegated_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  revoked_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  CONSTRAINT work_item_delegations_not_self CHECK (from_user_id <> to_user_id),
  CONSTRAINT work_item_delegations_revoked_pair
    CHECK ((revoked_at IS NULL) = (revoked_by IS NULL)),
  CONSTRAINT work_item_delegations_revoked_after CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE INDEX IF NOT EXISTS idx_work_item_delegations_item
  ON work_item_delegations(work_item_id, created_at DESC);
-- Действующее делегирование у задачи одно: два одновременных исполнителя
-- означают, что не отвечает никто.
CREATE UNIQUE INDEX IF NOT EXISTS uq_work_item_delegation_active
  ON work_item_delegations(work_item_id) WHERE revoked_at IS NULL;

-- История переносов срока. Перенос не переписывает срок молча: старый и новый
-- срок остаются вместе с причиной, поэтому «мигрирующую» задачу видно как есть.
CREATE TABLE IF NOT EXISTS work_item_migrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  org_unit_id uuid NOT NULL REFERENCES org_units(id) ON DELETE RESTRICT,
  due_at_before timestamptz NOT NULL,
  due_at_after timestamptz NOT NULL,
  reason text NOT NULL CONSTRAINT work_item_migrations_reason_text
    CHECK (char_length(reason) BETWEEN 3 AND 2000 AND reason ~ '[^[:space:]]'),
  -- Перенос по решению человека или автоматический при закрытии периода:
  -- в сводке это разные вещи.
  migrated_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  origin text NOT NULL DEFAULT 'MANUAL'
    CONSTRAINT work_item_migrations_origin CHECK (origin IN ('MANUAL','PERIOD_ROLLOVER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT work_item_migrations_moved CHECK (due_at_after <> due_at_before),
  CONSTRAINT work_item_migrations_manual_actor
    CHECK (origin <> 'MANUAL' OR migrated_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_work_item_migrations_item
  ON work_item_migrations(work_item_id, created_at DESC);

-- ─────────────────────────── карточка МБО ───────────────────────────

-- Карточка МБО на сотрудника и период. Период — месяц (YYYY-MM-01): в старом
-- портале это строка 'YYYY-MM', здесь дата, чтобы сравнения и сортировка
-- работали без разбора строк.
CREATE TABLE IF NOT EXISTS mbo_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  period_start date NOT NULL CONSTRAINT mbo_cards_period_month
    CHECK (date_trunc('month', period_start)::date = period_start),
  -- Зона ответственности на период фиксируется в карточке: перевод филиала к
  -- другому РМ в середине года не должен задним числом менять уже согласованное
  -- МБО.
  scope_note text,
  status text NOT NULL DEFAULT 'DRAFT'
    CONSTRAINT mbo_cards_status CHECK (status IN ('DRAFT','SUBMITTED','APPROVED','RETURNED','CLOSED')),
  comment text,
  submitted_at timestamptz,
  submitted_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  approved_at timestamptz,
  approved_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  -- Возврат на доработку с причиной: «вернули молча» не работает.
  returned_reason text,
  entity_version bigint NOT NULL DEFAULT 1 CONSTRAINT mbo_cards_version CHECK (entity_version >= 1),
  created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbo_cards_unique_subject_period UNIQUE (subject_user_id, period_start),
  CONSTRAINT mbo_cards_submitted_pair CHECK ((submitted_at IS NULL) = (submitted_by IS NULL)),
  CONSTRAINT mbo_cards_approved_pair CHECK ((approved_at IS NULL) = (approved_by IS NULL)),
  CONSTRAINT mbo_cards_returned_reason
    CHECK (status <> 'RETURNED' OR (returned_reason IS NOT NULL AND returned_reason ~ '[^[:space:]]')),
  -- Согласовать можно только сданную карточку.
  CONSTRAINT mbo_cards_approved_after_submit
    CHECK (approved_at IS NULL OR (submitted_at IS NOT NULL AND approved_at >= submitted_at))
);
CREATE INDEX IF NOT EXISTS idx_mbo_cards_period ON mbo_cards(period_start DESC, subject_user_id);

-- Фокусы периода — строками, а не четырьмя фиксированными колонками старого
-- портала. Фокусы в портале настраиваются, и новый фокус не должен требовать
-- миграции базы.
CREATE TABLE IF NOT EXISTS mbo_card_focuses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES mbo_cards(id) ON DELETE CASCADE,
  focus_code text,
  title text NOT NULL CONSTRAINT mbo_card_focuses_title
    CHECK (char_length(title) BETWEEN 1 AND 300 AND title ~ '[^[:space:]]'),
  commitment text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mbo_card_focuses_card ON mbo_card_focuses(card_id, sort_order);

-- KPI карточки. Горизонт: месяц периода или год, как в старом портале
-- (monthly|annual). Область — филиал или вся зона ответственности.
CREATE TABLE IF NOT EXISTS mbo_card_kpis (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES mbo_cards(id) ON DELETE CASCADE,
  horizon text NOT NULL CONSTRAINT mbo_card_kpis_horizon CHECK (horizon IN ('MONTH','YEAR')),
  -- NULL — показатель по всей зоне ответственности, а не по отдельному филиалу.
  org_unit_id uuid REFERENCES org_units(id) ON DELETE RESTRICT,
  kpi_code text NOT NULL,
  kpi_name text NOT NULL,
  unit text NOT NULL,
  weight numeric(6,2) CONSTRAINT mbo_card_kpis_weight CHECK (weight IS NULL OR weight >= 0),
  plan_value numeric(18,4),
  -- Факт НЕ хранится: он берётся из опубликованных показателей на момент
  -- просмотра. Копия факта в карточке разошлась бы с отчётностью после
  -- перезагрузки отчёта, и было бы два разных факта за один период.
  -- Здесь остаётся только то, чего в показателях нет:
  manual_fact_value numeric(18,4),
  manual_fact_comment text,
  fact_source text NOT NULL DEFAULT 'PUBLISHED'
    CONSTRAINT mbo_card_kpis_fact_source CHECK (fact_source IN ('PUBLISHED','MANUAL')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  CONSTRAINT mbo_card_kpis_unique UNIQUE (card_id, horizon, org_unit_id, kpi_code),
  -- Ручной факт обязан быть заполнен, если источник объявлен ручным: пустой
  -- ручной факт нельзя показывать как ноль.
  CONSTRAINT mbo_card_kpis_manual_value
    CHECK (fact_source <> 'MANUAL' OR manual_fact_value IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_mbo_card_kpis_card ON mbo_card_kpis(card_id, horizon, sort_order);

-- Связь карточки МБО с задачами. Задача остаётся в work_items; здесь только её
-- место в МБО: вес и на какой фокус она работает. Так задача из карточки филиала
-- структурирует МБО регионала, не превращаясь во вторую запись.
CREATE TABLE IF NOT EXISTS mbo_card_task_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES mbo_cards(id) ON DELETE CASCADE,
  work_item_id uuid NOT NULL REFERENCES work_items(id) ON DELETE RESTRICT,
  focus_id uuid REFERENCES mbo_card_focuses(id) ON DELETE SET NULL,
  weight numeric(6,2) CONSTRAINT mbo_card_task_links_weight CHECK (weight IS NULL OR weight >= 0),
  -- Как задача попала в МБО: поставлена в самом МБО или пришла из карточки
  -- филиала. В сводке это разные источники работы.
  link_origin text NOT NULL DEFAULT 'MBO'
    CONSTRAINT mbo_card_task_links_origin CHECK (link_origin IN ('MBO','BRANCH_CARD','DEVIATION')),
  linked_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mbo_card_task_links_unique UNIQUE (card_id, work_item_id)
);
CREATE INDEX IF NOT EXISTS idx_mbo_card_task_links_item ON mbo_card_task_links(work_item_id);

-- История карточки: сдача, согласование, возврат, правка плана. Нужна, потому
-- что МБО — согласованный документ, и «когда изменился план» обязано быть видно.
CREATE TABLE IF NOT EXISTS mbo_card_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id uuid NOT NULL REFERENCES mbo_cards(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  before_state jsonb,
  after_state jsonb,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mbo_card_history_card ON mbo_card_history(card_id, created_at DESC);

-- Шаблон KPI МБО — настройкой, а не константой в коде. В старом портале это был
-- массив KPI_TEMPLATE внутри server.cjs: смена веса требовала правки кода.
CREATE TABLE IF NOT EXISTS mbo_kpi_template (
  kpi_code text PRIMARY KEY,
  kpi_name text NOT NULL,
  unit text NOT NULL,
  default_weight numeric(6,2),
  -- Код показателя портала, из которого берётся факт. NULL — факта в
  -- показателях нет, и он вводится руками с указанием источника.
  metric_code text,
  -- Знаменатель для показателей-долей: факт = metric_code / metric_code_base.
  -- Висяки 45+ в старом портале считались как stock_45plus_units /
  -- stock_units_end, то есть это не отдельный показатель, а отношение двух.
  metric_code_base text,
  -- Умножать ли отношение на 100: доли в портале хранятся по-разному, и
  -- угадывать по единице измерения нельзя.
  ratio_as_percent boolean NOT NULL DEFAULT true,
  -- Как считать факт за год: сумма (штуки, рубли) или среднее (проценты,
  -- коэффициенты). В старом портале это решалось по единице измерения.
  year_aggregation text NOT NULL DEFAULT 'SUM'
    CONSTRAINT mbo_kpi_template_year_agg CHECK (year_aggregation IN ('SUM','AVERAGE','LAST')),
  -- Направление: у висяков 45+ и оборачиваемости лучше меньше.
  direction text NOT NULL DEFAULT 'HIGHER_IS_BETTER'
    CONSTRAINT mbo_kpi_template_direction
    CHECK (direction IN ('HIGHER_IS_BETTER','LOWER_IS_BETTER')),
  sort_order integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Четыре показателя старого портала с его весами 40/30/15/15. Веса и состав
-- дальше меняются в настройках, а не здесь.
-- Соответствие показателям портала объявлено явно:
--   валовая прибыль — «margin», который в портале и есть «Маржа (КСО +
--     железо), руб.»; удельная unitMarginKso сюда не годится — она на
--     машину, а не на период;
--   продажи АСП — «sales» (в старом портале fact_units_2);
--   оборачиваемость комиссии — «turnoverCommission»;
--   висяки 45+ — отношение «aged» к «stock», как и в старом портале.
INSERT INTO mbo_kpi_template (kpi_code, kpi_name, unit, default_weight, metric_code,
                              metric_code_base, year_aggregation, direction, sort_order)
VALUES
  ('gross_margin', 'Валовая прибыль (маржа + КСО)', 'руб.', 40, 'margin', NULL, 'SUM', 'HIGHER_IS_BETTER', 1),
  ('sales_units', 'Продажи АСП', 'шт', 30, 'sales', NULL, 'SUM', 'HIGHER_IS_BETTER', 2),
  ('turnover_commission', 'Оборачиваемость комиссии', 'коэф.', 15, 'turnoverCommission', NULL, 'AVERAGE', 'LOWER_IS_BETTER', 3),
  ('stock_45plus', 'Висяки 45+', '%', 15, 'aged', 'stock', 'AVERAGE', 'LOWER_IS_BETTER', 4)
ON CONFLICT (kpi_code) DO NOTHING;
