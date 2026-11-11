/**
 * How a dashboard fills itself: `projects show` first, then, for each area the
 * toil project covers, the toil commands that read its work items, pull requests,
 * builds and deployments, every one read-only and named `toil-ui` in the audit
 * log. What the toil project holds decides what is asked: its Jira project, its
 * Azure DevOps pipelines, its GitHub project board (or, with none named, the
 * repository's issues), the namespace of each environment. Every call is kept
 * with the panel it fed, so the panel can say so, and a call that fails is
 * shown on its panel with toil's own message and fix (principle 4), never
 * dropped.
 *
 * Jira and Azure DevOps are asked for open items and what changed within a
 * window of days (windowFor), not the whole project, and the per-item calls
 * (histories, pull request gets) run through one pool of PER_ITEM_CONCURRENCY
 * across the toil project.
 *
 * Work items and pull requests go through `mapOwi` (src/owi.ts), pull
 * requests as OWI 0.2 changes: each code host's `pr list`, then `pr get
 * --include reviews,checks,commits,files` for every open one and the newest
 * closed ones. Builds and deployments go through src/model/delivery.ts. One
 * loader, one toil project, no spreadsheet.
 */

import { ADO_FEED_FIELDS, feedStart, splitRevisionFeed } from './ado-revisions.ts';
import { adoBuilds, adoDeployments, byEnvironment, changeRef, githubBuild, jenkinsBuilds, openshiftDeployments } from './model/delivery.ts';
import { splitChangelogs } from './jira-changelog.ts';
import { GITHUB_BOARD_KEY, GITHUB_ITEMS } from './model/board.ts';
import { LOOKBACK_DAYS } from './model/flow.ts';
import { readPeople, type PersonEntry } from './model/people.ts';
import { readReadiness, type ReadinessSettings } from './model/readiness.ts';
import { AUTHOR_KINDS, mapOwi, OVERRIDABLE } from './owi.ts';
import { githubRepos, type GithubRepo } from './github-repos.ts';
import { resolveTargets, targetsOf, valuesOf } from './targets.ts';
import type { ToilProjectAnalyze } from '../../src/core/brief/prompt.ts';
import { CALL_OPTIONS, type Call, type Change, type ChangeRef, type Deployment, type Envelope, type Execute, type WorkItem } from './toil.ts';

/**
 * How many days back of its last change a closed Jira or Azure DevOps item is
 * still read: the cache's retention period, but at least LOOKBACK_DAYS so the
 * longest view (six weeks of throughput) stays whole. The cache prunes by when
 * a row was last synced, not by when an item changed, so the window is a
 * choice: a closed item older than it isn't read and leaves every view. The
 * sync passes windowFor(retentionDays); a browser that doesn't says
 * DEFAULT_WINDOW_DAYS, which is the same for the cache's default retention.
 */
export const windowFor = (retentionDays: number) => Math.max(retentionDays, LOOKBACK_DAYS);
export const DEFAULT_WINDOW_DAYS = windowFor(30);

/**
 * The JQL a dashboard sends: the project's open items, and anything updated
 * within the window, so a project's closed history from years ago isn't read
 * only to be pruned.
 */
export const JQL = (project: string, windowDays: number = DEFAULT_WINDOW_DAYS) => `project = ${project} AND (statusCategory != Done OR updated >= -${windowDays}d) ORDER BY Rank ASC`;
/** The areas that read Azure DevOps work items: one, whose connection is Server or Services, both sending the same work item shapes. */
export const ADO_AREAS = ['ado'] as const;
/** The areas that read Jira work items: one, whose connection is Data Center or Cloud, both sending the same issue shapes. */
export const JIRA_AREAS = ['jira'] as const;
/**
 * The WIQL a dashboard sends, bounded the same way as the JQL. WIQL has no
 * status category, so "open" is an item with no closed date (the Agile, Scrum
 * and CMMI processes set `ClosedDate` when an item reaches a closed state).
 * `toil ado work-item search --updated-since` ANDs onto the WHERE and
 * parenthesizes this one, so the two compose.
 */
export const wiqlFor = (windowDays: number = DEFAULT_WINDOW_DAYS) =>
  `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ([Microsoft.VSTS.Common.ClosedDate] = '' OR [System.ChangedDate] >= @Today - ${windowDays}) ORDER BY [System.Id]`;
export const WIQL = wiqlFor();

/**
 * The input with its query's window set to `windowDays`, when the query is
 * the dashboard's own (JQL() or wiqlFor()); any other input comes back as it
 * was. The store asks the cache for the search the sync made, which names the
 * window the sync used, and only the window may differ from what a browser sent.
 */
export function withWindow(input: Record<string, unknown>, windowDays: number): Record<string, unknown> {
  if (typeof input.jql === 'string') {
    const jql = input.jql.replace(/^(project = \S+ AND \(statusCategory != Done OR updated >= -)\d+(d\) ORDER BY Rank ASC)$/, `$1${windowDays}$2`);
    return jql === input.jql ? input : { ...input, jql };
  }
  if (typeof input.wiql === 'string') {
    const wiql = input.wiql.replace(/(\[System\.ChangedDate\] >= @Today - )\d+(\) ORDER BY \[System\.Id\])$/, `$1${windowDays}$2`);
    return wiql === input.wiql ? input : { ...input, wiql };
  }
  return input;
}

