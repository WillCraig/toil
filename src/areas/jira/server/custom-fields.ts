import { ToilError } from '../../../core/errors.js';
import type { CustomFieldDefinition, CustomFieldType } from '../area.js';

/**
 * Custom fields by friendly name. Jira knows a field as `customfield_10032`;
 * people know it as "Story Points". A connection's `customFields` maps one to
 * the other, and these helpers apply that map to input, JQL and output. The
 * map is optional: a raw field id always works without registering anything.
 * Nobody should need a data dictionary approved to type the name of a field.
 */

export interface CustomFieldMap {
  byName: Map<string, CustomFieldDefinition>;
  byId: Map<string, CustomFieldDefinition>;
}

export function buildFieldMap(fields: CustomFieldDefinition[]): CustomFieldMap {
  const byName = new Map<string, CustomFieldDefinition>();
  const byId = new Map<string, CustomFieldDefinition>();
  for (const f of fields) {
    byName.set(f.name.toLowerCase(), f);
    byId.set(f.id, f);
  }
  return { byName, byId };
}

/**
 * The map with a toil project's field aliases added (`storyPoints` for
 * `customfield_10002`), so `--field storyPoints=5` works. An alias names the
 * field, with the type the connection gives it when it registers that id; a
 * name the connection already uses keeps the connection's meaning. Aliases
 * are input only: output keeps the connection's names.
 */
export function withAliases(map: CustomFieldMap, aliases: Record<string, string>): CustomFieldMap {
  const byName = new Map(map.byName);
  for (const [alias, id] of Object.entries(aliases)) {
    if (byName.has(alias.toLowerCase())) continue;
    byName.set(alias.toLowerCase(), map.byId.get(id) ?? ({ id, name: alias } as CustomFieldDefinition));
  }
  return { byName, byId: map.byId };
}

/**
 * The field id to send for a key from --field, --fields-file, --input-file or
 * --fields. A registered field resolves by friendly name (any case) or id. An
 * unregistered key with no whitespace is taken as a raw Jira field id or name
 * (`customfield_10032`, `fixVersions`) and passed through. Undefined means an
 * unregistered key with whitespace: almost certainly a mistyped friendly name.
 */
export function resolveFieldKey(rawKey: string, fieldMap: CustomFieldMap): string | undefined {
  const def = fieldMap.byName.get(rawKey.toLowerCase()) ?? fieldMap.byId.get(rawKey);
  if (def) return def.id;
  return /\s/.test(rawKey) ? undefined : rawKey;
}

/**
 * Friendly field names in JQL become their ids. Quoted segments are left
 * alone, and longer names go first so "Story Points" wins over "Story".
 */
export function translateJql(jql: string, fieldMap: CustomFieldMap): string {
  if (fieldMap.byName.size === 0) return jql;
  const names = [...fieldMap.byName.keys()].sort((a, b) => b.length - a.length);
  const parts = jql.split(/(["'][^"']*["'])/);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part;
      let out = part;
      for (const name of names) {
        const def = fieldMap.byName.get(name)!;
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        out = out.replace(new RegExp(`(?<![\\w"'])${escaped}(?![\\w"'])`, 'gi'), def.id);
      }
      return out;
    })
    .join('');
}

/** `customfield_*` keys in an issue's fields become their friendly names. Returns a new object. */
export function translateFieldsInOutput(fields: Record<string, unknown>, fieldMap: CustomFieldMap): Record<string, unknown> {
  if (fieldMap.byId.size === 0) return fields;
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) result[fieldMap.byId.get(key)?.name ?? key] = value;
  return result;
}

/**
 * A --field value shaped the way Jira's API wants it for the field's type.
 * `cascading-select` takes the parent option id, or `parentId:childId`.
 * `user` is a Data Center username, sent as `{ name }`.
 */
export function formatFieldValue(value: string, type: CustomFieldType | undefined): unknown {
  switch (type) {
    case 'number':
      return Number(value);
    case 'select':
      return { value };
    case 'multi-select':
      return value.split(',').map((v) => ({ value: v.trim() }));
    case 'option-id':
      return { id: value };
    case 'cascading-select': {
      const colon = value.indexOf(':');
      if (colon !== -1) return { id: value.slice(0, colon).trim(), child: { id: value.slice(colon + 1).trim() } };
      return { id: value.trim() };
    }
    case 'labels':
      return value.split(',').map((v) => v.trim());
    case 'user':
      return { name: value };
    case 'multi-user':
      throw new ToilError('INVALID_INPUT', 'The custom field type "multi-user" is for Jira Cloud, which names people by accountId; Data Center has no such type.', {
        fix: 'Use type "user" (a username) for a single-user field, or drop the type for a raw value.',
      });
    default:
      return value;
  }
}

/** The CustomFieldType that suits a field, from the schema Jira reports for it. */
export function suggestedType(schema?: { type: string; custom?: string }): CustomFieldType | undefined {
  if (!schema) return undefined;
  const custom = schema.custom ?? '';
  // Jira Software and Advanced Roadmaps fields first: their schema types
  // ('any', 'array') would otherwise fall through to nothing.
  if (custom.endsWith(':gh-epic-link')) return 'string';
  if (custom.endsWith(':gh-sprint')) return 'number';
  if (custom.endsWith(':gh-lexo-rank')) return 'string';
  if (custom.endsWith(':jpo-custom-field-parent')) return 'string';
  if (custom.includes('cascadingselect')) return 'cascading-select';
  if (custom.includes('multicheckboxes') || custom.includes('multiselect')) return 'multi-select';
  if (custom.includes('select') || custom.includes('radiobuttons')) return 'select';
  if (custom.includes('userpicker') || custom.includes('multiuserpicker')) return 'user';
  if (custom.includes('labels')) return 'labels';
  if (custom.includes('url')) return 'url';
  if (custom.includes('textarea') || custom.includes('textfield')) return 'textarea';
  if (schema.type === 'number') return 'number';
  if (schema.type === 'date') return 'date';
  if (schema.type === 'datetime') return 'datetime';
  if (schema.type === 'string') return 'string';
  return undefined;
}
