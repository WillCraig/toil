/**
 * The agent's tools (#251, #291, #292): read-only, scoped to one dossier, and the
 * same list for every adapter. Nine read the cache a sync filled
 * (`owi_query`, `owi_get`, `owi_history`, and `owi_similar`, the scorer `toil
 * util owi similar` runs; `pr_query`, `pr_get` and `pr_metrics`, the pull
 * requests as OWI changes, worked out by src/model/prs.ts as the pull request
 * view works them out; `people_list` and `person_get`, each person's load as
 * src/model/people.ts and the People view work it out; `readiness_list` and
 * `readiness_get`, each item's readiness verdict, #307); the rest are `toil mcp`'s own read tools, by
 * their MCP names, for live lookups through `@imagile-dev/toil/api`'s
 * `execute()` with `readOnly: true`. There is no write tool, and a live tool
 * is built only for a command the registry says never writes, so the list
 * can't grow one by accident (test/agents.test.ts asserts it).
 *
 * Every tool call adds the ids it returned to a ledger: the items, the
 * parents, children and link targets they name, and the pull requests,
 * builds and deployments linked to them. An answer may cite only ids in its
 * ledger: anything else it names is flagged (answer.ts). `worklog_day`
 * (#308) reads one day's worklog page, the same fold the Worklog view shows,
 * and vouches for every item and pull request its lines name; `standup_report`
 * (#345) reads a range of days folded into a stand-up, the same report the
 * Worklog view's Stand-up shows, its lines numbered F1, F2, ... so a write-up
 * can say which facts it used. A reading room
 * with a sign-out sheet and no photocopier.
 */

import type { Cache, ChangeRow, TransitionRow } from '../cache.ts';
import type { AuthorKind, Change, Envelope, Execute, WorkItem } from '../../src/toil.ts';
import { flagsOf, KINDS, linked, PR_FLAG_LABEL, prMetrics, sizeOf, waitOf, workingDays, type Sample, type WaitingOn } from '../../src/model/prs.ts';
import { people, readPeople, type Card } from '../../src/model/people.ts';
import { CHECK_LABEL, readiness, readReadiness, tally, VERDICTS, type Readiness } from '../../src/model/readiness.ts';
import { SimilarityIndex } from '../../../src/core/owi/similar.ts';
import { CALLER } from '../store.ts';
import { addDays, appliedText, dayOf, isDay, OUTCOME_TEXT, timeOf, type WorklogPage } from '../../src/model/worklog.ts';
import { BUCKETS, BUCKET_TITLE, defaultRange, whenText, type StandupLine, type StandupReport } from '../../src/model/standup.ts';

/** What the cache tools read: one dossier's synced rows. */
export interface AgentData {
  items(): WorkItem[];
  transitions(itemId: string): TransitionRow[];
  changes(): ChangeRow[];
  /** When the dossier was last synced, or null if never. */
  syncedAt(): string | null;
  /** One UTC day's worklog page (#308), as the Worklog view builds it; absent where there is no worklog. */
  worklog?(day: string): Promise<WorklogPage>;
  /** The stand-up report for a range of UTC days (#345), as the Worklog view's Stand-up builds it; absent where there is no worklog. */
  standup?(from: string, to: string): Promise<StandupReport>;
}

/**
 * The dossier itself, as `dossiers show` prints it now: its `people` and
 * `wipLimit` among the rest. It's toil's own config on this machine, which the
 * cache never holds (server/store.ts reads it live), so the people tools ask
 * toil for it, read-only, on each call.
 */
export type ReadDossier = () => Promise<{ dossier: unknown; error: string | null }>;

/** The pull requests among a dossier's change rows, as the OWI changes they were made from. */
export const pullRequestsOf = (rows: ChangeRow[]): Change[] => rows.flatMap((r) => (r.kind === 'pull-request' && 'change' in r.ref && r.ref.change ? [r.ref.change] : []));

/** A dossier's rows in the SQLite cache, or null when it has never synced. */
export function cacheData(cache: Pick<Cache, 'states' | 'items' | 'transitions' | 'changes'>, dossier: string): AgentData | null {
  const state = cache.states().find((s) => s.name === dossier);
  if (!state) return null;
  return {
    items: () => cache.items(dossier),
    transitions: (id) => cache.transitions(dossier, id),
    changes: () => cache.changes(dossier),
    syncedAt: () => state.lastSavedAt,
  };
}

/** `dossiers show` through toil, read-only and labelled as Toil UI: the people tools' `ReadDossier`. */
export function dossierReader(execute: Execute, dossier: string): ReadDossier {
  return async () => {
    const e = await execute('dossiers show', { dossier }, { readOnly: true, caller: CALLER });
    if (!e.ok) return { dossier: null, error: `toil dossiers show ${dossier} failed: ${e.error.message}${e.error.fix ? ` ${e.error.fix}` : ''}` };
    return { dossier: typeof e.data === 'object' && e.data !== null ? ((e.data as { dossier?: unknown }).dossier ?? null) : null, error: null };
  };
}

/** One tool, described once for every SDK: a name, what it does, its input as JSON Schema, and what it runs. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (an object) of the input. */
  inputSchema: { type: 'object'; properties: Record<string, Record<string, unknown>>; required?: string[]; additionalProperties: false };
  /** Runs the tool. Never throws: a failure is `{ error }`, which the model reads. */
  run(input: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  /** A live tool's toil command (`github issue list`), for the chat's status line (#343). */
  command?: string;
}

/** What a registry entry must say before it becomes a live tool. */
export interface ReadCommand {
  name: string;
  tool: string;
  area?: string;
  description: string;
  writes: boolean;
  writesLocal: boolean;
  writesDependOnInput: boolean;
  inputSchema: Record<string, unknown>;
}

