import type { DirectoryUnit } from '../api/organization';

/** Display shaping only. Authorization always belongs to the API/adapter. */
export function directoryRows(units: DirectoryUnit[], search: string, collapsed: Set<string>) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const term = search.trim().toLocaleLowerCase('ru');
  const keep = new Set<string>();
  for (const unit of units) {
    if (!term || `${unit.display_name} ${unit.code}`.toLocaleLowerCase('ru').includes(term)) {
      let node: DirectoryUnit | undefined = unit;
      const seen = new Set<string>();
      while (node && !seen.has(node.id)) {
        keep.add(node.id); seen.add(node.id);
        node = node.parent_id ? byId.get(node.parent_id) : undefined;
      }
    }
  }
  const rows: { unit: DirectoryUnit; depth: number; hasChildren: boolean }[] = [];
  const visited = new Set<string>();
  function visit(unit: DirectoryUnit, depth: number) {
    if (visited.has(unit.id) || !keep.has(unit.id)) return;
    visited.add(unit.id);
    const children = units.filter(child => child.parent_id === unit.id && keep.has(child.id));
    rows.push({ unit, depth, hasChildren: children.length > 0 });
    if (term || !collapsed.has(unit.id)) children.forEach(child => visit(child, depth + 1));
  }
  units.filter(unit => !unit.parent_id || !byId.has(unit.parent_id)).forEach(unit => visit(unit, 0));
  return rows;
}
