import { Request, Response, NextFunction } from 'express';
import { config } from '../config';
import { ApiError } from '../util/errors';

/** BETA-01. Приём новых отчётов и публикация показателей зависят от
 * антивирусной проверки, поэтому в ограниченном первом выпуске они могут быть
 * отключены на сервере. Отключение не ослабляет проверки: запрос отклоняется до
 * доступа к файлам, хранилищу и публикации. Права, scope и CSRF при этом не
 * подменяются и не расширяются. */
export const REPORT_INTAKE_DISABLED_MESSAGE =
  'Загрузка отчётов и публикация показателей отключены в этом выпуске: контур ' +
  'антивирусной проверки не введён в работу. Ранее опубликованные показатели ' +
  'доступны для чтения.';

export function requireReportIntake(_req: Request, _res: Response, next: NextFunction): void {
  if (config.reportIntakeEnabled) return next();
  next(new ApiError('TEMPORARILY_UNAVAILABLE', REPORT_INTAKE_DISABLED_MESSAGE));
}

/** Явный признак для интерфейса. Клиент обязан отображать состояние, а не
 * угадывать его; при этом скрытие элементов не является механизмом запрета. */
export function featureFlags(): { report_intake: boolean; source_scan_mode: 'clamav' | 'off' } {
  return { report_intake: config.reportIntakeEnabled, source_scan_mode: config.reportScanMode };
}