/**
 * The live lookups the agent may make: the dashboards' own reads plus a
 * single item's fetch. `dossiers list` is left out: an answer is about one
 * dossier.
 */
export const LIVE_COMMANDS: readonly string[] = [
  'dossiers show',
  'jira issue search',
  'jira issue get',
  'jira issue history',
  'ado work-item search',
  'ado work-item get',
  'ado work-item get-many',
  'ado work-item history',
  'ado work-item iterations',
  'ado pr list',
  'ado pr get',
  'ado pr files',
  'ado pr diff',
  'ado pr threads',
  'ado pr builds',
  'ado run list',
  'github issue get',
  'github issue history',
  'github project items',
  'github pr list',
  'github pr get',
  'github commit checks',
  'github pr files',
  'github pr diff',
  'github pr threads',
  'github pr status',
  'bitbucket pr list',
  'bitbucket pr get',
  'bitbucket pr files',
  'bitbucket pr diff',
  'bitbucket pr builds',
  'jenkins pipeline runs',
  'openshift deployment list',
  // The workflow jobs (#532): a review reads a pull request's files and diff, and Diagram draws its model, local and read-only.
  'util c4 mermaid',
];

/** Fields a live tool never offers: the dossier is fixed, and a file or folder on this machine is not the agent's to name. */
export const HIDDEN_FIELDS = new Set(['dossier', 'cwd', 'connection', 'select', 'file']);
const hidden = (field: string) => HIDDEN_FIELDS.has(field) || /File$/.test(field) || field === 'out' || field === 'allowWrite';

/** The bounds on what one tool call returns (Bounds). */
export const MAX_QUERY = 200;
export const DEFAULT_QUERY = 50;
const MAX_BODY_CHARS = 4000;
/** A live result is cut to this many characters of JSON, and says so. */
export const MAX_LIVE_CHARS = 60_000;

