SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Пилотный филиал Саратов: роли и окна для прогона ежедневников.
--
-- Решение владельца (21.09.2026): пилотным берём Саратов, и прежде всего нужны
-- ежедневники каждой роли, чтобы прогнать их своими глазами.
--
-- Что мешало. Первое: окон заполнения в портале не было ни одного, а без окна
-- ежедневник не создаётся ни у кого. Второе: на Саратове был единственный грант
-- — региональный менеджер, то есть роли, у которых есть ежедневник, там просто
-- некому исполнять. Третье: тестовые учётные записи из миграции 038 привязаны к
-- синтетическим филиалам A и B, потому что в тот день все реальные филиалы были
-- PRE_LAUNCH; та миграция прямо предупреждала, что после активации гранты нужно
-- перевыдать, иначе тестовые роли показывают демонстрационную картину.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат описан у каждого
-- блока. Никакие фактические данные не создаются: ни ежедневников, ни значений
-- показателей. Заполняет их человек.

-- 1. Окно заполнения Саратова: сутки целиком.
--
-- Решение владельца: открытие — начало суток, закрытие — конец суток, обязательный
-- срок сдачи — конец текущих суток. Допуски «раньше» и «позже» нулевые: сутки и так
-- целиком внутри окна.
--
-- ОГОВОРКА: время московское. Часовые пояса филиалов не реализованы. Для Саратова
-- (МСК+1) конец суток по Москве наступает в 01:00 местного следующего дня — на час
-- позже местной полуночи. Это временный компромисс, а не выполненное требование.
--
-- Откат: DELETE FROM daily_log_policies WHERE reason LIKE 'Пилот Саратов%';
INSERT INTO daily_log_policies (org_unit_id, role_code, version, effective_from,
    base_open_time, base_close_time, early_open_hours, late_close_hours, reason, created_by)
SELECT b.id, r.role_code,
       coalesce((SELECT max(p.version) FROM daily_log_policies p
                  WHERE p.org_unit_id = b.id AND p.role_code = r.role_code), 0) + 1,
       CURRENT_DATE, '00:00', '23:59', 0, 0,
       'Пилот Саратов: сутки целиком, обязательный срок сдачи — конец текущих суток',
       u.id
FROM (SELECT id FROM org_directory_units WHERE code = 'BR-SARATOV' AND kind = 'ORG_UNIT') b
CROSS JOIN (VALUES ('RF'), ('ROP'), ('ROO')) AS r(role_code)
CROSS JOIN (SELECT id FROM app_users WHERE login = 'n.burlakov') u
WHERE NOT EXISTS (
    SELECT 1 FROM daily_log_policies p
     WHERE p.org_unit_id = b.id AND p.role_code = r.role_code
       AND p.base_open_time = '00:00' AND p.base_close_time = '23:59'
);

-- 2. Тестовые учётные записи линейных должностей.
--
-- Под этими записями невозможно войти: пароль каждой сгенерирован случайно при
-- создании миграции и нигде не сохранён. Они нужны только как цель просмотра
-- глазами роли, который пароль не использует — личность сессии подменяется на
-- стороне сервера. Так не появляется ни одного пароля, который надо кому-то
-- передавать, а потом отзывать.
--
-- Откат: UPDATE app_users SET is_active = false WHERE login IN (...).
INSERT INTO app_users (login, full_name, user_kind, password_hash, password_hash_updated_at, is_active)
VALUES
  ('test.mop',  'Тест · Менеджер отдела продаж',        'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$kxr5IyCkKTyx9AGpbb2eTw$Dc6SywDfj0Zy7IFkOwcGFscnKMNdFySxGqPXiQMsjIw', now(), true),
  ('test.eo',   'Тест · Эксперт отдела оценки',          'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$d0yrIMp8I9m65ITUTxTRzg$3mgdH4lc92guUjI81VYWiRFHZbq8GhE5giTHmfgPCkQ', now(), true),
  ('test.kso',  'Тест · Сотрудник КСО',                  'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$oTJke2BTTT9xnoGXMLv4MA$mH1PirwSjdGIYHQKYHwtFZDzNMCneHPdBT65gHEIxqk', now(), true),
  ('test.smop', 'Тест · Старший менеджер отдела продаж', 'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$Wy65dUH6p1zTbz1CjNnEug$weLvAVbfoXWLI1ml6sxgjAlH/Ujm/rz29rS+M8DWdLc', now(), true),
  ('test.smoo', 'Тест · Старший эксперт отдела оценки',  'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$EI3/ucXWAR5JanJAbr/n1A$HgLeONCTCQ9PK/BW86p2UdB+/kcHHKOQfJdyLRa4DqI', now(), true),
  ('test.rkso', 'Тест · Руководитель КСО филиала',       'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$nwFf3rUYL0aCnWU+UogvGA$JKgmR3H7L1vEUIjBvoEiEoPrF6mpbWwxJbiA8T8GHpU', now(), true)
