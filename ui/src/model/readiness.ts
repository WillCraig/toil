/**
 * The readiness gate (#307): whether a work item is ready to hand to an
 * agent, worked out before any model is asked. Pure functions of the item's
 * cached OWI record, the toil project it came from, the toil project's other items and,
 * at most, one live read of the item's workflow, which the caller makes and
 * passes in (`liveWorkflow`). No model, no premium request, no network of its
 * own, so the item page, the Command Center and the agent's readiness tools
 * all give the same verdict for the same data.
 *
 * Five checks, one row each, as the issue's table has them:
 *
 * - **Acceptance criteria**: in the field the toil project names
 *   (`<area>.fields.acceptanceCriteria`; Azure DevOps' own
 *   `Microsoft.VSTS.Common.AcceptanceCriteria` when it names none), or as a
 *   heading or a checklist in the body.
 * - **Description**: at least `minWords` words (25 by default, the section's
 *   `readiness.minWords`) of real text, once lines from the toil project's
 *   templates (`readiness.templates`) and placeholder lines are taken out.
 * - **Done state**: not already done, and a way to Done is known: GitHub
 *   issues close from any state; otherwise an item of the same type in the
 *   toil project has reached Done, or the live read says the workflow has a Done
 *   state (Azure DevOps) or offers a move into Done now (Jira).
 * - **Blockers**: no open item `blocks` it.
 * - **Scope**: it comes from one of the toil project's sources, and the toil project
 *   names a repository to work in.
 *
 * A row is `pass`, `thin` (missing something a person can decide to live
 * with) or `fail` (it can't be worked on as it is). The verdict is `blocked`
 * when any row fails, `thin` when any is thin, and `ready` only when all pass.
 * Five boxes, ticked by a function, which is the only kind of committee that
 * has ever finished on time.
 */

import type { StatusCategory, WorkItem } from '../toil.ts';

export type Verdict = 'ready' | 'thin' | 'blocked';
export type RowState = 'pass' | 'thin' | 'fail';
export type CheckId = 'acceptance' | 'description' | 'done' | 'blockers' | 'scope';

export const CHECKS: readonly CheckId[] = ['acceptance', 'description', 'done', 'blockers', 'scope'];
export const CHECK_LABEL: Record<CheckId, string> = {
  acceptance: 'Acceptance criteria',
  description: 'Description',
  done: 'Done state',
  blockers: 'Blockers',
  scope: 'Scope',
};
export const VERDICT_LABEL: Record<Verdict, string> = { ready: 'Ready', thin: 'Thin', blocked: 'Blocked' };
/** The same three, in plain words (src/plain-words.ts). */
export const VERDICT_PLAIN: Record<Verdict, string> = { ready: 'Ready', thin: 'Needs more detail', blocked: 'Blocked' };
export const VERDICTS: readonly Verdict[] = ['ready', 'thin', 'blocked'];

/** One check's row: its state, and why, with any item it names written as `[[id]]`. */
export interface Row {
  check: CheckId;
  label: string;
  state: RowState;
  reason: string;
  /** Where the row's answer came from: a field, the body, the cache, or the live command. */
  source: string;
}

export interface Readiness {
  id: string;
  verdict: Verdict;
  rows: Row[];
  /** The rows that aren't `pass`, worst first: why it isn't ready, in one place. */
  why: Row[];
}

/** Description words a ready item needs when the toil project sets no number. */
export const DEFAULT_MIN_WORDS = 25;
/** Azure DevOps' own acceptance criteria field, on every process that has one. */
export const ADO_ACCEPTANCE_FIELD = 'Microsoft.VSTS.Common.AcceptanceCriteria';

/** What one area's section says about readiness. */
export interface AreaReadiness {
  /** The field holding acceptance criteria, or null when there is none to look in. */
  acceptanceField: string | null;
  /** Where that field came from: the toil project, or the area's own default. */
  acceptanceFrom: 'toilProject' | 'default' | null;
  minWords: number;
  /** Template text, line by line, normalised: lines a description doesn't get credit for. */
  templateLines: string[];
}