/** The ids a tool result vouches for, and the tool calls made: what answer.ts checks citations against. */
export class Ledger {
  readonly ids = new Set<string>();
  readonly calls: Array<{ tool: string; input: Record<string, unknown> }> = [];
  add(id: string | null | undefined) {
    if (id) this.ids.add(id);
  }
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** Who an item is assigned to, by name, else by id: GitHub names people by login alone, which OWI keeps as the id. */
const assigneeOf = (item: WorkItem) => (item.assignee ? (item.assignee.name ?? item.assignee.id) : null);

/** An item as a tool returns it: no `native` record, a bounded body. */
function brief(item: WorkItem) {
  return {
    id: item.id,
    type: item.type,
    typeName: item.typeName,
    title: item.title,
    status: item.status,
    statusCategory: item.statusCategory,
    assignee: assigneeOf(item),
    priority: item.priority,
    estimate: item.estimate ? { value: item.estimate.value, unit: item.estimate.unit, field: item.estimate.field } : null,
    labels: item.labels,
    iteration: item.iteration?.name ?? null,
    parent: item.parent,
    children: item.children,
    links: item.links.map((l) => ({ type: l.type, direction: l.direction, target: l.target, name: l.name })),
    created: item.created,
    updated: item.updated,
    resolved: item.resolved,
    url: item.url,
  };
}

function bodyText(item: WorkItem): string | null {
  if (!item.body) return null;
  const text = typeof item.body.content === 'string' ? item.body.content : JSON.stringify(item.body.content);
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}… (cut at ${MAX_BODY_CHARS} characters)` : text;
}

/** Every id a returned item names (its own, its parent, children and link targets): each is in the tool's result, so an answer may cite it. */
function vouch(ledger: Ledger, item: Pick<WorkItem, 'id' | 'parent' | 'children' | 'links'>) {
  ledger.add(item.id);
  ledger.add(item.parent);
  for (const c of item.children) ledger.add(c);
  for (const l of item.links) ledger.add(l.target);
}

/** The most matches owi_similar returns, and how many by default. */
export const MAX_SIMILAR = 20;
export const DEFAULT_SIMILAR = 5;

/** The most pull requests pr_query returns, and how many by default. */
export const MAX_PRS = 100;
export const DEFAULT_PRS = 30;
const WAITS: WaitingOn[] = ['draft', 'changes', 'checks', 'review', 'merge'];
const round1 = (n: number) => Math.round(n * 10) / 10;

/** A pull request as a tool returns it: no `native` record; what it waits on, its flags and its work items as the view shows them. */
function prBrief(c: Change, byId: Map<string, WorkItem>, now: string) {
  const open = c.state === 'OPEN' || c.state === 'DRAFT';
  const wait = open ? waitOf(c, now) : null;
  const size = sizeOf(c);
  return {
    id: c.id,
    repo: c.repo,
    title: c.title,
    state: c.state,
    author: c.author ? (c.author.name ?? c.author.id) : null,
    authorKind: c.authorKind,
    authorKindSource: c.authorKindSource,
    authorKindSignal: c.authorKindSignal,
    waitingOn: wait?.on ?? null,
    waitingWorkingDays: wait?.days === null || wait === null ? null : round1(wait.days),
    waitingSince: wait?.since ?? null,
    why: wait?.why ?? null,
    reviewers: c.reviewers.map((r) => ({ who: r.person.name ?? r.person.id, state: r.state })),
    checks: c.checks,
    checksAt: c.checksAt,
    mergeable: c.mergeable,
    size: size.bucket,
    changedLines: size.lines,
    files: size.files,
    workItems: linked(c, byId),
    namesOutsideDossier: c.workItems.filter((id) => !byId.has(id)),
    flags: flagsOf(c, byId, now).map((f) => ({ flag: f.flag, label: PR_FLAG_LABEL[f.flag], evidence: f.text })),
    created: c.created,
    firstReviewAt: c.firstReviewAt,
    approvedAt: c.approvedAt,
    mergedAt: c.mergedAt,
    url: c.url,
    unmapped: c.unmapped.map((u) => u.field),
  };
}

/** A sample as a tool returns it: the median in working days, its sample size, and how many were unknown. */
const sampleOut = (s: Sample) => ({ median: s.median === null ? null : round1(s.median), p85: s.p85 === null ? null : round1(s.p85), n: s.n, unknown: s.unknown });

/** The pull request tools for one dossier: query, get and metrics over the synced OWI changes. */
export function prTools(dossier: string, data: AgentData, ledger: Ledger, now: () => string = () => new Date().toISOString()): ToolSpec[] {
  const note = () => ({ dossier, syncedAt: data.syncedAt() });
  const byIdOf = () => new Map(data.items().map((i) => [i.id, i]));
  const vouchPr = (b: { id: string; workItems: string[] }) => {
    ledger.add(b.id);
    for (const id of b.workItems) ledger.add(id);
  };
  return [
    {
      name: 'pr_query',
      description: `Lists the pull requests Toil UI's cache holds for the dossier "${dossier}" (GitHub, Bitbucket and Azure DevOps), as OWI changes, open ones longest-waiting first. Each says what it waits on (review, changes, checks, merge or draft) and for how many working days, why, its reviewers and their state, checks (PASSING, FAILING, PENDING, NONE, or null when not read), mergeable, size (XS to XL by changed lines), the dossier's work items it names, its flags, and authorKind (HUMAN, AGENT or BOT) with the signal that set it. All filters must match. Returns at most ${MAX_PRS} and says when there were more.`,
      inputSchema: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['OPEN', 'DRAFT', 'MERGED', 'DECLINED'], description: 'Default: OPEN and DRAFT.' },
          repo: { type: 'string', description: 'Part of the repository name.' },
          author: { type: 'string', description: "Part of the author's name or id." },
          authorKind: { type: 'string', enum: ['HUMAN', 'AGENT', 'BOT'] },
          waitingOn: { type: 'string', enum: WAITS, description: 'What an open pull request waits on.' },
          minWaitingDays: { type: 'number', minimum: 0, description: 'Only those waiting at least this many working days.' },
          olderThanDays: { type: 'number', minimum: 0, description: 'Only those opened at least this many working days ago.' },
          flagged: { type: 'boolean', description: 'Only those with at least one flag.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_PRS, description: `Default ${DEFAULT_PRS}.` },
        },
        additionalProperties: false,
      },
      async run(input) {
        const at = now();
        const byId = byIdOf();
        const repo = str(input.repo)?.toLowerCase();
        const author = str(input.author)?.toLowerCase();
        const limit = Math.min(MAX_PRS, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : DEFAULT_PRS));
        const states = str(input.state) ? [String(input.state)] : ['OPEN', 'DRAFT'];
        const all = pullRequestsOf(data.changes()).map((c) => ({ c, b: prBrief(c, byId, at) }));
        const matches = all
          .filter(({ c, b }) =>
            states.includes(c.state) &&
            (!repo || c.repo.toLowerCase().includes(repo)) &&
            (!author || [c.author?.id, c.author?.name].some((n) => n?.toLowerCase().includes(author))) &&
            (!str(input.authorKind) || c.authorKind === input.authorKind) &&
            (!str(input.waitingOn) || b.waitingOn === input.waitingOn) &&
            (typeof input.minWaitingDays !== 'number' || (b.waitingWorkingDays ?? -1) >= input.minWaitingDays) &&
            (typeof input.olderThanDays !== 'number' || (c.created !== null && workingDays(c.created, at) >= input.olderThanDays)) &&
            (input.flagged !== true || b.flags.length > 0),
          )
          .sort((x, y) => (y.b.waitingWorkingDays ?? -1) - (x.b.waitingWorkingDays ?? -1) || (x.c.created ?? '').localeCompare(y.c.created ?? ''))
          .map(({ b }) => b);
        const prs = matches.slice(0, limit);
        for (const b of prs) vouchPr(b);
        return { ...note(), now: at, total: matches.length, returned: prs.length, ...(matches.length > limit ? { more: `${matches.length - limit} more match; narrow the filters or raise limit (max ${MAX_PRS}).` } : {}), pullRequests: prs };
      },
    },
    {
      name: 'pr_get',
      description: `One pull request from the cache for "${dossier}", by its change id (such as github:imagile/payments-web#52, from pr_query): everything pr_query says, plus every review in order, and each named work item's title and status.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The change id.' } }, required: ['id'], additionalProperties: false },
      async run(input) {
        const id = str(input.id);
        const c = id ? pullRequestsOf(data.changes()).find((x) => x.id === id) : undefined;
        if (!c) return { ...note(), error: `The cache holds no pull request ${JSON.stringify(id ?? '')} in ${dossier}. Use pr_query to find ids.` };
        const byId = byIdOf();
        const b = prBrief(c, byId, now());
        vouchPr(b);
        return {
          ...note(),
          pullRequest: {
            ...b,
            branch: c.branch,
            reviews: c.reviews?.map((r) => ({ who: r.by.name ?? r.by.id, state: r.state, at: r.at })) ?? null,
            workItemDetail: b.workItems.map((wid) => {
              const i = byId.get(wid)!;
              return { id: wid, title: i.title, status: i.status, statusCategory: i.statusCategory };
            }),
          },
        };
      },
    },
    {
      name: 'pr_metrics',
      description: `Flow metrics for the pull requests in the cache for "${dossier}", for the last weeks (Monday to Sunday UTC, the current week included), split by authorKind (HUMAN, AGENT, BOT) and for ALL: pickup (opened to first review), review (first review to approval) and merge (approval to merge) as medians and 85th percentiles in working days, review rounds per merged pull request, sizes opened (XS to XL), and merged per week. Every figure has n, its sample size, and unknown, how many lacked the data; quote n with every figure.`,
      inputSchema: { type: 'object', properties: { weeks: { type: 'integer', minimum: 1, maximum: 26, description: 'Default 6.' } }, additionalProperties: false },
      async run(input) {
        const weeks = Number.isInteger(input.weeks) ? Math.min(26, Math.max(1, input.weeks as number)) : 6;
        const m = prMetrics(pullRequestsOf(data.changes()), now(), weeks);
        const kinds = ['ALL', ...KINDS] as Array<AuthorKind | 'ALL'>;
        const per = <T,>(f: (k: AuthorKind | 'ALL') => T) => Object.fromEntries(kinds.map((k) => [k, f(k)]));
        return {
          ...note(),
          from: m.from,
          to: m.to,
          unit: 'working days',
          pickup: per((k) => sampleOut(m.pickup[k])),
          review: per((k) => sampleOut(m.review[k])),
          merge: per((k) => sampleOut(m.merge[k])),
          reviewRounds: per((k) => sampleOut(m.rounds[k])),
          sizesOpened: m.sizes,
          mergedPerWeek: per((k) => m.throughput[k].map((w) => ({ weekOf: w.start, merged: w.items.length, ...(w.partial ? { partial: true } : {}) }))),
          mergedWithNoMergeTime: m.unplacedMerges,
          mergedWithNoApproval: m.mergedUnreviewed,
          pullRequests: m.counts,
        };
      },
    },
  ];
}