/** How many per-item calls (histories, pull request gets) run at once, across all of a toil project's areas. toil retries a 429 itself. */
export const PER_ITEM_CONCURRENCY = 4;

/**
 * A gate that lets `limit` calls through at once and queues the rest, first
 * come first served. The same number of counters is open for every area of a
 * toil project, which is how a queue at an airport stays fair.
 */
export function limiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function slot<T>(fn: () => Promise<T>): Promise<T> {
    // A finishing call hands its place straight to the next in line, so the count never dips for a newcomer to slip into.
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** The context inputs each area's reads are scoped by, in the toil project section's own words. */
export const BITBUCKET_INPUTS = ['project', 'workspace', 'repo'] as const;
export const ADO_PROJECT_INPUTS = ['collection', 'organization', 'project'] as const;
export const ADO_REPO_INPUTS = [...ADO_PROJECT_INPUTS, 'repo'] as const;

/** One place the sync read from, and how it went. `label` is what a screen calls it. */
export interface ReadTarget {
  area: string;
  label: string;
  work: boolean;
  pullRequests: boolean;
}

export type Panel = 'toilProject' | 'work' | 'prs' | 'owners' | 'builds' | 'deployments';

export interface ToilProjectSummary {
  name: string;
  description: string | null;
  /** The areas it covers, with the connection each would use. */
  sources: Array<{ area: string; connection: string | null }>;
  environments: string[];
}

export interface ToilProjectData extends ToilProjectSummary {
  items: WorkItem[];
  /** Pull requests, as OWI 0.2 changes. */
  pullRequests: Change[];
  /** Each GitHub repository's CODEOWNERS, by repository (`owner/repo`), where one was found. */
  codeowners: Record<string, { path: string; text: string }>;
  /** Each place the sync read from (a GitHub repository, a Bitbucket repo, an Azure DevOps project), and whether its work items and pull requests came back. */
  readTargets?: ReadTarget[];
  /** Things the pull request view should say about how it was read (an author kind it couldn't use). */
  prNotes: string[];
  changes: ChangeRef[];
  deployments: Deployment[];
  /** The toil project's `people` (#292): who each person is in every system, agents included. */
  people: PersonEntry[];
  /** How many items one person may have in progress at once, from the toil project; null when it sets none. */
  wipLimit: number | null;
  /** How Analyze briefs it (#494): the toil project's analyze key as written, null for the standard. */
  analyze: ToilProjectAnalyze | null;
  /** Where the toil project came from, for labelling its focus: its file, whose it is, and whether the reader adopted it. */
  origin: { source: string; file: string; adopted: boolean } | null;
  /** What couldn't be read from the toil project's people, in words the People view shows. */
  peopleNotes: string[];
  /** What the readiness gate (#307) reads from the toil project: its sources, repositories and each area's settings. */
  readiness: ReadinessSettings;
  /** Every call, by the panel it fed. */
  calls: Record<Panel, Call[]>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const recs = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' || typeof x === 'number' ? [String(x)] : [])) : []);

/** A command that came back `ok: false`, with toil's message and fix. */
export class CallFailed extends Error {
  constructor(readonly call: Call) {
    super(call.error ?? `${call.command} failed.`);
  }
}

interface ShowArea {
  connection: { value: string; deployment?: string } | null;
  inputs: Record<string, string>;
}

/** `projects show`'s data, as the dashboard reads it. */
function readShow(data: Rec): { summary: ToilProjectSummary; areas: Record<string, ShowArea>; toilProject: Rec } {
  const areas = (isRec(data.areas) ? data.areas : {}) as Record<string, ShowArea>;
  const toilProject = isRec(data.toilProject) ? data.toilProject : {};
  const summary: ToilProjectSummary = {
    name: String(data.name),
    description: typeof toilProject.description === 'string' ? toilProject.description : null,
    sources: Object.entries(areas).map(([area, a]) => ({ area, connection: a.connection?.value ?? null })),
    environments: Object.keys(isRec(toilProject.environments) ? toilProject.environments : {}),
  };
  return { summary, areas, toilProject };
}

/**
 * The OWI keys in a toil project section's `fields` (`estimate`, `estimateLabel`,
 * `iterationDays`, …). The rest of `fields` are `--field` aliases for the
 * area's own commands, which OWI would refuse as names it has no field for.
 */
export function owiFields(fields: unknown): Record<string, string> {
  if (!isRec(fields)) return {};
  return Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => (OVERRIDABLE as readonly string[]).includes(e[0]) && typeof e[1] === 'string'));
}

/**
 * What `jira issue search` returns when it is given no `fields`
 * (`STANDARD_SEARCH_FIELDS` in src/areas/jira/{cloud,server}/client.ts), which
 * a search that names any field no longer adds on its own. ui/test holds this
 * list to both of them, so a field toil starts returning is not lost here.
 */
export const JIRA_STANDARD_FIELDS = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'project', 'created', 'updated', 'labels', 'reporter'];

/**
 * What `mapOwi` reads from a Jira issue (src/core/owi/jira.ts) by a standard
 * field name and a search does not return by itself: the description (the
 * readiness check reads it), how and when it was resolved, the due date, the
 * original estimate (the hours fallback when no points field is registered),
 * and the parent, sub-tasks and links that the Board, the Graph and the
 * blockers are drawn from. The epic link is not here: it comes only from a
 * registered field.
 */