/** What the gate reads from a toil project: its sources, its repositories, and each area's settings. */
export interface ReadinessSettings {
  /** The areas the toil project has a section for. */
  sources: string[];
  /** The toil project's repositories, by name. */
  repos: string[];
  areas: Record<string, AreaReadiness>;
  /** What couldn't be used, in words the views show. */
  notes: string[];
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys at the top of a toil project that aren't area sections (src/core/toil-project.ts, TOP_LEVEL). */
const NOT_SECTIONS = new Set(['$schema', 'name', 'description', 'env', 'repos', 'environments', 'people', 'wipLimit']);

/**
 * The gate's settings, from the toil project as `projects show` prints it. Each
 * area section may hold `fields.acceptanceCriteria` (a field id, also the
 * area's `--field` alias) and `readiness: { minWords, templates }`, reference
 * data toil keeps as written.
 */
export function readReadiness(toilProject: unknown): ReadinessSettings {
  const d = isRec(toilProject) ? toilProject : {};
  const notes: string[] = [];
  const repos = (Array.isArray(d.repos) ? d.repos : []).flatMap((r) => (isRec(r) && typeof r.name === 'string' && r.name ? [r.name] : []));
  const sources: string[] = [];
  const areas: Record<string, AreaReadiness> = {};
  for (const [area, section] of Object.entries(d)) {
    if (NOT_SECTIONS.has(area) || !isRec(section)) continue;
    sources.push(area);
    const fields = isRec(section.fields) ? section.fields : {};
    const named = typeof fields.acceptanceCriteria === 'string' && fields.acceptanceCriteria.trim() ? fields.acceptanceCriteria.trim() : null;
    const fallback = area.startsWith('ado') ? ADO_ACCEPTANCE_FIELD : null;
    const r = section.readiness;
    let minWords = DEFAULT_MIN_WORDS;
    let templateLines: string[] = [];
    if (r !== undefined && !isRec(r)) notes.push(`The ${area} section's "readiness" isn't an object of minWords and templates, so the defaults apply.`);
    if (isRec(r)) {
      if (r.minWords !== undefined) {
        if (typeof r.minWords === 'number' && Number.isInteger(r.minWords) && r.minWords >= 0) minWords = r.minWords;
        else notes.push(`The ${area} section's readiness.minWords isn't a whole number of 0 or more, so ${DEFAULT_MIN_WORDS} applies.`);
      }
      if (r.templates !== undefined) {
        if (Array.isArray(r.templates) && r.templates.every((t) => typeof t === 'string')) templateLines = [...new Set((r.templates as string[]).flatMap((t) => lines(t).map(normalise).filter(Boolean)))];
        else notes.push(`The ${area} section's readiness.templates isn't a list of template texts, so no template is taken out of descriptions.`);
      }
    }
    areas[area] = { acceptanceField: named ?? fallback, acceptanceFrom: named ? 'toilProject' : fallback ? 'default' : null, minWords, templateLines };
  }
  return { sources, repos, areas, notes };
}

// Text out of a body ---------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** A numeric entity's character; one outside Unicode reads as U+FFFD, as a browser shows it, rather than throwing on text a tracker sent. */
const codePoint = (n: number) => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '\ufffd');
const decode = (s: string) => s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => (e[0] === '#' ? codePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)));

