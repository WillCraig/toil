import { ToilError } from '../errors.js';
import { adoHistory, adoItem, iterationDates, workItemsOf } from './ado.js';
import { idFor, isRecord, str, unmapped, warnings, type MapState, type OwiDocument } from './common.js';
import { adoChange, adoPrs } from './change-ado.js';
import { bitbucketChange, bitbucketCloudChange, bitbucketPrs } from './change-bitbucket.js';
import { githubChange, githubPrs } from './change-github.js';
import { joinChanges, type ChangeMapState, type ChangeOptions } from './change.js';
import { applyBoard, applyMilestones, boardEntries, boardItem, estimateLabelPattern, githubHistory, githubItem, issuesOf as githubIssuesOf, noBoard, reciprocalLinks, type BoardEntry } from './github.js';
import { issuesOf as jiraIssuesOf, jiraHistory, jiraItem } from './jira.js';
import { OVERRIDABLE, OWI_AREAS, OWI_SOURCES, type Change, type FieldOverrides, type History, type OrphanHistory, type OwiFamily, type OwiWarning, type StatusCategory, type WorkItem } from './types.js';

/**
 * Turns toil command output into OWI items: one or more envelopes (or bare
 * `data` with the command named), each mapped by the area and command its
 * `meta.command` names, then joined. A GitHub issue and its board item
 * become one item; a history attaches to the item it belongs to; a pull
 * request listed and then read with `pr get` becomes one change. This is
 * where the mappers are composed, and the only place; each source's own
 * reading is in its module. Nothing here talks to anything, which in this
 * line of work counts as a feature.
 */

/** The most items one call maps; the rest are left out with a warning, never silently. */
export const MAX_ITEMS = 5000;

/** The commands whose output maps, by area, with the area's name: `jira issue search`, `github pr get`. */
export const OWI_COMMANDS: Record<string, { items: string[]; history: string[]; context: string[]; changes: string[] }> = Object.fromEntries(
  Object.entries(OWI_SOURCES).map(([area, s]) => [area, { items: s.items.map((c) => `${area} ${c}`), history: s.history.map((c) => `${area} ${c}`), context: s.context.map((c) => `${area} ${c}`), changes: s.changes.map((c) => `${area} ${c}`) }]),
);

/** Why a history's status can have no category, by the shape it came in; the area names the command that shows it. */
const UNKNOWN_HISTORY: Record<OwiFamily, (area: string) => string> = {
  jira: () => "Jira's changelog names statuses only, and a status no item in the input is in has no category to learn",
  ado: (area) => `a state in the revisions is a custom one, outside the default states OWI knows; ${area} work-item states shows its category`,
  github: () => 'GitHub issues are only open or closed, so this should not happen; the history is kept as it was read',
  bitbucket: () => 'Bitbucket has no work items, so this should not happen',
  'bitbucket-cloud': () => 'Bitbucket has no work items, so this should not happen',
};

/** Commands that look as if they should map but don't, and what to run instead. */
const INSTEAD: Record<string, string> = Object.fromEntries(
  Object.entries(OWI_SOURCES)
    .filter(([, s]) => s.family === 'ado')
    .map(([area]) => [`${area} work-item search`, `it returns work item ids only: fetch their fields with ${area} work-item get-many and map that`]),
);

export interface OwiSkipped {
  /** Where in the input: `document 2`. */
  at: string;
  command: string | null;
  reason: string;
}

export interface OwiResult {
  items: WorkItem[];
  /** Pull requests, as OWI 0.2 changes. */
  changes: Change[];
  /** Histories for items that weren't in the input, so a caller can attach them to items it already has. */
  histories: OrphanHistory[];
  skipped: OwiSkipped[];
  warnings: OwiWarning[];
}

export interface DocumentOptions {
  /** For bare `data`: the command that returned it (`jira issue search`). */
  command?: string | undefined;
  /** For a history with no key of its own (`jira issue history`, `github issue history`): the item's key. */
  key?: string | undefined;
}

