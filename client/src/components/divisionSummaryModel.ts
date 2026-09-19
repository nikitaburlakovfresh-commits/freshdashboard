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

export interface RiskWeights {
  risk_weight_red:number; risk_weight_amber:number; risk_weight_deviation_without_task:number;
  risk_weight_task_overdue:number; risk_weight_branch_without_data:number;
}

/** Человеческие названия весов приоритетности риска для экрана настроек. */
export const RISK_WEIGHT_LABELS:Record<keyof RiskWeights,string>={
  risk_weight_red:'Красный показатель',
  risk_weight_amber:'Жёлтый показатель',
  risk_weight_deviation_without_task:'Отклонение без задачи',
  risk_weight_task_overdue:'Просроченная задача',
  risk_weight_branch_without_data:'Филиал без данных',
};

/**
 * Оценка риска строки по утверждённым весам. Повторяет серверную формулу, чтобы
 * экран мог объяснить порядок, но сам порядок задаёт сервер по настройкам портала.
 */
export function riskScore(w:RiskWeights,x:{red:number;amber:number;
  deviations_without_task:number;tasks_overdue:number;branches_without_data:number}):number {
  return x.red*w.risk_weight_red+x.amber*w.risk_weight_amber
    +x.deviations_without_task*w.risk_weight_deviation_without_task
    +x.tasks_overdue*w.risk_weight_task_overdue
    +x.branches_without_data*w.risk_weight_branch_without_data;
}

/** Подпись действия по отклонению: задача либо уже поставлена, либо ещё нет. */
export function deviationAction(d:{has_task:boolean;task_status:string|null}):
  {label:string;actionable:boolean} {
  return d.has_task
    ?{label:`Задача поставлена${d.task_status?` · ${d.task_status}`:''}`,actionable:false}
    :{label:'Поставить задачу',actionable:true};
}
