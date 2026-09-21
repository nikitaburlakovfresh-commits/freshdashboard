-- Рейтинг регионального менеджера: три блока, восстановленные из старого портала
-- и подтверждённые решением владельца 21.09.2026.
--
-- Формула снята из работающей сборки старого портала, а не воспроизведена по
-- памяти. Там блок подписан «склад/поставки», но считает он план и факт
-- ПОСТАВОК в штуках: X(planSupplies, suppliesFactUnits). Склада на дату в
-- рейтинге не было. Подпись оставлена честной — «поставки».
--
-- Это НЕ балл филиала. Балл филиала считается матрицей показателей и живёт в
-- scoring_*. Рейтинг регионала — отдельная величина по его зоне: 50 % выполнение
-- плана продаж, 30 % склад на дату, 20 % выполнение плана маржи.
--
-- Чем он отличается от того, что показывалось раньше. Раньше рядом с фамилией
-- стояло среднее арифметическое баллов филиалов зоны. Такое среднее уравнивает
-- филиал с планом в 10 машин и филиал с планом в 60: маленький тянет зону
-- наверх ровно так же, как большой. Здесь величины зоны сначала складываются, а
-- выполнение считается от сложенного — вклад филиала пропорционален его плану.
--
-- Состав блоков объявлен данными: сменить метрику, вес или порог цвета можно
-- настройкой, без релиза.
SET LOCAL search_path = pilot_r1, public, pg_catalog;

CREATE TABLE IF NOT EXISTS rm_rating_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effective_from  date NOT NULL,
  effective_to    date,
  -- Пороги цвета текста: зелёный от green_from, жёлтый от amber_from, ниже красный.
  green_from      numeric NOT NULL,
  amber_from      numeric NOT NULL,
  note            text,
  created_by      uuid REFERENCES app_users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT rm_rating_versions_period CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT rm_rating_versions_bands CHECK (green_from > amber_from)
);

CREATE TABLE IF NOT EXISTS rm_rating_blocks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id    uuid NOT NULL REFERENCES rm_rating_versions(id) ON DELETE CASCADE,
  code          text NOT NULL,
  label         text NOT NULL,
  weight        numeric NOT NULL CHECK (weight > 0),
  fact_metric   text NOT NULL REFERENCES metric_catalog(code),
  plan_metric   text NOT NULL REFERENCES metric_catalog(code),
  -- RUN_RATE — факт приводится к темпу месяца (факт × дней в месяце / прошедших
  -- дней) и делится на план. POINT_IN_TIME — состояние на дату, темп не
  -- применяется: склад на 20-е число не нужно пересчитывать на месяц.
  method        text NOT NULL CHECK (method IN ('RUN_RATE','POINT_IN_TIME')),
  -- HIGHER — чем больше факта к плану, тем лучше. LOWER — наоборот: превышение
  -- плана склада означает затоваривание, поэтому выполнение считается как
  -- план / факт.
  direction     text NOT NULL CHECK (direction IN ('HIGHER','LOWER')),
  -- Ограничение вклада блока. В рейтинге регионала на старом портале его не
  -- было (ограничение в 120 % применялось только к баллу филиала), поэтому здесь
  -- он пуст. Поле оставлено, чтобы ввести ограничение настройкой, если
  -- перевыполнение одного блока начнёт вытягивать зону.
  cap_pct       numeric CHECK (cap_pct IS NULL OR cap_pct > 0),
  sort_order    integer NOT NULL,
  UNIQUE (version_id, code)
);

-- Действующая редакция по решению владельца. Сумма весов 100.
WITH v AS (
  INSERT INTO rm_rating_versions(effective_from,green_from,amber_from,note)
  VALUES (DATE '2026-09-01', 90, 80,
    'Формула старого портала, подтверждённая владельцем 21.09.2026: продажи 50, поставки 30, маржа 20; зелёный от 90 %, жёлтый 80–90 %, красный ниже 80 %. Без ограничения перевыполнения, как в исходной формуле.')
  RETURNING id
)
INSERT INTO rm_rating_blocks(version_id,code,label,weight,fact_metric,plan_metric,method,direction,cap_pct,sort_order)
SELECT v.id, b.code, b.label, b.weight, b.fact_metric, b.plan_metric, b.method, b.direction, b.cap_pct::numeric, b.sort_order
FROM v, (VALUES
  ('sales','Продажи, план/факт run-rate',50,'sales','plan','RUN_RATE','HIGHER',NULL::text,10),
  ('supplies','Поставки, план/факт run-rate',30,'suppliesFact','suppliesPlan','RUN_RATE','HIGHER',NULL,20),
  ('margin','Маржа, план/факт run-rate',20,'margin','planMargin','RUN_RATE','HIGHER',NULL,30)
) AS b(code,label,weight,fact_metric,plan_metric,method,direction,cap_pct,sort_order);