/** HTML as lines of text: block ends become line breaks, a checkbox becomes `[ ]`, every other tag goes. */
function htmlText(html: string): string {
  return decode(
    html
      .replace(/<input\b[^>]*type=["']?checkbox[^>]*>/gi, '[ ] ')
      .replace(/<h([1-6])\b[^>]*>/gi, (_, n: string) => `\n${'#'.repeat(Number(n))} `)
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/ul|\/ol)\b[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

/** Atlassian Document Format as lines: a heading as `#`, a task as `[ ]`, each block on its own line. */
function adfText(node: unknown): string {
  if (!isRec(node)) return '';
  if (node.type === 'text' && typeof node.text === 'string') return node.text;
  const inner = (Array.isArray(node.content) ? node.content : []).map(adfText).join('');
  switch (node.type) {
    case 'heading':
      return `\n${'#'.repeat(isRec(node.attrs) && typeof node.attrs.level === 'number' ? node.attrs.level : 1)} ${inner}\n`;
    case 'taskItem':
      return `\n[ ] ${inner}\n`;
    case 'listItem':
      return `\n- ${inner}\n`;
    case 'paragraph':
    case 'blockquote':
    case 'codeBlock':
      return `\n${inner}\n`;
    case 'hardBreak':
      return '\n';
    default:
      return inner;
  }
}

/** Jira wiki markup's headings (`h2. Goal`) as Markdown's, so one reading covers both. */
const wikiText = (s: string) => s.replace(/^\s*h([1-6])\.\s+/gim, (_, n: string) => `${'#'.repeat(Number(n))} `);

/** A body, or a field's value, as plain lines of text. */
export function textOf(value: unknown, format?: string): string {
  if (value === null || value === undefined) return '';
  if (isRec(value)) return adfText(value);
  if (typeof value !== 'string') return '';
  if (format === 'html' || (format === undefined && /<\/?[a-z][\s\S]*?>/i.test(value))) return htmlText(value);
  if (format === 'wiki') return wikiText(value);
  return value;
}

const lines = (text: string) => text.split(/\r?\n/);
/** A line as a template compares it: no heading or list marks, no case, single spaces, no trailing colon. */
const normalise = (line: string) =>
  line
    .replace(/^\s*(?:(?:#{1,6}|[-*+]|\d+[.)]|\[[ xX]?\])\s*)+/, '')
    .replace(/[:.]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

const WORD = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
export const wordCount = (text: string) => text.match(WORD)?.length ?? 0;

/** A line that is only a placeholder: TBD, TODO, N/A, lorem ipsum, a `<fill this in>` or a run of punctuation. */
const PLACEHOLDER_LINE = /^(tbd|tba|todo|to do|n\/?a|none|nothing|wip|placeholder|description|details|lorem ipsum.*|[-_.=*#~]+)$/i;
/** A `<what goes here>` or `{what goes here}` inside a line: template slots nobody filled. */
const SLOT = /<[^<>\n]{1,60}>|\{[^{}\n]{1,60}\}/g;

/** The words in a body that count as description: template lines, placeholder lines and empty slots taken out. */
export function realText(text: string, templateLines: readonly string[]): string {
  const template = new Set(templateLines);
  return lines(text)
    .filter((l) => {
      const n = normalise(l);
      return n !== '' && !template.has(n) && !PLACEHOLDER_LINE.test(n);
    })
    .map((l) => l.replace(SLOT, ' '))
    .join('\n');
}

/** A heading line: the words alone, or followed by a colon and text; a sentence that starts with them ("Acceptance criteria are still to come") isn't one. */
const AC_HEADING = /^\s*(?:#{1,6}\s*|\*{1,2})?(acceptance criteria|definition of done|done when)\s*\**\s*(?::\s*(.*))?$/i;
const CHECKBOX = /^\s*(?:[-*+]\s*)?\[[ xX]?\]\s+\S/;

/**
 * Acceptance criteria in a body: a heading (or a leading "Acceptance criteria:")
 * with text under it, or a checklist. Text counts as the description check counts
 * it (`realText`), so "Acceptance criteria: TBD" or a heading over "N/A" doesn't.
 */
export function acceptanceInBody(text: string, templateLines: readonly string[] = []): 'heading' | 'checklist' | null {
  const words = (line: string) => wordCount(realText(line, templateLines));
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const m = AC_HEADING.exec(ls[i]!);
    if (!m) continue;
    if (words(m[2] ?? '') > 0) return 'heading';
    for (let j = i + 1; j < ls.length; j++) {
      if (/^\s*#{1,6}\s/.test(ls[j]!)) break;
      if (words(ls[j]!) > 0) return 'heading';
    }
  }
  return ls.some((l) => CHECKBOX.test(l) && words(l) > 0) ? 'checklist' : null;
}

/**
 * A field's value in the item's source records: `fields[<id>]`, as Jira and
 * Azure DevOps both send it, else the field at the top. Jira can send a
 * custom field under its registered name rather than its id, so a field
 * whose name says "acceptance criteria" counts too.
 */
function fieldValue(item: WorkItem, field: string): { value: unknown; key: string } | null {
  const wanted = field.toLowerCase();
  for (const rec of Object.values(item.native ?? {})) {
    if (!isRec(rec)) continue;
    const fields = isRec(rec.fields) ? rec.fields : rec;
    for (const [k, v] of Object.entries(fields)) if (k.toLowerCase() === wanted && v !== null && v !== undefined && v !== '') return { value: v, key: k };
    for (const [k, v] of Object.entries(fields)) if (/^acceptance\s*criteria$/i.test(k) && v !== null && v !== undefined && v !== '') return { value: v, key: k };
  }
  return null;
}

// The checks ------------------------------------------------------------------------

/** What one live read of the item's workflow found, from `workflowRead`'s command. */
export interface LiveWorkflow {
  /** The toil command that was read. */
  command: string;
  /** The read failed: toil's message and fix. */
  error?: string;
  /** Azure DevOps: the type's states. Jira: the transitions the item offers now. */
  states?: Array<{ name: string; category: StatusCategory | null }>;
  kind?: 'states' | 'transitions';
}

/** The one live read that settles the done-state check, for an item the cache can't settle it for; null when none applies. */
export function workflowRead(item: WorkItem): { command: string; input: Record<string, unknown> } | null {
  const area = item.source.area;
  if (area.startsWith('jira')) return { command: `${area} issue transitions`, input: { key: item.source.key } };
  if (area.startsWith('ado') && item.typeName) return { command: `${area} work-item states`, input: { type: item.typeName } };
  return null;
}

/** Azure DevOps' state categories and Jira's status category keys, as OWI's. */
const ADO_CATEGORY: Record<string, StatusCategory> = { proposed: 'TODO', inprogress: 'IN_PROGRESS', resolved: 'IN_PROGRESS', completed: 'DONE', removed: 'DONE' };
const JIRA_CATEGORY: Record<string, StatusCategory> = { new: 'TODO', indeterminate: 'IN_PROGRESS', done: 'DONE' };

/** A live read's data, as the done-state check reads it: ADO's `[{ name, category }]`, Jira's `[{ name, to: { statusCategory } }]`. */
export function liveWorkflow(item: WorkItem, command: string, data: unknown, error?: string): LiveWorkflow {
  if (error) return { command, error };
  const list = Array.isArray(data) ? data : isRec(data) && Array.isArray(data.transitions) ? data.transitions : [];
  if (item.source.area.startsWith('ado')) {
    return {
      command,
      kind: 'states',
      // Removed is a way out, not a way to Done: only Completed counts.
      states: list.filter(isRec).map((s) => ({ name: String(s.name ?? ''), category: typeof s.category === 'string' ? (s.category.toLowerCase() === 'removed' ? null : (ADO_CATEGORY[s.category.toLowerCase()] ?? null)) : null })),
    };
  }
  return {
    command,
    kind: 'transitions',
    states: list.filter(isRec).map((t) => {
      const to = isRec(t.to) ? t.to : {};
      const cat = isRec(to.statusCategory) && typeof to.statusCategory.key === 'string' ? (JIRA_CATEGORY[to.statusCategory.key] ?? null) : null;
      return { name: String(to.name ?? t.name ?? ''), category: cat };
    }),
  };
}

export interface GateInput {
  item: WorkItem;
  settings: ReadinessSettings;
  /** The toil project's items, by id: blockers and the done-state evidence are read from them. */
  byId: Map<string, WorkItem>;
  /** The one live read, when someone asked for it. */
  live?: LiveWorkflow;
}

const row = (check: CheckId, state: RowState, reason: string, source: string): Row => ({ check, label: CHECK_LABEL[check], state, reason, source });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function acceptance(item: WorkItem, area: AreaReadiness | undefined, body: string): Row {
  const field = area?.acceptanceField ?? null;
  if (field) {
    const found = fieldValue(item, field);
    if (found) {
      const words = wordCount(realText(textOf(found.value), area?.templateLines ?? []));
      if (words > 0) return row('acceptance', 'pass', `${plural(words, 'word')} in ${found.key}.`, `field ${found.key}`);
    }
  }
  const inBody = acceptanceInBody(body, area?.templateLines ?? []);
  if (inBody) return row('acceptance', 'pass', inBody === 'heading' ? 'A heading in the description lists them.' : 'The description has a checklist.', 'description');
  const where = field ? `${field} is empty, and the description has` : 'The description has';
  return row('acceptance', 'thin', `None found. ${where} no acceptance criteria heading or checklist.`, field ? `field ${field}, description` : 'description');
}

function description(item: WorkItem, area: AreaReadiness | undefined, body: string): Row {
  const min = area?.minWords ?? DEFAULT_MIN_WORDS;
  const all = wordCount(body);
  const real = wordCount(realText(body, area?.templateLines ?? []));
  const left = all - real;
  const aside = left > 0 ? `, not counting ${plural(left, 'word')} of template or placeholder text` : '';
  if (!item.body || all === 0) return row('description', 'thin', `No description; ${plural(min, 'word')} are needed.`, 'description');
  if (real >= min) return row('description', 'pass', `${plural(real, 'word')} of real text${aside}.`, 'description');
  return row('description', 'thin', `${plural(real, 'word')} of real text${aside}; ${plural(min, 'word')} are needed.`, 'description');
}

const sameType = (a: WorkItem, b: WorkItem) => a.source.connection === b.source.connection && (a.typeName ?? a.type).toLowerCase() === (b.typeName ?? b.type).toLowerCase();
const reachedDone = (i: WorkItem) => i.statusCategory === 'DONE' || (i.history?.transitions ?? []).some((t) => t.toCategory === 'DONE');

function doneState(item: WorkItem, byId: Map<string, WorkItem>, live: LiveWorkflow | undefined): Row {
  const type = item.typeName ?? item.type.toLowerCase();
  if (item.statusCategory === 'DONE') return row('done', 'fail', `Already done (${item.status ?? 'Done'}).`, 'status');
  if (live?.error) return row('done', 'thin', `The live read failed: ${live.error}`, `toil ${live.command}`);
  if (live?.states) {
    const done = live.states.filter((s) => s.category === 'DONE');
    if (live.kind === 'states') {
      return done.length
        ? row('done', 'pass', `The ${type} workflow has a Done state: ${done.map((s) => s.name).join(', ')}.`, `toil ${live.command}`)
        : row('done', 'fail', `The ${type} workflow has no Done state, so it can never be finished.`, `toil ${live.command}`);
    }
    return done.length
      ? row('done', 'pass', `It can move to Done now: ${done.map((s) => s.name).join(', ')}.`, `toil ${live.command}`)
      : row('done', 'thin', `None of the ${plural(live.states.length, 'move')} it offers now goes straight to Done; the workflow may get there in more steps.`, `toil ${live.command}`);
  }
  if (item.statusCategory === 'UNKNOWN') return row('done', 'thin', `toil couldn't tell what category the status ${item.status ?? '(none)'} is in, so it isn't known to be open.`, 'status');
  if (item.source.area === 'github') return row('done', 'pass', `Open (${item.status ?? 'open'}); a GitHub issue closes from any state.`, 'status');
  const seen = [...byId.values()].find((other) => other.id !== item.id && sameType(other, item) && reachedDone(other));
  if (seen) return row('done', 'pass', `Open (${item.status ?? 'open'}), and another ${type} here reached Done ([[${seen.id}]]), so the workflow gets there.`, 'cache');
  return row('done', 'thin', `Open (${item.status ?? 'open'}), but no ${type} in this Toil project has reached Done, so a way there isn't known from the cache. Check the workflow live.`, 'cache');
}

function blockers(item: WorkItem, byId: Map<string, WorkItem>): Row {
  const by = item.links.filter((l) => l.type === 'blocks' && l.direction === 'inward');
  if (!by.length) return row('blockers', 'pass', 'Nothing blocks it.', 'links');
  const open = by.filter((l) => byId.has(l.target) && byId.get(l.target)!.statusCategory !== 'DONE');
  const unknown = by.filter((l) => !byId.has(l.target));
  if (open.length) return row('blockers', 'fail', `Blocked by ${open.map((l) => `[[${l.target}]] (${byId.get(l.target)!.status ?? 'open'})`).join(', ')}.`, 'links');
  if (unknown.length) return row('blockers', 'thin', `Blocked by ${unknown.map((l) => l.target).join(', ')}, which this Toil project doesn't hold, so whether ${unknown.length === 1 ? "it's" : "they're"} still open isn't known.`, 'links');
  return row('blockers', 'pass', `Its ${by.length === 1 ? 'blocker is' : 'blockers are'} done (${by.map((l) => `[[${l.target}]]`).join(', ')}).`, 'links');
}

/** The repository a GitHub issue lives in, by the toil project's repository names; null for other trackers. */
const issueRepo = (item: WorkItem) => (item.source.area === 'github' ? (/^[^/]+\/([^#]+)#/.exec(item.source.key)?.[1] ?? null) : null);

function scope(item: WorkItem, settings: ReadinessSettings): Row {
  if (!settings.sources.includes(item.source.area)) return row('scope', 'fail', `It came from ${item.source.area}, which isn't one of this Toil project's sources (${settings.sources.join(', ') || 'none'}).`, 'toilProject');
  const repos = settings.repos;
  if (!repos.length) return row('scope', 'thin', 'The Toil project names no repository, so an agent could plan it but has nowhere to implement it. Add one with toil projects add-repo.', 'Toil project repos');
  const own = issueRepo(item);
  if (own && repos.includes(own)) return row('scope', 'pass', `${item.source.area} is one of the Toil project's sources, and its repository, ${own}, is in the Toil project.`, 'Toil project repos');
  if (repos.length === 1) return row('scope', 'pass', `${item.source.area} is one of the Toil project's sources, and an agent works in ${repos[0]}.`, 'Toil project repos');
  return row('scope', 'pass', `${item.source.area} is one of the Toil project's sources, which names ${plural(repos.length, 'repository', 'repositories')} (${repos.join(', ')}); one is chosen when it starts.`, 'Toil project repos');
}

const ORDER: Record<RowState, number> = { fail: 0, thin: 1, pass: 2 };

/** The verdict and its five rows for one item. */
export function readiness({ item, settings, byId, live }: GateInput): Readiness {
  const area = settings.areas[item.source.area];
  const body = item.body ? textOf(item.body.content, item.body.format) : '';
  const rows = [acceptance(item, area, body), description(item, area, body), doneState(item, byId, live), blockers(item, byId), scope(item, settings)];
  const verdict: Verdict = rows.some((r) => r.state === 'fail') ? 'blocked' : rows.some((r) => r.state === 'thin') ? 'thin' : 'ready';
  const why = rows.filter((r) => r.state !== 'pass').sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return { id: item.id, verdict, rows, why };
}

/** Every item's readiness, in the toil project's order. */
export function readinessAll(items: WorkItem[], settings: ReadinessSettings): Readiness[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.map((item) => readiness({ item, settings, byId }));
}

/** How many items have each verdict. */
export function tally(list: Readiness[]): Record<Verdict, number> {
  const out: Record<Verdict, number> = { ready: 0, thin: 0, blocked: 0 };
  for (const r of list) out[r.verdict]++;
  return out;
}
