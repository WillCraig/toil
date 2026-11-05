/**
 * The worklog (#308): one page per toil project per day, facts only, folded from
 * what Toil UI already holds. A page is a pure function of its inputs: the
 * day's events, the agent runs and notes recorded that day, and the syncs
 * that say how much of the day the cache can vouch for. No model writes a
 * line of it, and the same inputs always give the same page, byte for byte.
 *
 * Events come two ways:
 *
 * - **From the sources' own history** (`eventsFrom`): status and sprint
 *   changes from each item's history, pull requests opened, reviewed, merged
 *   and declined from their OWI changes, and builds by the time the source gives each run,
 *   with a recovery wherever a passing build follows a failing one.
 * - **Seen by a sync** (`observedEvents`): what the trackers record no time
 *   for, a new blocker, a blocker cleared, a sprint that ended (#419), or a
 *   deployment that failed or came back, found by
 *   comparing one sync's picture with the last. Each says it was first seen
 *   at that sync, and when the sync before it ran, since it happened somewhere
 *   between the two.
 *
 * Days are UTC days, as every other date in Toil UI is, and the page says so.
 * Minutes of a meeting nobody had to attend, taken by the furniture.
 */

import type { Answer } from '../agent.ts';
import type { ChangeRef, Deployment, Person, StatusCategory, WorkItem } from '../toil.ts';
import { sprints } from './sprint.ts';

export type WorklogKind =
  | 'status'
  | 'sprint'
  | 'blocker'
  | 'blocker-cleared'
  | 'sprint-ended'
  | 'pr-opened'
  | 'pr-review'
  | 'pr-merged'
  | 'pr-declined'
  | 'build-failed'
  | 'build-passed'
  | 'build-recovered'
  | 'deploy-failed'
  | 'deploy-recovered';

/** Which part of the page an event goes in. `build-passed` is kept to tell a recovery from a first pass, and shown nowhere. */
export const SECTION_OF: Record<WorklogKind, 'work' | 'prs' | 'delivery' | null> = {
  status: 'work',
  sprint: 'work',
  blocker: 'work',
  'blocker-cleared': 'work',
  'sprint-ended': 'work',
  'pr-opened': 'prs',
  'pr-review': 'prs',
  'pr-merged': 'prs',
  'pr-declined': 'prs',
  'build-failed': 'delivery',
  'build-passed': null,
  'build-recovered': 'delivery',
  'deploy-failed': 'delivery',
  'deploy-recovered': 'delivery',
};

/** Something a line names, with what to call it and where it lives. */
export interface WorklogRef {
  label: string;
  url: string | null;
}

/** One fact, as the cache recorded it. */
export interface WorklogEvent {
  /** Stable across syncs: the same fact always has the same key, so recording it twice is one row. */
  key: string;
  kind: WorklogKind;
  /** When it happened, or for an observed event, when a sync first saw it. ISO 8601, UTC. */
  at: string;
  /** The OWI id of the item or pull request, or the build or deployment id, the line is about. */
  subject: string;
  /** The area it came from (`github`, `jira`, `ado`). */
  source: string;
  label: string;
  title: string;
  url: string | null;
  /** Who did it, when the source says. */
  by: string | null;
  /** The fact in words; may cite other things as `[[id]]`, each in `refs`. */
  text: string;
  /** Every id the line names: its subject, and anything in `text`. */
  cites: string[];
  refs: Record<string, WorklogRef>;
  /** For an event seen by a sync rather than recorded with a time: the sync before the one that saw it. */
  observed: { previousSync: string | null } | null;
  /** The builds of one pull request or pipeline, for telling a recovery from a pass. */
  group?: string;
  /**
   * Whose line it is in a stand-up (#345): who moved the item or changed its
   * sprint, who opened, wrote or reviewed the pull request, the author of the
   * pull request a build built, the assignee of a newly blocked item. Null
   * when the source doesn't say; absent on a fact recorded before #345, which
   * the next sync records again with it.
   */
  who?: Person | null;
  /** For a status change: the category it moved into. */
  toCategory?: StatusCategory;
}

/** A proposal an agent run made, and whether toil's audit log shows a person applied it. */
export interface RunProposal {
  id: string;
  title: string;
  item: string;
  command: string | null;
  input: Record<string, unknown> | null;
}

