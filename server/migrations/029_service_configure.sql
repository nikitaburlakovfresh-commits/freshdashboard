SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Пользователь явно разрешил сервисную ветвь настройки канона (19.09.2026).
-- Возможность CONFIGURE ограничена порогами светофора, моделью балла и
-- фокусами внимания; управление людьми, ролями и назначениями остаётся за
-- живым администратором. Возможность отзывается вместе с субъектом.
ALTER TABLE service_intake_authorizations DROP CONSTRAINT service_intake_authorizations_capability_check;
ALTER TABLE service_intake_authorizations ADD CONSTRAINT service_intake_authorizations_capability_check
  CHECK (capability IN ('INTAKE','PUBLISH','CONFIGURE'));