export const JIRA_OWI_FIELDS = ['description', 'resolution', 'resolutiondate', 'duedate', 'timeoriginalestimate', 'parent', 'subtasks', 'issuelinks'];

/** The OWI keys whose value is the name or id of a Jira field (the others are units, labels and day counts). */
const JIRA_FIELD_KEYS = ['estimate', 'iteration', 'team', 'dueDate', 'priority', 'type'] as const;
/** The section's `fields` the readiness check reads from the issue too: the field acceptance criteria are kept in. */
const JIRA_READ_FIELDS = [...JIRA_FIELD_KEYS, 'acceptanceCriteria'] as const;

/** A custom field a Jira connection registers, as `jira issue fields` lists it. */
export interface RegisteredField {
  id: string;
  name: string;
}

/** The registered custom fields in a `jira issue fields` answer; anything that isn't an id and a name is left out. */
export function registeredFields(data: unknown): RegisteredField[] {
  return (Array.isArray(data) ? data : []).flatMap((f) => (isRec(f) && typeof f.id === 'string' && typeof f.name === 'string' ? [{ id: f.id, name: f.name }] : []));
}

/** The registered field an OWI override names, by its id or its name in any case. */
const registeredBy = (registered: readonly RegisteredField[], value: string) => registered.find((f) => f.id === value) ?? registered.find((f) => f.name.toLowerCase() === value.toLowerCase());

/**
 * The `fields` a Jira search is asked for: the standard ones, what `mapOwi`
 * reads, every custom field the connection registers, and the field each of
 * the Toil project's `fields` name (an OWI override, or where acceptance
 * criteria are kept), as the id search resolves it. A name that is neither
 * registered nor one word could not be resolved (search refuses it, and with it
 * the whole read), so it is left out and `mapOwi` says the field is missing.
 */
export function jiraSearchFields(registered: readonly RegisteredField[], section: Record<string, unknown>): string {
  const named = JIRA_READ_FIELDS.flatMap((k) => {
    const v = section[k];
    if (typeof v !== 'string' || v.trim() === '') return [];
    const def = registeredBy(registered, v.trim());
    return def ? [def.id] : /\s/.test(v.trim()) ? [] : [v.trim()];
  });
  return [...new Set([...JIRA_STANDARD_FIELDS, ...JIRA_OWI_FIELDS, ...registered.map((f) => f.id), ...named])].join(',');
}

/**
 * Jira search returns a registered custom field under the name the connection
 * registers it as, but an OWI override (and the readiness check's acceptance
 * criteria) may name it by id, which is what the Fields step writes. Each
 * issue gets every registered field's value copied back under its id, so both
 * spellings find it. The overrides themselves stay as written: the sprint
 * history (`jiraHistory`) matches Jira's own label or the id, never the
 * registered name. A field the search returned no value for is left alone, and
 * a value already under its id is never replaced.
 */
export function withFieldIds(search: Envelope, registered: readonly RegisteredField[]): Envelope {
  const data = search.data;
  if (!search.ok || !registered.length || !isRec(data) || !Array.isArray(data.issues)) return search;
  const issues = data.issues.map((issue) => {
    if (!isRec(issue) || !isRec(issue.fields)) return issue;
    const fields: Rec = { ...issue.fields };
    for (const { id, name } of registered) if (fields[id] === undefined && fields[name] !== undefined) fields[id] = fields[name];
    return { ...issue, fields };
  });
  return { ...search, data: { ...data, issues } } as Envelope;
}

/** How many pull requests that aren't open are still read in full (`pr get --include`): the newest ones, which the flow metrics measure. */
export const CHECKED_CLOSED_PRS = 20;

/**
 * The pull requests read in full: every open one, and the newest closed or
 * merged ones. A repository with years of history would otherwise cost
 * several requests per pull request it ever had, on every sync.
 */
export function checkedPrs<T extends Pick<Change, 'state' | 'closedAt' | 'mergedAt' | 'updated' | 'created'>>(prs: T[]): T[] {
  const when = (p: T) => p.mergedAt ?? p.closedAt ?? p.updated ?? p.created ?? '';
  const open = (p: T) => p.state === 'OPEN' || p.state === 'DRAFT';
  const closed = prs.filter((p) => !open(p)).sort((a, b) => (when(a) < when(b) ? 1 : -1)).slice(0, CHECKED_CLOSED_PRS);
  const keep = new Set([...prs.filter(open), ...closed]);
  return prs.filter((p) => keep.has(p));
}

/** What `pr get --include` reads for each pull request read in full. */
export const PR_INCLUDE = 'reviews,checks,commits,files';

/** Each code host the loader reads pull requests from: its list's state for every pull request, and its get's id field. */
export const PR_HOSTS = [
  { area: 'bitbucket', all: 'ALL', id: 'id' },
  { area: 'ado', all: 'all', id: 'id' },
  { area: 'github', all: 'all', id: 'number' },
] as const;

/** Where GitHub looks for CODEOWNERS, in its own order. */
export const CODEOWNERS_PATHS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