/** What the audit log says about one proposal. */
export type Applied =
  | { state: 'applied'; at: string; via: string }
  | { state: 'not-applied' }
  | { state: 'no-command' }
  | { state: 'unknown'; why: string };

/**
 * One agent run, as Toil UI recorded it. Today every run is a question asked
 * in the Ask pane (`ask`). Assign-to-agent (#293) records its assignments
 * through the same record with `kind: 'assignment'`. `capped` is a run
 * stopped at a usage cap (#295), refused before it began or stopped partway,
 * and the outcome an assignment's turn or cost cap will use too.
 */
export interface AgentRun {
  id: string;
  kind: 'ask' | 'assignment';
  toilProject: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'finished' | 'failed' | 'stopped' | 'capped';
  /** Who answered: the adapter and model. */
  by: string;
  /** The question, or a starter's label. */
  prompt: string;
  /** The answer as the person saw it, or null when there was none. */
  answer: string | null;
  error: string | null;
  citations: string[];
  unverified: string[];
  proposals: RunProposal[];
}

/** A line a person added to a day. */
export interface WorklogNote {
  id: string;
  at: string;
  by: string;
  text: string;
}

/** One source's sync, as the cache recorded it. */
export interface SyncRun {
  area: string;
  at: string;
  ok: boolean;
  error: string | null;
}

/** Everything one day's page is folded from. */
export interface WorklogInput {
  toilProject: string;
  /** `yyyy-mm-dd`, UTC. */
  day: string;
  events: WorklogEvent[];
  runs: AgentRun[];
  /** By proposal id. */
  applied: Record<string, Applied>;
  notes: WorklogNote[];
  /** Every sync of the toil project the cache still holds. */
  syncs: SyncRun[];
  /** The clock: only which day it is matters to the page, never the time. */
  now: string;
  retentionDays: number;
  /** Where each run's transcript is, relative to the page: `../runs/<id>.md`. */
  transcript?: (runId: string) => string;
}

export interface RunLine {
  run: AgentRun;
  proposals: Array<{ proposal: RunProposal; applied: Applied }>;
  transcript: string;
}

export interface WorklogPage {
  toilProject: string;
  day: string;
  timeZone: 'UTC';
  /** What the cache can't vouch for on this day, said at the top. */
  gaps: string[];
  work: WorklogEvent[];
  prs: WorklogEvent[];
  delivery: WorklogEvent[];
  agents: RunLine[];
  notes: WorklogNote[];
  /** Each source's syncs on this day. */
  sources: Array<{ area: string; syncs: number; failed: number; last: string | null }>;
}

// Days and times -----------------------------------------------------------------

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** The UTC day an instant falls on, or null when it isn't a time. */
export function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/** Whether a string is a real `yyyy-mm-dd` day. */
export function isDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const t = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === value;
}

export function isMonth(value: unknown): value is string {
  return typeof value === 'string' && MONTH_RE.test(value) && isDay(`${value}-01`);
}

export const monthOf = (day: string) => day.slice(0, 7);

