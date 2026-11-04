/**
 * Sprint health, worked out from OWI items alone: what was planned, what was
 * added after the sprint started, what came over from the last one, what is
 * done, and what is at risk and why. Pure functions of the items, the changes
 * and a clock, so the views and the scripted agent agree with the tests.
 *
 * Every finding says what it rests on (principle 4): an iteration change from
 * the item's history, or, where the source keeps no history of it (a GitHub
 * Projects item), the field it came from instead. The sprint review will still
 * ask for it as a slide.
 */

import type { ChangeRef, WorkItem } from '../toil.ts';

const DAY = 86_400_000;

export interface SourceSprint {
  connection: string;
  id: string | null;
  name: string;
  path: string | null;
  start: string | null;
  end: string | null;
}

/** One sprint across sources, matched by name: each tracker keeps its own copy and dates. */
export interface Sprint {
  name: string;
  start: string | null;
  end: string | null;
  sources: SourceSprint[];
}

const connectionOf = (id: string) => id.slice(0, id.indexOf(':'));

export function sprints(items: WorkItem[]): Sprint[] {
  const byName = new Map<string, Sprint>();
  for (const item of items) {
    const it = item.iteration;
    if (!it || !(it.start && it.end)) continue;
    const sprint = byName.get(it.name) ?? { name: it.name, start: null, end: null, sources: [] };
    const connection = connectionOf(item.id);
    if (!sprint.sources.some((s) => s.connection === connection)) {
      sprint.sources.push({ connection, id: it.id, name: it.name, path: it.path, start: it.start, end: it.end });
      if (!sprint.start || it.start < sprint.start) sprint.start = it.start;
      if (!sprint.end || it.end > sprint.end) sprint.end = it.end;
    }
    byName.set(it.name, sprint);
  }
  return [...byName.values()].sort((a, b) => (a.start! < b.start! ? -1 : 1));
}

/** The sprint running at `now`, else the latest that started before it. */
export function currentSprint(items: WorkItem[], now: string): Sprint | null {
  const all = sprints(items);
  return all.find((s) => s.start! <= now && now < s.end!) ?? all.filter((s) => s.start! <= now).at(-1) ?? null;
}

export const inSprint = (item: WorkItem, sprint: Sprint) => item.iteration?.name === sprint.name;

export interface Entry {
  kind: 'planned' | 'added' | 'carried';
  /** When it entered the sprint, if anything recorded it. */
  at: string | null;
  /** The sprint it came from, when carried over. */
  from: string | null;
  /** What the finding rests on, in the record's own terms. */
  evidence: string;
}

const GITHUB_PROJECT_ITEM = 'github project items';

/**
 * How an item came to be in its current sprint. An iteration change whose
 * `from` names another sprint (not just a parent area path, as Azure DevOps
 * moves from `Payments` to `Payments\Sprint 42`) is a carry-over; one after the
 * sprint started is scope added; anything else was planned.
 */
export function entry(item: WorkItem): Entry {
  const it = item.iteration;
  if (!it) return { kind: 'planned', at: null, from: null, evidence: 'no iteration' };
  const here = (name: string) => name === it.name || (it.path !== null && name === it.path);
  const move = (item.history?.iterations ?? []).filter((c) => c.to.some(here) && !c.from.some(here)).at(-1);
  if (move) {
    const other = move.from.find((name) => !(it.path && it.path.startsWith(`${name}\\`)));
    if (other) return { kind: 'carried', at: move.at, from: other, evidence: 'history.iterations' };
    const added = it.start !== null && move.at > it.start;
    return { kind: added ? 'added' : 'planned', at: move.at, from: null, evidence: 'history.iterations' };
  }
  // GitHub Projects keeps no iteration history, but the board item records when it was added.
  const boardItem = item.native[GITHUB_PROJECT_ITEM] as { createdAt?: string } | undefined;
  if (boardItem?.createdAt) {
    const at = new Date(boardItem.createdAt).toISOString();
    const added = it.start !== null && at > it.start;
    return { kind: added ? 'added' : 'planned', at, from: null, evidence: `${GITHUB_PROJECT_ITEM}: createdAt` };
  }
  return { kind: 'planned', at: null, from: null, evidence: item.history ? 'history.iterations' : 'no history synced' };
}

export type Reason =
  | { code: 'blocked'; by: string }
  | { code: 'carried'; from: string }
  | { code: 'failing-build'; change: string }
  | { code: 'unestimated' };

export interface Risk {
  id: string;
  reasons: Reason[];
}

export interface Tally {
  count: number;
  points: number;
}

