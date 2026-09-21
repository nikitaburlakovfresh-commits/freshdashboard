SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Модель балла по ТЗ v2.12 §22.1: полосы на каждый показатель и статус по баллу.
--
-- Почему это исправление, а не изменение бизнес-правил. Действующая модель
-- портала была перенесена из файла `server/rag-calc.ts` исходников старого
-- портала. Этот файл в старом портале не используется: рабочий код вызывает
-- расчёт с третьим параметром, которого в нём нет. Фактически работающая
-- модель извлечена из рабочей сборки `dist/index.cjs` и совпадает с ТЗ §22.1:
-- функция вида sk(факт, план_фокус, план_минимум), баллы 110 и 90, ограничение
-- 120, направление «больше лучше» или «меньше лучше», настройка по каждому
-- показателю. То есть от ТЗ отклонялась наша реализация, а не старый портал.
--
-- Проверка перед миграцией: рабочая модель, восстановленная и прогнанная на
-- данных старого портала за 21.09.2026, даёт 11 зелёных, 6 жёлтых, 21 красный
-- и средний балл 77,5 — ровно то, что показывает боевой портал.
--
-- Расхождение с ТЗ, которое сохраняем осознанно: ТЗ §22.1.2 требует для
-- красного пропорциональный балл в диапазоне 0–90, рабочий портал ставит
-- плоские 50. Оставляем 50, иначе цифры не совпадут с боевым порталом.
--
-- Аддитивная. Повторный прогон безопасен.
-- Неразрушающий откат описан в конце файла.

-- 1. Статус по баллу. NULL в обоих полях = правило выключено, работают
--    прежние правила (порог выручки, стоп-фактор, слабые показатели).
--    Заданы оба — статус определяется только баллом, прежние правила молчат.
ALTER TABLE scoring_models ADD COLUMN IF NOT EXISTS green_score_from numeric;
ALTER TABLE scoring_models ADD COLUMN IF NOT EXISTS amber_score_from numeric;

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='scoring_models_score_bands') THEN
    ALTER TABLE scoring_models ADD CONSTRAINT scoring_models_score_bands CHECK (
      (green_score_from IS NULL AND amber_score_from IS NULL)
      OR (green_score_from IS NOT NULL AND amber_score_from IS NOT NULL
          AND green_score_from >= amber_score_from AND amber_score_from >= 0)
    );
  END IF;
END $$;

-- 2. Полосы и направление на каждый показатель.
ALTER TABLE scoring_weights ADD COLUMN IF NOT EXISTS band_green numeric;
ALTER TABLE scoring_weights ADD COLUMN IF NOT EXISTS band_amber numeric;
ALTER TABLE scoring_weights ADD COLUMN IF NOT EXISTS direction text;

-- 3. Два новых способа расчёта.
--    RATIO_TO_PLAN — прогноз к плану без коэффициента месяца: прогноз уже
--    учитывает темп, делить его ещё раз на долю месяца нельзя.
--    BAND_PCT — значение × 100 сравнивается с полосами по направлению.
ALTER TABLE scoring_weights DROP CONSTRAINT IF EXISTS scoring_weights_evaluation_check;
ALTER TABLE scoring_weights ADD CONSTRAINT scoring_weights_evaluation_check CHECK (
  evaluation = ANY (ARRAY['RUN_RATE','RATIO_X100','CONVERSION_BANDS','RATIO_TO_PLAN','BAND_PCT'])
);

DO $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='scoring_weights_direction_check') THEN
    ALTER TABLE scoring_weights ADD CONSTRAINT scoring_weights_direction_check CHECK (
      direction IS NULL OR direction = ANY (ARRAY['HIGHER_IS_BETTER','LOWER_IS_BETTER'])
    );
  END IF;
  -- Полосы обязательны для BAND_PCT и запрещены для остальных способов:
  -- иначе в настройке появится показатель с полосами, которые никуда не влияют.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='scoring_weights_band_required') THEN
    ALTER TABLE scoring_weights ADD CONSTRAINT scoring_weights_band_required CHECK (
      (evaluation = 'BAND_PCT'
        AND band_green IS NOT NULL AND band_amber IS NOT NULL AND direction IS NOT NULL)
      OR (evaluation <> 'BAND_PCT'
        AND band_green IS NULL AND band_amber IS NULL AND direction IS NULL)
    );
  END IF;
  -- Прогноз к плану без плана посчитать нельзя.
  IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='scoring_weights_ratio_plan') THEN
    ALTER TABLE scoring_weights ADD CONSTRAINT scoring_weights_ratio_plan CHECK (
      evaluation <> 'RATIO_TO_PLAN' OR plan_metric IS NOT NULL
    );
  END IF;
END $$;

-- 4. Доля 45+ в выкупе по штукам.
--    Это НЕ показатель agedShare из сводного отчёта: там доля по среднему
--    возрасту остатка. В модели старого портала участвует доля автомобилей с
--    хранением 45 дней и более среди машин выкупа, считаемая по реестру VIN.
--    Подменять одно другим нельзя — значение разойдётся.
INSERT INTO metric_catalog(code, display_name, unit, is_count, is_additive, is_active)
VALUES('buyback45Share', 'Доля 45+ в выкупе (шт)', 'PCT', false, false, true)
ON CONFLICT (code) DO NOTHING;

-- 5. Версия модели, воспроизводящая работающий портал.
--    Вступает в силу с 01.09.2026, как и предыдущая версия: предыдущая
--    считала сентябрь по устаревшим правилам, её результат неверен, поэтому
--    она закрывается той же датой и в расчёт не попадает. Это исправление
--    дефекта расчёта, а не изменение управленческих правил задним числом.
DO $$
DECLARE
  prev_id   uuid;
  prev_from date;
  new_id    uuid := gen_random_uuid();
  who       uuid;
  aud       uuid;