const isEnvelope = (value: unknown): value is { ok: unknown; data?: unknown; error?: unknown; meta: { command: string; context?: unknown } } =>
  isRecord(value) && 'ok' in value && isRecord(value.meta) && typeof value.meta.command === 'string';

/**
 * The input's JSON values: one document, or a JSON array of envelopes (each
 * a document), or JSON Lines (one envelope a line, as `>>` appends them).
 */
export function parseOwiInput(text: string): unknown[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new ToilError('INVALID_INPUT', 'The input is empty.', { fix: 'Pipe a toil command\'s output in (toil jira issue search … | toil util owi map), or pass the file that holds it.' });
  try {
    return inputValues(JSON.parse(trimmed) as unknown);
  } catch {
    // Not one JSON value: JSON Lines, one envelope a line.
  }
  return trimmed.split(/\r?\n/).flatMap((line, i) => {
    if (line.trim() === '') return [];
    try {
      return [JSON.parse(line) as unknown];
    } catch (err) {
      throw new ToilError('INVALID_INPUT', `Line ${i + 1} of the input isn't JSON (${(err as Error).message}), and the input as a whole isn't one JSON value either.`, {
        fix: 'Pass one envelope, a JSON array of envelopes, or one envelope a line.',
      });
    }
  });
}

/**
 * One parsed input as its documents: an array of envelopes (or `{ key, history }`
 * wrappers) is several; anything else, an array of bare data included, is one.
 * The CLI's reader and the API's `mapOwi` both split input here, so they can't drift.
 */
export function inputValues(value: unknown): unknown[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => isEnvelope(v) || isWrapper(v)) ? value : [value];
}

const isWrapper = (value: unknown): value is { key: string; history: unknown } => isRecord(value) && typeof value.key === 'string' && 'history' in value && Object.keys(value).length === 2;

/** The documents in the input's values, with what failed or doesn't map listed in `skipped`. */
export function documentsFrom(values: unknown[], options: DocumentOptions = {}): { documents: OwiDocument[]; skipped: OwiSkipped[] } {
  const documents: OwiDocument[] = [];
  const skipped: OwiSkipped[] = [];
  values.forEach((raw, i) => {
    const at = `document ${i + 1}`;
    const wrapped = isWrapper(raw) ? raw : undefined;
    const value = wrapped ? wrapped.history : raw;
    const key = wrapped?.key ?? options.key;
    let command: string;
    let data: unknown;
    let connection: string | undefined;
    let deployment: string | undefined;
    const inputs: Record<string, string> = {};
    if (isEnvelope(value)) {
      command = value.meta.command;
      if (value.ok !== true) {
        const code = isRecord(value.error) ? str(value.error.code) : null;
        skipped.push({ at, command, reason: `the call failed${code ? ` (${code})` : ''}, so there is nothing to map` });
        return;
      }
      data = value.data;
      const context = isRecord(value.meta.context) ? value.meta.context : {};
      connection = isRecord(context.connection) ? (str(context.connection.value) ?? undefined) : undefined;
      deployment = isRecord(context.connection) ? (str(context.connection.deployment) ?? undefined) : undefined;
      if (isRecord(context.inputs)) for (const [name, input] of Object.entries(context.inputs)) if (isRecord(input) && typeof input.value === 'string') inputs[name] = input.value;
    } else if (options.command !== undefined) {
      command = options.command;
      data = value;
    } else {
      throw new ToilError('INVALID_INPUT', `${at} of the input isn't a toil envelope, so it doesn't say which command it came from.`, {
        fix: 'Pass the whole envelope a command printed, or name the command with --command (for example --command "jira issue search") when passing its data alone.',
      });
    }
    const area = [...OWI_AREAS].sort((a, b) => b.length - a.length).find((a) => command.startsWith(`${a} `));
    const known = area ? OWI_COMMANDS[area] : undefined;
    if (!area || !known || ![...known.items, ...known.history, ...known.context, ...known.changes].includes(command)) {
      if (INSTEAD[command]) {
        skipped.push({ at, command, reason: INSTEAD[command]! });
        return;
      }
      const all = Object.values(OWI_COMMANDS).flatMap((c) => [...c.items, ...c.history, ...c.context, ...c.changes]);
      throw new ToilError('INVALID_INPUT', `${at} is the output of "${command}", which OWI doesn't map.`, { fix: `Map the output of one of: ${all.join(', ')}.` });
    }
    documents.push({ area, command, connection: connection ?? area, ...(deployment === undefined ? {} : { deployment }), data, inputs, at, ...(key === undefined ? {} : { key }) });
  });
  return { documents, skipped };
}