/** One card, as people_list returns it: the load, never a score. */
function personBrief(c: Card) {
  return {
    key: c.who.key,
    name: c.who.name,
    kind: c.who.kind,
    mapped: c.who.mapped,
    identities: c.who.identities.map((i) => `${i.area}:${i.id}`),
    inProgress: c.wip.flatMap((g) => g.items.map((w) => ({ id: w.item.id, title: w.item.title, status: g.status, daysInStatus: w.days }))),
    overLimit: c.overLimit,
    openPullRequests: c.prs.map((p) => ({ id: p.change.id, title: p.change.title, waitingOn: p.wait.on, waitingWorkingDays: p.wait.days === null ? null : round1(p.wait.days), writtenWithAgent: p.withAgent })),
    reviewsWaitingOnThem: c.reviews.map((r) => ({ id: r.change.id, title: r.change.title, openWorkingDays: r.days })),
    blocked: c.blocked.map((b) => ({ id: b.item.id, title: b.item.title, blockedBy: b.by.map((x) => ({ id: x.id, status: x.item ? x.item.status : null, inDossier: x.item !== null })) })),
  };
}

/** Every id a card names, so an answer may cite them. */
function vouchCard(ledger: Ledger, c: Card) {
  for (const g of c.wip) for (const w of g.items) ledger.add(w.item.id);
  for (const p of c.prs) ledger.add(p.change.id);
  for (const r of c.reviews) ledger.add(r.change.id);
  for (const b of c.blocked) {
    ledger.add(b.item.id);
    for (const x of b.by) ledger.add(x.id);
  }
  for (const a of c.activity) ledger.add(a.kind === 'moved' ? a.item.id : a.change.id);
}

