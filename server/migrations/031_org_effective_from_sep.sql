SET LOCAL search_path = pilot_r1, public, pg_catalog;

-- Отдельно рассмотренная миграция идентичности справочника (её и требует
-- триггер org_directory_identity_immutable).
--
-- Решение регионального директора франчайзинговой сети от 19.09.2026: текущий
-- состав филиалов и текущие закрепления филиал → кластер → дивизион → сеть
-- действуют с 01.09.2026. Справочник был заведён в портале 15 и 19.09.2026
-- позже фактической даты вступления в силу, из-за чего факт за 18.09.2026 не
-- проходил проверку исторического покрытия периода.
--
-- Миграция только сдвигает дату НАЧАЛА действия назад до 01.09.2026 для
-- действующих (не закрытых) записей. Ничего не удаляется, закрытые периоды
-- (effective_to IS NOT NULL) не трогаются, подчинённость и имена не меняются,
-- более ранние даты сохраняются как есть. Периоды до 01.09.2026 остаются
-- непокрытыми — факт за август и ранее по-прежнему не опубликовать без
-- отдельного решения по исторической структуре.

ALTER TABLE org_directory_units DISABLE TRIGGER org_directory_identity_immutable;

UPDATE org_directory_units
   SET effective_from = DATE '2026-09-01'
 WHERE effective_to IS NULL
   AND effective_from > DATE '2026-09-01';

ALTER TABLE org_directory_units ENABLE TRIGGER org_directory_identity_immutable;

ALTER TABLE org_directory_affiliation_history DISABLE TRIGGER org_directory_affiliations_immutable;

-- У филиала может быть несколько интервалов истории. Сдвигается только самый
-- ранний интервал каждого филиала, иначе открытый интервал пересёкся бы с уже
-- закрытым и нарушил ограничение непересечения диапазонов.
UPDATE org_directory_affiliation_history h
   SET effective_from = DATE '2026-09-01'
 WHERE h.effective_from > DATE '2026-09-01'
   AND h.effective_from = (SELECT min(x.effective_from) FROM org_directory_affiliation_history x
                            WHERE x.org_unit_id = h.org_unit_id);

ALTER TABLE org_directory_affiliation_history ENABLE TRIGGER org_directory_affiliations_immutable;

ALTER TABLE org_directory_name_history DISABLE TRIGGER org_directory_names_immutable;

UPDATE org_directory_name_history h
   SET effective_from = DATE '2026-09-01'
 WHERE h.effective_from > DATE '2026-09-01'
   AND h.effective_from = (SELECT min(x.effective_from) FROM org_directory_name_history x
                            WHERE x.org_unit_id = h.org_unit_id);

ALTER TABLE org_directory_name_history ENABLE TRIGGER org_directory_names_immutable;

DO $$
DECLARE late_units integer; late_aff integer;
BEGIN
  SELECT count(*) INTO late_units FROM org_directory_units
    WHERE effective_to IS NULL AND effective_from > DATE '2026-09-01';
  SELECT count(*) INTO late_aff FROM org_directory_affiliation_history h
    WHERE h.effective_from > DATE '2026-09-01'
      AND h.effective_from = (SELECT min(x.effective_from) FROM org_directory_affiliation_history x
                               WHERE x.org_unit_id = h.org_unit_id);
  IF late_units > 0 OR late_aff > 0 THEN
    RAISE EXCEPTION 'Остались действующие записи справочника позже 01.09.2026: units=%, affiliations=%',
      late_units, late_aff;
  END IF;
END $$;