/** `fields` as `name=value` entries (the CLI's repeatable --field) or an object (a toil project section's `fields`), checked. */
export function fieldOverrides(fields: string[] | Record<string, string> | undefined): FieldOverrides {
  const entries = Array.isArray(fields)
    ? fields.map((entry) => {
        const at = entry.indexOf('=');
        if (at <= 0 || at === entry.length - 1) throw new ToilError('INVALID_INPUT', `"${entry}" isn't a field override.`, { fix: 'Write it as name=field, for example estimate=customfield_10234 or estimateUnit=hours.' });
        return [entry.slice(0, at), entry.slice(at + 1)] as const;
      })
    : Object.entries(fields ?? {});
  const out: FieldOverrides = {};
  for (const [name, value] of entries) {
    if (!(OVERRIDABLE as readonly string[]).includes(name)) {
      throw new ToilError('INVALID_INPUT', `"${name}" isn't an OWI field that can be pointed at a field of your own.`, { fix: `Use one of: ${OVERRIDABLE.join(', ')}.` });
    }
    if (name === 'estimateUnit' && !['points', 'hours', 'days'].includes(value)) {
      throw new ToilError('INVALID_INPUT', `estimateUnit must be points, hours or days, not "${value}".`, { fix: 'Pass estimateUnit=points, estimateUnit=hours or estimateUnit=days.' });
    }
    if (name === 'estimateLabel') estimateLabelPattern(value);
    if (name === 'iterationDays' && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 366)) {
      throw new ToilError('INVALID_INPUT', `iterationDays must be a whole number of days from 1 to 366, not "${value}".`, { fix: 'Pass the sprint length in days, for example iterationDays=14.' });
    }
    out[name as keyof FieldOverrides] = value;
  }
  return out;
}

/** What mapOwi takes besides the documents: field overrides, and for changes, key patterns and author kinds. */
export interface MapOptions {
  fields?: FieldOverrides;
  skipped?: OwiSkipped[];
  /** Key patterns (`keyPatterns` in ./change.ts), checked. */
  keys?: ChangeOptions['keys'];
  /** Author kinds by id (`authorKinds` in ./change.ts), checked. */
  authors?: ChangeOptions['authors'];
}

