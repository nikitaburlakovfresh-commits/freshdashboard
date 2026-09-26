SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Подсветка ключевых полей ежедневника красным, жёлтым и зелёным.
--
-- Пороги — решение владельца 26.09.2026. Хранятся данными, а не кодом: порог
-- меняется новой версией правила с датой вступления в силу, прежние версии
-- остаются в истории, и ежедневник прошлого дня красится по правилу своего дня.
--
-- rule.bands — список зон по порядку, первая подходящая побеждает. Границы:
-- gt (>), gte (>=), lt (<), lte (<=). Значение вне всех зон не красится: это
-- честнее, чем приписать цвет, которого владелец не задавал.
-- rule.options — цвет по ответу поля выбора.
--
-- basis:
--   INPUT  — красится введённое человеком значение;
--   PORTAL — красится расчёт портала (поле в рублях, а цвет по темпу в %).
--
-- Аддитивная, повторный прогон безопасен.

CREATE TABLE IF NOT EXISTS daily_field_color_rules (
    id bigserial PRIMARY KEY,
    field_path text NOT NULL CHECK (field_path ~ '^[a-z0-9_]{1,80}$'),
    version integer NOT NULL CHECK (version >= 1),
    effective_from date NOT NULL,
    basis text NOT NULL DEFAULT 'INPUT' CHECK (basis IN ('INPUT', 'PORTAL')),
    rule jsonb NOT NULL CHECK (jsonb_typeof(rule) = 'object'),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 3 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (field_path, version)
);

INSERT INTO daily_field_color_rules (field_path, version, effective_from, basis, rule, reason)
SELECT v.field_path, 1, DATE '2026-09-01', v.basis, v.rule::jsonb,
       'Решение владельца 26.09.2026: пороги ежедневника РФ'
FROM (VALUES
  -- Задача 1: темп RunRate к плану месяца. >= 100 зелёный, 90–99,9 жёлтый, < 90 красный.
  ('t1_sales_pct',  'INPUT',  '{"bands":[{"color":"GREEN","gte":100},{"color":"AMBER","gte":90,"lt":100},{"color":"RED","lt":90}]}'),
  ('t1_supply_pct', 'INPUT',  '{"bands":[{"color":"GREEN","gte":100},{"color":"AMBER","gte":90,"lt":100},{"color":"RED","lt":90}]}'),
  ('t1_km',         'PORTAL', '{"bands":[{"color":"GREEN","gte":100},{"color":"AMBER","gte":90,"lt":100},{"color":"RED","lt":90}]}'),
  -- Задача 4: сверка с QLIK. Совпадает — зелёный, не совпадает — красный.
  ('t4_sales',   'INPUT', '{"options":{"Совпадает":"GREEN","Не совпадает":"RED"}}'),
  ('t4_gross',   'INPUT', '{"options":{"Совпадает":"GREEN","Не совпадает":"RED"}}'),
  ('t4_supply',  'INPUT', '{"options":{"Совпадает":"GREEN","Не совпадает":"RED"}}'),
  ('t4_stock',   'INPUT', '{"options":{"Совпадает":"GREEN","Не совпадает":"RED"}}'),
  ('t4_credits', 'INPUT', '{"options":{"Совпадает":"GREEN","Не совпадает":"RED"}}'),
  -- Задача 5: доля 45+ в штуках и деньгах. До 8 % зелёный, свыше 8 до 15 жёлтый, выше 15 красный.
  ('t5_share_pct', 'INPUT', '{"bands":[{"color":"GREEN","lte":8},{"color":"AMBER","gt":8,"lte":15},{"color":"RED","gt":15}]}'),
  ('t5_share_rub', 'INPUT', '{"bands":[{"color":"GREEN","lte":8},{"color":"AMBER","gt":8,"lte":15},{"color":"RED","gt":15}]}'),
  -- Средний возраст старше 30 дней: 31–55 жёлтый, более 55 красный.
  ('t5_age',    'INPUT', '{"bands":[{"color":"GREEN","lte":30},{"color":"AMBER","gt":30,"lte":55},{"color":"RED","gt":55}]}'),
  -- % к рынку старше 30 дней: ниже 100 зелёный, 100–105 жёлтый, выше 105 красный.
  ('t5_market', 'INPUT', '{"bands":[{"color":"GREEN","lt":100},{"color":"AMBER","gte":100,"lte":105},{"color":"RED","gt":105}]}'),
  -- Задача 6: конверсии.
  ('t6_sr_lead',  'INPUT', '{"bands":[{"color":"GREEN","gte":10},{"color":"AMBER","gte":8,"lt":10},{"color":"RED","lt":8}]}'),
  ('t6_sr_call',  'INPUT', '{"bands":[{"color":"GREEN","gt":10},{"color":"AMBER","gte":8,"lte":10},{"color":"RED","lt":8}]}'),
  ('t6_sr_visit', 'INPUT', '{"bands":[{"color":"GREEN","gt":15},{"color":"AMBER","gte":12,"lte":15},{"color":"RED","lt":12}]}'),
  ('t6_sr_chat',  'INPUT', '{"bands":[{"color":"GREEN","gt":6},{"color":"AMBER","gte":4,"lte":6},{"color":"RED","lt":4}]}'),
  -- Задача 7: структура склада. Выше 40 % выкупа (ниже 60 % комиссии) порог не задан — не красится.
  ('t7_share_buy', 'INPUT', '{"bands":[{"color":"GREEN","gte":27,"lte":40},{"color":"AMBER","gte":21,"lt":27},{"color":"RED","lt":21}]}'),
  ('t7_share_com', 'INPUT', '{"bands":[{"color":"GREEN","gte":60,"lte":73},{"color":"AMBER","gt":73,"lte":79},{"color":"RED","gt":79}]}')
) AS v(field_path, basis, rule)
WHERE NOT EXISTS (SELECT 1 FROM daily_field_color_rules r WHERE r.field_path = v.field_path);