/**
 * The key patterns a toil project's pull requests are read with, from the work
 * items it already holds: each Jira project's `PAY-{n}`, Azure Boards'
 * `AB#{n}` for each Azure DevOps connection, and each GitHub repository's
 * `owner/repo#{n}`, each to the connection the items came from. A host's own
 * `#12` needs none.
 */
export function keyPatternsFor(items: WorkItem[]): string[] {
  const out = new Set<string>();
  for (const i of items) {
    const conn = i.source.connection;
    if (i.source.area.startsWith('jira')) out.add(`${i.source.key.replace(/-\d+$/, '')}-{n}=${conn}`);
    else if (i.source.area.startsWith('ado')) out.add(`AB#{n}=${conn}`);
    else if (i.source.area === 'github') out.add(`${i.source.key.replace(/#\d+$/, '')}#{n}=${conn}`);
  }
  return [...out];
}

/** A toil project section's `authorKinds`, keeping the entries OWI can use and saying which it left out. */
export function authorKindsOf(section: Rec, area: string, notes: string[]): Record<string, string> {
  if (section.authorKinds === undefined) return {};
  if (!isRec(section.authorKinds)) {
    notes.push(`The ${area} section's authorKinds isn't an object of author id to HUMAN, AGENT or BOT, so it was left out.`);
    return {};
  }
  const out: Record<string, string> = {};
  for (const [id, kind] of Object.entries(section.authorKinds)) {
    if (typeof kind === 'string' && (AUTHOR_KINDS as readonly string[]).includes(kind.toUpperCase())) out[id] = kind.toUpperCase();
    else notes.push(`The ${area} section's authorKinds gives ${id} as ${JSON.stringify(kind)}, which isn't HUMAN, AGENT or BOT, so it was left out.`);
  }
  return out;
}

/** How many closed issues of a repository with no board still get their history read: the most recently closed. */
export const CLOSED_ISSUE_HISTORIES = 50;

/**
 * The issues whose timelines are read: every open one, and the most recently
 * closed ones, which are all throughput and cycle time look at. A repository
 * with thousands of closed issues would otherwise send one request each on
 * its first sync. The rest are still listed, with no history.
 */
export function historyNumbers(issues: Rec[]): number[] {
  const numbered = issues.filter((i) => typeof i.number === 'number');
  const when = (i: Rec) => String(i.closed_at ?? i.updated_at ?? '');
  const closed = numbered.filter((i) => i.state === 'closed').sort((a, b) => (when(a) < when(b) ? 1 : -1)).slice(0, CLOSED_ISSUE_HISTORIES);
  const keep = new Set([...numbered.filter((i) => i.state !== 'closed'), ...closed]);
  return numbered.filter((i) => keep.has(i)).map((i) => i.number as number);
}

const connectionOf = (env: Envelope, fallback: string) => (env.ok ? (env.meta.context?.connection?.value ?? fallback) : fallback);

/**
 * The OWI mapper as the loader calls it: the browser's (src/owi.ts), or the
 * API's of the toil Toil UI runs with, whose records may be an older OWI
 * version than this source's types. So its records are read as this
 * version's: OWI only adds. One that returns no `changes` maps no pull
 * requests (OWI 0.1), and the view says so.
 */
export type LoaderMapOwi = (input: unknown, options?: { fields?: Record<string, string>; keyPatterns?: string[]; authorKinds?: Record<string, string> }) => { items: unknown[]; changes?: unknown[] };

/** The most ids one `get-many` call takes. */
const GET_MANY_MAX = 1000;

export interface LoadOptions {
  /** The OWI mapper: the browser's (src/owi.ts) by default; the tests pass the API's to prove they agree. */
  mapOwi?: LoaderMapOwi;
  /** Days of closed Jira and Azure DevOps items to read; the sync passes the cache's retention. */
  windowDays?: number;
  /** The clock the Azure DevOps feed's start date is counted back from; the sync passes its own. */
  now?: () => Date;
}

