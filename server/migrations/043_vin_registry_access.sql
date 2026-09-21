SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Доступ к реестру автомобилей (VIN).
--
-- Состояние до этой миграции: в `report_detail_access` ноль записей, то есть
-- реестр не мог ни опубликовать, ни прочитать никто, включая администратора
-- сети. Публиковать детальные строки по-прежнему может только администратор
-- сети — это разрешение и выдаётся здесь.
--
-- Отдельно о просмотре. Прежняя схема требовала выдавать право на КАЖДЫЙ
-- филиал отдельной записью: чтобы коммерческий директор увидел реестр по сети,
-- нужно было 39 записей, и при открытии филиала их пришлось бы добавлять
-- вручную. Владелец портала прямо потребовал обратного: роли должны отличаться
-- уровнем видимости, а не набором отдельных защит. Поэтому просмотр реестра
-- переведён на обычную видимость филиалов роли — ту же, по которой работают
-- главная страница и карточка филиала. Это поведение старого портала, где
-- реестр — просто вкладка филиала.
--
-- Персональные данные при этом не раскрываются: разбор отчёта намеренно не
-- переносит в портал столбцы «Эксперт-Оценщик», «Подтвердил Сделку»,
-- «Диагност», «Технический Координатор» и ссылку на ТС.
--
-- Аддитивная, повторный прогон безопасен.
-- Неразрушающий откат указан в конце файла.

DO $$
DECLARE
  admin_grant uuid;
  aud         uuid;
BEGIN
  SELECT g.id INTO admin_grant FROM role_grants g
    JOIN app_users u ON u.id = g.user_id
    WHERE u.login = 'n.burlakov' AND g.role_code = 'SUPER_ADMIN'
      AND g.scope_kind = 'NETWORK' AND g.org_unit_id IS NULL AND g.revoked_at IS NULL
      AND g.valid_from <= now() AND (g.valid_until IS NULL OR g.valid_until > now())
    ORDER BY g.valid_from DESC LIMIT 1;
  IF admin_grant IS NULL THEN
    RAISE NOTICE 'Действующего права администратора сети нет — разрешение не выдаётся';
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM report_detail_access
    WHERE grant_id = admin_grant AND permission_code = 'report_detail.publish' AND revoked_at IS NULL) THEN
    RETURN; -- повторный прогон
  END IF;

  -- Выдача разрешения — это событие, и оно записывается в журнал как событие.
  aud := gen_random_uuid();
  INSERT INTO audit_log(id, actor_user_id, actor_role, action, aggregate_type, aggregate_id,
    aggregate_version, request_id, occurred_at, after_state, reason, resolution, retention_class)
  SELECT aud, g.user_id, 'SUPER_ADMIN', 'REPORT_DETAIL_PERMISSION_PROVISIONED', 'access', admin_grant,
    1, gen_random_uuid(), now(),
    jsonb_build_object('permission_code','report_detail.publish','kinds',ARRAY['vinInventory','managerDiscounts'],'subject','administrator'),
    'Решение владельца портала от 21.09.2026: доступ к реестру VIN', 'APPLIED', 'SECURITY_5Y'
    FROM role_grants g WHERE g.id = admin_grant;

  INSERT INTO report_detail_access(grant_id, permission_code, kinds, valid_from, approval_reference, audit_id)
  VALUES(admin_grant, 'report_detail.publish', ARRAY['vinInventory','managerDiscounts'],
    now(), 'Решение владельца портала от 21.09.2026: загрузка реестра VIN и скидок по менеджерам', aud);
END $$;

-- Сервисный субъект ежедневного приёма QLIK. Реестр склада приходит каждый
-- день, и его приём не должен зависеть от того, зашёл ли человек в портал:
-- цель портала — работать дальше без правки кода и без ручных операций.
-- Возможность PUBLISH у субъекта уже выдана и действует; здесь добавляется
-- только разрешение на детальный контур для того же гранта.
DO $$
DECLARE
  svc_grant uuid;
  aud       uuid;
BEGIN
  -- Окружение без сервисного приёма (более старая схема, репетиционный контур):
  -- разрешение просто не выдаётся, миграция не падает.
  IF to_regclass('pilot_r1.service_intake_actors') IS NULL
    OR to_regclass('pilot_r1.service_intake_authorizations') IS NULL THEN
    RAISE NOTICE 'Сервисного приёма в этой базе нет — разрешение не выдаётся';
    RETURN;
  END IF;
  EXECUTE $q$
    SELECT z.grant_id
      FROM service_intake_actors a
      JOIN service_intake_authorizations z ON z.actor_user_id = a.user_id
      WHERE a.code = 'qlik_daily_v2' AND a.revoked_at IS NULL AND z.capability = 'PUBLISH'
        AND z.revoked_at IS NULL AND z.valid_from <= now()
        AND (z.valid_until IS NULL OR z.valid_until > now())
      LIMIT 1 $q$ INTO svc_grant;
  IF svc_grant IS NULL THEN
    RAISE NOTICE 'Действующего сервисного субъекта приёма нет — разрешение не выдаётся';
    RETURN;
  END IF;
  IF EXISTS(SELECT 1 FROM report_detail_access
    WHERE grant_id = svc_grant AND permission_code = 'report_detail.publish' AND revoked_at IS NULL) THEN
    RETURN; -- повторный прогон
  END IF;
  aud := gen_random_uuid();
  INSERT INTO audit_log(id, actor_user_id, actor_role, action, aggregate_type, aggregate_id,
    aggregate_version, request_id, occurred_at, after_state, reason, resolution, retention_class)
  SELECT aud, g.user_id, 'SUPER_ADMIN', 'REPORT_DETAIL_PERMISSION_PROVISIONED', 'service_intake', svc_grant,
    1, gen_random_uuid(), now(),
    jsonb_build_object('permission_code','report_detail.publish','kinds',ARRAY['vinInventory','managerDiscounts'],'subject','service.qlik_daily_v2'),
    'Решение владельца портала от 21.09.2026: ежедневный приём реестра VIN', 'APPLIED', 'SECURITY_5Y'
    FROM role_grants g WHERE g.id = svc_grant;
  INSERT INTO report_detail_access(grant_id, permission_code, kinds, valid_from, approval_reference, audit_id)
  VALUES(svc_grant, 'report_detail.publish', ARRAY['vinInventory','managerDiscounts'],
    now(), 'Решение владельца портала от 21.09.2026: ежедневный приём реестра VIN сервисным субъектом', aud);
END $$;

-- Неразрушающий откат:
--   UPDATE report_detail_access SET revoked_at = now()
--    WHERE permission_code = 'report_detail.publish'
--      AND approval_reference LIKE 'Решение владельца портала от 21.09.2026%';
