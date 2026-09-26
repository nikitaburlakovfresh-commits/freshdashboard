SET LOCAL search_path = pilot_r1, public, pg_catalog;
-- Технический руководитель УК (решение владельца 26.09.2026): должность управляющей
-- компании, доступна при регистрации, ставит и получает задачи внутри УК.
INSERT INTO roles (code, display_name, scope_kind, is_system)
VALUES ('TECHNICAL_HEAD_UC', 'Технический руководитель УК', 'NETWORK', true)
ON CONFLICT (code) DO NOTHING;

INSERT INTO task_assign_rules(setter_role,target,note)
VALUES ('TECHNICAL_HEAD_UC', 'UK_ANY', 'Решение владельца 26.09.2026: задачи внутри УК')
ON CONFLICT DO NOTHING;
