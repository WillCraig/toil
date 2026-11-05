import { ToilError } from '../errors.js';
import { isRecord } from '../owi/common.js';
import type { Change, ChangeState, StatusCategory, WorkItem } from '../owi/types.js';

/**
 * Reads the briefing's input back in: what `util owi map` printed (each
 * envelope, or its data), JSON arrays of OWI records, or one record a line,
 * in any mix, so the items and the pull requests can come from separate
 * calls (`jira issue search … | util owi map` and `bitbucket pr list … |
 * util owi map`). A record is a work item when it has a statusCategory and a
 * change when it has a repo and a state. Anything else is skipped and listed
 * with why, never guessed at. A missing list is read as empty, a link that
 * isn't one is dropped, and an estimate whose value isn't a number is read as
 * none, so a malformed field can't crash the rules or skew a total. Forms
 * received in triplicate, filed once.
 */

export interface BriefRecords {
  items: WorkItem[];
  changes: Change[];
  skipped: Array<{ at: string; reason: string }>;
  /** Ids given more than once; the first was kept. */
  duplicates: string[];
}

const CATEGORIES = new Set<StatusCategory>(['TODO', 'IN_PROGRESS', 'DONE', 'UNKNOWN']);
const STATES = new Set<ChangeState>(['OPEN', 'MERGED', 'DECLINED', 'DRAFT']);
const isEnvelope = (v: unknown): v is { ok: unknown; data?: unknown; meta: { command: string } } => isRecord(v) && 'ok' in v && isRecord(v.meta) && typeof v.meta.command === 'string';
const list = (v: unknown) => (Array.isArray(v) ? v : []);

/**
 * The JSON values in some text, however they're laid out: one value, one a
 * line, or several pretty-printed documents run together (`cat a.json b.json`).
 * A scanner finds where each top-level value ends, outside strings.
 */
function values(text: string): unknown[] {
  if (text.trim() === '') throw new ToilError('INVALID_INPUT', 'The input is empty.', { fix: 'Pipe OWI records in (toil jira issue search … | toil util owi map | toil projects brief), or pass the file that holds them.' });
  const out: unknown[] = [];
  let depth = 0;
  let inString = false;
  let from = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    if (from < 0 && !/\s/.test(ch)) from = i;
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    if (from >= 0 && depth === 0 && (ch === '}' || ch === ']')) {
      out.push(parse(text.slice(from, i + 1), out.length + 1));
      from = -1;
    }
  }
  if (from >= 0) out.push(parse(text.slice(from), out.length + 1));
  return out;
}

function parse(chunk: string, n: number): unknown {
  try {
    return JSON.parse(chunk) as unknown;
  } catch (err) {
    throw new ToilError('INVALID_INPUT', `Document ${n} of the input isn't JSON (${(err as Error).message}).`, {
      fix: 'Pass what toil util owi map printed, JSON arrays of OWI records, or one record a line.',
    });
  }
}

/** The work items and changes in some text. */
export function readBriefRecords(text: string): BriefRecords {
  const out: BriefRecords = { items: [], changes: [], skipped: [], duplicates: [] };
  const seen = new Set<string>();
  const add = (at: string, value: unknown) => {
    const r = record(value);
    if (typeof r === 'string') return void out.skipped.push({ at, reason: r });
    if (seen.has(r.record.id)) return void out.duplicates.push(r.record.id);
    seen.add(r.record.id);
    if (r.kind === 'item') out.items.push(r.record);
    else out.changes.push(r.record);
  };
  const walk = (value: unknown, at: string, depth: number): void => {
    if (isEnvelope(value)) {
      if (value.meta.command !== 'util owi map') {
        throw new ToilError('INVALID_INPUT', `${at === 'the input' ? 'The input' : at} is the output of "${value.meta.command}", not OWI records.`, { fix: `Map it first: pipe it through toil util owi map, then into toil projects brief.` });
      }
      if (value.ok !== true) return void out.skipped.push({ at, reason: 'the util owi map call failed, so it holds no records' });
      return walk(value.data, at, depth);
    }
    if (Array.isArray(value) && depth < 2) return value.forEach((v, i) => walk(v, `${at}, [${i}]`, depth + 1));
    if (isRecord(value) && !('title' in value) && (Array.isArray(value.items) || Array.isArray(value.changes))) {
      list(value.items).forEach((v, i) => add(`${at}, items[${i}]`, v));
      list(value.changes).forEach((v, i) => add(`${at}, changes[${i}]`, v));
      return;
    }
    add(at, value);
  };
  const all = values(text);
  all.forEach((v, i) => walk(v, all.length === 1 ? 'the input' : `document ${i + 1}`, 0));
  return out;
}

type Read = { kind: 'item'; record: WorkItem } | { kind: 'change'; record: Change };

function record(v: unknown): Read | string {
  if (!isRecord(v)) return 'it is not an OWI record';
  if (typeof v.id !== 'string' || v.id === '') return 'it has no id';
  if (typeof v.title !== 'string') return `${v.id} has no title`;
  if (typeof v.repo === 'string' && STATES.has(v.state as ChangeState)) {
    return { kind: 'change', record: { ...(v as unknown as Change), workItems: list(v.workItems).filter((w): w is string => typeof w === 'string'), reviewers: list(v.reviewers) as Change['reviewers'] } };
  }
  if (CATEGORIES.has(v.statusCategory as StatusCategory)) {
    const source = isRecord(v.source) && typeof v.source.key === 'string' ? (v.source as WorkItem['source']) : { area: '', connection: v.id.split(':')[0] ?? '', key: v.id.slice(v.id.indexOf(':') + 1), command: '' };
    const links = list(v.links).filter((l): l is WorkItem['links'][number] => isRecord(l) && typeof l.type === 'string' && typeof l.target === 'string' && (l.direction === 'inward' || l.direction === 'outward'));
    const estimate = isRecord(v.estimate) && typeof v.estimate.value === 'number' && Number.isFinite(v.estimate.value) ? (v.estimate as unknown as WorkItem['estimate']) : null;
    return { kind: 'item', record: { ...(v as unknown as WorkItem), source, links, estimate, url: typeof v.url === 'string' ? v.url : null } };
  }
  return `${v.id} is neither a work item (no statusCategory) nor a change (no repo and state)`;
}
