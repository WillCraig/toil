import { ToilError } from '../../core/errors.js';
import type { FileAccess } from '../../core/files.js';
import type { Warning } from '../../core/envelope.js';
import { parsePositiveId } from './client.js';

/**
 * Turning flags and an `--input-file` into the document payload Alation's
 * Document Hub API takes: snake_case keys, custom fields as `{ field_id, value }`
 * pairs, and `@path` values read from files through `ctx.files`. Flags win
 * over the file, and the caller hears which ones did, in writing, as is
 * customary when one form overrides another.
 */

export interface CustomField {
  field_id: number;
  field_name?: string;
  value: unknown;
}

export const DOCUMENT_INPUT_FILE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Document title' },
    description: { type: 'string', description: 'Document summary; "@path" reads the value from a file' },
    hub: { type: 'integer', description: 'document_hub_id (required on create)' },
    folder: { type: 'integer', description: 'parent_folder_id (required on create)' },
    template: { type: 'integer', description: 'template_id; required whenever fields are supplied' },
    parentDocument: { type: 'integer', description: 'parent_document_id for a sub-document' },
    navLinkFolders: { type: 'array', items: { type: 'integer' }, description: 'nav_link_folder_ids' },
    fields: {
      type: 'object',
      description: 'Custom field values keyed by numeric Alation field_id; string values starting with "@" are read from that file',
      additionalProperties: true,
    },
  },
};

export const DOCUMENT_INPUT_FILE_EXAMPLE = {
  title: 'Customer table onboarding notes',
  description: '@docs/customer-notes.md',
  hub: 1,
  folder: 42,
  template: 7,
  fields: { '10001': 'Team Data Platform' },
};

/** A string starting with `@` becomes that file's contents; anything else is returned as is. */
export async function resolveAtFileRef(value: unknown, files: FileAccess): Promise<unknown> {
  if (typeof value !== 'string' || !value.startsWith('@')) return value;
  return await files.readText(value.slice(1));
}

/**
 * An `--input-file` `fields` dictionary as Alation's custom_fields array.
 * Keys are numeric field IDs; values pass through as written, `@file` read.
 */
export async function toCustomFields(fields: unknown, files: FileAccess): Promise<CustomField[]> {
  if (fields === undefined) return [];
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) {
    throw new ToilError('INVALID_INPUT', '--input-file "fields" must be an object keyed by Alation custom field ID', { fix: 'Write it as { "10001": "value" }. Run toil alation document schema for an example.' });
  }
  // One key at a time, in the order written, so a bad key stops it before any later file is read.
  const result: CustomField[] = [];
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) {
      throw new ToilError('INVALID_INPUT', `--input-file "fields" key "${key}" is not a numeric Alation field_id`, { fix: 'Key each custom field by its numeric field_id, e.g. "10001".' });
    }
    result.push({ field_id: Number(key), value: await resolveAtFileRef(value, files) });
  }
  return result;
}

async function readJsonInputFile(path: string, files: FileAccess): Promise<unknown> {
  const raw = await files.readText(path);
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `--input-file must contain valid JSON: ${(err as Error).message}`, { fix: 'Run toil alation document schema for the expected shape and a runnable example.' });
  }
}

/** Flag values over --input-file values; the keys a flag overrode are returned. */
function mergeWithOverrides(fromJson: Record<string, unknown>, fromFlags: Record<string, unknown>): { merged: Record<string, unknown>; overrides: string[] } {
  const merged: Record<string, unknown> = { ...fromJson };
  const overrides: string[] = [];
  for (const [key, value] of Object.entries(fromFlags)) {
    if (value === undefined) continue;
    if (Object.prototype.hasOwnProperty.call(fromJson, key)) overrides.push(key);
    merged[key] = value;
  }
  return { merged, overrides };
}

export interface DocumentFlags {
  title?: string | undefined;
  description?: string | undefined;
  hub?: number | string | undefined;
  folder?: number | string | undefined;
  template?: number | string | undefined;
  parentDocument?: number | string | undefined;
  inputFile?: string | undefined;
}

const idFlag = (value: number | string | undefined, flag: string) => (value !== undefined ? parsePositiveId(value, flag) : undefined);

/**
 * The payload create and update share. Suspected bug (#77 item 7): values from
 * the file (`hub`, `folder`, `navLinkFolders`, ...) pass through unchecked.
 */
export async function buildDocumentPayload(flags: DocumentFlags, files: FileAccess, warn: (warning: Warning) => void): Promise<{ payload: Record<string, unknown>; overrides: string[] }> {
  const fromJson: Record<string, unknown> = {};
  if (flags.inputFile) {
    const parsed = await readJsonInputFile(flags.inputFile, files);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new ToilError('INVALID_INPUT', '--input-file must contain a JSON object. Run: toil alation document schema', { fix: 'Run toil alation document schema for the expected shape and a runnable example.' });
    }
    Object.assign(fromJson, parsed);
  }
  const fromFlags: Record<string, unknown> = {
    title: flags.title,
    description: flags.description,
    hub: idFlag(flags.hub, '--hub'),
    folder: idFlag(flags.folder, '--folder'),
    template: idFlag(flags.template, '--template'),
    parentDocument: idFlag(flags.parentDocument, '--parent-document'),
  };
  const { merged, overrides } = mergeWithOverrides(fromJson, fromFlags);
  if (overrides.length) warn({ code: 'ALATION_INPUT_OVERRIDDEN', message: `--input-file values overridden by flags: ${overrides.join(', ')}` });

  const payload: Record<string, unknown> = {};
  if (merged.title !== undefined) payload.title = merged.title;
  if (merged.description !== undefined) payload.description = await resolveAtFileRef(merged.description, files);
  if (merged.hub !== undefined) payload.document_hub_id = merged.hub;
  if (merged.folder !== undefined) payload.parent_folder_id = merged.folder;
  if (merged.template !== undefined) payload.template_id = merged.template;
  if (merged.parentDocument !== undefined) payload.parent_document_id = merged.parentDocument;
  if (merged.navLinkFolders !== undefined) payload.nav_link_folder_ids = merged.navLinkFolders;
  const customFields = await toCustomFields(merged.fields, files);
  if (customFields.length) {
    if (payload.template_id === undefined) {
      throw new ToilError('INVALID_INPUT', 'Alation requires template_id whenever custom fields are set. Pass --template <id> or "template" in --input-file.', {
        fix: 'Add --template <id>, or "template" in --input-file.',
      });
    }
    payload.custom_fields = customFields;
  }
  return { payload, overrides };
}
