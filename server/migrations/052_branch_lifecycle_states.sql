SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Состояния филиалов: 39 действующих.
--
-- Решение владельца 21.09.2026: «Ноябрьск мы же обсудили что закрыт, Тагил тоже
-- пока не работает, Томск на этапе запуска — все не в статусе открыта, для
-- расчёта рейтинга не идёт».
--
-- Почему это правка данных, а не бизнес-решение об открытии. В справочнике
-- 42 филиала из 45 стояли в состоянии PRE_LAUNCH, включая те, что работают,
-- сдают отчёты QLIK и имеют опубликованные показатели за сентябрь. Состояние
-- просто не заполнялось при переносе. Если применить правило владельца к таким
-- данным буквально, рейтинг опустеет целиком: в расчёт не войдёт ни один
-- филиал.
--
-- Список действующих сверен со старой базой портала (branches.status='active'),
-- где их ровно 39, и совпал с нашими PRE_LAUNCH-филиалами полностью, без
-- расхождений. Остаются не действующими: Ноябрьск (CLOSED, миграция 040),
-- Томск и Чайковский (на этапе запуска), Владивосток (в старой базе тоже не
-- действующий). Нижнего Тагила в справочнике нет вовсе — он приходит в отчётах
-- строкой без филиала, и это отдельный открытый вопрос.
--
-- Синтетические филиалы A и B реестра совместимости не затрагиваются.
--
-- Аддитивная по смыслу, повторный прогон безопасен. Неразрушающий откат:
-- UPDATE org_directory_units SET lifecycle_state='PRE_LAUNCH'
--  WHERE id IN (SELECT org_unit_id FROM org_lifecycle_corrections);

-- Что именно и почему было исправлено, остаётся в базе: иначе смена состояния
-- 39 филиалов не отличалась бы от бизнес-активации, оформляемой в портале.
CREATE TABLE IF NOT EXISTS org_lifecycle_corrections (
  org_unit_id   uuid PRIMARY KEY REFERENCES org_directory_units(id),
  state_before  text NOT NULL,
  state_after   text NOT NULL,
  source        text NOT NULL,
  reason        text NOT NULL,
  recorded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TEMP TABLE active_branch_names(display_name text) ON COMMIT DROP;
INSERT INTO active_branch_names(display_name) VALUES
  ('Благовещенск'),
  ('Братск'),
  ('Владимир'),
  ('Дагомыс'),
  ('Димитровград'),
  ('Ижевск'),
  ('Иркутск'),
  ('Казань'),
  ('Калининград'),
  ('Кемерово'),
  ('Кропоткин'),
  ('Курган'),
  ('Мурманск'),
  ('Муром'),
  ('Нижний Новгород'),
  ('Новосибирск'),
  ('Новосибирск Большевистская'),
  ('Омск Волгоградская'),
  ('Омск Кольцевая'),
  ('Орел'),
  ('Оренбург'),
  ('Орехово-Зуево'),
  ('Петрозаводск'),
  ('Ростов'),
  ('Рязань'),
  ('Саратов'),
  ('Севастополь'),
  ('Сочи'),
  ('Сургут Север'),
  ('Сургут Юг'),
  ('Сыктывкар'),
  ('Тамбов'),
  ('Тверь'),
  ('Улан-Удэ'),
  ('Ульяновск'),
  ('Уфа'),
  ('Челябинск'),
  ('Чита'),
  ('Ярославль')
;

-- Справочник защищён триггером org_directory_identity_immutable, который в
-- тексте ошибки требует отдельно рассмотренную миграцию. Это она. Защита
-- снимается на одну операцию и возвращается в этой же транзакции.
ALTER TABLE org_directory_units DISABLE TRIGGER org_directory_identity_immutable;

DO $$
DECLARE matched integer; changed integer;
BEGIN
  CREATE TEMP TABLE targets ON COMMIT DROP AS
  SELECT u.id, u.lifecycle_state
    FROM org_directory_units u
    JOIN org_directory_name_history n ON n.org_unit_id = u.id AND n.effective_to IS NULL
    JOIN active_branch_names a ON a.display_name = n.display_name
   WHERE u.kind = 'ORG_UNIT' AND u.lifecycle_state = 'PRE_LAUNCH'
     AND NOT u.is_demo AND u.pilot_org_unit_id IS NULL;
  SELECT count(*) INTO matched FROM targets;
  -- Ожидается ровно 39. Меньше или больше означает, что справочник изменился
  -- после сверки, и менять состояния наугад нельзя.
  IF matched <> 39 THEN
    RAISE EXCEPTION 'Ожидалось 39 действующих филиалов, сопоставлено %', matched;
  END IF;

  INSERT INTO org_lifecycle_corrections(org_unit_id,state_before,state_after,source,reason)
  SELECT t.id, t.lifecycle_state, 'ACTIVE', 'Старая база портала, branches.status=active',
    'Состояние не заполнялось при переносе: филиал работает и имеет опубликованные показатели за сентябрь 2026'
    FROM targets t
  ON CONFLICT (org_unit_id) DO NOTHING;

  UPDATE org_directory_units SET lifecycle_state = 'ACTIVE'
   WHERE id IN (SELECT id FROM targets);
  GET DIAGNOSTICS changed = ROW_COUNT;
  IF changed <> 39 THEN
    RAISE EXCEPTION 'Ожидалось изменить 39 филиалов, изменено %', changed;
  END IF;
END $$;

ALTER TABLE org_directory_units ENABLE TRIGGER org_directory_identity_immutable;
