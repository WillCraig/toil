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
 * Then one row for each ticket rule (#657) that applies to the item, from the
 * toil project's `standards.use`, as toil's own `standards check` worked it
 * out (src/core/standards/check.ts). Until that check has been read, or when
 * it failed or returned nothing for the item, the rules are one row, "Ticket
 * rules", saying so; a rule whose text wasn't in the record read is `skipped`.
 *
 * A row is `pass`, `thin` (missing something a person can decide to live
 * with), `fail` (it can't be worked on as it is) or `skipped` (a ticket rule
 * nobody could check). The verdict is `blocked` when any row fails, `thin`
 * when any is thin, `unread` ("Rules not read yet") when nothing fails or is
 * thin but a ticket rule wasn't checked, and `ready` only when every row
 * passes. A rule nobody read is unknown, not a pass (principle 12), so an item
 * is never slated for an agent on rules toil hasn't read.
 * Five boxes, ticked by a function, which is the only kind of committee that
 * has ever finished on time.
 */

import { ADO_ACCEPTANCE_FIELD } from '../../../src/core/standards/check.ts';
import { acceptanceInBody, lines, normalise, realText, textOf, wordCount } from '../../../src/core/standards/text.ts';
import type { RuleResult } from '../../../src/core/standards/types.ts';
import type { StatusCategory, WorkItem } from '../toil.ts';

// The body reader is toil's (src/core/standards/text.ts), so a ticket rule and these rows read a description one way.
export { ADO_ACCEPTANCE_FIELD, acceptanceInBody, realText, textOf, wordCount };

/** `unread`: nothing fails or is thin, but a ticket rule the toil project names wasn't checked on the item, so it isn't known to be ready. */
export type Verdict = 'ready' | 'thin' | 'blocked' | 'unread';
export type RowState = 'pass' | 'thin' | 'fail' | 'skipped';
/** The five fixed checks. */
export type FixedCheckId = 'acceptance' | 'description' | 'done' | 'blockers' | 'scope';
/** A fixed check, a ticket rule (`rule:<standard>/<rule>`), or `rules`: the one row for ticket rules not read yet, or that failed to read. */
export type CheckId = FixedCheckId | 'rules' | `rule:${string}`;

export const CHECKS: readonly FixedCheckId[] = ['acceptance', 'description', 'done', 'blockers', 'scope'];
export const CHECK_LABEL: Record<FixedCheckId, string> = {
  acceptance: 'Acceptance criteria',
  description: 'Description',
  done: 'Done state',
  blockers: 'Blockers',
  scope: 'Scope',
};
export const VERDICT_LABEL: Record<Verdict, string> = { ready: 'Ready', thin: 'Thin', blocked: 'Blocked', unread: 'Rules not read yet' };
/** The same four, in plain words (src/plain-words.ts). */
export const VERDICT_PLAIN: Record<Verdict, string> = { ready: 'Ready', thin: 'Needs more detail', blocked: 'Blocked', unread: 'Rules not read yet' };
export const VERDICTS: readonly Verdict[] = ['ready', 'thin', 'blocked', 'unread'];

/** One check's row: its state, and why, with any item it names written as `[[id]]`. */
export interface Row {
  check: CheckId;
  label: string;
  state: RowState;
  reason: string;
  /** Where the row's answer came from: a field, the body, the last sync (the cache, in plain words), or the live command. */
  source: string;
  /** A ticket rule's row: which rule it is, for "Fix with AI agent". */
  rule?: { standard: string; rule: string };
}

export interface Readiness {
  id: string;
  verdict: Verdict;
  rows: Row[];
  /** The rows that aren't `pass`, worst first (a skipped rule last): why it isn't ready, in one place. */
  why: Row[];
}

/** Description words a ready item needs when the toil project sets no number. */
export const DEFAULT_MIN_WORDS = 25;
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
  /** The ticket rules the toil project names (`standards.use`), in order; empty when it names none, and then no rule row shows. */
  standards: string[];
  /** The ticket rules as toil checked them, once read; absent, a toil project that names some shows them as not read yet. */
  rules?: RulesReading;
}

/** Tracker fields whose everyday name is known, by id in lower case (Azure DevOps' without `System.`). */
const KNOWN_FIELDS: Record<string, string> = {
  title: 'Title',
  summary: 'Title',
  description: 'Description',
  body: 'Comment',
  priority: 'Priority',
  labels: 'Labels',
  'story points': 'Story points',
  storypoints: 'Story points',
  'microsoft.vsts.scheduling.storypoints': 'Story points',
  'microsoft.vsts.common.acceptancecriteria': 'Acceptance criteria',
  'microsoft.vsts.tcm.reprosteps': 'Repro steps',
};

