import { ToilError } from '../../../core/errors.js';
import type { FileAccess } from '../../../core/files.js';

/**
 * Work item fields as a caller names them: `--field name=value`, an
 * `--input-file` describing the item, `@file` references inside it, and the
 * friendly aliases that turn "Acceptance Criteria" into
 * `Microsoft.VSTS.Common.AcceptanceCriteria`. A field is known by three names
 * here, which is two fewer than on the paper form.
 */

export interface JsonPatchOp {
  op: 'add' | 'replace' | 'remove';
  path: string;
  value?: unknown;
}

/** Shape of the JSON accepted by --input-file on work-item create and work-item update. */
export interface WorkItemJsonInput {
  type?: string;
  fields?: Record<string, unknown>;
}

/** Friendly name to reference name for the most common fields, applied under the connection's own `fieldAliases`. */
export const ADO_FIELD_ALIAS_CANDIDATES: Array<[string, string]> = [
  ['title', 'System.Title'],
  ['state', 'System.State'],
  ['assignedto', 'System.AssignedTo'],
  ['assigned-to', 'System.AssignedTo'],
  ['description', 'System.Description'],
  ['areapath', 'System.AreaPath'],
  ['area-path', 'System.AreaPath'],
  ['iterationpath', 'System.IterationPath'],
  ['iteration', 'System.IterationPath'],
  ['tags', 'System.Tags'],
  ['priority', 'Microsoft.VSTS.Common.Priority'],
  ['severity', 'Microsoft.VSTS.Common.Severity'],
  ['effort', 'Microsoft.VSTS.Scheduling.Effort'],
  ['storypoints', 'Microsoft.VSTS.Scheduling.StoryPoints'],
  ['story-points', 'Microsoft.VSTS.Scheduling.StoryPoints'],
  ['remainingwork', 'Microsoft.VSTS.Scheduling.RemainingWork'],
  ['remaining', 'Microsoft.VSTS.Scheduling.RemainingWork'],
  ['acceptancecriteria', 'Microsoft.VSTS.Common.AcceptanceCriteria'],
  ['reprosteps', 'Microsoft.VSTS.TCM.ReproSteps'],
  ['foundinsource', 'Microsoft.VSTS.Build.FoundIn'],
];

const DEFAULT_ALIASES: Record<string, string> = Object.fromEntries(ADO_FIELD_ALIAS_CANDIDATES);

const stripSeparators = (s: string): string => s.toLowerCase().replace(/[\s-]+/g, '');

/**
 * `--field name=value` arguments as a record, split on the first `=`. A
 * missing `=`, or one at the start, is refused. Values stay strings.
 */
export function parseFieldArgs(fields: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const f of fields) {
    const eq = f.indexOf('=');
    if (eq <= 0) throw new ToilError('INVALID_INPUT', `Invalid --field value "${f}". Expected format: name=value`, { fix: 'Pass each field as name=value, e.g. --field "Story Points=5".' });
    result[f.slice(0, eq)] = f.slice(eq + 1);
  }
  return result;
}

/**
 * JSON Patch `add` ops for a field record. A key resolves through the
 * connection's `fieldAliases` over the built-in ones: as typed, lower-cased, then ignoring case,
 * spaces and dashes. A key that matches none is sent as a reference name.
 */
export function buildFieldPatch(fields: Record<string, unknown>, fieldAliases: Record<string, string> = {}): JsonPatchOp[] {
  const aliases = { ...DEFAULT_ALIASES, ...fieldAliases };
  return Object.entries(fields).map(([key, value]) => {
    let refName: string | undefined = aliases[key.toLowerCase()] ?? aliases[key];
    if (!refName) {
      const target = stripSeparators(key);
      refName = Object.entries(aliases).find(([aliasKey]) => stripSeparators(aliasKey) === target)?.[1];
    }
    return { op: 'add' as const, path: `/fields/${refName ?? key}`, value };
  });
}

/** A string value starting with `@` is that file's text; anything else is returned as is. */
export async function resolveAtFileRef(value: unknown, files: FileAccess): Promise<unknown> {
  if (typeof value !== 'string' || !value.startsWith('@')) return value;
  return await files.readText(value.slice(1));
}

/** Reads and parses an --input-file. `-` reads stdin where the front door allows it. */
export async function readJsonInputFile(path: string, files: FileAccess): Promise<WorkItemJsonInput> {
  const raw = await files.readText(path);
  try {
    return JSON.parse(raw) as WorkItemJsonInput;
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `--input-file must contain valid JSON: ${(err as Error).message}`, { fix: 'Run toil ado work-item schema for the expected shape and a runnable example.' });
  }
}

const BUILTIN_WORK_FIELD_KEYS = new Set(['title', 'description', 'assignee', 'assignedto', 'priority']);

/**
 * Splits an --input-file `fields` dictionary into the four fields `work
 * create` has flags for (title, description, assignee, priority; any case,
 * spaces ignored, `AssignedTo` as assignee) and the rest, kept as written.
 * `@file` references are read on every value.
 */
export async function splitWorkFieldsDictionary(fields: Record<string, unknown>, files: FileAccess): Promise<{ builtin: Record<string, unknown>; custom: Record<string, unknown> }> {
  const builtin: Record<string, unknown> = {};
  const custom: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of Object.entries(fields)) {
    const value = await resolveAtFileRef(rawValue, files);
    const key = rawKey.toLowerCase().replace(/\s+/g, '');
    if (BUILTIN_WORK_FIELD_KEYS.has(key)) builtin[key === 'assignedto' ? 'assignee' : key] = value;
    else custom[rawKey] = value;
  }
  return { builtin, custom };
}

/** Flag values over --input-file values; flags win, and the keys they overrode are returned. */
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

/** The JSON Schema `work-item schema` returns for the --input-file of work-item create and update. */
export const ADO_WORK_INPUT_FILE_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'toil Azure DevOps work item input file',
  description:
    'Shape accepted by --input-file on `toil ado work-item create` / `work-item update`. ' +
    'CLI flags (--title, --description, --priority, --field, ...) override matching keys here; ' +
    'overridden keys are reported in meta.warnings.',
  type: 'object',
  properties: {
    type: { type: 'string', description: 'Work item type, e.g. Bug, Task, User Story (create only)' },
    fields: {
      type: 'object',
      description:
        'Field dictionary. Built-in keys (case-insensitive): title, description, assignee, priority. ' +
        'Any other key (e.g. "Acceptance Criteria", or a raw reference name like ' +
        '"Microsoft.VSTS.Common.AcceptanceCriteria" or a custom "MyOrg.SomeField") resolves through ' +
        "the connection's fieldAliases and the built-in aliases, falling back to the key itself — " +
        'custom fields never need to be pre-registered to be usable here. Any string value may be ' +
        '"@path/to/file" to read that field\'s content from a file instead of inlining it (useful for ' +
        'large rich-text fields like Description or Acceptance Criteria).',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
} as const;

export const ADO_WORK_INPUT_FILE_EXAMPLE = {
  type: 'Bug',
  fields: {
    Title: 'Login broken on Safari',
    Description: '@desc.html',
    'Acceptance Criteria': '@ac.md',
    Priority: 2,
    'MyOrg.SomeCustomField': 'x',
  },
};
