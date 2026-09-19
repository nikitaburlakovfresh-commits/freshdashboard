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
  '/organization': 'organization.directory.review',
  '/prepared-reports': 'report.fact_access.manage',
  '/saved-network': 'report.fact_access.manage',
  '/settings/thresholds': 'metric.threshold.manage',
  '/settings/scoring': 'metric.scoring.manage',
  '/settings/focus': 'metric.focus.manage',
  '/settings/notifications': 'notification.policy.manage',
  '/modules': 'portal.setting.manage',
};

/**
 * Навигационные заглушки следующих этапов показываются только администратору
 * портала: исполнителю и региональному менеджеру они не нужны и создают
 * ложное ощущение готового функционала.
 */
export function canSeeNavLink(
  link: { path: string; future?: boolean },
  grants: Grant[],
  permissions = navPermissions(grants),
): boolean {
  if (link.future && link.path !== '/diary') return isSuperAdmin(grants);
  const required = NAV_REQUIRED_PERMISSION[link.path];
  if (!required) return true;
  return isSuperAdmin(grants) || permissions.has(required);
}
