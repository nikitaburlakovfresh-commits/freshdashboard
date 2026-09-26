import { Grant } from '../api/types';

/**
 * Видимость разделов меню определяется правами, а не ролью в коде.
 * Право может быть выдано на сеть или на конкретный OrgUnit: для навигации
 * достаточно любого действующего гранта, а область данных ограничивает сервер.
 * Пункты без права в карте видны каждому авторизованному пользователю.
 */
export function navPermissions(grants: Grant[]): Set<string> {
  return new Set(grants.flatMap(g => g.permissions));
}
export function isSuperAdmin(grants: Grant[]): boolean {
  return grants.some(g => g.role === 'SUPER_ADMIN' && g.scope_kind === 'NETWORK');
}

/** Право, без которого пункт меню не показывается. */
export const NAV_REQUIRED_PERMISSION: Record<string, string> = {
  '/access': 'access.directory.read',
  // Настройка наборов прав и решения по заявкам на доступ — только владелец
  // платформы. Оба раздела меняют полномочия, поэтому гейт строже обычного
  // права на чтение справочника доступов.
  '/access/roles': 'user.assign_role',
  '/access/registrations': 'user.create',
  '/organization': 'organization.directory.review',
  '/prepared-reports': 'report.fact_access.manage',
  '/saved-network': 'report.fact_access.manage',
  '/settings/thresholds': 'metric.threshold.manage',
  '/settings/source-naming': 'report.source_naming.manage',
  '/settings/scoring': 'metric.scoring.manage',
  '/settings/focus': 'metric.focus.manage',
  '/settings/notifications': 'notification.policy.manage',
  '/modules': 'portal.setting.manage',
  // Сетевые экраны управления задачами — для постановщиков (РМ, дивизион,
  // владелец). РФ видит сеть на стартовом экране только для просмотра.
  '/operational': 'work_item.assign',
  '/division-summary': 'work_item.assign',
};

/**
 * Описание пункта меню. Признак work выделяет разделы ежедневной работы
 * руководителя и ролей филиала; всё остальное по умолчанию считается
 * администрированием портала и живёт в свёрнутом разделе.
 */
export interface NavLinkDef<Icon = string> {
  path: string;
  label: string;
  icon: Icon;
  /** Ежедневный рабочий сценарий. Без признака раздел административный. */
  work?: boolean;
  future?: boolean;
}

/** Раздел ежедневной работы — только по явному признаку, без догадок по пути. */
export function isWorkLink(link: { work?: boolean }): boolean {
  return link.work === true;
}

/**
 * Навигационные заглушки следующих этапов показываются только администратору
 * портала: исполнителю и региональному менеджеру они не нужны и создают
 * ложное ощущение готового функционала.
 */
export function canSeeNavLink(
  link: { path: string; future?: boolean; label?: string; icon?: unknown; work?: boolean },
  grants: Grant[],
  permissions = navPermissions(grants),
): boolean {
  if (link.future && link.path !== '/diary') return isSuperAdmin(grants);
  const required = NAV_REQUIRED_PERMISSION[link.path];
  if (!required) return true;
  return isSuperAdmin(grants) || permissions.has(required);
}
