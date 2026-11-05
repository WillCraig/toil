import type { FieldOverrides, Iteration, OwiArea, OwiWarning, Person, StatusCategory, Unmapped, WorkItem, WorkItemType } from './types.js';
import { OWI_VERSION } from './types.js';

/**
 * What every source's mapper shares: the document it was handed, the
 * warnings it raises (each said once, however many items hit it), the type
 * table, dates, and reading a value out of whatever shape a field holds. A
 * shared services function, in other words, without the chargeback.
 */

/** One command's output, as the mapper reads it. */
export interface OwiDocument {
  area: OwiArea;
  /** `jira issue search`, `ado work-item get-many`: what the envelope's meta.command says. */
  command: string;
  /** The toil connection, the first part of every id. The area's name when the input says none. */
  connection: string;
  /** Which deployment of the area the connection is (`server`, `cloud`), when the envelope's meta.context says. */
  deployment?: string;
  data: unknown;
  /** The context inputs the call resolved (`owner`, `repo`, `project`), from meta.context. */
  inputs: Record<string, string>;
  /** For a history document, the item it belongs to, when the output doesn't say. */
  key?: string;
  /** Where in the input it was: `document 2`. */
  at: string;
}

export interface MapState {
  fields: FieldOverrides;
  warn: (code: string, message: string) => void;
}

/** Collects warnings, each code and message once. */
export function warnings(): { warn: (code: string, message: string) => void; list: OwiWarning[] } {
  const seen = new Set<string>();
  const list: OwiWarning[] = [];
  return {
    list,
    warn: (code, message) => {
      const key = `${code}\u0000${message}`;
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ code, message });
    },
  };
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
export const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * A field's value as text: a string or number as it is, an option or user
 * object by its value, name, displayName or title, a list by its first such
 * entry. Null when none of those hold.
 */
export function text(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = text(entry);
      if (found !== null) return found;
    }
    return null;
  }
  if (isRecord(value)) return str(value.value) ?? str(value.name) ?? str(value.displayName) ?? str(value.title);
  return null;
}

/**
 * Any date-time a source writes, as UTC with toISOString: ISO 8601 with Z or
 * an offset, and Jira's offset without a colon (`+0000`). Null when absent,
 * undefined when present but unreadable, so the caller can say which.
 */
export function instant(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const iso = value.replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(iso)) return undefined;
  // A date alone, or a time with no zone, is read as UTC, never as this machine's zone.
  const zoned = /T|\s/.test(iso) ? (/(Z|[+-]\d{2}:\d{2})$/.test(iso) ? iso : `${iso}Z`) : `${iso}T00:00:00Z`;
  const ms = Date.parse(zoned.replace(' ', 'T'));
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/** A calendar date (YYYY-MM-DD), from a date or the date part of a date-time. */
export function day(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return undefined;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1]! : undefined;
}

/**
 * The work item types by the name a source gives them, lowercased. A name not
 * here is OTHER, with the source's own word kept in typeName (Feature is
 * OTHER on purpose: it sits between an epic and a story, and is neither).
 */
const TYPES: Record<string, WorkItemType> = {
  epic: 'EPIC',
  story: 'STORY',
  'user story': 'STORY',
  'product backlog item': 'STORY',
  requirement: 'STORY',
  task: 'TASK',
  'sub-task': 'TASK',
  subtask: 'TASK',
  bug: 'BUG',
  defect: 'BUG',
  incident: 'INCIDENT',
};

export function typeOf(name: string | null, extra: Record<string, WorkItemType> = {}): WorkItemType {
  if (name === null) return 'OTHER';
  const key = name.toLowerCase();
  return extra[key] ?? TYPES[key] ?? 'OTHER';
}

/** An item with every field empty, for a mapper to fill. */
export function blank(doc: OwiDocument, key: string, title: string, native: Record<string, unknown>): WorkItem {
  return {
    owi: OWI_VERSION,
    id: idFor(doc.connection, key),
    source: { area: doc.area, connection: doc.connection, key, command: doc.command, ...(doc.deployment === undefined ? {} : { deployment: doc.deployment }) },
    url: null,
    type: 'OTHER',
    typeName: null,
    title,
    body: null,
    status: null,
    statusCategory: 'UNKNOWN',
    resolution: null,
    assignee: null,
    reporter: null,
    priority: null,
    estimate: null,
    labels: [],
    team: null,
    iteration: null,
    parent: null,
    children: [],
    links: [],
    created: null,
    updated: null,
    resolved: null,
    dueDate: null,
    history: null,
    unmapped: [],
    native,
  };
}

export const idFor = (connection: string, key: string) => `${connection}:${key}`;

/** Records a field left empty, and why; one entry per field. */
export function unmapped(item: WorkItem, field: string, reason: string): void {
  if (!item.unmapped.some((u: Unmapped) => u.field === field)) item.unmapped.push({ field, reason });
}

/** Sets a date field, or says why it couldn't be read. */
export function setInstant(item: WorkItem, field: 'created' | 'updated' | 'resolved', value: unknown, from: string): void {
  const at = instant(value);
  if (at === undefined) unmapped(item, field, `${from} holds ${JSON.stringify(value)}, which isn't a date-time`);
  else item[field] = at;
}

/** Sets dueDate, or says why it couldn't be read. */
export function setDay(item: WorkItem, value: unknown, from: string): void {
  const at = day(value);
  if (at === undefined) unmapped(item, 'dueDate', `${from} holds ${JSON.stringify(value)}, which isn't a date`);
  else item.dueDate = at;
}

/** The category of a status the source gave no category for, by an unknown-state warning. */
export function unknownState(item: WorkItem, state: MapState, status: string, why: string): StatusCategory {
  state.warn('OWI_UNKNOWN_STATE', `"${status}" (${item.source.area}) is a status OWI has no category for, so its items are UNKNOWN: ${why}`);
  unmapped(item, 'statusCategory', `"${status}" has no category: ${why}`);
  return 'UNKNOWN';
}

/** An override's unit: the toil-project-style `estimateUnit`, checked by the caller; points when not given. */
export const overrideUnit = (state: MapState) => (state.fields.estimateUnit as 'points' | 'hours' | 'days' | undefined) ?? 'points';

/** A Person from parts, or null without an id. */
export function person(id: unknown, name: unknown, email: unknown): Person | null {
  const key = str(id) ?? (typeof id === 'number' ? String(id) : null);
  if (key === null) return null;
  return { id: key, name: str(name), email: str(email) };
}

/** The iteration that is current: the active one, else the latest future one, else the last. */
export function current(iterations: Iteration[]): Iteration | null {
  return iterations.find((i) => i.state === 'current') ?? [...iterations].reverse().find((i) => i.state === 'future') ?? iterations[iterations.length - 1] ?? null;
}