ON CONFLICT (login) DO NOTHING;

-- 3. Гранты всех ролей филиала на Саратов: и новым тестовым записям, и уже
-- существующим test.rf / test.rop / test.roo, у которых грант висел на
-- синтетическом филиале.
--
-- Синтетические гранты НЕ отзываются: отзыв — изменение прав, а не наша задача
-- здесь, и тестовая запись спокойно держит два филиала. Если понадобится, чтобы
-- тестовая роль видела только Саратов, синтетический грант отзывается вручную в
-- разделе доступов.
--
-- Откат: UPDATE role_grants SET revoked_at = now() WHERE org_unit_id =
--   (SELECT id FROM org_directory_units WHERE code='BR-SARATOV') AND user_id IN
--   (SELECT id FROM app_users WHERE login LIKE 'test.%');
INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
SELECT u.id, m.role_code, 'ORG_UNIT', b.id, now()
FROM (VALUES
    ('test.rf', 'RF'), ('test.rop', 'ROP'), ('test.roo', 'ROO'),
    ('test.mop', 'MOP'), ('test.eo', 'EO'), ('test.kso', 'KSO_STAFF'),
    ('test.smop', 'SMOP'), ('test.smoo', 'SMOO'), ('test.rkso', 'RKSO')
) AS m(login, role_code)
JOIN app_users u ON u.login = m.login AND u.is_active
CROSS JOIN (SELECT id FROM org_directory_units WHERE code = 'BR-SARATOV' AND kind = 'ORG_UNIT') b
WHERE EXISTS (SELECT 1 FROM roles r WHERE r.code = m.role_code AND r.scope_kind = 'ORG_UNIT')
  AND NOT EXISTS (
    SELECT 1 FROM role_grants g
     WHERE g.user_id = u.id AND g.role_code = m.role_code AND g.org_unit_id = b.id
       AND g.revoked_at IS NULL
  );

-- 4. Роли ежедневника владельцу портала на Саратове.
--
-- Просмотр глазами роли работает только на чтение — намеренно, чтобы атрибуция в
-- аудите оставалась честной. Поэтому под тестовой учётной записью нельзя ни
-- создать ежедневник, ни заполнить его. Чтобы владелец мог пройти ежедневник
-- каждой роли по-настоящему, эти роли нужны на его собственной учётной записи.
--
-- Это проверочная настройка прав, а не оргструктура: филиал по-прежнему закреплён
-- за своим региональным менеджером, историческая отчётность не затрагивается.
-- Гранты снимаются обычным отзывом в разделе доступов после пилота.
--
-- Откат: UPDATE role_grants SET revoked_at = now() WHERE user_id =
--   (SELECT id FROM app_users WHERE login='n.burlakov') AND role_code IN ('RF','ROP','ROO');
INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
SELECT u.id, r.role_code, 'ORG_UNIT', b.id, now()
FROM (SELECT id FROM app_users WHERE login = 'n.burlakov' AND is_active) u
CROSS JOIN (VALUES ('RF'), ('ROP'), ('ROO')) AS r(role_code)
CROSS JOIN (SELECT id FROM org_directory_units WHERE code = 'BR-SARATOV' AND kind = 'ORG_UNIT') b
WHERE NOT EXISTS (
    SELECT 1 FROM role_grants g
     WHERE g.user_id = u.id AND g.role_code = r.role_code AND g.org_unit_id = b.id
       AND g.revoked_at IS NULL
);
