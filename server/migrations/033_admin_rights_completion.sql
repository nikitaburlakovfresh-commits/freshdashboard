SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Завершение привязки прав администратора к роли SUPER_ADMIN.
--
-- Причина: 12 из 38 объявленных прав не были привязаны ни к одной роли, из-за
-- чего соответствующие разделы портала недоступны ни одному пользователю.
-- Миграция 020 объявила право metric.threshold.manage, но, в отличие от
-- миграций 022, 023, 027 и 028, пропустила шаг INSERT INTO role_permissions.
-- Остальные права предполагалось выдавать сервисными скриптами
-- (provisionAccessAdministration, provisionFactAdministrator), однако их
-- предусловие «единственный SUPER_ADMIN» не выполняется: счётчик грантов не
-- исключает отозванные, а сервисные субъекты приёма также держат SUPER_ADMIN.
--
-- Миграция аддитивная: ни одно существующее право не отзывается, ни одна
-- опубликованная величина не изменяется, ON CONFLICT DO NOTHING делает
-- повторный прогон безопасным. Неразрушающий откат — DELETE перечисленных
-- пар из role_permissions.
--
-- Следствие для безопасности, принятое владельцем осознанно: сервисные
-- субъекты приёма держат грант SUPER_ADMIN (serviceActor.ts требует именно
-- эту роль), поэтому расширение роли расширяет и их достижимую область.
-- Разделение сервисной роли вынесено отдельным шагом до переезда на основной
-- сервер, чтобы не менять работающий контур приёма QLIK перед 01.10.2026.

INSERT INTO role_permissions(role_code,permission_code) VALUES
 -- Пороги светофора: восполняет пропуск миграции 020
 ('SUPER_ADMIN','metric.threshold.manage'),
 -- Управление доступами (набор accessPermissions из accessProvisioning.ts)
 ('SUPER_ADMIN','access.directory.read'),
 ('SUPER_ADMIN','access.change.draft'),
 ('SUPER_ADMIN','access.change.preview'),
 ('SUPER_ADMIN','access.change.apply'),
 -- Пользователи, роли и зачисление
 ('SUPER_ADMIN','user.create'),
 ('SUPER_ADMIN','user.assign_role'),
 ('SUPER_ADMIN','user.enrollment.manage'),
 -- Допуска к показателям факта
 ('SUPER_ADMIN','report.fact_access.manage'),
 -- Детализация (отчёт №8, VIN)
 ('SUPER_ADMIN','report_detail.read'),
 ('SUPER_ADMIN','report_detail.publish'),
 -- Проверка источников данных
 ('SUPER_ADMIN','data_source.probe')
ON CONFLICT DO NOTHING;