BEGIN
  IF EXISTS(SELECT 1 FROM scoring_models WHERE reason LIKE 'Восстановление рабочей модели%') THEN
    RETURN; -- повторный прогон
  END IF;

  SELECT id, created_by, audit_id, effective_from INTO prev_id, who, aud, prev_from
    FROM scoring_models WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1;
  IF prev_id IS NULL THEN
    -- Окружение без настроенной модели балла (чистая база, репетиционный
    -- контур). Создавать модель здесь нельзя: у неё обязательны автор и запись
    -- аудита, а их взять неоткуда. Настройка выполняется в портале.
    RAISE NOTICE 'Действующей модели балла нет — версия не создаётся';
    RETURN;
  END IF;

  -- Версии модели неизменяемы: триггер портала допускает только закрытие
  -- версии, а период версии обязан быть непустым. Поэтому ошибочная версия от
  -- 19.09.2026 (она начинается 2026-09-01) закрывается следующим днём, а
  -- исправленная версия начинается с 2026-09-02. Портал выбирает версию по
  -- дате окончания периода, поэтому любой период, заканчивающийся 02.09.2026
  -- или позже, считается по исправленной модели. История не переписывается:
  -- видно, что версия существовала один день и чем была заменена.
  UPDATE scoring_models SET effective_to = '2026-09-02' WHERE id = prev_id;

  INSERT INTO scoring_models(
    id, score_cap,
    red_score_below, red_revenue_runrate_below, red_weak_metric_below,
    red_weak_metric_count, stop_turnover_below,
    green_score_above, green_revenue_above, green_turnover_above, green_no_metric_below,
    conversion_green_from, conversion_green_score,
    conversion_amber_from, conversion_amber_score, conversion_red_score,
    green_score_from, amber_score_from,
    effective_from, reason, created_by, audit_id)
  VALUES(
    new_id, 120,
    -- Прежние правила остаются в строке только потому, что столбцы NOT NULL.
    -- При заданных green_score_from и amber_score_from они не применяются.
    80, 75, 70, 2, 75,
    90, 85, 85, 70,
    -- Полосы конверсии переехали в сам показатель; здесь остаются баллы полос
    -- 110 / 90 / 50, общие для всех показателей с полосами.
    17, 110, 14, 90, 50,
    90, 80,
    '2026-09-02',
    'Восстановление рабочей модели старого портала по ТЗ §22.1: статус по баллу 90 и 80, полосы на каждый показатель. Прежняя версия была перенесена из неиспользуемого файла исходников.',
    who, aud);

  INSERT INTO scoring_weights(id, model_id, metric, weight, evaluation, plan_metric, rule_role,
    band_green, band_amber, direction) VALUES
    -- Продажи, шт: прогноз к плану.
    (gen_random_uuid(), new_id, 'forecast', 40, 'RATIO_TO_PLAN', 'plan', 'ORDINARY',
      NULL, NULL, NULL),
    -- Маржа+КСО: прогноз к плану. «Маржа» в портале = КСО + Железо.
    (gen_random_uuid(), new_id, 'forecastMargin', 15, 'RATIO_TO_PLAN', 'planMargin', 'ORDINARY',
      NULL, NULL, NULL),
    (gen_random_uuid(), new_id, 'turnoverBuyout', 10, 'BAND_PCT', NULL, 'ORDINARY',
      95, 85, 'HIGHER_IS_BETTER'),
    (gen_random_uuid(), new_id, 'turnoverCommission', 20, 'BAND_PCT', NULL, 'ORDINARY',
      36, 32, 'HIGHER_IS_BETTER'),
    (gen_random_uuid(), new_id, 'funnelTrafficToDeal', 5, 'BAND_PCT', NULL, 'ORDINARY',
      17, 14, 'HIGHER_IS_BETTER'),
    -- Чем меньше доля залежавшихся машин, тем лучше.
    (gen_random_uuid(), new_id, 'buyback45Share', 10, 'BAND_PCT', NULL, 'ORDINARY',
      10, 15, 'LOWER_IS_BETTER');
END $$;

-- Неразрушающий откат:
--   UPDATE scoring_models SET effective_to = NULL
--    WHERE id = (SELECT id FROM scoring_models WHERE effective_to = '2026-09-02'
--                ORDER BY effective_from DESC LIMIT 1);
--   UPDATE scoring_models SET effective_to = '2026-09-02'
--    WHERE reason LIKE 'Восстановление рабочей модели%';
-- Столбцы и показатель справочника при откате не удаляются: они аддитивны.

-- Содержание версии 24def822-f0ac-4568-943e-2e6982295fbc до исправления,
-- зафиксировано перед применением (прогон 21.09.2026):
--   score_cap 120, red_score_below 70, green_score_above 85,
--   red_revenue_runrate_below 75, red_weak_metric_below 70,
--   red_weak_metric_count 2, stop_turnover_below 75,
--   green_revenue_above 85, green_turnover_above 85, green_no_metric_below 70,
--   green_score_from NULL, amber_score_from NULL.
--   Веса: sales 30 RUN_RATE plan REVENUE; margin 25 RUN_RATE planMargin;
--         kso 15 RUN_RATE planKso; turnoverBuyout 15 RATIO_X100 TURNOVER_STOP.
-- Этот набор давал 1 зелёный филиал против 11 на работающем портале, потому что
-- был перенесён из файла исходников, который сам портал не вызывает.