/** The day `n` days after `day` (before, for a negative `n`). */
export function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Every day of a month, in order. */
export function daysOfMonth(month: string): string[] {
  const out: string[] = [];
  for (let d = `${month}-01`; monthOf(d) === month; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The month before or after. */
export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const total = y * 12 + (m - 1) + n;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`;
}

// Spelled out here rather than through Intl, whose wording moves with each runtime's ICU data: a page
// must read the same on every machine and every Node release, or "the same page twice" isn't.
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const two = (n: number) => String(n).padStart(2, '0');
const utc = (day: string) => new Date(`${day}T00:00:00Z`);

/** `14:05`, UTC. */
export const timeOf = (iso: string) => {
  const d = new Date(iso);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
};
/** `Tuesday 20 October 2026`. */
export const longDay = (day: string) => {
  const d = utc(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/** `20 Oct 2026`. */
export const shortDay = (day: string) => {
  const d = utc(day);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]!.slice(0, 3)} ${d.getUTCFullYear()}`;
};
/** `October 2026`. */
export const monthName = (month: string) => {
  const d = utc(`${month}-01`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
/** `20 Oct 2026 14:05 UTC`. */
const when = (iso: string) => `${shortDay(dayOf(iso)!)} ${timeOf(iso)} UTC`;

/** What an observed line says about the sync that saw it and the one before, which bound when it happened. */
export function seenText(e: Pick<WorklogEvent, 'at' | 'observed'>): string {
  if (!e.observed) return '';
  const prev = e.observed.previousSync;
  const before = prev ? `; the one before ran ${dayOf(prev) === dayOf(e.at) ? `at ${timeOf(prev)} UTC` : when(prev)}` : '';
  return `first seen by the sync at ${timeOf(e.at)} UTC${before}`;
}

// Events from the sources' own history ------------------------------------------------

const person = (p: { name: string | null; id: string } | null | undefined) => (p ? (p.name ?? p.id) : null);
const keyOf = (item: WorkItem) => item.source.key.replace(/^[^/]+\//, '');
const prLabel = (id: string) => {
  const key = id.slice(id.indexOf(':') + 1);
  return key.replace(/^[^/]*\//, '');
};
const valid = (iso: string | null | undefined): iso is string => typeof iso === 'string' && !Number.isNaN(Date.parse(iso));
const isoOf = (iso: string) => new Date(iso).toISOString();
const names = (list: string[]) => list.join(', ');
const unfinished = (item: WorkItem | undefined) => item !== undefined && item.statusCategory !== 'DONE';
const REVIEW_TEXT = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', COMMENTED: 'commented', DISMISSED: 'approval withdrawn' } as const;

function itemEvent(item: WorkItem, kind: WorklogKind, at: string, text: string, by: Person | null, keyTail: string, refs: Record<string, WorklogRef> = {}): WorklogEvent {
  return {
    key: `${kind}:${item.id}:${isoOf(at)}:${keyTail}`,
    kind,
    at: isoOf(at),
    subject: item.id,
    source: item.source.area,
    label: keyOf(item),
    title: item.title,
    url: item.url,
    by: person(by),
    text,
    cites: [item.id, ...Object.keys(refs)],
    refs: { [item.id]: { label: keyOf(item), url: item.url }, ...refs },
    observed: null,
    who: by,
  };
}

/**
 * What the toil project's history records, with each fact's own time: status and
 * sprint changes, pull requests opened, reviewed, merged and declined, and
 * failing builds, with a recovery wherever a passing build follows a failing
 * one in the same pull request's builds. `known` is what earlier syncs
 * recorded, so a build that failed then and passes now counts as recovered
 * even when the failing run is no longer listed.
 */
export function eventsFrom(input: { items: WorkItem[]; changes: ChangeRef[] }, known: WorklogEvent[] = []): WorklogEvent[] {
  const out: WorklogEvent[] = [];
  for (const item of input.items) {
    for (const t of item.history?.transitions ?? []) {
      if (!valid(t.at)) continue;
      out.push({ ...itemEvent(item, 'status', t.at, `${t.from ?? 'Created'} → ${t.to}`, t.by, `${t.from ?? ''}>${t.to}`), toCategory: t.toCategory });
    }
    for (const c of item.history?.iterations ?? []) {
      if (!valid(c.at)) continue;
      const text = !c.from.length ? `added to ${names(c.to)}` : !c.to.length ? `dropped from ${names(c.from)}` : `moved from ${names(c.from)} to ${names(c.to)}`;
      out.push(itemEvent(item, 'sprint', c.at, text, c.by, `${names(c.from)}>${names(c.to)}`));
    }
  }

  const builds: ChangeRef[] = [];
  for (const ref of input.changes) {
    if (ref.kind === 'build') {
      builds.push(ref);
      continue;
    }
    const c = ref.change;
    if (!c) continue;
    const base = (kind: WorklogKind, at: string, text: string, by: Person | null, tail = '', who: Person | null = by): WorklogEvent => ({
      key: `${kind}:${c.id}:${isoOf(at)}${tail}`,
      kind,
      at: isoOf(at),
      subject: c.id,
      source: c.source.area,
      label: prLabel(c.id),
      title: c.title,
      url: c.url,
      by: person(by),
      text,
      cites: [c.id],
      refs: { [c.id]: { label: prLabel(c.id), url: c.url } },
      observed: null,
      who,
    });
    // A merge or a close is the author's news in a stand-up, though the source doesn't say who pressed the button.
    if (valid(c.created)) out.push(base('pr-opened', c.created, c.state === 'DRAFT' ? 'opened as a draft' : 'opened', c.author));
    for (const r of c.reviews ?? []) if (valid(r.at)) out.push(base('pr-review', r.at, REVIEW_TEXT[r.state], r.by, `:${r.by.id}:${r.state}`));
    if (c.state === 'MERGED' && valid(c.mergedAt)) out.push(base('pr-merged', c.mergedAt, c.branch.target ? `merged into ${c.branch.target}` : 'merged', null, '', c.author));
    if (c.state === 'DECLINED' && valid(c.closedAt ?? null)) out.push(base('pr-declined', c.closedAt!, 'closed without merging', null, '', c.author));
  }

  // Builds: each pull request's (or pipeline's) runs in time order, with what earlier syncs saw.
  const groups = new Map<string, Array<{ at: string; outcome: 'failed' | 'passed'; ref: ChangeRef | null }>>();
  const groupOf = (b: ChangeRef) => `${b.command}|${b.builds ?? b.id}|${b.kind === 'build' && b.command === 'ado run list' ? b.title.replace(/\s+\S+$/, '') : ''}`;
  for (const b of builds) {
    if ((b.outcome !== 'failed' && b.outcome !== 'passed') || !valid(b.at)) continue;
    const g = groupOf(b);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push({ at: isoOf(b.at), outcome: b.outcome, ref: b });
  }
  for (const e of known) {
    if (!e.group || !groups.has(e.group)) continue;
    if (e.kind === 'build-failed') groups.get(e.group)!.push({ at: e.at, outcome: 'failed', ref: null });
    if (e.kind === 'build-passed' || e.kind === 'build-recovered') groups.get(e.group)!.push({ at: e.at, outcome: 'passed', ref: null });
  }
  for (const [group, runs] of groups) {
    runs.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.outcome === b.outcome ? 0 : a.outcome === 'failed' ? -1 : 1));
    let failing = false;
    for (const run of runs) {
      const b = run.ref;
      if (b) {
        const pr = b.builds;
        const kind: WorklogKind = run.outcome === 'failed' ? 'build-failed' : failing ? 'build-recovered' : 'build-passed';
        const text = kind === 'build-failed' ? `failed (${b.state})` : kind === 'build-recovered' ? 'passing again after a failure' : 'passed';
        const refs: Record<string, WorklogRef> = pr ? { [pr]: { label: prLabel(pr), url: input.changes.find((c) => c.id === pr)?.url ?? null } } : {};
        out.push({
          key: `${kind}:${b.id}:${run.at}`,
          kind,
          at: run.at,
          subject: b.id,
          source: b.source,
          label: b.title,
          title: pr ? `for [[${pr}]]` : b.title,
          url: b.url,
          by: null,
          text,
          cites: pr ? [pr] : [],
          refs,
          observed: null,
          group,
          who: pr ? (input.changes.find((c) => c.id === pr)?.change?.author ?? null) : null,
        });
      }
      failing = run.outcome === 'failed';
    }
  }
  return out;
}

// Events seen by a sync ------------------------------------------------------------

/** One sync's picture, as `observedEvents` compares it. */
export interface Snapshot {
  items: WorkItem[];
  deployments: Deployment[];
}

/** The blockers on each item now: `blocked id → blocker ids` for every inward blocks link whose blocker isn't done. */
function blockers(items: WorkItem[]): Map<string, Set<string>> {
  const byId = new Map(items.map((i) => [i.id, i]));
  const out = new Map<string, Set<string>>();
  for (const item of items) {
    if (!unfinished(item)) continue;
    for (const l of item.links) {
      if (l.type !== 'blocks' || l.direction !== 'inward' || !unfinished(byId.get(l.target))) continue;
      if (!out.has(item.id)) out.set(item.id, new Set());
      out.get(item.id)!.add(l.target);
    }
  }
  return out;
}

/**
 * What changed between the last sync's picture and this one's that the
 * trackers record no time for: a blocker that wasn't there before, and a
 * deployment that started failing or came back. With no earlier picture
 * there is nothing to compare, so the first sync sees nothing new.
 */
export function observedEvents(before: Snapshot | null, after: Snapshot, at: string, previousSync: string | null): WorklogEvent[] {
  if (!before) return [];
  const out: WorklogEvent[] = [];
  const stamp = isoOf(at);
  const old = blockers(before.items);
  const byId = new Map(after.items.map((i) => [i.id, i]));
  // A source the last picture didn't have (an area just linked to the toil project) brings its blockers with it, not new ones.
  const watched = new Set(before.items.map((i) => i.source.area));
  for (const [blocked, now] of blockers(after.items)) {
    const item = byId.get(blocked)!;
    if (!watched.has(item.source.area)) continue;
    for (const by of [...now].sort()) {
      if (old.get(blocked)?.has(by)) continue;
      const blocker = byId.get(by)!;
      const e = itemEvent(item, 'blocker', stamp, `blocked by [[${by}]]`, null, by, { [by]: { label: keyOf(blocker), url: blocker.url } });
      out.push({ ...e, key: `blocker:${blocked}:${by}:${stamp}`, observed: { previousSync }, who: item.assignee });
    }
  }
  // A blocker gone since the last picture, on an item still open: the item it blocked can move (#419). A blocker that
  // left the picture counts (a done item can drop out of the query), unless its whole source did: an area unlinked from
  // the toil project, or one that read nothing, clears nothing.
  const now = blockers(after.items);
  const areas = new Set(after.items.map((i) => i.source.area));
  for (const [blocked, was] of old) {
    const item = byId.get(blocked);
    if (!item || !unfinished(item)) continue;
    for (const by of [...was].sort()) {
      if (now.get(blocked)?.has(by)) continue;
      const blocker = byId.get(by) ?? before.items.find((i) => i.id === by);
      if (blocker && !areas.has(blocker.source.area)) continue;
      const refs = blocker ? { [by]: { label: keyOf(blocker), url: blocker.url } } : {};
      const e = itemEvent(item, 'blocker-cleared', stamp, `no longer blocked by [[${by}]]`, null, by, refs);
      out.push({ ...e, key: `blocker-cleared:${blocked}:${by}:${stamp}`, observed: { previousSync }, who: item.assignee });
    }
  }
  // A sprint whose end fell between the last good sync and this one (#419), with its tally as this sync saw it.
  if (previousSync) {
    for (const sprint of sprints(after.items)) {
      const end = sprint.end ? Date.parse(sprint.end) : NaN;
      if (!(end > Date.parse(previousSync) && end <= Date.parse(at))) continue;
      const items = after.items.filter((i) => i.iteration?.name === sprint.name);
      const done = items.filter((i) => i.statusCategory === 'DONE');
      const pts = (list: WorkItem[]) => list.reduce((n, i) => n + (i.estimate?.unit === 'points' ? i.estimate.value : 0), 0);
      const figures = [`${done.length} of ${items.length} ${items.length === 1 ? 'item' : 'items'} done`, ...(pts(items) ? [`${pts(done)} of ${pts(items)} points done`] : [])];
      out.push({
        key: `sprint-ended:${sprint.name}:${isoOf(sprint.end!)}`,
        kind: 'sprint-ended',
        at: isoOf(sprint.end!),
        subject: `sprint:${sprint.name}`,
        source: sprint.sources[0]?.connection ?? '',
        label: sprint.name,
        title: '',
        url: null,
        by: null,
        text: `ended: ${figures.join(', ')}`,
        cites: [],
        refs: {},
        observed: { previousSync },
        who: null,
      });
    }
  }
  const previous = new Map(before.deployments.map((d) => [d.id, d]));
  for (const d of after.deployments) {
    const was = previous.get(d.id);
    if (!was || was.outcome === d.outcome || d.outcome === 'running') continue;
    const kind: WorklogKind | null = d.outcome === 'failed' ? 'deploy-failed' : was.outcome === 'failed' ? 'deploy-recovered' : null;
    if (!kind) continue;
    out.push({
      key: `${kind}:${d.id}:${stamp}`,
      kind,
      at: stamp,
      subject: d.id,
      source: d.source,
      label: d.name,
      title: `in ${d.environment}`,
      url: d.url,
      by: null,
      text: kind === 'deploy-failed' ? `failing (${d.state}), was ${was.state}` : `running again (${d.state}), was ${was.state}`,
      cites: [],
      refs: {},
      observed: { previousSync },
      who: null,
    });
  }
  return out;
}

// The page ---------------------------------------------------------------------------

const ORDER: Record<WorklogKind, number> = {
  status: 0, sprint: 1, 'sprint-ended': 1.5, blocker: 2, 'blocker-cleared': 2.5, 'pr-opened': 3, 'pr-review': 4, 'pr-merged': 5, 'pr-declined': 6, 'build-failed': 7, 'build-passed': 8, 'build-recovered': 9, 'deploy-failed': 10, 'deploy-recovered': 11,
};
const byTime = (a: WorklogEvent, b: WorklogEvent) => (a.at < b.at ? -1 : a.at > b.at ? 1 : ORDER[a.kind] - ORDER[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What the cache can't vouch for on a day, from the syncs it holds. */
export function gapsFor(input: Pick<WorklogInput, 'day' | 'syncs' | 'now' | 'retentionDays'>): string[] {
  const { day, syncs, retentionDays } = input;
  const today = dayOf(input.now)!;
  const out: string[] = [];
  const ok = syncs.filter((s) => s.ok).sort((a, b) => (a.at < b.at ? -1 : 1));
  if (day < addDays(today, -retentionDays)) {
    out.push(`This day is older than the cache's ${plural(retentionDays, 'day')} retention: anything not synced again since has been deleted, so what's left here is what the cache still held when the page was built.`);
  }
  if (!ok.length) {
    out.push("Toil UI hasn't synced this Toil project successfully yet, so this page holds only what was recorded without a sync: notes and agent runs.");
    return out;
  }
  const first = ok[0]!;
  const firstDay = dayOf(first.at)!;
  if (firstDay > day) {
    out.push(`The earliest sync the cache holds is ${when(first.at)}, after this day. Status and sprint changes, pull requests, reviews and builds come from the sources' own histories, so they're here; new blockers and deployment changes are seen only by a sync, so any from this day are missing. So are events on items a sync doesn't read in full: the 50 most recently closed issues of a repository with no board, and the 20 newest closed pull requests.`);
  } else if (firstDay === day) {
    out.push(`The earliest sync the cache holds ran at ${timeOf(first.at)} UTC on this day; blockers and deployment changes before then weren't watched.`);
  }
  const areas = [...new Set(syncs.map((s) => s.area))].sort();
  if (day === today) {
    const last = ok.at(-1)!;
    out.push(dayOf(last.at) === today ? `Today so far: built from the syncs up to ${timeOf(last.at)} UTC. Anything after that shows once the next sync runs.` : `No sync has run today yet; the last was ${when(last.at)}. Today's events show once one runs.`);
  } else if (day > firstDay) {
    const quiet = areas.filter((a) => !ok.some((s) => s.area === a && dayOf(s.at) === day));
    if (quiet.length) {
      const next = ok.find((s) => quiet.includes(s.area) && dayOf(s.at)! > day);
      out.push(`No sync of ${names(quiet)} ran on this day, so blockers and deployment changes from it show on the day of the next one${next ? ` (${when(next.at)})` : ''}.`);
    }
  }
  if (day < today && day >= firstDay) {
    const unfinishedAreas = areas.filter((a) => {
      const last = ok.filter((s) => s.area === a).at(-1);
      return last && dayOf(last.at) === day;
    });
    if (unfinishedAreas.length) out.push(`The last sync of ${names(unfinishedAreas)} ran on this day; anything later in it shows after the next sync.`);
  }
  for (const f of syncs.filter((s) => !s.ok && dayOf(s.at) === day).sort((a, b) => (a.at < b.at ? -1 : 1))) {
    out.push(`The sync of ${f.area} failed at ${timeOf(f.at)} UTC${f.error ? `: ${f.error}` : ''}.`);
  }
  for (const a of areas) {
    const mine = syncs.filter((s) => s.area === a).sort((x, y) => (x.at < y.at ? -1 : 1));
    const latest = mine.at(-1)!;
    const good = mine.filter((s) => s.ok).at(-1);
    if (!latest.ok && day >= dayOf(good?.at ?? latest.at)!) out.push(`The latest sync of ${a} failed (${when(latest.at)}), so its events after ${good ? `its last good sync (${when(good.at)})` : 'it was first tried'} aren't here yet.`);
  }
  return out;
}

/** The page for one day: a pure fold of its input. */
export function buildDay(input: WorklogInput): WorklogPage {
  const mine = input.events.filter((e) => dayOf(e.at) === input.day).sort(byTime);
  const section = (s: 'work' | 'prs' | 'delivery') => mine.filter((e) => SECTION_OF[e.kind] === s);
  const transcript = input.transcript ?? ((id: string) => `../runs/${id}.md`);
  const agents = input.runs
    .filter((r) => dayOf(r.startedAt) === input.day)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.id < b.id ? -1 : 1))
    .map((run) => ({ run, transcript: transcript(run.id), proposals: run.proposals.map((proposal) => ({ proposal, applied: proposal.command ? (input.applied[proposal.id] ?? { state: 'not-applied' as const }) : { state: 'no-command' as const } })) }));
  const notes = input.notes.filter((n) => dayOf(n.at) === input.day).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
  const areas = [...new Set(input.syncs.map((s) => s.area))].sort();
  return {
    toilProject: input.toilProject,
    day: input.day,
    timeZone: 'UTC',
    gaps: gapsFor(input),
    work: section('work'),
    prs: section('prs'),
    delivery: section('delivery'),
    agents,
    notes,
    sources: areas.map((area) => {
      const on = input.syncs.filter((s) => s.area === area && dayOf(s.at) === input.day).sort((a, b) => (a.at < b.at ? -1 : 1));
      return { area, syncs: on.length, failed: on.filter((s) => !s.ok).length, last: on.at(-1)?.at ?? null };
    }),
  };
}

/** How many lines a page has, for the calendar. */
export const lineCount = (p: WorklogPage) => p.work.length + p.prs.length + p.delivery.length + p.agents.length + p.notes.length;

// Markdown ---------------------------------------------------------------------------

/** Markdown's own characters in text from a tracker, escaped so a title can't make a link or a heading. */
export function escapeMd(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
}

/** A ref as a Markdown link, or as code when it has no URL. */
export const link = (ref: WorklogRef) => (ref.url ? `[${escapeMd(ref.label)}](${ref.url.replace(/[()\s]/g, (c) => (c === '(' ? '%28' : c === ')' ? '%29' : '%20'))})` : `\`${ref.label.replace(/`/g, "'")}\``);

/** Text with its `[[id]]` citations as links, from the line's own refs. */
export function cited(text: string, refs: Record<string, WorklogRef>): string {
  return text
    .split(/(\[\[[^\]]+\]\])/)
    .map((part) => {
      const m = /^\[\[([^\]]+)\]\]$/.exec(part);
      if (!m) return escapeMd(part);
      const ref = refs[m[1]!];
      return ref ? link(ref) : `\`${m[1]}\``;
    })
    .join('');
}

