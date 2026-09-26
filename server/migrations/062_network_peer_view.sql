SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- 062. Просмотр всей сети руководителем филиала (решение владельца 26.09.2026).
--
-- РФ видит на стартовом экране все филиалы сети плитками с баллом, свой филиал —
-- отдельной большой плиткой в шапке, и может открыть карточку любого филиала
-- только для просмотра: без фамилий региональных менеджеров, без задач и без
-- изменений.
--
-- Сделано правом, а не кодом роли: право назначается и снимается галочкой в
-- «Наборах прав», и его можно выдать другой роли без релиза.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- DELETE FROM role_permissions WHERE permission_code='metric.network.peer_view';

INSERT INTO permissions(code,description) VALUES
  ('metric.network.peer_view','Просмотр балла и карточек всех филиалов сети — без задач, фамилий и изменений')
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions(role_code,permission_code) VALUES ('RF','metric.network.peer_view')
ON CONFLICT DO NOTHING;
