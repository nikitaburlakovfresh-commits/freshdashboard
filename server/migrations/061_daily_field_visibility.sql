-- Скрытие полей ежедневника без правки шаблона (шаблоны неизменяемы).
-- Решение владельца 26.09.2026: в задаче 7 РФ убрать тройки «Общий / Выкуп /
-- Комиссия» (средний возраст склада и средний срок продажи). Сохранённые
-- значения не удаляются; поле возвращается новой версией с hidden = false.
SET LOCAL search_path = pilot_r1, public, pg_catalog;
CREATE TABLE IF NOT EXISTS daily_field_visibility (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role_code text NOT NULL,
  field_path text NOT NULL,
  version integer NOT NULL CHECK (version >= 1),
  effective_from date NOT NULL,
  hidden boolean NOT NULL,
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (role_code, field_path, version)
);
INSERT INTO daily_field_visibility (role_code, field_path, version, effective_from, hidden, reason)
SELECT 'RF', v.fp, 1, DATE '2026-09-01', true,
       'Решение владельца 26.09.2026: лишние поля задачи 7 после «Средний срок выхода в рекламу»'
FROM (VALUES ('t7_age_all'),('t7_age_buy'),('t7_age_com'),('t7_sold_age_all'),('t7_sold_age_buy'),('t7_sold_age_com')) v(fp)
ON CONFLICT (role_code, field_path, version) DO NOTHING;