/** Maps the documents to OWI items and changes, joins board items and histories to their items, and reports what it couldn't. */
export function mapOwi(documents: OwiDocument[], options: MapOptions = {}): OwiResult {
  const said = warnings();
  const state: MapState = { fields: options.fields ?? {}, warn: said.warn };
  const skipped = [...(options.skipped ?? [])];
  const items = new Map<string, WorkItem>();
  let duplicates = 0;
  let pulls = 0;
  const add = (item: WorkItem | undefined, doc: OwiDocument) => {
    if (!item) return void skipped.push({ at: doc.at, command: doc.command, reason: 'a record has no key to name the item by' });
    const before = items.get(item.id);
    if (before) {
      duplicates++;
      item.native = { ...before.native, ...item.native };
    }
    items.set(item.id, item);
  };

  const kind = (k: 'items' | 'history' | 'context' | 'changes') => (d: OwiDocument) => OWI_COMMANDS[d.area]?.[k].includes(d.command) === true;
  const itemDocs = documents.filter(kind('items'));
  const historyDocs = documents.filter(kind('history'));
  const contextDocs = documents.filter(kind('context'));

  // Context first: Azure DevOps iteration dates, by connection and path.
  const dates = new Map<string, Map<string, { id: string | null; start: string | null; end: string | null }>>();
  for (const doc of contextDocs) {
    const into = dates.get(doc.connection) ?? new Map();
    dates.set(doc.connection, into);
    if (!iterationDates(doc.data, into)) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold an iteration tree" });
  }

  const categories = new Map<string, Map<string, StatusCategory>>();
  const boards: Array<{ doc: OwiDocument; entries: BoardEntry[] }> = [];
  const githubIssues: Array<{ item: WorkItem; issue: Record<string, unknown> }> = [];
  for (const doc of itemDocs) {
    const family = OWI_SOURCES[doc.area]!.family;
    if (family === 'jira') {
      const issues = jiraIssuesOf(doc.data);
      if (!issues) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold Jira issues" });
      const learned = categories.get(doc.connection) ?? new Map<string, StatusCategory>();
      categories.set(doc.connection, learned);
      for (const issue of issues ?? []) add(jiraItem(doc, issue, state, learned), doc);
    } else if (family === 'ado') {
      const records = workItemsOf(doc.data);
      if (!records) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold work items" });
      for (const record of records ?? []) add(adoItem(doc, record, state, dates.get(doc.connection) ?? new Map()), doc);
    } else if (doc.command === `${doc.area} project items`) {
      const board = boardEntries(doc);
      if (!board) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold project items" });
      else {
        boards.push({ doc, entries: board.entries });
        pulls += board.pulls;
      }
    } else {
      const found = githubIssuesOf(doc.data);
      if (!found) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold GitHub issues" });
      pulls += found?.pulls ?? 0;
      for (const issue of found?.issues ?? []) {
        const item = githubItem(doc, issue, state);
        add(item, doc);
        if (item) githubIssues.push({ item, issue });
      }
    }
  }

  // GitHub: milestones first, then each board item fills in its issue, or stands in for it.
  applyMilestones(githubIssues, state);
  const onBoard = new Set<string>();
  for (const { doc, entries } of boards) {
    for (const entry of entries) {
      const id = idFor(doc.connection, entry.key);
      onBoard.add(id);
      let item = items.get(id);
      if (!item) {
        item = boardItem(doc, entry);
        items.set(id, item);
      }
      applyBoard(item, entry, doc, state);
    }
  }
  for (const item of items.values()) if (OWI_SOURCES[item.source.area]?.family === 'github' && !onBoard.has(item.id)) noBoard(item, state);
  reciprocalLinks(githubIssues.map((p) => p.item).filter((item) => items.get(item.id) === item), items);

  // Histories, attached to their items.
  const orphans: OrphanHistory[] = [];
  const attach = (doc: OwiDocument, key: string, history: History) => {
    const id = idFor(doc.connection, key);
    const item = items.get(id);
    if (!item) return void orphans.push({ id, history });
    item.history = item.history ? { transitions: [...item.history.transitions, ...history.transitions], iterations: [...item.history.iterations, ...history.iterations] } : history;
    item.native[doc.command] = doc.data;
  };
  for (const doc of historyDocs) {
    const family = OWI_SOURCES[doc.area]!.family;
    if (family === 'ado') {
      const byItem = adoHistory(doc, state);
      if (!byItem) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold revisions" });
      for (const [key, history] of byItem ?? []) attach(doc, key, history);
      continue;
    }
    const key = historyKey(doc);
    if (key === undefined) {
      skipped.push({ at: doc.at, command: doc.command, reason: `its output doesn't say which ${family === 'github' ? 'issue' : 'issue key'} it belongs to: wrap it as { "key": "…", "history": <envelope> }, or pass --key` });
      continue;
    }
    const learned = categories.get(doc.connection) ?? new Map();
    const history = family === 'github' ? githubHistory(doc) : jiraHistory(doc, state, (s) => learned.get(s));
    if (!history) skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold a history" });
    else attach(doc, key, history);
  }
  for (const item of items.values()) {
    if (item.history?.transitions.some((t) => t.toCategory === 'UNKNOWN' || t.fromCategory === 'UNKNOWN')) {
      unmapped(item, 'history.transitions', `some statuses in the history have no category: ${UNKNOWN_HISTORY[OWI_SOURCES[item.source.area]?.family ?? 'jira'](item.source.area)}`);
    }
  }

  const changes = mapChanges(documents.filter(kind('changes')), { ...state, changes: { keys: options.keys ?? [], authors: options.authors ?? {} } }, skipped);

  if (duplicates > 0) said.warn('OWI_DUPLICATE_ITEM', `${duplicates} records named an item already in the input; the later record was kept, and native holds both.`);
  if (pulls > 0) said.warn('OWI_PULL_REQUESTS_SKIPPED', `${pulls} pull requests in issue lists or boards were left out: an issue list holds too little of a pull request to map it as a change; map github pr list or github pr get for those.`);
  let list = [...items.values()];
  if (list.length > MAX_ITEMS) {
    said.warn('OWI_ITEMS_CAPPED', `The input holds ${list.length} items; the first ${MAX_ITEMS} were mapped and ${list.length - MAX_ITEMS} left out. Map the rest in another call.`);
    list = list.slice(0, MAX_ITEMS);
  }
  for (const s of skipped) said.warn('OWI_SKIPPED', `${s.at}${s.command ? ` (${s.command})` : ''} wasn't mapped: ${s.reason}.`);
  let changeList = changes;
  if (changeList.length > MAX_ITEMS) {
    said.warn('OWI_ITEMS_CAPPED', `The input holds ${changeList.length} changes; the first ${MAX_ITEMS} were mapped and ${changeList.length - MAX_ITEMS} left out. Map the rest in another call.`);
    changeList = changeList.slice(0, MAX_ITEMS);
  }
  return { items: list, changes: changeList, histories: orphans, skipped, warnings: said.list };
}

