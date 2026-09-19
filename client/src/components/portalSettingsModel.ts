/** Подписи и проверки экрана «Уведомления и сроки». Чистые функции — тестируются отдельно. */
export const POLICY_LABELS:Record<string,string>={
  NONE:'Не рассылать',
  ASSIGNEE:'Ответственному по задаче',
  REVIEWERS:'Проверяющим (региональный менеджер)',
};

/** Человеческие названия событий каталога; неизвестное событие показывается кодом. */
export const EVENT_LABELS:Record<string,string>={
  'work_item.assigned':'Назначена задача (в том числе по отклонению показателя)',
  'work_item.submitted':'Результат сдан на приёмку',
  'work_item.accepted':'Задача принята',
  'work_item.rework_requested':'Задача возвращена на доработку',
  'work_item.cancelled':'Задача отменена',
  'work_item.reopened':'Задача возобновлена',
  'work_item.created':'Задача создана',
  'work_item.started':'Задача взята в работу',
  'work_item.fields_patched':'Изменены поля задачи',
  'metric.deviation.task_created':'Зафиксировано отклонение показателя',
  'metric.threshold.changed':'Изменён порог показателя',
  'notification.policy.changed':'Изменена политика рассылки',
  'portal.setting.changed':'Изменена настройка портала',
};
export const eventLabel=(code:string)=>EVENT_LABELS[code]??code;

export const UNIT_HINTS:Record<string,string>={HOURS:'часов',NUMBER:''};

/** Подсказка допустимого диапазона настройки. */
export function settingHint(s:{min:number|null;max:number|null;integer:boolean;unit:string}):string {
  if(s.min===null||s.max===null)return '';
  const unit=UNIT_HINTS[s.unit]??'';
  return `Допустимо ${s.integer?'целое ':''}значение от ${s.min} до ${s.max}${unit?` ${unit}`:''}.`;
}

/** Значение настройки проверяется до отправки, теми же границами, что и на сервере. */
export function settingValueValid(raw:string,s:{min:number|null;max:number|null;integer:boolean}):boolean {
  if(raw.trim()==='')return false;
  const v=Number(raw);
  if(!Number.isFinite(v))return false;
  if(s.integer&&!Number.isInteger(v))return false;
  if(s.min!==null&&v<s.min)return false;
  if(s.max!==null&&v>s.max)return false;
  return true;
}

/** Основание обязательно: 16–500 символов, как требует сервер. */
export const reasonValid=(raw:string)=>raw.trim().length>=16&&raw.length<=500;