/**
 * A field's everyday name for a proposal's table (#657): "Acceptance criteria"
 * for the field the Toil project names as its acceptance criteria
 * (`<area>.fields.acceptanceCriteria`, often a `customfield_…`), else a name
 * every tracker shares; null when there is none, and the id is shown instead.
 */
export function fieldName(field: string, settings: Pick<ReadinessSettings, 'areas'>, area: string | null): string | null {
  const f = field.toLowerCase().replace(/^system\./, '');
  const criteria = (area ? [settings.areas[area]] : Object.values(settings.areas)).some((a) => a?.acceptanceField?.toLowerCase() === field.toLowerCase());
  return criteria ? 'Acceptance criteria' : (KNOWN_FIELDS[f] ?? null);
}

/**
 * What toil's `standards check` said, as the page holds it: not read yet (the
 * call hasn't come back, or the toil project never synced), read, or failed,
 * with toil's message. Unread is never an empty result (principle 12).
 */
export interface RulesReading {
  state: 'unread' | 'read' | 'failed';
  /** Each item's rule results, by OWI id; only when read. */
  byItem: ReadonlyMap<string, readonly RuleResult[]>;
  /** Why the read failed, in toil's words; null otherwise. */
  message: string | null;
  /**
   * What toil said about reading the rules that isn't a failure, each in toil's own words (its `meta.warnings`): a
   * standard set aside or skipped (STANDARDS_SKIPPED, STANDARD_SHADOWS_BUILTIN), a file that couldn't be used
   * (STANDARD_PATH_INVALID), a key it ignored (STANDARD_UNKNOWN_KEY, STANDARD_DUPLICATE_KEY). Empty when unread or failed.
   */
  warnings: readonly string[];
}

export const RULES_UNREAD: RulesReading = { state: 'unread', byItem: new Map(), message: null, warnings: [] };

/** The gate's settings with the ticket rules as last read. */
export const withRules = (settings: ReadinessSettings, rules: RulesReading | undefined): ReadinessSettings => (rules ? { ...settings, rules } : settings);

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Keys at the top of a toil project that aren't area sections (src/core/toil-project.ts, TOP_LEVEL). */
const NOT_SECTIONS = new Set(['$schema', 'name', 'description', 'env', 'repos', 'environments', 'people', 'wipLimit', 'archived', 'analyze', 'classify', 'standards', 'dimensions', 'views']);

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
  const use = isRec(d.standards) && Array.isArray(d.standards.use) ? d.standards.use.filter((u): u is string => typeof u === 'string' && u !== '') : [];
  return { sources, repos, areas, notes, standards: use };
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

const row = (check: FixedCheckId, state: RowState, reason: string, source: string): Row => ({ check, label: CHECK_LABEL[check], state, reason, source });
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
  // The field by what it holds, not its tracker id: the raw key stays in the source line, where a person checking it looks.
  const where = field ? 'The acceptance criteria field is empty, and the description has' : 'The description has';
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
  if (seen) return row('done', 'pass', `Open (${item.status ?? 'open'}), and another ${type} here reached Done ([[${seen.id}]]), so the workflow gets there.`, 'last sync');
  return row('done', 'thin', `Open (${item.status ?? 'open'}), but no ${type} in this Toil project has reached Done, so a way there isn't known from the last sync. Check the workflow live.`, 'last sync');
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
  if (!repos.length) return row('scope', 'thin', 'The Toil project names no repository, so an agent could plan it but has nowhere to implement it. Add one under Settings, Toil projects.', 'Toil project repos');
  const own = issueRepo(item);
  if (own && repos.includes(own)) return row('scope', 'pass', `${item.source.area} is one of the Toil project's sources, and its repository, ${own}, is in the Toil project.`, 'Toil project repos');
  if (repos.length === 1) return row('scope', 'pass', `${item.source.area} is one of the Toil project's sources, and an agent works in ${repos[0]}.`, 'Toil project repos');
  return row('scope', 'pass', `${item.source.area} is one of the Toil project's sources, which names ${plural(repos.length, 'repository', 'repositories')} (${repos.join(', ')}); one is chosen when it starts.`, 'Toil project repos');
}

/** The label of the one row that stands for ticket rules nobody has read. */
export const RULES_LABEL = 'Ticket rules';

/**
 * The item's ticket-rule rows: one per rule that applies, once read; until
 * then one row saying they weren't read yet, or why the read failed. A read
 * that holds no result for the item (it synced after the check, say) is one
 * such row too, never "no rule applies". None when the toil project names no
 * rules and nothing was read.
 */