/** One event as a Markdown list item. */
export function eventLine(e: WorklogEvent): string {
  const subject = link({ label: e.label, url: e.url });
  const title = e.title ? ` ${cited(e.title, e.refs)}` : '';
  const by = e.by ? `, by ${escapeMd(e.by)}` : '';
  const seen = e.observed ? ` (${seenText(e)})` : '';
  return `- ${timeOf(e.at)} ${subject}${title}: ${cited(e.text, e.refs)}${by}${seen}`;
}

export const OUTCOME_TEXT: Record<AgentRun['outcome'], string> = { running: 'still running', finished: 'finished', failed: 'failed', stopped: 'stopped before it finished', capped: 'stopped at its cap' };

/** What the audit log says about a proposal, in words. */
export function appliedText(a: Applied): string {
  switch (a.state) {
    case 'applied':
      return `applied: toil's audit log has the write at ${when(a.at)} (${a.via})`;
    case 'not-applied':
      return "not applied: toil's audit log has no matching write";
    case 'no-command':
      return 'toil has no command for it, so nothing to apply';
    case 'unknown':
      return `couldn't check toil's audit log: ${a.why}`;
  }
}

export function runLine(r: RunLine): string[] {
  const { run } = r;
  const span = run.finishedAt ? `${timeOf(run.startedAt)}–${timeOf(run.finishedAt)}` : timeOf(run.startedAt);
  const kind = run.kind === 'ask' ? 'Asked' : 'Assigned';
  const cites = run.citations.length ? `, citing ${plural(run.citations.length, 'item')}${run.unverified.length ? ` (${run.unverified.length} unverified)` : ''}` : '';
  const why = run.error ? `: ${escapeMd(run.error)}` : '';
  const lines = [`- ${span} ${kind} ${escapeMd(run.by)}: "${escapeMd(run.prompt)}", ${OUTCOME_TEXT[run.outcome]}${why}${cites} ([transcript](${r.transcript}))`];
  for (const p of r.proposals) lines.push(`  - Proposal: ${escapeMd(p.proposal.title)}${p.proposal.command ? ` (\`toil ${p.proposal.command}\`)` : ''}, ${appliedText(p.applied)}`);
  return lines;
}

/** A page as Markdown: deterministic, so the same page always gives the same text. */
export function markdownOf(page: WorklogPage): string {
  const out = [`# Worklog: ${escapeMd(page.toilProject)}, ${longDay(page.day)}`, '', `Toil project \`${page.toilProject}\`, ${page.day}, times in UTC. Built by Toil UI from its cache: facts only, each linked to its source.`, ''];
  if (page.gaps.length) {
    out.push('## Coverage', '');
    for (const g of page.gaps) out.push(`- ${escapeMd(g)}`);
    out.push('');
  }
  const section = (title: string, events: WorklogEvent[], none: string) => {
    out.push(`## ${title}`, '');
    if (events.length) for (const e of events) out.push(eventLine(e));
    else out.push(none);
    out.push('');
  };
  section('Work items', page.work, 'No status changes, sprint changes or new blockers recorded.');
  section('Pull requests', page.prs, 'No pull requests opened, reviewed, merged or declined.');
  section('Builds and deployments', page.delivery, 'No builds or deployments failed or recovered.');
  out.push('## Agent runs', '');
  if (page.agents.length) for (const r of page.agents) out.push(...runLine(r));
  else out.push('No agent runs.');
  out.push('', '## Notes', '');
  if (page.notes.length) for (const n of page.notes) out.push(`- ${timeOf(n.at)} ${escapeMd(n.by)}: ${escapeMd(n.text)}`);
  else out.push('No notes.');
  out.push('', '## Sources', '');
  if (page.sources.length) {
    for (const s of page.sources) out.push(`- ${s.area}: ${s.syncs ? `${plural(s.syncs, 'sync')} this day${s.failed ? `, ${s.failed} failed` : ''}, the last at ${timeOf(s.last!)} UTC` : 'no sync this day'}`);
  } else {
    out.push('- No syncs recorded.');
  }
  out.push('');
  return out.join('\n');
}

/** A month's pages as one Markdown file, oldest first. */
export function monthMarkdown(toilProject: string, month: string, pages: WorklogPage[]): string {
  const head = [`# Worklog: ${escapeMd(toilProject)}, ${monthName(month)}`, '', `${plural(pages.length, 'day')} with a page, times in UTC.`, ''];
  return [...head, ...pages.map((p) => markdownOf(p).replace(/^# /, '## ').replace(/\n## /g, '\n### '))].join('\n');
}

/** A run's transcript as Markdown: the question, the answer as the person saw it, and its proposals. */
export function transcriptOf(run: AgentRun): string {
  const out = [`# ${run.kind === 'ask' ? 'Question' : 'Assignment'} to ${escapeMd(run.by)}`, '', `Toil project \`${run.toilProject}\`, started ${when(run.startedAt)}${run.finishedAt ? `, ${OUTCOME_TEXT[run.outcome]} ${when(run.finishedAt)}` : `, ${OUTCOME_TEXT[run.outcome]}`}. Written by the agent, not by Toil UI: its citations were checked against what its tools returned.`, '', '## Asked', '', escapeMd(run.prompt), '', '## Answer', ''];
  out.push(run.answer ?? (run.error ? `No answer: ${escapeMd(run.error)}` : 'No answer.'), '');
  if (run.citations.length) out.push('## Citations', '', ...run.citations.map((c) => `- \`${c}\`${run.unverified.includes(c) ? ' (unverified: no tool returned it)' : ''}`), '');
  if (run.proposals.length) out.push('## Proposals', '', ...run.proposals.map((p) => `- ${escapeMd(p.title)}${p.command ? ` (\`toil ${p.command}\`)` : ''}`), '');
  return out.join('\n');
}

/** A finished answer as the run record keeps it. */
export function runFromAnswer(base: Pick<AgentRun, 'id' | 'kind' | 'toilProject' | 'startedAt' | 'by' | 'prompt'>, finishedAt: string, answer: Answer): AgentRun {
  return {
    ...base,
    finishedAt,
    outcome: 'finished',
    answer: answer.parts.map((p) => p.text).join('\n\n'),
    error: null,
    citations: answer.citations,
    unverified: answer.unverified ?? [],
    proposals: answer.proposals.map((p) => ({ id: p.id, title: p.title, item: p.item, command: p.command, input: p.input })),
  };
}
