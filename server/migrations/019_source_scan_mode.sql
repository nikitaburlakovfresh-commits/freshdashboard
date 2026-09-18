-- BETA-02. Режим проверки оригиналов отчётов.
-- Аддитивная миграция: расширяет допустимые статусы проверки, чтобы отсутствие
-- антивирусной проверки фиксировалось честно (NOT_SCANNED), а не выдавалось за
-- чистый результат (CLEAN). Антивирусный контур в коде сохранён и включается
-- переменной REPORT_SCAN_MODE=clamav без изменения схемы и данных.
-- Существующие строки не изменяются: прежние значения CLEAN/INFECTED остаются
-- допустимыми, история проверок остаётся неизменяемой (триггер immutable).
SET search_path = pilot_r1, pg_catalog;

ALTER TABLE report_source_scans DROP CONSTRAINT report_source_scans_result_check;
ALTER TABLE report_source_scans ADD CONSTRAINT report_source_scans_result_check
  CHECK (result IN ('CLEAN', 'INFECTED', 'NOT_SCANNED'));

COMMENT ON COLUMN report_source_scans.result IS
  'CLEAN/INFECTED — результат антивирусной проверки; NOT_SCANNED — проверка не выполнялась (REPORT_SCAN_MODE=off), публикация помечается соответствующим статусом в provenance.';