/** The two people tools for one dossier (#292): everyone's load, and one person's plate in full. */
export function peopleTools(dossier: string, data: AgentData, ledger: Ledger, readDossier: ReadDossier, now: () => string = () => new Date().toISOString()): ToolSpec[] {
  const note = () => ({ dossier, syncedAt: data.syncedAt() });
  const view = async () => {
    const shown = await readDossier();
    const team = readPeople(shown.dossier);
    if (shown.error) team.notes.unshift(`${shown.error} So nobody is mapped, and no limit is known.`);
    return { team, view: people({ dossier, entries: team.people, wipLimit: team.wipLimit, items: data.items(), changes: pullRequestsOf(data.changes()), now: now() }) };
  };
  const LOAD = 'This is load, not performance: never rank, score or compare people; say what is on each plate and what blocks it, citing ids.';
  return [
    {
      name: 'people_list',
      description: `The people of the dossier "${dossier}" (its people list, agents included as kind agent) and the accounts in its data it doesn't map, each with their current load from Toil UI's cache: items in progress with days in their status, open pull requests and what each waits on, reviews waiting on them, and blocked items with what blocks them. Also the dossier's work-in-progress limit and who is over it, the team's review queue, unassigned items in the current sprint, and accounts that share an email with someone (suggested matches, never applied). ${LOAD}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        const { team, view: v } = await view();
        const cards = [...v.people, ...v.unmapped];
        for (const c of cards) vouchCard(ledger, c);
        for (const r of v.team.reviewQueue) ledger.add(r.change.id);
        for (const i of v.team.unassigned?.items ?? []) ledger.add(i.id);
        return {
          ...note(),
          now: now(),
          rule: LOAD,
          wipLimitPerPerson: v.wipLimit,
          notes: team.notes,
          people: v.people.map(personBrief),
          unmapped: v.unmapped.map(personBrief),
          suggestedMatches: v.suggestions.map((s) => ({ accounts: s.identities.map((i) => `${i.area}:${i.id}`), probably: s.person ?? `a new person, ${s.name}`, sharedEmail: s.email, applyWith: s.command })),
          ambiguous: v.ambiguous,
          pullRequestsByUnnamedAgents: v.unnamedAgents.map((c) => c.id),
          team: {
            inProgress: v.team.wip.total,
            overLimit: v.team.wip.over.map((o) => ({ name: o.name, inProgress: o.count })),
            reviewQueue: v.team.reviewQueue.map((r) => ({ id: r.change.id, waitingWorkingDays: r.wait.days === null ? null : round1(r.wait.days) })),
            unassignedInSprint: v.team.unassigned ? { sprint: v.team.unassigned.sprint, ids: v.team.unassigned.items.map((i) => i.id) } : null,
          },
        };
      },
    },
    {
      name: 'person_get',
      description: `One person's plate in the dossier "${dossier}", from people_list's key or by name or account (such as Pat Example, or github:pat-ex): everything people_list says about them plus their recent activity (status moves, their pull requests merged, reviews they gave) over the last 14 days. ${LOAD}`,
      inputSchema: { type: 'object', properties: { person: { type: 'string', description: "people_list's key, a name, or an account as area:id." } }, required: ['person'], additionalProperties: false },
      async run(input) {
        const wanted = str(input.person)?.toLowerCase();
        const { view: v } = await view();
        const cards = [...v.people, ...v.unmapped];
        const card =
          cards.find((c) => c.who.key.toLowerCase() === wanted) ??
          cards.find((c) => c.who.name.toLowerCase() === wanted) ??
          cards.find((c) => c.who.identities.some((i) => `${i.area}:${i.id}`.toLowerCase() === wanted || i.id.toLowerCase() === wanted));
        if (!card) return { ...note(), error: `Nobody in ${dossier} is ${JSON.stringify(input.person ?? '')}. Use people_list for the names and keys.`, people: cards.map((c) => ({ key: c.who.key, name: c.who.name })) };
        vouchCard(ledger, card);
        return {
          ...note(),
          now: now(),
          rule: LOAD,
          person: {
            ...personBrief(card),
            recentActivity: card.activity.map((a) =>
              a.kind === 'moved' ? { kind: 'moved', at: a.at, id: a.item.id, from: a.from, to: a.to } : a.kind === 'merged' ? { kind: 'their pull request merged', at: a.at, id: a.change.id } : { kind: 'reviewed', at: a.at, id: a.change.id, state: a.state },
            ),
            moreActivity: card.moreActivity,
          },
        };
      },
    },
  ];
}

/** The most items readiness_list returns, and how many by default. */
export const MAX_READINESS = 200;
export const DEFAULT_READINESS = 50;

const CITE = /\[\[([^\]]+)\]\]/g;

/** Every id a verdict names: the item, and any blocker or Done example its rows cite. */
function vouchReadiness(ledger: Ledger, r: Readiness) {
  ledger.add(r.id);
  for (const row of r.rows) for (const m of row.reason.matchAll(CITE)) ledger.add(m[1]);
}

const verdictBrief = (item: WorkItem, r: Readiness) => ({
  id: item.id,
  title: item.title,
  type: item.typeName ?? item.type,
  status: item.status,
  statusCategory: item.statusCategory,
  assignee: assigneeOf(item),
  verdict: r.verdict,
  notReadyBecause: r.why.map((w) => ({ check: w.label, state: w.state, reason: w.reason })),
});

/**
 * The two readiness tools for one dossier (#307): every item's verdict, and
 * one item's five rows, worked out by src/model/readiness.ts from the cache
 * and the dossier's settings, as the Command Center and the item page work
 * them out. No live read: the item page's workflow check is a person's to
 * press.
 */
export function readinessTools(dossier: string, data: AgentData, ledger: Ledger, readDossier: ReadDossier): ToolSpec[] {
  const note = () => ({ dossier, syncedAt: data.syncedAt() });
  const RULE =
    'Verdicts come from the cached records with no model call: ready means all five checks pass (acceptance criteria, description, done state, blockers, scope); thin means something a person could waive is missing; blocked means it cannot be worked on as it is. Only ready items are slated for an agent. Cite every item by its id.';
  const settingsNow = async () => {
    const shown = await readDossier();
    const settings = readReadiness(shown.dossier);
    if (shown.error) settings.notes.unshift(`${shown.error} So no source, repository or readiness setting is known, and every item fails scope.`);
    return settings;
  };
  return [
    {
      name: 'readiness_list',
      description: `Every work item in the dossier "${dossier}" with its readiness verdict for agent work (ready, thin or blocked) and, for each that isn't ready, which of the five checks (${Object.values(CHECK_LABEL).join(', ')}) didn't pass and why, from Toil UI's cache. Done items are left out unless includeDone is true. Also the count of each verdict among open items, and the dossier's readiness settings. ${RULE}`,
      inputSchema: {
        type: 'object',
        properties: {
          verdict: { type: 'string', enum: [...VERDICTS], description: 'Only items with this verdict.' },
          includeDone: { type: 'boolean', description: 'Include items that are already done (they are always blocked). Default false.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_READINESS, description: `Default ${DEFAULT_READINESS}.` },
        },
        additionalProperties: false,
      },
      async run(input) {
        const settings = await settingsNow();
        const items = data.items();
        const byId = new Map(items.map((i) => [i.id, i]));
        const all = items.map((item) => ({ item, r: readiness({ item, settings, byId }) }));
        const open = all.filter((x) => x.item.statusCategory !== 'DONE');
        const limit = Math.min(MAX_READINESS, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : DEFAULT_READINESS));
        const matches = (input.includeDone === true ? all : open).filter((x) => !str(input.verdict) || x.r.verdict === input.verdict);
        const returned = matches.slice(0, limit);
        for (const x of returned) vouchReadiness(ledger, x.r);
        return {
          ...note(),
          rule: RULE,
          openByVerdict: tally(open.map((x) => x.r)),
          settings: {
            sources: settings.sources,
            repositories: settings.repos,
            areas: Object.fromEntries(Object.entries(settings.areas).map(([a, s]) => [a, { acceptanceCriteriaField: s.acceptanceField, acceptanceCriteriaFieldFrom: s.acceptanceFrom, minWords: s.minWords, templateLines: s.templateLines.length }])),
          },
          notes: settings.notes,
          total: matches.length,
          returned: returned.length,
          ...(matches.length > limit ? { more: `${matches.length - limit} more match; narrow with verdict or raise limit (max ${MAX_READINESS}).` } : {}),
          items: returned.map((x) => verdictBrief(x.item, x.r)),
        };
      },
    },
    {
      name: 'readiness_get',
      description: `One work item's readiness in "${dossier}", by its OWI id: its verdict and all five rows (each pass, thin or fail, with its reason and where the answer came from). ${RULE}`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The OWI id.' } }, required: ['id'], additionalProperties: false },
      async run(input) {
        const id = str(input.id);
        const items = data.items();
        const item = id ? items.find((i) => i.id === id) : undefined;
        if (!item) return { ...note(), error: `The cache holds no item ${JSON.stringify(id ?? '')} in ${dossier}. Use readiness_list or owi_query to find ids.` };
        const settings = await settingsNow();
        const r = readiness({ item, settings, byId: new Map(items.map((i) => [i.id, i])) });
        vouchReadiness(ledger, r);
        return { ...note(), rule: RULE, notes: settings.notes, ...verdictBrief(item, r), rows: r.rows.map((w) => ({ check: w.label, state: w.state, reason: w.reason, source: w.source })) };
      },
    },
  ];
}