/**
 * Every pull request in the change documents, one change each. A pull
 * request listed and also read with `pr get` is one change, with the get's
 * fields. Last, a work item a change names that is itself a change in the
 * input is dropped from its `workItems`: GitHub numbers issues and pull
 * requests together, so `#12` may be either, and the input says which.
 */
function mapChanges(docs: OwiDocument[], state: ChangeMapState, skipped: OwiSkipped[]): Change[] {
  const out = new Map<string, Change>();
  for (const doc of docs) {
    const known = OWI_SOURCES[doc.area]!.family;
    const prs = known === 'github' ? githubPrs(doc.data) : known === 'ado' ? adoPrs(doc.data) : bitbucketPrs(doc.data);
    if (!prs) {
      skipped.push({ at: doc.at, command: doc.command, reason: "it doesn't hold pull requests" });
      continue;
    }
    for (const pr of prs) {
      // Bitbucket's two deployments send different shapes. The connection says which; a bare record shows it (Cloud's has a destination, Data Center's a toRef).
      const family = known === 'bitbucket' && (doc.deployment === 'cloud' || (doc.deployment === undefined && isRecord(pr.destination))) ? 'bitbucket-cloud' : known;
      const change =
        family === 'github' ? githubChange(doc, pr, state)
        : family === 'ado' ? adoChange(doc, pr, state)
        : family === 'bitbucket-cloud' ? bitbucketCloudChange(doc, pr, state)
        : bitbucketChange(doc, pr, state);
      // The shape decided, so say which deployment it was: Toil UI picks its review commands by it.
      if (change && family === 'bitbucket-cloud' && change.source.deployment === undefined) change.source.deployment = 'cloud';
      if (!change) {
        skipped.push({ at: doc.at, command: doc.command, reason: "a pull request has no number or repository to name it by" });
        continue;
      }
      const before = out.get(change.id);
      out.set(change.id, before ? joinChanges(before, change) : change);
    }
  }
  for (const change of out.values()) change.workItems = change.workItems.filter((id) => !out.has(id));
  return [...out.values()];
}

/** The item a keyless history belongs to: Jira's issue key, or GitHub's owner/repo#number (a bare number takes the envelope's owner and repo). */
function historyKey(doc: OwiDocument): string | undefined {
  const key = doc.key?.trim();
  if (!key) return undefined;
  if (OWI_SOURCES[doc.area]?.family !== 'github' || key.includes('/')) return key;
  const number = key.replace(/^#/, '');
  const { owner, repo } = doc.inputs;
  return owner && repo && /^\d+$/.test(number) ? `${owner}/${repo}#${number}` : undefined;
}
