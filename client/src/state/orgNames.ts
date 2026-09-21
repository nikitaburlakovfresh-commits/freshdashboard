import { useEffect, useState } from 'react';
import { getOrganizationTree } from '../api/organization';

/**
 * Названия филиалов по их идентификатору.
 *
 * До этого в портале лежала таблица из двух синтетических филиалов пилота, и
 * все реальные филиалы показывались сырым UUID — в списке задач, на дашборде и
 * в окне постановки задачи. Названия есть в справочнике оргструктуры, поэтому
 * берём их оттуда.
 *
 * Справочник читается один раз на загрузку приложения и хранится здесь: он
 * меняется редко, а запрашивать его на каждом экране заново незачем.
 *
 * Если справочник недоступен, возвращается сам идентификатор. Придумывать
 * название нельзя: руководитель примет его за настоящее.
 */
let cache: Map<string, string> | null = null;
let inflight: Promise<Map<string, string>> | null = null;

function load(): Promise<Map<string, string>> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = getOrganizationTree(new Date().toISOString().slice(0, 10))
      .then(tree => {
        cache = new Map(tree.items.map(u => [u.id, u.display_name]));
        return cache;
      })
      .catch(() => new Map<string, string>())
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Сбрасывает кеш: нужен после переименования или создания филиала. */
export function forgetOrgNames() { cache = null; }

export function useOrgNames(): (id: string | null | undefined) => string {
  const [names, setNames] = useState<Map<string, string>>(cache ?? new Map());
  useEffect(() => {
    let live = true;
    load().then(map => { if (live) setNames(map); });
    return () => { live = false; };
  }, []);
  return (id) => (id ? names.get(id) ?? id : 'Филиал не указан');
}