/** The four work item cache tools for one dossier. */
export function cacheTools(dossier: string, data: AgentData, ledger: Ledger): ToolSpec[] {
  const note = () => ({ dossier, syncedAt: data.syncedAt() });
  return [
    {
      name: 'owi_query',
      description: `Lists the work items Toil UI's cache holds for the dossier "${dossier}", as OWI records (no native payload). Filter by any of the fields; all filters must match. Text matches the id or title, case-insensitively. Returns at most ${MAX_QUERY} items and says when there were more.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Words in the id or title.' },
          type: { type: 'string', enum: ['EPIC', 'STORY', 'TASK', 'BUG', 'INCIDENT', 'OTHER'] },
          statusCategory: { type: 'string', enum: ['TODO', 'IN_PROGRESS', 'DONE'] },
          status: { type: 'string', description: "The source's own status word." },
          assignee: { type: 'string', description: 'Part of the assignee name; "none" for unassigned.' },
          iteration: { type: 'string', description: 'Part of the iteration (sprint) name.' },
          label: { type: 'string' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_QUERY, description: `Default ${DEFAULT_QUERY}.` },
        },
        additionalProperties: false,
      },
      async run(input) {
        const text = str(input.text)?.toLowerCase();
        const assignee = str(input.assignee)?.toLowerCase();
        const iteration = str(input.iteration)?.toLowerCase();
        const limit = Math.min(MAX_QUERY, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : DEFAULT_QUERY));
        const matches = data.items().filter(
          (i) =>
            (!text || i.id.toLowerCase().includes(text) || i.title.toLowerCase().includes(text)) &&
            (!str(input.type) || i.type === input.type) &&
            (!str(input.statusCategory) || i.statusCategory === input.statusCategory) &&
            (!str(input.status) || (i.status ?? '').toLowerCase() === String(input.status).toLowerCase()) &&
            (!assignee || (assignee === 'none' ? !i.assignee : (assigneeOf(i) ?? '').toLowerCase().includes(assignee))) &&
            (!iteration || (i.iteration?.name ?? '').toLowerCase().includes(iteration)) &&
            (!str(input.label) || i.labels.includes(String(input.label))),
        );
        const items = matches.slice(0, limit).map(brief);
        for (const i of items) vouch(ledger, i);
        return { ...note(), total: matches.length, returned: items.length, ...(matches.length > limit ? { more: `${matches.length - limit} more match; narrow the filters or raise limit (max ${MAX_QUERY}).` } : {}), items };
      },
    },
    {
      name: 'owi_get',
      description: `One work item from the cache for "${dossier}", by its OWI id (such as jira:PAY-101), with its body and the pull requests, builds and deployments linked to it.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The OWI id.' } }, required: ['id'], additionalProperties: false },
      async run(input) {
        const id = str(input.id);
        const item = id ? data.items().find((i) => i.id === id) : undefined;
        if (!item) return { ...note(), error: `The cache holds no item ${JSON.stringify(id ?? '')} in ${dossier}. Use owi_query to find ids.` };
        vouch(ledger, item);
        const changes = data
          .changes()
          .filter((c) => c.items.includes(item.id))
          .map((c) => ({ kind: c.kind, id: c.id, area: c.area, state: c.state, outcome: c.outcome, at: c.at }));
        for (const c of changes) ledger.add(c.id);
        return { ...note(), item: { ...brief(item), body: bodyText(item) }, changes };
      },
    },
    {
      name: 'owi_similar',
      description: `Finds likely duplicate work items in the cache for "${dossier}", scored the way toil util owi similar scores them: pass query (some text, such as the title of an item about to be filed) or id (an OWI id, to find what duplicates that item). Returns at most limit matches scoring 0.35 or more, best first, each with score (0 to 1) and why: the shared title and body terms, how alike the titles are by trigram, shared labels, the same parent and a direct link. Lexical: it finds shared words, not shared meaning.`,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Text to rank the items against.' },
          id: { type: 'string', description: 'The OWI id of an item, to rank the others against it.' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_SIMILAR, description: `Default ${DEFAULT_SIMILAR}.` },
        },
        additionalProperties: false,
      },
      async run(input) {
        const query = str(input.query);
        const id = str(input.id);
        if (!query === !id) return { ...note(), error: 'Pass exactly one of query (text to rank against) and id (an OWI id from owi_query).' };
        const limit = Math.min(MAX_SIMILAR, Math.max(1, Number.isInteger(input.limit) ? (input.limit as number) : DEFAULT_SIMILAR));
        const index = new SimilarityIndex(data.items());
        const found = query ? index.query(query, { limit }) : index.item(id!, { limit });
        if (!found) return { ...note(), error: `The cache holds no item ${JSON.stringify(id)} in ${dossier}. Use owi_query to find ids.` };
        if (id) ledger.add(id);
        const matches = found.matches.map((m) => ({ id: m.id, title: m.title, score: m.score, why: { summary: m.why.summary, titleTerms: m.why.titleTerms, bodyTerms: m.why.bodyTerms, trigram: m.why.trigram, labels: m.why.labels, parent: m.why.parent, link: m.why.link } }));
        for (const m of matches) ledger.add(m.id);
        return { ...note(), count: found.count, returned: matches.length, matches };
      },
    },
    {
      name: 'owi_history',
      description: `The status transitions the cache holds for one work item in "${dossier}" (from, to, when, by whom), oldest first.`,
      inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The OWI id.' } }, required: ['id'], additionalProperties: false },
      async run(input) {
        const id = str(input.id);
        const item = id ? data.items().find((i) => i.id === id) : undefined;
        if (!item) return { ...note(), error: `The cache holds no item ${JSON.stringify(id ?? '')} in ${dossier}. Use owi_query to find ids.` };
        ledger.add(item.id);
        return { ...note(), id: item.id, transitions: data.transitions(item.id).map((t) => ({ from: t.from, to: t.to, fromCategory: t.fromCategory, toCategory: t.toCategory, at: t.at, by: t.by })) };
      },
    },
  ];
}

