/**
 * Человеческое название ежедневника (решение владельца 26.09.2026):
 * «AI-Трекер задач · Руководитель филиала» вместо «Ежедневник RF · 2026-09-26».
 * Название в базе не меняется — история и поиск остаются прежними.
 */
export const ROLE_RU: Record<string, string> = {
  RF: 'Руководитель филиала', ACTING_RF: 'Замещающий руководителя филиала', ROP: 'Руководитель отдела продаж',
  ROO: 'Руководитель отдела оценки', SMOP: 'Старший менеджер отдела продаж', SMOO: 'Старший менеджер отдела оценки',
  MOP: 'Менеджер отдела продаж', EO: 'Эксперт отдела оценки', RKSO: 'Руководитель КСО филиала', KSO_STAFF: 'Сотрудник КСО',
  STOCK: 'Сток-менеджер', MARKETING: 'Маркетолог', HR_BRANCH: 'HR филиала', ACCOUNTANT: 'Бухгалтер',
  LEGAL_BRANCH: 'Юрист филиала', BH: 'Собственник', REGIONAL_MANAGER: 'Региональный менеджер',
};
export const TRACKER = 'AI-Трекер задач';
export const ruDate = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** Название для списков и заголовков; прочие задачи — как есть. */
export function displayTitle(title: string, role?: string | null): string {
  let m = /^Ежедневник ([A-Z_]+) · (\d{4}-\d{2}-\d{2})$/.exec(title);
  if (m) return `${TRACKER} · ${ROLE_RU[m[1]] ?? m[1]} · ${ruDate(m[2])}`;
  m = /^Личная запись дня · (\d{4}-\d{2}-\d{2})$/.exec(title);
  if (m) return `${TRACKER}${role && ROLE_RU[role] ? ` · ${ROLE_RU[role]}` : ''} · ${ruDate(m[1])}`;
  return title;
}
/** Ежедневник или личная запись дня — показываются как трекер. */
export const trackerDate = (title: string) =>
  /^(?:Ежедневник [A-Z_]+|Личная запись дня) · (\d{4}-\d{2}-\d{2})$/.exec(title)?.[1] ?? null;
