import { parseWorkbook } from './parseWorkbook';
import { validatePeriod, type ImportPeriod, type ReportBatch } from './reportModel';

self.onmessage = async (event: MessageEvent<{ files: File[]; period: ImportPeriod }>) => {
  try {
    const { files, period } = event.data;
    validatePeriod(period);
    if (!files.length || files.length > 9 || files.reduce((s, f) => s + f.size, 0) > 40 * 1024 * 1024)
      throw new Error('Выберите от 1 до 9 файлов общим размером не более 40 МБ.');
    const batch: ReportBatch = { reports: [], skipped: [], period };
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!/\.xlsx$/i.test(file.name) || file.size > 15 * 1024 * 1024 || !file.size)
        throw new Error(`Файл ${i + 1}: нужен непустой .xlsx не более 15 МБ.`);
      self.postMessage({ type: 'progress', value: `Проверка файла ${i + 1} из ${files.length}…` });
      let report;
      try { report = await parseWorkbook(await file.arrayBuffer(), file.name.slice(0, 200)); }
      catch (error) {
        // Do not forward raw library error text: it can contain private cell data.
        const message = error instanceof Error && /^(Архив|Превышен|Ячейки|Некорректн|Допустимо|Заголовки|Даты|Не найдена|Итоговая|В отчёте|.{1,100}!(?:[A-Z]+\d+):|.{1,100}, строка \d+:)/.test(error.message)
          ? error.message : 'Повреждённый или неподдерживаемый Excel. Проверьте формат и числовые ячейки.';
        throw new Error(`Файл ${i + 1}: ${message}`);
      }
      if (!report) batch.skipped.push({ file: file.name.slice(0, 200), reason: 'Формат не поддерживается. Детальные строки, VIN, сотрудники и CRM-ссылки не импортированы.' });
      else {
        if (batch.reports.some(r => r.kind === report.kind))
          throw new Error('В пакете два отчёта одного типа. Оставьте одну сводку и один отчёт продаж; весь новый пакет отклонён.');
        batch.reports.push(report);
      }
    }
    if (!batch.reports.length) throw new Error('Поддерживаемые отчёты не найдены. Нужна сводка продаж/склада или отчёт продаж с КСО и маржой. Остальные форматы пропущены.');
    self.postMessage({ type: 'complete', batch });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Не удалось прочитать пакет.' });
  }
};