/** True when a registry entry can never change anything, whatever its input. */
export const neverWrites = (c: Pick<ReadCommand, 'writes' | 'writesLocal' | 'writesDependOnInput'>) => !c.writes && !c.writesLocal && !c.writesDependOnInput;

/** The ids an envelope's work items map to, through toil's own OWI mappers. Nothing when it doesn't map. */
export type MapIds = (envelope: Envelope) => string[];

/**
 * `toil mcp`'s read tools for live lookups, one per command in `LIVE_COMMANDS`
 * that the registry has and says never writes. The dossier is fixed to this
 * one; every call is read-only with Toil UI's caller label.
 */
export function liveTools(dossier: string, registry: readonly ReadCommand[], execute: Execute, mapIds: MapIds, ledger: Ledger): ToolSpec[] {
  const tools: ToolSpec[] = [];
  for (const name of LIVE_COMMANDS) {
    const command = registry.find((c) => c.name === name);
    if (!command || !neverWrites(command)) continue;
    const schema = command.inputSchema as { properties?: Record<string, Record<string, unknown>>; required?: string[] };
    const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).filter(([k]) => !hidden(k)));
    const required = (schema.required ?? []).filter((k) => !hidden(k));
    tools.push({
      name: command.tool,
      command: command.name,
      description: `Live, read-only: toil ${command.name} for the dossier "${dossier}", straight from the tracker rather than the cache. ${command.description}`,
      inputSchema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
      async run(input, signal) {
        const clean = Object.fromEntries(Object.entries(input).filter(([k]) => k in properties));
        const envelope = await execute(command.name, { ...clean, ...('dossier' in (schema.properties ?? {}) ? { dossier } : {}) }, { readOnly: true, caller: CALLER, ...(signal ? { signal } : {}) });
        if (envelope.ok) for (const id of mapIds(envelope)) ledger.add(id);
        const text = JSON.stringify(envelope.ok ? { data: envelope.data, warnings: envelope.meta.warnings ?? [] } : { error: envelope.error });
        return text.length > MAX_LIVE_CHARS ? { cut: `The result was ${text.length} characters, cut to ${MAX_LIVE_CHARS}; ask for fewer with limit or a narrower query.`, json: text.slice(0, MAX_LIVE_CHARS) } : JSON.parse(text);
      },
    });
  }
  return tools;
}

/**
 * `proposal_fields`: the input a toil write command takes, from the
 * registry, so a proposal's input is one toil would accept. It reads the
 * registry and runs nothing; the command itself is never callable.
 */
export function proposalTool(registry: readonly ReadCommand[]): ToolSpec {
  const hiddenHere = new Set(['dossier', 'cwd', 'select', 'allowWrite']);
  return {
    name: 'proposal_fields',
    description: "The input fields of one toil write command (such as jira issue update or ado work-item update), for a proposal's input. It reads toil's command list and runs nothing: you can't call a write command, only propose one.",
    inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'The toil command, such as jira issue update.' } }, required: ['command'], additionalProperties: false },
    async run(input) {
      const name = str(input.command);
      const c = name ? registry.find((r) => r.name === name) : undefined;
      if (!c || !c.writes) {
        const like = registry.filter((r) => r.writes && name && r.area === name.split(' ')[0]).map((r) => r.name);
        return { error: `toil has no write command ${JSON.stringify(name ?? '')}.`, ...(like.length ? { writeCommandsInThatArea: like } : {}) };
      }
      const s = c.inputSchema as { properties?: Record<string, { type?: unknown; description?: unknown; enum?: unknown; items?: unknown }>; required?: string[] };
      const fields = Object.fromEntries(Object.entries(s.properties ?? {}).filter(([k]) => !hiddenHere.has(k)).map(([k, v]) => [k, { type: v.type, ...(v.enum ? { enum: v.enum } : {}), ...(v.items ? { items: v.items } : {}), description: v.description }]));
      return { command: c.name, description: c.description, fields, required: (s.required ?? []).filter((k) => !hiddenHere.has(k)) };
    },
  };
}

