SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Права коммерческого директора и собственника франчайзи.
--
-- Решение владельца (21.09.2026): «Ком дир, полный доступ, кроме панели Админ».
--
-- Что считается панелью Админ и потому исключено: управление пользователями,
-- ролями и доступами, оргструктура (создание, переименование, перенос и
-- активация филиалов), настройки портала, управление доступом к показателям
-- и служебный приём данных. Это работа владельца платформы, а не
-- коммерческого руководителя: иначе смена подчинённости или выдача прав
-- пройдёт без единого владельца процесса.
--
-- Что коммерческий директор получает: всю картину сети и все рабочие
-- действия — задачи во всех состояниях, пороги, фокусы, модель балла,
-- детализация отчётов и её публикация, названия филиалов в отчётах,
-- предпросмотр загружаемых данных, политика уведомлений.
--
-- Область видимости задаётся грантом (scope_kind), а не этим набором: набор
-- отвечает на вопрос «что можно делать», грант — «где». Полная сеть у
-- коммерческого директора появится только с сетевым грантом.
--
-- Собственник франчайзи (BH) получает чтение своего филиала и участие в
-- задачах. Он не ставит задачи по сети и не меняет правила расчёта: филиал
-- принадлежит ему, но правила едины для сети.
--
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- DELETE FROM role_permissions WHERE role_code IN ('COMMERCIAL_DIRECTOR','BH');

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'COMMERCIAL_DIRECTOR', p.code
FROM permissions p
WHERE p.code NOT IN (
  -- Пользователи, роли, доступы
  'access.change.apply', 'access.change.draft', 'access.change.preview',
  'access.directory.read', 'user.create', 'user.assign_role',
  'user.enrollment.manage', 'report.fact_access.manage',
  -- Оргструктура
  'org_unit.create', 'org_unit.move', 'org_unit.rename', 'org_unit.activate',
  'organization.change.apply', 'organization.change.draft',
  'organization.change.preview', 'organization.directory.review',
  -- Служебное
  'portal.setting.manage', 'service_intake.execute'
)
ON CONFLICT (role_code, permission_code) DO NOTHING;

INSERT INTO role_permissions (role_code, permission_code)
SELECT 'BH', p.code
FROM permissions p
WHERE p.code IN (
  'notification.read',
  'report_detail.read',
  'work_item.read', 'work_item.history.read',
  'work_item.start', 'work_item.submit', 'work_item.fields.write'
)
ON CONFLICT (role_code, permission_code) DO NOTHING;