function ruleRows(item: WorkItem, settings: ReadinessSettings): Row[] {
  const rules = settings.rules ?? (settings.standards.length > 0 ? RULES_UNREAD : undefined);
  if (!rules) return [];
  const source = `ticket rules: ${settings.standards.join(', ')}`;
  if (rules.state === 'read') {
    const results = rules.byItem.get(item.id);
    if (results) return results.map((r) => ({ check: `rule:${r.standard}/${r.rule}` as const, label: r.name, state: r.state, reason: r.reason, source: `${r.source} (ticket rules: ${r.standard})`, rule: { standard: r.standard, rule: r.rule } }));
    if (settings.standards.length === 0) return [];
    return [{ check: 'rules', label: RULES_LABEL, state: 'skipped', reason: "Not read yet: toil's last check of the ticket rules has no result for this item. Sync again to check it.", source }];
  }
  if (settings.standards.length === 0) return [];
  const reason = rules.state === 'failed' ? `Couldn't be checked: ${rules.message ?? 'toil gave no reason.'}` : 'Not read yet.';
  return [{ check: 'rules', label: RULES_LABEL, state: 'skipped', reason, source }];
}

const ORDER: Record<RowState, number> = { fail: 0, thin: 1, pass: 2, skipped: 3 };

/** The verdict and its rows for one item: the five checks, then its ticket rules. */
export function readiness({ item, settings, byId, live }: GateInput): Readiness {
  const area = settings.areas[item.source.area];
  const body = item.body ? textOf(item.body.content, item.body.format) : '';
  const rows = [acceptance(item, area, body), description(item, area, body), doneState(item, byId, live), blockers(item, byId), scope(item, settings), ...ruleRows(item, settings)];
  const verdict: Verdict = rows.some((r) => r.state === 'fail') ? 'blocked' : rows.some((r) => r.state === 'thin') ? 'thin' : rows.some((r) => r.state === 'skipped') ? 'unread' : 'ready';
  // A skipped rule isn't a miss, but nor is it a pass: it is in why, after the misses, since it is what keeps an item from ready.
  const why = rows.filter((r) => r.state !== 'pass').sort((a, b) => ORDER[a.state] - ORDER[b.state]);
  return { id: item.id, verdict, rows, why };
}

/**
 * Whether the item would still be Blocked with every ticket rule passing: blocked by an open item, done already, or outside
 * the Toil project. Fixing its ticket rules can't make such an item ready, so it is not the one to lead a fix with.
 */
export function blockedBesidesRules(item: WorkItem, settings: ReadinessSettings, byId: Map<string, WorkItem>): boolean {
  return readiness({ item, settings: { ...settings, standards: [], rules: RULES_UNREAD }, byId }).verdict === 'blocked';
}

/** Every item's readiness, in the toil project's order. */
export function readinessAll(items: WorkItem[], settings: ReadinessSettings): Readiness[] {
  const byId = new Map(items.map((i) => [i.id, i]));
  return items.map((item) => readiness({ item, settings, byId }));
}

/** What makes an item Blocked, as the Tickets page says it under its Blocked figure. */
export const BLOCKED_WHY = 'Waiting on another item, done already, outside the Toil project, or failing a ticket rule.';

/** The open items whose verdict is Blocked: the Tickets page's Blocked figure, which its tab's badge repeats. */
export function blockedOpen(items: WorkItem[], settings: ReadinessSettings): number {
  return readinessAll(items, settings).filter((r, i) => r.verdict === 'blocked' && items[i]!.statusCategory !== 'DONE').length;
}

/**
 * The Blocked figure with whether it is exact (#657, principle 12): a ticket rule can fail an item, which makes it
 * Blocked, so while any open item's rules are unread (not read yet, failed to read, or no result for it) the count is
 * only a floor and may grow once they are read. The Tickets tab's badge and the page's figure show it as a floor (or a
 * dash) while `exact` is false, never as the exact count.
 */
export function blockedOpenReading(items: WorkItem[], settings: ReadinessSettings): { count: number; exact: boolean } {
  const open = readinessAll(items, settings).filter((_, i) => items[i]!.statusCategory !== 'DONE');
  return { count: open.filter((r) => r.verdict === 'blocked').length, exact: !open.some((r) => r.rows.some((row) => row.check === 'rules')) };
}

/** How many items have each verdict. */
export function tally(list: Readiness[]): Record<Verdict, number> {
  const out: Record<Verdict, number> = { ready: 0, thin: 0, blocked: 0, unread: 0 };
  for (const r of list) out[r.verdict]++;
  return out;
}