/** The worklog tool (#308): one day's page, every line with its time and the ids it names. Days are UTC. */
export function worklogTool(dossier: string, data: AgentData, ledger: Ledger, now: () => string = () => new Date().toISOString()): ToolSpec[] {
  const worklog = data.worklog;
  if (!worklog) return [];
  return [
    {
      name: 'worklog_day',
      description: `The worklog page for one UTC day of the dossier "${dossier}": the work items that changed status (from, to, who, when), were added to or dropped from a sprint, or got a new blocker; the pull requests opened, reviewed, merged or declined; the builds and deployments that failed or recovered; the agent runs (questions asked in Toil UI) with their proposals and whether toil's audit log shows a person applied them; and the notes a person added. Each line has its UTC time and cite, the ids to cite it by. gaps says what the cache can't vouch for on that day: quote it when it matters to the answer. Built by code from the cache, facts only.`,
      inputSchema: { type: 'object', properties: { day: { type: 'string', description: 'The UTC day, yyyy-mm-dd. Default: yesterday.' } }, additionalProperties: false },
      async run(input) {
        const today = dayOf(now())!;
        const day = str(input.day) ?? addDays(today, -1);
        if (!isDay(day)) return { error: `${JSON.stringify(day)} isn't a day: give it as yyyy-mm-dd.` };
        if (day > today) return { error: `${day} is after today (${today}, UTC), so it has no page yet.` };
        const page = await worklog(day);
        const lines = [...page.work, ...page.prs, ...page.delivery].map((e) => {
          for (const id of e.cites) ledger.add(id);
          return { time: timeOf(e.at), kind: e.kind, about: e.label, title: e.title, text: e.text, by: e.by, cite: e.cites, ...(e.observed ? { firstSeenBySync: true, previousSync: e.observed.previousSync } : {}) };
        });
        return {
          dossier,
          day,
          timeZone: 'UTC',
          gaps: page.gaps,
          lines,
          agentRuns: page.agents.map((r) => ({
            started: timeOf(r.run.startedAt),
            finished: r.run.finishedAt ? timeOf(r.run.finishedAt) : null,
            by: r.run.by,
            asked: r.run.prompt,
            outcome: OUTCOME_TEXT[r.run.outcome],
            proposals: r.proposals.map((x) => ({ title: x.proposal.title, command: x.proposal.command, status: appliedText(x.applied) })),
          })),
          notes: page.notes.map((n) => ({ time: timeOf(n.at), by: n.by, text: n.text })),
          syncs: page.sources,
        };
      },
    },
  ];
}

/** The stand-up tool (#345): a range of days folded into a stand-up, every line numbered, with the ids it names. */
export function standupTool(dossier: string, data: AgentData, ledger: Ledger, now: () => string = () => new Date().toISOString()): ToolSpec[] {
  const standup = data.standup;
  if (!standup) return [];
  return [
    {
      name: 'standup_report',
      description: `The stand-up report for the dossier "${dossier}" over a range of UTC days, built by code from the worklog: team lines first (the sprint's working days left, scope added to or dropped from a sprint, builds and deployments that broke or recovered), then each person, agents included, with what they got done, what is in progress, what is blocked and what is next in the sprint. Every line has its fact number (F1, F2, ...) and cite, the ids to cite it by. gaps says what the worklog can't vouch for in the range. Default range: since the last working day, through today.`,
      inputSchema: {
        type: 'object',
        properties: { from: { type: 'string', description: 'The first UTC day, yyyy-mm-dd. Default: the last working day before today.' }, to: { type: 'string', description: 'The last UTC day, yyyy-mm-dd. Default: today.' } },
        additionalProperties: false,
      },
      async run(input) {
        const today = dayOf(now())!;
        const range = defaultRange(today);
        const from = str(input.from) ?? range.from;
        const to = str(input.to) ?? range.to;
        if (!isDay(from) || !isDay(to)) return { error: 'Give from and to as days, yyyy-mm-dd.' };
        let report: StandupReport;
        try {
          report = await standup(from, to);
        } catch (e) {
          return { error: e instanceof Error ? e.message : String(e) };
        }
        const line = (l: StandupLine) => {
          for (const id of l.cites) ledger.add(id);
          return { fact: l.fact, when: whenText(report, l), about: l.label, title: l.title, text: l.text, cite: l.cites };
        };
        return {
          dossier,
          from: report.from,
          to: report.to,
          timeZone: 'UTC',
          asOfSync: report.asOf,
          gaps: report.gaps,
          team: report.team.map(line),
          people: report.people.map((p) => ({ name: p.name, kind: p.kind, inDossierPeople: p.mapped, ...Object.fromEntries(BUCKETS.map((b) => [BUCKET_TITLE[b], p.lines[b].map(line)])) })),
        };
      },
    },
  ];
}

/** Wraps every tool so the ledger records the call. */
export function recorded(tools: ToolSpec[], ledger: Ledger): ToolSpec[] {
  return tools.map((t) => ({
    ...t,
    async run(input, signal) {
      ledger.calls.push({ tool: t.name, input });
      try {
        return await t.run(input ?? {}, signal);
      } catch (e) {
        return { error: `${t.name} failed: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  }));
}