export interface Health {
  sprint: Sprint;
  items: WorkItem[];
  entries: Map<string, Entry>;
  /** Working days (Monday to Friday, UTC) gone and in total. */
  days: { gone: number; total: number };
  planned: Tally;
  added: Tally;
  carried: Tally;
  done: Tally;
  remaining: Tally;
  /** Items estimated in another unit, left out of every points total and listed instead. */
  otherUnits: string[];
  unestimated: string[];
  risks: Risk[];
}

const isDone = (item: WorkItem) => item.statusCategory === 'DONE';
const points = (item: WorkItem) => (item.estimate?.unit === 'points' ? item.estimate.value : 0);
const tally = (items: WorkItem[]): Tally => ({ count: items.length, points: items.reduce((n, i) => n + points(i), 0) });

/** Working days (Monday to Friday, UTC) of a sprint gone at `now`, and in total: what "day 7 of 10" reads. */
export function sprintDays(start: string, end: string, now: string): { gone: number; total: number } {
  const from = Date.parse(start);
  const to = Date.parse(end);
  return { gone: weekdays(from, Math.min(Date.parse(now), to)), total: weekdays(from, to) };
}

/** Working days left in a sprint: the days not yet gone, so today, which has started, is not one of them. The Toil projects cards and the Summary tab both say this number. */
export const daysLeft = (days: { gone: number; total: number }): number => Math.max(0, days.total - days.gone);

function weekdays(from: number, to: number): number {
  let n = 0;
  for (let t = Math.floor(from / DAY) * DAY; t < to; t += DAY) {
    const d = new Date(t).getUTCDay();
    if (d !== 0 && d !== 6) n++;
  }
  return n;
}

/** The newest build for an item, by when it ran. */
export function latestBuild(id: string, changes: ChangeRef[]): ChangeRef | null {
  return changes.filter((c) => c.kind === 'build' && c.items.includes(id)).sort((a, b) => (a.at < b.at ? 1 : -1))[0] ?? null;
}

/** Work that needs an estimate: not done, not a container (epic, feature), and not a child of an estimated item. */
export function needsEstimate(item: WorkItem, byId: Map<string, WorkItem>): boolean {
  if (item.estimate || isDone(item) || item.type === 'EPIC' || item.type === 'OTHER') return false;
  const parent = item.parent ? byId.get(item.parent) : undefined;
  return !parent?.estimate;
}

export function health(all: WorkItem[], changes: ChangeRef[], now: string): Health | null {
  const sprint = currentSprint(all, now);
  if (!sprint) return null;
  const byId = new Map(all.map((i) => [i.id, i]));
  const items = all.filter((i) => inSprint(i, sprint));
  const entries = new Map(items.map((i) => [i.id, entry(i)]));
  const kind = (k: Entry['kind']) => items.filter((i) => entries.get(i.id)!.kind === k);

  const risks: Risk[] = [];
  for (const item of items) {
    if (isDone(item)) continue;
    const reasons: Reason[] = [];
    for (const link of item.links) {
      const blocker = byId.get(link.target);
      if (link.type === 'blocks' && link.direction === 'inward' && blocker && !isDone(blocker)) reasons.push({ code: 'blocked', by: blocker.id });
    }
    const e = entries.get(item.id)!;
    if (e.kind === 'carried') reasons.push({ code: 'carried', from: e.from! });
    const build = latestBuild(item.id, changes);
    if (build?.outcome === 'failed') reasons.push({ code: 'failing-build', change: build.id });
    if (needsEstimate(item, byId)) reasons.push({ code: 'unestimated' });
    if (reasons.length) risks.push({ id: item.id, reasons });
  }

  return {
    sprint,
    items,
    entries,
    days: sprintDays(sprint.start!, sprint.end!, now),
    planned: tally(kind('planned')),
    added: tally(kind('added')),
    carried: tally(kind('carried')),
    done: tally(items.filter(isDone)),
    remaining: tally(items.filter((i) => !isDone(i))),
    otherUnits: items.filter((i) => i.estimate && i.estimate.unit !== 'points').map((i) => i.id),
    unestimated: items.filter((i) => needsEstimate(i, byId)).map((i) => i.id),
    risks,
  };
}

/** Plain words for a reason, with the ids it names written as citations. */
export function describe(reason: Reason): string {
  switch (reason.code) {
    case 'blocked':
      return `Blocked by [[${reason.by}]], which isn't done`;
    case 'carried':
      return `Carried over from ${reason.from}`;
    case 'failing-build':
      return 'Its latest build failed';
    case 'unestimated':
      return 'No estimate';
  }
}
