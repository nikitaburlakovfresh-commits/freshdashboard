SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Матрица балла, утверждённая владельцем 21.09.2026.
--
-- Состав и веса (решение владельца, приоритет 1 источников требований):
--   Выручка                 30  факт к плану, пропорционально прошедшим дням
--   Маржа                   20  факт к плану, пропорционально дням
--   КСО                     15  факт к плану, пропорционально дням
--   Оборачиваемость склада  25  прогноз продаж за месяц / склад на 1 число
--   Конверсия трафик→сделка  5  полосы 17 / 14, больше лучше
--   Кредиты                  5  доля кредитных сделок факт к плану доли
--   Доля 45+ в выкупе        5  полосы 10 / 15, меньше лучше
--
-- Сумма весов 105, а не 100. Это допустимо: балл считается взвешенным средним,
-- то есть делится на сумму весов фактически посчитанных показателей. Поэтому
-- 105 не завышает и не занижает результат, но выглядит как опечатка — вопрос
-- владельцу задан отдельно и правится настройкой без миграции.
--
-- Из прежней модели убраны: прогноз продаж в штуках (владелец считает его тем
-- же, что выручка), оборачиваемость выкупа и оборачиваемость комиссии по
-- отдельности — вместо них одна оборачиваемость склада.
--
-- «Маржа» в портале = КСО + Железо, поэтому КСО входит и в маржу, и в свой
-- собственный вес. Это соответствует прежней матрице старого портала, где
-- маржа 25 и КСО 15 существовали одновременно.
--
-- Дата вступления в силу — 21.09.2026, день решения. Периоды, заканчивающиеся
-- 21.09.2026 и позже, считаются по этой матрице; более ранние периоды
-- остаются на прежней версии, поэтому историческая отчётность не смещается.
-- Дату задним числом не ставим: это исказило бы уже показанные результаты.
--
-- Аддитивная. Повторный прогон безопасен.
-- Неразрушающий откат описан в конце файла.

DO $$
DECLARE
  prev_id uuid;
  new_id uuid := gen_random_uuid();
  author uuid;
  audit uuid;
BEGIN
  SELECT id INTO prev_id FROM scoring_models
   WHERE effective_to IS NULL ORDER BY effective_from DESC LIMIT 1;
  IF prev_id IS NULL THEN
    RAISE NOTICE 'Действующей модели балла нет — версия не создаётся';
    RETURN;
  END IF;

  -- Уже применено: версия с этим составом весов существует.
  IF EXISTS (
    SELECT 1 FROM scoring_weights w
     JOIN scoring_models m ON m.id = w.model_id
    WHERE w.metric = 'stockTurnover' AND m.effective_to IS NULL
  ) THEN
    RAISE NOTICE 'Матрица владельца уже действует — повтор не требуется';
    RETURN;
  END IF;

  SELECT created_by, audit_id INTO author, audit FROM scoring_models WHERE id = prev_id;

  -- Версии модели неизменяемы: допускается только закрытие версии, причём
  -- период обязан быть непустым. Прежняя версия закрывается 21.09.2026.
  UPDATE scoring_models SET effective_to = '2026-09-21' WHERE id = prev_id;

  INSERT INTO scoring_models(
    id, score_cap,
    red_score_below, red_revenue_runrate_below, red_weak_metric_below,
    red_weak_metric_count, stop_turnover_below,
    green_score_above, green_revenue_above, green_turnover_above, green_no_metric_below,
    conversion_green_from, conversion_green_score,
    conversion_amber_from, conversion_amber_score, conversion_red_score,
    green_score_from, amber_score_from,
    effective_from, reason, created_by, audit_id)
  SELECT
    new_id, score_cap,
    red_score_below, red_revenue_runrate_below, red_weak_metric_below,
    red_weak_metric_count, stop_turnover_below,
    green_score_above, green_revenue_above, green_turnover_above, green_no_metric_below,
    conversion_green_from, conversion_green_score,
    conversion_amber_from, conversion_amber_score, conversion_red_score,
    -- Статус по баллу оставляем как есть: зелёный от 90, жёлтый от 80.
    green_score_from, amber_score_from,
    '2026-09-21',
    'Матрица балла владельца от 21.09.2026: выручка 30, маржа 20, КСО 15, оборачиваемость склада 25, конверсия 5, кредиты 5, доля 45+ 5. Прогноз продаж в штуках исключён как дублирующий выручку.',
    author, audit
  FROM scoring_models WHERE id = prev_id;

  INSERT INTO scoring_weights(id, model_id, metric, weight, evaluation, plan_metric, rule_role,
    band_green, band_amber, direction) VALUES
    -- Выручка: факт периода к месячному плану, пропорционально прошедшим дням.
    -- Роль REVENUE — по ней работают прежние правила статуса, если полосы балла
    -- когда-нибудь выключат.
    (gen_random_uuid(), new_id, 'revenue', 30, 'RUN_RATE', 'planRevenue', 'REVENUE',
      NULL, NULL, NULL),
    (gen_random_uuid(), new_id, 'margin', 20, 'RUN_RATE', 'planMargin', 'ORDINARY',
      NULL, NULL, NULL),
    (gen_random_uuid(), new_id, 'kso', 15, 'RUN_RATE', 'planKso', 'ORDINARY',
      NULL, NULL, NULL),
    -- Оборачиваемость склада: расчётный показатель, прогноз продаж за месяц к
    -- складу на 1 число. Доля × 100, ограничение общее для модели.
    (gen_random_uuid(), new_id, 'stockTurnover', 25, 'RATIO_X100', NULL, 'ORDINARY',
      NULL, NULL, NULL),
    (gen_random_uuid(), new_id, 'funnelTrafficToDeal', 5, 'BAND_PCT', NULL, 'ORDINARY',
      17, 14, 'HIGHER_IS_BETTER'),
    -- Кредиты: доля кредитных сделок факт к плановой доле. Коэффициент месяца
    -- не применяется — сравниваются две доли.
    (gen_random_uuid(), new_id, 'creditShareFact', 5, 'RATIO_TO_PLAN', 'creditSharePlan', 'ORDINARY',
      NULL, NULL, NULL),
    (gen_random_uuid(), new_id, 'buyback45Share', 5, 'BAND_PCT', NULL, 'ORDINARY',
      10, 15, 'LOWER_IS_BETTER');
END $$;

-- Неразрушающий откат:
--   UPDATE scoring_models SET effective_to = NULL
--    WHERE effective_from = '2026-09-21' AND effective_to IS NULL;
--   -- затем закрыть версию владельца датой её начала нельзя (период обязан быть
--   -- непустым), поэтому откат выполняется созданием новой версии с прежним
--   -- составом весов через панель модели балла. Строки не удаляются.
