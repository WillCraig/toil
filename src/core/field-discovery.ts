/**
 * What `jira field discover` concludes from a sample of issues, as pure
 * functions: a short preview of a value, an alias from a field's name, the
 * Open Work Item field a custom field most likely is, and the `toil projects
 * field` commands that name the ones a person confirms. Toil UI imports this
 * file for the same table, so a screen and a terminal never disagree about
 * what a field is. The reading of the sample is the area's; the guessing is
 * here, where it can be tested without a Jira. Guesses are a matter of record
 * in a way that minutes of meetings are not.
 */

export type Confidence = 'high' | 'medium';

/** The OWI field a custom field likely is, said with how sure and why, so a person can overrule it. */
export interface OwiGuess {
  field: 'estimate' | 'iteration' | 'priority' | 'type' | 'team' | 'dueDate';
  confidence: Confidence;
  why: string;
}

export interface FieldSchema {
  type: string;
  custom?: string;
}

/** OWI keys a toil project's `fields` also reads as pointers; a friendly alias must never be one by accident. */
const OWI_KEYS = ['estimate', 'estimateUnit', 'priority', 'type', 'team', 'dueDate', 'iteration', 'estimateLabel', 'iterationDays'];

const PREVIEW_MAX = 80;

const shorten = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat;
};

/** Data Center sends a sprint as `com.atlassian.greenhopper.service.sprint.Sprint@1a2b[id=7,state=ACTIVE,name=Sprint 7,…]`. */
const sprintName = (text: string): string | undefined => (text.startsWith('com.atlassian.greenhopper.') ? /\bname=([^,\]]*)/.exec(text)?.[1] : undefined);

const previewOne = (value: unknown): string | undefined => {
  if (typeof value === 'string') return sprintName(value) ?? shorten(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  // A person is never shown: a display name is somebody's name, and the sample is for the field.
  if ('accountId' in o || 'emailAddress' in o || ('displayName' in o && 'active' in o)) return '(a person)';
  if (o.type === 'doc' && o.version !== undefined) return '(rich text)';
  const named = [o.value, o.name, o.key, o.id].find((v) => typeof v === 'string' || typeof v === 'number');
  if (named === undefined) return '(an object)';
  const state = typeof o.state === 'string' ? ` (${o.state.toLowerCase()})` : '';
  return `${shorten(String(named))}${state}`;
};

/** True when a field holds something on an issue: a `null`, an empty string or an empty list is a field with no value. */
export function holdsValue(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** A value as at most 80 characters of text: strings, ids, names and states, never a person or a body of text. */
export function previewValue(value: unknown): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, 3).map(previewOne).filter((s): s is string => s !== undefined);
    return shorten(`${shown.join(', ')}${value.length > 3 ? ', …' : ''}`) || '(a list)';
  }
  return previewOne(value) ?? '(an object)';
}

