SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Тестовые учётные записи для просмотра глазами роли.
--
-- Запрос владельца (21.09.2026): нужны тестовые версии руководителя филиала,
-- РОПа, РОО и собственника, чтобы видеть их экраны при разработке.
--
-- Под этими записями невозможно войти: пароль каждой сгенерирован случайно
-- при создании миграции и нигде не сохранён. Они нужны только как цель
-- просмотра глазами роли, который не использует пароль — личность сессии
-- подменяется на стороне сервера. Так не появляется ни одного пароля,
-- который надо кому-то передавать или потом отзывать.
--
-- Гранты привязаны к двум демонстрационным филиалам, потому что все 43
-- реальных филиала на 21.09.2026 находятся в состоянии PRE_LAUNCH. Когда
-- филиалы будут активированы, гранты нужно перевыдать на реальные — иначе
-- тестовые роли будут показывать демонстрационную картину.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- UPDATE app_users SET is_active=false WHERE login LIKE 'test.%';

INSERT INTO app_users (login, full_name, user_kind, password_hash, password_hash_updated_at, is_active)
VALUES ('test.rop', 'Тест · Руководитель отдела продаж', 'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$XES0Q1eyQzAX249hzFjQ1A$4PTOKm+po2sgI1lI7/ezD/ADcLCCxBH7IOq4lOBcmz0', now(), true)
ON CONFLICT (login) DO NOTHING;

INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
SELECT u.id, 'ROP', 'ORG_UNIT', '00000000-0000-4000-8000-00000000000a'::uuid, now()
FROM app_users u WHERE u.login = 'test.rop'
  AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.user_id = u.id
    AND g.role_code = 'ROP' AND g.revoked_at IS NULL);

INSERT INTO app_users (login, full_name, user_kind, password_hash, password_hash_updated_at, is_active)
VALUES ('test.roo', 'Тест · Руководитель отдела оценки', 'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$wiugaYBtoVDtDGhgCEiAgA$W59pthWmijTmiqJHnxJun4cOPaG2QoeohTWZUxyZIU0', now(), true)
ON CONFLICT (login) DO NOTHING;

INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
SELECT u.id, 'ROO', 'ORG_UNIT', '00000000-0000-4000-8000-00000000000a'::uuid, now()
FROM app_users u WHERE u.login = 'test.roo'
  AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.user_id = u.id
    AND g.role_code = 'ROO' AND g.revoked_at IS NULL);

INSERT INTO app_users (login, full_name, user_kind, password_hash, password_hash_updated_at, is_active)
VALUES ('test.bh', 'Тест · Собственник франчайзи', 'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$TCsiUvbfDA5YXwS0gpKMDw$/IC8VjAEdVqGqqA9zaGrnxnUtUgvSIUcYkVlLkktIDU', now(), true)
ON CONFLICT (login) DO NOTHING;

INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
SELECT u.id, 'BH', 'ORG_UNIT', '00000000-0000-4000-8000-00000000000b'::uuid, now()
FROM app_users u WHERE u.login = 'test.bh'
  AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.user_id = u.id
    AND g.role_code = 'BH' AND g.revoked_at IS NULL);

INSERT INTO app_users (login, full_name, user_kind, password_hash, password_hash_updated_at, is_active)
VALUES ('test.rf', 'Тест · Руководитель филиала', 'INDIVIDUAL', '$argon2id$v=19$m=65536,t=3,p=4$25RGK8V7xCphSxljzom/pw$aRsTvaRS7eVq4YVKvYfTimpTg5vGa1LyPZekFBPbk0k', now(), true)
ON CONFLICT (login) DO NOTHING;

INSERT INTO role_grants (user_id, role_code, scope_kind, org_unit_id, valid_from)
SELECT u.id, 'RF', 'ORG_UNIT', '00000000-0000-4000-8000-00000000000a'::uuid, now()
FROM app_users u WHERE u.login = 'test.rf'
  AND NOT EXISTS (SELECT 1 FROM role_grants g WHERE g.user_id = u.id
    AND g.role_code = 'RF' AND g.revoked_at IS NULL);
