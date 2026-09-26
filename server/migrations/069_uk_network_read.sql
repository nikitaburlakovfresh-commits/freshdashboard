SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- 069. Сотрудники УК видят всю сеть на чтение (решение владельца 26.09.2026):
-- обзор сети и карточки всех филиалов без изменений. Выдано правом, а не кодом:
-- для каждой роли его можно снять галочкой в «Наборах прав», уровни доступа
-- по ролям УК будут настроены отдельно.
-- Аддитивная, повторный прогон безопасен. Неразрушающий откат:
-- DELETE FROM role_permissions WHERE permission_code='metric.network.peer_view' AND role_code<>'RF';
INSERT INTO role_permissions(role_code,permission_code)
SELECT r.code,'metric.network.peer_view' FROM roles r
 WHERE r.code IN ('COMMERCIAL_DIRECTOR','FINANCE_HEAD','FRESH_ACADEMY','HR_UC','KSO_HEAD','LEGAL_UC',
   'MARKETING_UC','QUALITY_CONTROL','TECHNICAL_COORDINATOR','TECHNICAL_HEAD_UC')
ON CONFLICT DO NOTHING;
