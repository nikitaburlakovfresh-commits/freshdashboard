SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Разумное время заполнения разделов ежедневника.
--
-- Задача: отсечь фиктивное исполнение, когда весь день «выполняется» вечером
-- одним заходом. При этом портал знает только время заполнения поля, а не время
-- события, поэтому два ограничения ведут себя принципиально по-разному.
--
-- not_before — ЖЁСТКИЙ ЗАПРЕТ. «Закрыть день» раньше 16:00 портал запрещает
-- честно: по часам он точно знает, что день ещё не кончился, и никаких
-- допущений о поведении человека не делает.
--
-- not_after — НЕ ЗАПРЕТ, А ОТМЕТКА. Запретить отмечать утреннюю планёрку после
-- 13:00 нельзя: руководитель, который реально провёл её в 9:00, а сел за форму в
-- 14:00, получил бы запрет и не смог отчитаться честно. Хуже того, запрет
-- обходится — планёрка отмечается заранее, в 8:00, до того как прошла, и
-- фиктивность переезжает туда, где её не видно. Поэтому позднее заполнение
-- разрешено, но помечается «заполнено вне разумного окна» и попадает в сводку
-- руководителю и собственнику. Видимость не обходится, в отличие от запрета.
--
-- Отметка НЕ хранится отдельным полем: она выводится из work_item_fields
-- .updated_at, то есть из единственного факта, который у нас есть. Хранить
-- производную от времени значило бы рисковать расхождением с этим фактом.
--
-- Правила версионные и сетевые: раздел ежедневника одинаков по всей сети, а
-- разное время по филиалам — это часовые пояса, отдельная нереализованная задача.
CREATE TABLE IF NOT EXISTS daily_section_time_rules (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    section_num integer NOT NULL CHECK (section_num > 0),
    version integer NOT NULL CHECK (version >= 1),
    effective_from date NOT NULL,
    -- Раньше этого времени раздел заполнять нельзя (жёсткий запрет).
    not_before time,
    -- Позже этого времени заполнение разрешено, но помечается как позднее.
    not_after time,
    reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 5 AND 500),
    created_by uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (section_num, version),
    -- Пустое правило бессмысленно: хотя бы одна граница должна быть задана.
    CHECK (not_before IS NOT NULL OR not_after IS NOT NULL),
    -- Окно внутри одних суток: «не раньше 16:00 и не позже 13:00» нельзя
    -- выполнить никогда, и такое правило заблокировало бы раздел навсегда.
    CHECK (not_before IS NULL OR not_after IS NULL OR not_before < not_after)
);

CREATE INDEX IF NOT EXISTS daily_section_time_rules_lookup
    ON daily_section_time_rules (section_num, effective_from DESC, version DESC);

-- Начальные значения из прямого решения владельца: утренние планёрки после 13:00
-- выглядят фиктивно, закрытие дня раньше 16:00 звучит как бред. Номера разделов
-- взяты из schema ежедневника: 1, 2, 3 — планёрки с РОП/РОО/КСО, с МОП и с
-- экспертами оценки; 28 — сверка факт/план и закрытие дня; 99 — закрытие дня.
--
-- Значения именно начальные: они меняются в настройках портала, без правки кода.
INSERT INTO daily_section_time_rules (section_num, version, effective_from, not_before, not_after, reason, created_by)
SELECT s.section_num, 1, CURRENT_DATE, s.not_before, s.not_after, s.reason, u.id
FROM (VALUES
    (1, NULL::time, '13:00'::time, 'Утренняя планёрка, отмеченная во второй половине дня, выглядит фиктивно'),
    (2, NULL::time, '13:00'::time, 'Утренняя планёрка с МОП, отмеченная во второй половине дня, выглядит фиктивно'),
    (3, NULL::time, '13:00'::time, 'Утренняя планёрка с экспертами оценки во второй половине дня выглядит фиктивно'),
    (28, '16:00'::time, NULL::time, 'Закрывать день и сверять факт с планом раньше 16:00 бессмысленно: день не кончился'),
    (99, '16:00'::time, NULL::time, 'Закрывать день раньше 16:00 бессмысленно: день ещё не кончился')
) AS s(section_num, not_before, not_after, reason)
CROSS JOIN (SELECT id FROM app_users WHERE login = 'n.burlakov' LIMIT 1) u
WHERE NOT EXISTS (
    SELECT 1 FROM daily_section_time_rules r WHERE r.section_num = s.section_num
);
