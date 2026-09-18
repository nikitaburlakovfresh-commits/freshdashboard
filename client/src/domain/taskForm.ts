import type { FieldDef, SavedField } from '../api/types';

export type FieldDraft = { value: string; baseValue: string; version: number };
export type FieldDrafts = Record<string, FieldDraft>;

export function mergeSavedFields(drafts: FieldDrafts, fields: SavedField[], savedPath?: string): FieldDrafts {
  return Object.fromEntries(fields.map(field => {
    const old = drafts[field.field_path];
    const keep = old && old.value !== old.baseValue && field.field_path !== savedPath;
    const value = field.value ?? '';
    return [field.field_path, keep ? old : { value, baseValue: value, version: field.field_version }];
  }));
}

export function hasUnsavedFields(drafts: FieldDrafts): boolean {
  return Object.values(drafts).some(d => d.value !== d.baseValue);
}

export function parseGroup(value: string): Record<string, string>[] | null {
  if (!value) return [];
  try {
    const rows: unknown = JSON.parse(value);
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' || Array.isArray(row) ||
      Object.values(row).some(v => typeof v !== 'string'))) return null;
    return rows;
  } catch { return null; }
}

// Convenience only; the API remains authoritative for full type validation.
export function requiredFieldsPresent(schema: FieldDef[], fields: SavedField[]): boolean {
  return schema.every(def => {
    const value = fields.find(f => f.field_path === def.field_path)?.value ?? '';
    if (!value.trim()) return !def.required;
    if (def.type !== 'repeatable_group') return true;
    const rows = parseGroup(value);
    return rows !== null && rows.length >= (def.min_items ?? 0) &&
      rows.every(row => (def.child_fields ?? []).every(child => !child.required || !!row[child.field_path]?.trim()));
  });
}
