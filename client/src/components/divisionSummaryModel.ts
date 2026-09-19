/** Чистые правила отображения сводки отклонений по дивизиону. */

export interface FocusInput {
  red:number; amber:number; deviations_without_task:number; tasks_overdue:number;
}

/**
 * Порядок фокуса руководителя: сначала красные, затем жёлтые, затем отклонения
 * без поставленной задачи и просроченные задачи. Значения только сортируют
 * перечень и не превращаются в оценку качества работы.
 */
export function focusOrder(a:FocusInput,b:FocusInput):number {
  return b.red-a.red||b.amber-a.amber
    ||b.deviations_without_task-a.deviations_without_task
    ||b.tasks_overdue-a.tasks_overdue;
}

/** Ответственный за территорию: вакансия называется вакансией, а не пустотой. */
export function managerLabel(m:{full_name:string|null;is_vacant:boolean}):string {
  return m.is_vacant||!m.full_name?'Вакансия регионального менеджера':m.full_name;
}

/**
 * Подпись отсутствующих показателей. Отсутствие публикации не равно нулю и не
 * равно выполнению, поэтому формулировка говорит именно об отсутствии данных.
 */
export function missingLabel(metrics:string[],names:Record<string,string>):string {
  if(!metrics.length)return '';
  return `Нет опубликованных данных: ${metrics.map(m=>names[m]??m).join(', ')}`;
}
