import { ToilError } from '../../../core/errors.js';
import type { FileAccess } from '../../../core/files.js';
import { formatFieldValue, resolveFieldKey, type CustomFieldMap } from './custom-fields.js';

/**
 * Turning what a caller typed into what Jira Cloud's API takes: `--field Name=value`,
 * a `--fields-file`, an `--input-file` describing the whole issue, `@file`
 * references inside it, and JQL from a flag or a file. Files are read through
 * `ctx.files`, never `node:fs`, so `-` means stdin only where stdin is free.
 * The same rules as `jira`'s, kept separate so a fix to one variant can't
 * quietly change the other. Supporting documents may be attached; they will,
 * unusually, be read.
 */

/** Shape of the JSON accepted by --input-file on issue create and issue update. */
export interface IssueJsonInput {
  project?: string;
  issueType?: string;
  fields?: Record<string, unknown>;
}

export const BUILTIN_ISSUE_FIELDS = new Set(['summary', 'description', 'priority', 'assignee', 'labels', 'parent']);

const FIELD_FIX = "Use the raw field id (e.g. customfield_10032), or register its friendly name in the connection's customFields. Run toil jira issue fields --discover to find ids.";
const unknownField = (name: string) =>
  new ToilError('INVALID_INPUT', `Unknown custom field: "${name}". Fields must be registered in config by friendly name or ID. Run: toil jira issue fields`, { fix: FIELD_FIX });

/** A string value starting with `@` is replaced by that file's contents; anything else is returned as is. */
export async function resolveAtFileRef(value: unknown, files: FileAccess): Promise<unknown> {
  if (typeof value !== 'string' || !value.startsWith('@')) return value;
  return await files.readText(value.slice(1));
}

/** Reads and parses a JSON file argument. `-` reads stdin where available. */
export async function readJsonInputFile(path: string, files: FileAccess, flag = '--input-file'): Promise<unknown> {
  const raw = await files.readText(path);
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `${flag} must contain valid JSON: ${(err as Error).message}`, {
      fix: 'Run toil jira issue schema for the expected shape and a runnable example.',
    });
  }
}

/**
 * Splits an --input-file `fields` dictionary into Jira's built-in fields
 * (summary, description, priority, assignee, labels, parent; any case) and
 * custom fields, resolving `@file` references on every value.
 */
export async function splitFieldsDictionary(
  fields: Record<string, unknown>,
  fieldMap: CustomFieldMap,
  files: FileAccess,
): Promise<{ builtin: Record<string, unknown>; custom: Record<string, unknown> }> {
  const builtin: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const value = await resolveAtFileRef(rawValue, files);
    const key = rawKey.toLowerCase();
    if (BUILTIN_ISSUE_FIELDS.has(key)) {
      builtin[key] = value;
      continue;
    }
    const id = resolveFieldKey(rawKey, fieldMap);
    if (id === undefined) throw unknownField(rawKey);
    custom[id] = value;
  }
  return { builtin, custom };
}

/**
 * `--field Name=value` arguments as field id to value. `Name=@file` reads the
 * value from a file, as JSON when it parses and as text when it doesn't;
 * otherwise a registered field's type shapes the value.
 */
export async function parseFieldArgs(args: string[], fieldMap: CustomFieldMap, files: FileAccess): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const arg of args) {
    const eq = arg.indexOf('=');
    if (eq === -1) {
      throw new ToilError('INVALID_INPUT', `Invalid --field format (expected Name=value): ${arg}`, { fix: 'Pass --field "Story Points=5", or --field "Test Steps=@steps.json".' });
    }
    const name = arg.slice(0, eq).trim();
    const value = arg.slice(eq + 1);
    const id = resolveFieldKey(name, fieldMap);
    if (id === undefined) throw unknownField(name);
    if (value.startsWith('@')) {
      const raw = (await files.readText(value.slice(1))).trim();
      try {
        result[id] = JSON.parse(raw) as unknown;
      } catch {
        result[id] = raw;
      }
    } else {
      const def = fieldMap.byName.get(name.toLowerCase()) ?? fieldMap.byId.get(name);
      result[id] = def ? formatFieldValue(value, def.type) : value;
    }
  }
  return result;
}

/** A --fields-file: a JSON object of field name or id to the value Jira's API takes, unshaped. */
export async function parseFieldsFile(path: string, fieldMap: CustomFieldMap, files: FileAccess): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await files.readText(path);
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `Cannot read fields file "${path}": ${(err as Error).message}`, { fix: 'Check the path. Relative paths resolve against the working directory.' });
  }
  const shape = { fix: 'Write it as { "Story Points": 5, "customfield_10032": "..." }.' };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ToilError('INVALID_INPUT', `Fields file "${path}" must be a valid JSON object`, shape);
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new ToilError('INVALID_INPUT', `Fields file "${path}" must be a JSON object`, shape);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    const id = resolveFieldKey(key, fieldMap);
    if (id === undefined) {
      throw new ToilError('INVALID_INPUT', `Unknown field in "${path}": "${key}". Fields must be registered in config by friendly name or ID. Run: toil jira issue fields`, { fix: FIELD_FIX });
    }
    result[id] = value;
  }
  return result;
}

/**
 * Merges flag values over --input-file values. Flags win; the keys they
 * overrode are returned so the caller hears about it rather than losing the
 * file's value silently.
 */
export function mergeWithOverrides(fromJson: Record<string, unknown>, fromFlags: Record<string, unknown>): { merged: Record<string, unknown>; overrides: string[] } {
  const merged: Record<string, unknown> = { ...fromJson };
  const overrides: string[] = [];
  for (const [key, value] of Object.entries(fromFlags)) {
    if (value === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(fromJson, key)) overrides.push(key);
    merged[key] = value;
  }
  return { merged, overrides };
}

/** Labels from an --input-file array or a comma-separated flag. */
export function normalizeLabels(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => String(v).trim());
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A comma-separated flag as a list, empty entries dropped. */
export const commaList = (value: string): string[] =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * The JQL for `jira issue search`, from --jql or --jql-file, trimmed: a file almost
 * always ends in a newline, and Jira rejects the trailing whitespace.
 */
export async function resolveJql(jql: string | undefined, jqlFile: string | undefined, files: FileAccess): Promise<string> {
  if (jql !== undefined && jqlFile !== undefined) {
    throw new ToilError('INVALID_INPUT', 'Cannot specify both --jql and --jql-file', { fix: 'Pass one of them.' });
  }
  const raw = jqlFile !== undefined ? await files.readText(jqlFile) : jql;
  if (raw === undefined) throw new ToilError('INVALID_INPUT', 'Must specify --jql or --jql-file', { fix: 'Pass --jql "project = ABC", or --jql-file query.jql.' });
  const trimmed = raw.trim();
  // Separate from the missing case: someone who did pass --jql-file shouldn't be told to pass it.
  if (!trimmed) throw new ToilError('INVALID_INPUT', 'JQL query is empty', { fix: 'Put a JQL query in the flag or file.' });
  return trimmed;
}

/** Field ids in Jira's error messages, shown with their friendly names. */
export function translateFieldErrors(err: unknown, fieldMap: CustomFieldMap): unknown {
  if (!(err instanceof ToilError) || fieldMap.byId.size === 0) return err;
  const message = err.message.replace(/\bcustomfield_\d+\b/g, (id) => {
    const def = fieldMap.byId.get(id);
    return def ? `${def.name} (${id})` : id;
  });
  if (message === err.message) return err;
  return new ToilError(err.code, message, { fix: err.fix, details: err.details });
}
