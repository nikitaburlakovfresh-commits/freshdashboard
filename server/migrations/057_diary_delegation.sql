SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Поручения из ежедневника и снятие блокера сдачи дня.
--
-- Решения владельца 26.09.2026 по ежедневнику РФ:
--   1. Снять блокер сдачи дня.
--   4. По конкретному автомобилю действие можно поставить в будущее, и в этот
--      день должна возникнуть задача; либо передать её РОП, РОО, стоку или
--      кому-то ещё. Каждую машину можно направить разному человеку или никому.
--   5. По звонку и по анализу трафика руководитель филиала направляет свой вывод
--      вместе с конкретным звонком в задачи РОП, маркетологу и так далее.
--
-- Аддитивная, повторный прогон безопасен.

-- 1. Правило «закрыть день не раньше 16:00» перестаёт быть запретом.
--
-- Разделы 28 и 99 обязательны для сдачи, поэтому запрет их заполнения до 16:00
-- означал, что день нельзя сдать до 16:00 вообще. На пилоте это блокер: владелец
-- проверяет ежедневник утром. Правило остаётся, но в режиме отметки — раннее
-- закрытие дня видно так же, как позднее заполнение планёрки, и не запрещено.
-- Режим хранится в правиле: вернуть запрет можно настройкой, без кода.
ALTER TABLE daily_section_time_rules
    ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'BLOCK';
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'daily_section_time_rules_mode_check') THEN
        ALTER TABLE daily_section_time_rules
            ADD CONSTRAINT daily_section_time_rules_mode_check CHECK (mode IN ('BLOCK', 'MARK'));
    END IF;
END $$;

INSERT INTO daily_section_time_rules (section_num, version, effective_from, not_before, not_after, mode, reason, created_by)
SELECT r.section_num, r.version + 1, CURRENT_DATE, r.not_before, r.not_after, 'MARK',
       'Решение владельца 26.09.2026: раннее закрытие дня отмечается, но не запрещает сдачу',
       r.created_by
FROM (
    SELECT DISTINCT ON (section_num) *
      FROM daily_section_time_rules
     WHERE section_num IN (28, 99)
     ORDER BY section_num, effective_from DESC, version DESC
) r
WHERE r.mode = 'BLOCK';

-- 2. Поручение знает, откуда оно пришло.
--
-- brief — суть поручения словами постановщика: вывод по звонку, решение по
-- машине. Поля результата принадлежат исполнителю, поэтому текст постановщика
-- в них класть нельзя — он хранится у самой задачи.
--
-- source_ref — ссылка на строку ежедневника: какой ежедневник, какой раздел,
-- какая запись списка, какая ссылка на машину или звонок. По ней ежедневник
-- показывает у строки, кому и на когда она поручена.
--
-- Родительская связь parent_work_item_id уже есть с миграции 053.
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS brief text;
ALTER TABLE work_items ADD COLUMN IF NOT EXISTS source_ref jsonb;
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_items_brief_check') THEN
        ALTER TABLE work_items ADD CONSTRAINT work_items_brief_check
            CHECK (brief IS NULL OR char_length(brief) BETWEEN 1 AND 4000);
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_work_items_source_diary
    ON work_items ((source_ref->>'diary_work_item_id')) WHERE source_ref IS NOT NULL;

-- 3. Шаблоны поручений по ролям филиала.
--
-- В портале шаблон задачи определяет ровно одну роль исполнителя: поле
-- результата принадлежит этой роли. Поэтому поручение РОП и поручение
-- маркетологу — разные шаблоны с одним и тем же полем «Результат выполнения».
-- Роль исполнителя берётся из действующего гранта человека на филиале.
INSERT INTO templates (id, code, version, requires_acceptance, field_schema_version, display_name,
    is_system, field_schema, field_ownership_rules, field_visibility_rules)
SELECT gen_random_uuid(), 'delegated_task_' || lower(r.code) || '_v1', 1, true, 1,
       'Поручение · ' || r.display_name, true,
       '[{"type": "text", "label": "Результат выполнения", "required": true, "max_chars": 4000, "min_chars": 1, "field_path": "completion_summary"}]'::jsonb,
       jsonb_build_object('completion_summary', r.code),
       '{}'::jsonb
FROM roles r
WHERE r.scope_kind = 'ORG_UNIT'
  AND r.code IN ('RF', 'ROP', 'ROO', 'RKSO', 'STOCK', 'MARKETING', 'MOP', 'EO', 'SMOP', 'SMOO', 'KSO_STAFF')
  AND NOT EXISTS (SELECT 1 FROM templates t WHERE t.code = 'delegated_task_' || lower(r.code) || '_v1');