export async function loadToilProject(execute: Execute, name: string, options: LoadOptions = {}): Promise<ToilProjectData> {
  const calls: Record<Panel, Call[]> = { toilProject: [], work: [], prs: [], owners: [], builds: [], deployments: [] };

  /** One call and how it went, not yet recorded anywhere. */
  const send = async (command: string, input: Rec): Promise<{ env: Envelope | null; call: Call }> => {
    const env = await execute(command, input, CALL_OPTIONS);
    const call: Call = { command, input, ok: env.ok, error: env.ok ? null : `${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}` };
    return { env: env.ok ? env : null, call };
  };

  /** One call, recorded on its panel. A failure is kept on the panel and comes back as null. */
  const run = async (panel: Panel, command: string, input: Rec): Promise<Envelope | null> => {
    const { env, call } = await send(command, input);
    calls[panel].push(call);
    if (!env && panel === 'toilProject') throw new CallFailed(call);
    return env;
  };

  /**
   * One call per input, at most PER_ITEM_CONCURRENCY at a time across the
   * whole toil project. The answers come back, and the calls are recorded on the
   * panel, in the order of the inputs however they finished, so the same
   * toil project loads the same way twice.
   */
  const slot = limiter(PER_ITEM_CONCURRENCY);
  const runEach = async (panel: Panel, command: string, inputs: Rec[]): Promise<Array<Envelope | null>> => {
    const sent = await Promise.all(inputs.map((input) => slot(() => send(command, input))));
    calls[panel].push(...sent.map((s) => s.call));
    return sent.map((s) => s.env);
  };

  const show = await run('toilProject', 'projects show', { toilProject: name });
  const { summary, areas, toilProject } = readShow(show!.data as Rec);
  const section = (area: string) => (isRec(toilProject[area]) ? (toilProject[area] as Rec) : {});
  const repos = recs(toilProject.repos).map((r) => String(r.name));
  const base = { toilProject: name };

  // Work items, mapped to OWI ---------------------------------------------------------
  // Each area is mapped on its own, with its own section's OWI fields.
  const boardOf = new Map<string, { project: number; owner?: string }>();
  const work: Record<(typeof JIRA_AREAS)[number] | (typeof ADO_AREAS)[number] | 'github', unknown[]> = { jira: [], ado: [], github: [] };
  const tasks: Array<Promise<void>> = [];
  /** The custom fields each Jira connection registers, read once before its searches, so they ask for the fields the Toil project names. */
  const registered: Record<string, RegisteredField[]> = {};
  /** Each place a read went to (a GitHub repository, a Bitbucket repo, an Azure DevOps project) and whether its work items and pull requests came back, for the Pull requests view to say. */
  const readState = new Map<string, ReadTarget>();
  const track = (area: string, label: string): ReadTarget => {
    const key = label ? `${area} ${label}` : area;
    if (!readState.has(key)) readState.set(key, { area, label: area === 'github' ? label : key, work: true, pullRequests: true });
    return readState.get(key)!;
  };
  const markUnread = (target: ReadTarget, what: 'work' | 'prs') => {
    if (what === 'work') target.work = false;
    else target.pullRequests = false;
  };
  // A repo name that a section's per-repo values leave half-named can't be read; it is said so, work items and pull requests both, rather than dropped.
  // Only what that name's reads would have fetched is said: pull requests for Bitbucket (no work items are read from it) and for Azure DevOps by repo, its work items by project.
  if (areas.bitbucket) for (const name of resolveTargets(section('bitbucket'), BITBUCKET_INPUTS).skipped) markUnread(track('bitbucket', name), 'prs');
  if (areas.ado) {
    for (const name of resolveTargets(section('ado'), ADO_REPO_INPUTS).skipped) markUnread(track('ado', name), 'prs');
    for (const name of resolveTargets(section('ado'), ADO_PROJECT_INPUTS).skipped) markUnread(track('ado', name), 'work');
  }
  // A Jira project is named in the JQL, so a per-repo `project` is one search per distinct project. Plain, it is the project `projects show` resolved.
  for (const jira of JIRA_AREAS.filter((a) => areas[a])) {
    const projects = [...new Set([areas[jira]!.inputs.project, ...valuesOf(section(jira), 'project')].filter((p): p is string => Boolean(p)))];
    // `issue fields` lists what the connection holds and asks Jira nothing.
    const listed = projects.length ? await run('work', `${jira} issue fields`, { ...base }) : null;
    registered[jira] = registeredFields(listed?.data);
    // A list that failed is unknown, not empty: the search is then asked for no `fields`, as before #573, and returns what it returns by itself.
    const fields = listed ? jiraSearchFields(registered[jira], isRec(section(jira).fields) ? (section(jira).fields as Rec) : {}) : undefined;
    for (const project of projects) {
      tasks.push((async () => {
        const state = track(jira, projects.length > 1 ? project : '');
        // The search brings each issue's history with it (toil's --changelog); only an issue whose changelog came back short is read with a call of its own.
        const asked = await run('work', `${jira} issue search`, { ...base, jql: JQL(project, options.windowDays), changelog: true, ...(fields === undefined ? {} : { fields }) });
        if (!asked) return markUnread(state, 'work');
        const { search, histories: inline, incomplete } = splitChangelogs(asked, `${jira} issue history`);
        work[jira].push(withFieldIds(search, registered[jira] ?? []));
        for (const { key, history } of inline) work[jira].push({ key, history });
        const histories = await runEach('work', `${jira} issue history`, incomplete.map((key) => ({ ...base, key })));
        histories.forEach((history, n) => {
          if (history) work[jira].push({ key: incomplete[n]!, history });
        });
      })());
    }
  }
  // Azure DevOps Server and Services send the same work item shapes under the same command names. Work items belong to a project, so a per-repo `project` is one read per distinct project.
  for (const ado of ADO_AREAS.filter((a) => areas[a])) {
    for (const target of targetsOf(section(ado), ADO_PROJECT_INPUTS)) {
      tasks.push((async () => {
        const scope = target.inputs;
        const state = track(ado, target.label);
        const iterations = await run('work', `${ado} work-item iterations`, { ...base, ...scope });
        if (iterations) work[ado].push(iterations);
        const search = await run('work', `${ado} work-item search`, { ...base, ...scope, wiql: wiqlFor(options.windowDays) });
        if (!search) markUnread(state, 'work');
        const ids = search ? recs((search.data as Rec).workItems).map((w) => Number(w.id)) : [];
        if (!ids.length) return;
        // get-many takes at most 1000 ids a call, so a larger window is asked for in slices, in order.
        const items: Rec[] = [];
        for (let from = 0; from < ids.length; from += GET_MANY_MAX) {
          const batch = await run('work', `${ado} work-item get-many`, { ...base, ...scope, id: ids.slice(from, from + GET_MANY_MAX) });
          if (!batch) {
            markUnread(state, 'work');
            continue;
          }
          work[ado].push(batch);
          items.push(...recs((batch.data as Rec).value));
        }
        // One feed of every revision since the window opened stands in for each item's history call; an item whose revisions it doesn't hold whole is read with work-item history (src/ado-revisions.ts).
        // A toil project that maps its own iteration field can't use the feed (it asks for System.IterationPath only), so the call is skipped and every item is read with work-item history.
        const iteration = owiFields(section(ado).fields).iteration;
        const feed = items.length && iteration === undefined ? await run('work', `${ado} work-item feed`, { ...base, ...scope, updatedSince: feedStart((options.now ?? (() => new Date()))(), options.windowDays ?? DEFAULT_WINDOW_DAYS), fields: ADO_FEED_FIELDS }) : null;
        const { histories: inline, incomplete } = splitRevisionFeed(feed, items, `${ado} work-item history`, iteration);
        work[ado].push(...inline);
        // Items get-many didn't return have no rev to check the feed against, so they are read one by one as before.
        const known = new Set(items.map((i) => Number(i.id)));
        const histories = await runEach('work', `${ado} work-item history`, [...incomplete, ...ids.filter((id) => !known.has(id))].map((id) => ({ ...base, ...scope, id })));
        for (const revisions of histories) if (revisions) work[ado].push(revisions);
      })());
    }
  }
  // Every GitHub repository the toil project covers is read with its owner and repo passed explicitly (src/github-repos.ts). When none can be worked out the call goes as toil resolves it, and its failure shows on the panel.
  const repoList = areas.github ? githubRepos(toilProject, areas.github.inputs) : [];
  const targets: Array<GithubRepo | null> = areas.github ? (repoList.length ? repoList : [null]) : [];
  const scopeOf = (r: GithubRepo | null): Rec => (r ? { owner: r.owner, repo: r.repo } : {});
  const keyOf = (r: GithubRepo | null, number: number) => (r ? `${r.slug}#${number}` : String(number));
  for (const r of repoList) track('github', r.slug);
  const failed = (r: GithubRepo | null, what: 'issues' | 'prs') => {
    if (r) markUnread(readState.get(`github ${r.slug}`)!, what === 'issues' ? 'work' : 'prs');
  };
  if (areas.github) {
    tasks.push((async () => {
      const readHistories = async (r: GithubRepo | null, wanted: number[]) => {
        const histories = await runEach('work', 'github issue history', wanted.map((number) => ({ ...base, ...scopeOf(r), number })));
        histories.forEach((events, n) => {
          if (events) work.github.push({ key: keyOf(r, wanted[n]!), history: events });
        });
      };
      const projects = strings(section('github').projects);
      // No board named: each repository's own issues are the tracker, open and closed.
      if (!projects.length) {
        await Promise.all(targets.map(async (r) => {
          // Through the toil project's pool, so a toil project of forty repositories doesn't send forty lists at once.
          const issues = await slot(() => run('work', 'github issue list', { ...base, ...scopeOf(r), state: 'all' }));
          if (!issues) return failed(r, 'issues');
          work.github.push(issues);
          // The closed-issue history cap (CLOSED_ISSUE_HISTORIES) applies to each repository on its own, so a second repository doesn't starve the first of histories.
          await readHistories(r, historyNumbers(recs(issues.data)));
        }));
        return;
      }
      // The project numbers are the section's, so each board is read once, under the section's plain owner (the first repository's when owner is per repo); each repository then takes the issues of it that live there.
      const sectionOwner = section('github').owner;
      const owner = typeof sectionOwner === 'string' && sectionOwner ? sectionOwner : targets[0]?.owner;
      const board: Rec[] = [];
      // Which board each item id came from, so a move on the Board can name the project (GITHUB_BOARD_KEY).
      boardOf.clear();
      for (const project of projects) {
        const answer = await run('work', 'github project items', { ...base, ...(owner ? { owner } : {}), project: Number(project) });
        if (!answer) continue;
        work.github.push(answer);
        board.push(...recs(answer.data));
        for (const b of recs(answer.data)) if (typeof b.id === 'string') boardOf.set(b.id, { project: Number(project), ...(owner ? { owner } : {}) });
      }
      for (const r of targets) {
        const slug = (r ? r.slug : `${areas.github!.inputs.owner}/${areas.github!.inputs.repo}`).toLowerCase();
        const numbers = new Set<number>();
        for (const item of board) {
          const content = isRec(item.content) ? item.content : {};
          if (isRec(content.repository) && String(content.repository.nameWithOwner).toLowerCase() === slug && typeof content.number === 'number') numbers.add(content.number);
        }
        if (!numbers.size) continue;
        const wanted = [...numbers];
        const issues = await run('work', 'github issue get', { ...base, ...scopeOf(r), number: wanted, subIssues: true });
        if (issues) work.github.push(issues);
        else failed(r, 'issues');
        await readHistories(r, wanted);
      }
    })());
  }
  await Promise.all(tasks);
  const mapper = options.mapOwi ?? mapOwi;
  const items = Object.entries(work).flatMap(([area, docs]) => (docs.length ? (mapper(docs, { fields: owiFields(section(area).fields) }).items as WorkItem[]) : []));

  // An issue on a board remembers which one, so a move on the Board can say which project's Status to set.
  for (const item of items) {
    const entry = item.native[GITHUB_ITEMS] as { id?: unknown } | undefined;
    const on = typeof entry?.id === 'string' ? boardOf.get(entry.id) : undefined;
    if (on) item.native[GITHUB_BOARD_KEY] = on;
  }

  // Pull requests, as OWI changes, then their builds and deployments ------------------
  const changes: ChangeRef[] = [];
  const deployments: Deployment[] = [];
  const environments = isRec(toilProject.environments) ? (toilProject.environments as Record<string, Rec>) : {};
  const namespaces = Object.entries(environments).flatMap(([env, e]) => (isRec(e.openshift) && typeof e.openshift.namespace === 'string' ? [[env, e.openshift.namespace] as const] : []));
  const byId = new Map(items.map((i) => [i.id, i]));
  const keyPatterns = keyPatternsFor(items);
  const prNotes: string[] = [];
  const pullRequests: Change[] = [];
  const codeowners: ToilProjectData['codeowners'] = {};

  /**
   * One host's pull requests: the list, then a get with everything a list
   * lacks for each one read in full, mapped together so a pull request in
   * both is one change.
   */
  const readPrs = async (host: (typeof PR_HOSTS)[number], scope: Rec = {}): Promise<{ prs: Change[]; gets: Map<string, Envelope>; read: boolean }> => {
    const gets = new Map<string, Envelope>();
    const list = await run('prs', `${host.area} pr list`, { ...base, ...scope, state: host.all });
    if (!list) return { prs: [], gets, read: false };
    const authorKinds = authorKindsOf(section(host.area), host.area, prNotes);
    const first = mapper([list], { keyPatterns, authorKinds });
    if (!first.changes) {
      prNotes.push('The toil Toil UI runs with maps no pull requests (it reads OWI 0.1), so none are shown. Upgrade toil to one that maps OWI 0.2 changes.');
      return { prs: [], gets, read: true };
    }
    const listed = first.changes as Change[];
    const docs: Envelope[] = [list];
    const checked = checkedPrs(listed);
    const got = await runEach('prs', `${host.area} pr get`, checked.map((pr) => ({ ...base, ...scope, [host.id]: Number(pr.id.slice(pr.id.lastIndexOf('#') + 1)), include: PR_INCLUDE })));
    got.forEach((envelope, n) => {
      if (envelope) {
        docs.push(envelope);
        gets.set(checked[n]!.id, envelope);
      }
    });
    const prs = (mapper(docs, { keyPatterns, authorKinds }).changes ?? []) as Change[];
    pullRequests.push(...prs);
    return { prs, gets, read: true };
  };
  const refs = (prs: Change[]) => prs.map((c) => changeRef(c, byId));
  const onOpenShift = async (prs: ChangeRef[]) => {
    const out: Deployment[] = [];
    for (const [env, namespace] of namespaces) {
      const answer = await run('deployments', 'openshift deployment list', { ...base, env, namespace });
      if (answer) out.push(...openshiftDeployments(answer.data, env, repos, prs));
    }
    return out;
  };

  if (areas.bitbucket) {
    const prs: ChangeRef[] = [];
    for (const t of targetsOf(section('bitbucket'), BITBUCKET_INPUTS)) {
      const state = track('bitbucket', t.label);
      const read = await readPrs(PR_HOSTS[0], t.inputs);
      if (!read.read) markUnread(state, 'prs');
      prs.push(...refs(read.prs));
    }
    changes.push(...prs);
    for (const job of strings(section('jenkins').jobs)) {
      for (const pr of prs) {
        const id = pr.id.slice(pr.id.lastIndexOf('#') + 1);
        const runs = await run('builds', 'jenkins pipeline runs', { ...base, name: `${job}/PR-${id}`, limit: 5 });
        if (runs) changes.push(...jenkinsBuilds(runs.data, connectionOf(runs, 'jenkins'), `${job}/PR-${id}`, pr));
      }
    }
  }
  // Azure DevOps Services has no pipeline commands yet, and reads its pull requests only when the toil project names a repository (Server also reads the remote).
  const onServices = areas.ado?.connection?.deployment === 'cloud';
  const adoRepo = areas.ado?.inputs.repo || valuesOf(section('ado'), 'repo').length > 0;
  if (areas.ado && !(onServices && !adoRepo)) {
    const prs: ChangeRef[] = [];
    for (const t of targetsOf(section('ado'), ADO_REPO_INPUTS)) {
      const state = track('ado', t.label);
      const read = await readPrs(PR_HOSTS[1], t.inputs);
      if (!read.read) markUnread(state, 'prs');
      prs.push(...refs(read.prs));
    }
    changes.push(...prs);
    const connection = prs[0]?.change?.source.connection ?? areas.ado.connection?.value ?? 'ado';
    // A pipeline lives in one project, so each is tried in the toil project's projects in turn and the first to answer is kept; a failure is recorded only when no project has it (the last one's).
    const projects = targetsOf(section('ado'), ADO_PROJECT_INPUTS);
    const firstAnswer = async (panel: Panel, name: string): Promise<Envelope | null> => {
      let last: Call | null = null;
      for (const t of projects) {
        const { env, call } = await send('ado run list', { ...base, ...t.inputs, name, top: 20 });
        if (env) {
          calls[panel].push(call);
          return env;
        }
        last = call;
      }
      if (last) calls[panel].push(last);
      return null;
    };
    for (const pipeline of onServices ? [] : strings(section('ado').builds)) {
      const runs = await firstAnswer('builds', pipeline);
      if (runs) changes.push(...adoBuilds(runs.data, connectionOf(runs, connection), prs));
    }
    for (const pipeline of onServices ? [] : strings(section('ado').deployments)) {
      const runs = await firstAnswer('deployments', pipeline);
      if (runs) deployments.push(...adoDeployments(runs.data, connectionOf(runs, connection), prs));
    }
  }
  if (areas.github) {
    for (const r of targets) {
      const { prs, gets, read } = await readPrs(PR_HOSTS[2], scopeOf(r));
      if (!read) failed(r, 'prs');
      const github = refs(prs);
      changes.push(...github);
      for (const pr of github) {
        const got = gets.get(pr.id);
        const checks = got && isRec(got.data) && isRec(got.data.included) ? got.data.included.checks : undefined;
        const build = Array.isArray(checks) ? githubBuild(checks, pr.change!.source.connection, pr) : null;
        if (build) changes.push(build);
      }
      // CODEOWNERS, for suggesting reviewers, only when an open pull request has none to ask.
      if (prs.some((c) => (c.state === 'OPEN' || c.state === 'DRAFT') && !c.reviewers.length)) {
        const repo = r ? r.slug : `${areas.github.inputs.owner}/${areas.github.inputs.repo}`;
        for (const path of CODEOWNERS_PATHS) {
          const answer = await run('owners', 'github repo file', { ...base, ...scopeOf(r), path });
          const text = answer && isRec(answer.data) && typeof answer.data.text === 'string' ? answer.data.text : null;
          if (text !== null) {
            codeowners[repo] = { path, text };
            break;
          }
        }
      }
    }
    // A head's check runs came with its get: one build per pull request read in full, so the gets fed the builds too.
    calls.builds.push(...calls.prs.filter((c) => c.command === 'github pr get'));
  }

  // OpenShift once per toil project, after every code host's pull requests are in, so a
  // toil project with two code hosts reads each namespace once (#229 review).
  if (namespaces.length) deployments.push(...(await onOpenShift(changes.filter((c) => c.kind === 'pull-request'))));

  const team = readPeople(toilProject);
  const analyze = isRec(toilProject.analyze) ? (toilProject.analyze as ToilProjectAnalyze) : null;
  const shown = show!.data as Rec;
  const origin = typeof shown.source === 'string' && typeof shown.file === 'string' ? { source: shown.source, file: shown.file, adopted: shown.adopted === true } : null;
  return { ...summary, items, pullRequests, codeowners, prNotes: [...new Set(prNotes)], readTargets: [...readState.values()], changes, deployments: deployments.sort(byEnvironment), people: team.people, wipLimit: team.wipLimit, analyze, origin, peopleNotes: team.notes, readiness: readReadiness(toilProject), calls };
}