/** `Story point estimate` becomes `storyPointEstimate`; a name with nothing usable falls back on the id's number. */
export function aliasFrom(name: string, id: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const camel = words.map((w, i) => (i === 0 ? w.charAt(0).toLowerCase() + w.slice(1) : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  const clean = camel.replace(/^[^a-z]+/, '');
  return clean === '' ? `field${id.replace(/\D/g, '')}` : clean;
}

const numeric = (s?: FieldSchema) => s?.type === 'number';

/** The OWI field a custom field likely is, from its name and the schema Jira reports; undefined when nothing fits. */
export function guessOwi(name: string, schema: FieldSchema | undefined): OwiGuess | undefined {
  const custom = schema?.custom ?? '';
  const n = name.trim().toLowerCase();
  if (custom.endsWith(':gh-sprint')) return { field: 'iteration', confidence: 'high', why: "Jira Software's own Sprint field" };
  if (numeric(schema) && (n === 'story points' || n === 'story point estimate')) return { field: 'estimate', confidence: 'high', why: `a number named "${name}", where Jira keeps story points` };
  if (numeric(schema) && /\b(points?|estimate)\b/.test(n) && !/\b(original|remaining|time|hours?)\b/.test(n)) return { field: 'estimate', confidence: 'medium', why: `a number whose name mentions ${/point/.test(n) ? 'points' : 'an estimate'}` };
  if (/rm-teams-custom-field-team|atlassian-team/.test(custom)) return { field: 'team', confidence: 'high', why: "Jira's own Team field" };
  if (n === 'team') return { field: 'team', confidence: 'medium', why: 'a field named Team' };
  if ((schema?.type === 'date' || schema?.type === 'datetime') && /\b(due date|deadline|target (end|date))\b/.test(n)) return { field: 'dueDate', confidence: 'medium', why: `a date named "${name}"` };
  if (n === 'priority') return { field: 'priority', confidence: 'medium', why: 'a custom field named Priority' };
  if (n === 'type' || n === 'work type' || n === 'issue type') return { field: 'type', confidence: 'medium', why: `a custom field named "${name}"` };
  return undefined;
}

export interface FieldSuggestion {
  alias: string;
  owi: OwiGuess | null;
  /** What Jira's own field is, when toil knows it and OWI has no field for it (an epic link). */
  note?: string;
}

/**
 * An alias and an OWI guess for each field, collision-safe: two fields whose
 * names flatten to one alias get the second's id number added, and an alias that
 * is an OWI key is kept only for the field that is that OWI field.
 */
export function suggest(fields: Array<{ id: string; name: string; schema?: FieldSchema | undefined }>): Map<string, FieldSuggestion> {
  const taken = new Set<string>();
  const out = new Map<string, FieldSuggestion>();
  for (const f of fields) {
    const owi = guessOwi(f.name, f.schema) ?? null;
    let alias = aliasFrom(f.name, f.id);
    if (OWI_KEYS.includes(alias) && alias !== owi?.field) alias = `${alias}Field`;
    if (taken.has(alias)) alias = `${alias}${f.id.replace(/\D/g, '')}`;
    taken.add(alias);
    const epic = f.schema?.custom?.endsWith(':gh-epic-link') === true;
    out.set(f.id, { alias, owi, ...(epic ? { note: "Jira's Epic Link field; OWI has no field to point at it" } : {}) });
  }
  return out;
}

export interface FieldPick {
  /** The Jira field id, e.g. customfield_10016. */
  id: string;
  alias: string;
  /** The OWI field to also point at it, from the guess, when the person ticked the row. */
  owi?: OwiGuess['field'] | undefined;
}

/** One `toil projects field` call: its input, and the line a person can type. */
export interface FieldCommand {
  input: { toilProject: string; area: string; alias: string; id: string; replace?: true };
  line: string;
}

const quote = (v: string) => (/^(<[\w-]+>|[\w.:/@=-]+)$/.test(v) ? v : `"${v.replace(/"/g, '\\"')}"`);

/**
 * The `projects field` calls that name the picked fields: the friendly alias
 * first, then, for a field that is an OWI field, a second alias with the OWI
 * key (`estimate`, `iteration`) that points the mapping at it. The pointer needs
 * `--replace` because the field already has its friendly alias, the same flag
 * Toil UI's "Point an existing alias at this field" box sets. Nothing here runs.
 */
export function fieldCommands(toilProject: string, area: string, picks: FieldPick[]): FieldCommand[] {
  const out: FieldCommand[] = [];
  const make = (alias: string, id: string, replace: boolean): FieldCommand => ({
    input: { toilProject, area, alias, id, ...(replace ? { replace: true as const } : {}) },
    line: `toil projects field ${[toilProject, area, alias, id].map(quote).join(' ')}${replace ? ' --replace' : ''}`,
  });
  for (const p of picks) {
    out.push(make(p.alias, p.id, false));
    if (p.owi !== undefined && p.owi !== p.alias) out.push(make(p.owi, p.id, true));
  }
  return out;
}