/** A Toil project put away with `toil projects archive` (#561): all the list needs of it. */
export interface ArchivedToilProject {
  name: string;
  description: string | null;
}

/** `projects list`, and `projects show` for each, so the list can say what each one covers. */
export async function loadToilProjects(execute: Execute): Promise<{ toilProjects: ToilProjectSummary[]; /** The archived ones; null when they could not be read, which is not none. */ archived: ArchivedToilProject[] | null; calls: Call[] }> {
  const calls: Call[] = [];
  const call = async (command: string, input: Rec) => {
    const env = await execute(command, input, CALL_OPTIONS);
    const c: Call = { command, input, ok: env.ok, error: env.ok ? null : `${env.error.message}${env.error.fix ? ` ${env.error.fix}` : ''}` };
    calls.push(c);
    if (!env.ok) throw new CallFailed(c);
    return env.data as Rec;
  };
  const list = await call('projects list', {});
  const names = recs(list.toilProjects).filter((d) => d.shadowedBy === null || d.shadowedBy === undefined).map((d) => String(d.name));
  const toilProjects: ToilProjectSummary[] = [];
  for (const name of names) {
    toilProjects.push(readShow(await call('projects show', { toilProject: name })).summary);
  }
  // An older toil has no --archived and refuses the field. Then the archived are unknown, and the page offers nothing it can't back.
  let archived: ArchivedToilProject[] | null = null;
  try {
    const gone = await call('projects list', { archived: true });
    archived = recs(gone.toilProjects).filter((d) => d.shadowedBy === null || d.shadowedBy === undefined).map((d) => ({ name: String(d.name), description: typeof d.description === 'string' ? d.description : null }));
  } catch (e) {
    if (!(e instanceof CallFailed)) throw e;
    // Left out of Sources: the refusal is a toil too old for the flag, not something the person's page is about.
    calls.pop();
  }
  return { toilProjects, archived, calls };
}
