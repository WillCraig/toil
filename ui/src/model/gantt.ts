/**
 * The blocker Gantt (#396): every item that blocks or is blocked, as a bar on
 * the sprint's timeline, made of what the toil project already holds and nothing
 * fetched for it. A bar's segments are its time in progress (its
 * transitions), its time blocked (its `blocks` links, until the blocker
 * finished) and its failing checks (its pull requests' builds and checks).
 * "Waits on" arrows join each blocker to what it holds up, and the chain of
 * open blockers holding the most points is the critical chain.
 *
 * Every time that is estimated says so (principle 4). A link carries no date
 * in any tracker toil reads, so a blocked segment starts at the later of the
 * two items' creation; an item whose history never recorded a move into In
 * progress (GitHub records only open and closed) starts when it was created.
 * Pure, so the tab, the Overview and the tests agree. The project plan,
 * drawn after the fact, which is when project plans are most accurate.
 */

import type { ChangeRef, WorkItem } from '../toil.ts';
import { blockerOrder, heldBy } from './blockers.ts';
import { doneAt } from './flow.ts';
import { dependencyGraph } from './graph.ts';
import type { Prepared } from './insights.ts';
import { readiness, type ReadinessSettings, type Verdict } from './readiness.ts';
import type { Health } from './sprint.ts';

const DAY = 86_400_000;

export type SegmentKind = 'progress' | 'blocked' | 'checks';

export interface Segment {
  kind: SegmentKind;
  /** ISO instants, unclipped: the view clips them to the timeline. */
  start: string;
  end: string;
  /** True when `start` (or, for a finished item with no recorded finish, `end`) is estimated. */
  estimated: boolean;
  /** For one blocker's wait (`Bar.blocked`), the blocker; for failing checks, the build or pull request; null on the main lane, where blocked time is the union of every wait. */
  by: string | null;
}

export interface Bar {
  id: string;
  /** Its rank in the dependency graph: blockers sit above what they block. */
  rank: number;
  done: boolean;
  /** Points, when it is estimated in points. */
  points: number | null;
  /** The main lane: blocked time (the union of every wait), and time in progress while not blocked. Never overlapping. */
  segments: Segment[];
  /** Each blocker's wait on its own, for the table and the tooltip: these may overlap one another. */
  blocked: Segment[];
  /** The lane under it: failing checks, which can run while it is blocked or in progress. */
  checks: Segment[];
  /** Where the bar's time came from, in words, for the table. */
  evidence: string[];
  onChain: boolean;
  /** The readiness gate's verdict, for work not started yet; null once it has started. */
  ready: Verdict | null;
}

export interface Arrow {
  /** The blocker. */
  from: string;
  /** The item that waits on it. */
  to: string;
  /** False once the blocker is done: the wait is over. */
  live: boolean;
  onChain: boolean;
}

export interface Chain {
  /** Head first: each blocks the next. */
  ids: string[];
  points: number;
  /** True when no item on any chain has points, so the longest chain was taken instead. */
  byCount: boolean;
}

export interface Gantt {
  /** The timeline: the sprint's dates, else the bars' own, reaching at least to now. */
  start: string;
  end: string;
  now: string;
  sprint: string | null;
  bars: Bar[];
  arrows: Arrow[];
  chain: Chain | null;
  /** True when the `blocks` links loop. */
  cycle: boolean;
}

export interface GanttInput {
  prepared: Prepared;
  health: Health | null;
  readiness: ReadinessSettings;
  now: string;
}

type Span = [number, number];
const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : NaN);
const ok = (n: number) => Number.isFinite(n);
const at = (ms: number) => new Date(ms).toISOString();
const pointsOf = (item: WorkItem | undefined) => (item?.estimate?.unit === 'points' ? item.estimate.value : null);

/** When an item finished: its last move into Done, else its resolution, else its last update (estimated). */
function finished(item: WorkItem): { at: number; estimated: boolean } | null {
  if (item.statusCategory !== 'DONE') return null;
  const moved = t(doneAt(item));
  if (ok(moved)) return { at: moved, estimated: false };
  const resolved = t(item.resolved);
  if (ok(resolved)) return { at: resolved, estimated: false };
  const updated = t(item.updated);
  return ok(updated) ? { at: updated, estimated: true } : null;
}

/** Its spells in progress, from its transitions; with none recorded, from its creation (estimated), for an item in progress or done. */
function progress(item: WorkItem, end: number): { spans: Span[]; estimated: boolean } {
  const moves = [...(item.history?.transitions ?? [])].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const spans: Span[] = [];
  let open: number | null = null;
  for (const m of moves) {
    const when = t(m.at);
    if (!ok(when)) continue;
    if (m.toCategory === 'IN_PROGRESS' && open === null) open = when;
    else if (m.toCategory !== 'IN_PROGRESS' && open !== null) {
      spans.push([open, when]);
      open = null;
    }
  }
  if (open !== null) spans.push([open, end]);
  if (spans.length || item.statusCategory === 'TODO' || item.statusCategory === 'UNKNOWN') return { spans, estimated: false };
  const created = t(item.created);
  return ok(created) ? { spans: [[created, end]], estimated: true } : { spans: [], estimated: true };
}

/** `a` with every part of `cut` taken out. */
function minus(a: Span[], cut: Span[]): Span[] {
  let out = a;
  for (const [cs, ce] of cut) {
    out = out.flatMap(([s, e]): Span[] => {
      if (ce <= s || cs >= e) return [[s, e]];
      return [...(cs > s ? [[s, cs] as Span] : []), ...(ce < e ? [[ce, e] as Span] : [])];
    });
  }
  return out.filter(([s, e]) => e > s);
}

/** Spans merged where they overlap or touch, in order: two blockers' waits over the same days are one stretch blocked. */
function union(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const [s, e] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The chain of open blockers holding the most points: head first. Ties go to the longer chain, then to the blocker the recommendation names first. */
function criticalChain(held: Map<string, string[]>, p: Prepared): Chain | null {
  if (!held.size) return null;
  const pts = (id: string) => pointsOf(p.byId.get(id)) ?? 0;
  const anyPoints = [...held.keys(), ...[...held.values()].flat()].some((id) => pts(id) > 0);
  const weight = (id: string) => (anyPoints ? pts(id) : 1);
  const best = new Map<string, string[]>();
  // The heaviest path from `id` down; a loop is cut where it comes back round.
  const walk = (id: string, path: Set<string>): string[] => {
    if (best.has(id)) return best.get(id)!;
    let top: string[] = [];
    let topWeight = -1;
    for (const next of held.get(id) ?? []) {
      if (path.has(next)) continue;
      const down = walk(next, new Set(path).add(next));
      const w = down.reduce((n, x) => n + weight(x), 0);
      if (w > topWeight || (w === topWeight && down.length > top.length)) [top, topWeight] = [down, w];
    }
    const chain = [id, ...top];
    best.set(id, chain);
    return chain;
  };
  const blocked = new Set([...held.values()].flat());
  const heads = blockerOrder(held).map(([id]) => id);
  const starts = heads.filter((id) => !blocked.has(id));
  let chain: string[] = [];
  let w = -1;
  for (const id of starts.length ? starts : heads) {
    const c = walk(id, new Set([id]));
    const cw = c.reduce((n, x) => n + weight(x), 0);
    if (cw > w || (cw === w && c.length > chain.length)) [chain, w] = [c, cw];
  }
  return { ids: chain, points: chain.reduce((n, id) => n + pts(id), 0), byCount: !anyPoints };
}

/** Each pull request's builds that fail now, as one span from the first of its latest run of failures. */
function failing(item: WorkItem, changes: ChangeRef[], end: number): Segment[] {
  const prs = changes.filter((c) => c.kind === 'pull-request' && c.items.includes(item.id) && c.outcome === 'open');
  const out: Segment[] = [];
  for (const pr of prs) {
    const builds = changes.filter((c) => c.kind === 'build' && c.builds === pr.id && ok(t(c.at))).sort((a, b) => (a.at < b.at ? -1 : 1));
    let from: ChangeRef | null = null;
    for (const b of builds) from = b.outcome === 'failed' ? (from ?? b) : null;
    if (from) out.push({ kind: 'checks', start: from.at, end: at(end), estimated: false, by: from.id });
    else if (!builds.length && pr.change?.checks === 'FAILING') {
      const since = t(pr.change.checksAt);
      const guess = t(pr.change.updated ?? pr.change.created);
      if (ok(since)) out.push({ kind: 'checks', start: at(since), end: at(end), estimated: false, by: pr.id });
      else if (ok(guess)) out.push({ kind: 'checks', start: at(guess), end: at(end), estimated: true, by: pr.id });
    }
  }
  return out;
}

export function blockerGantt(input: GanttInput): Gantt {
  const { prepared: p, health: h } = input;
  const now = t(input.now);
  const g = dependencyGraph(p.items);
  const rank = new Map(g.nodes.map((n) => [n.id, n.rank]));
  const unfinished = (id: string) => p.byId.has(id) && p.byId.get(id)!.statusCategory !== 'DONE';
  // Every blocks link between two items the toil project holds, where one end is still open: a done blocker shows when the wait ended.
  const edges = g.edges.filter((e) => e.type === 'blocks' && p.byId.has(e.source) && p.byId.has(e.target) && e.source !== e.target && (unfinished(e.source) || unfinished(e.target)));
  const held = heldBy(p);
  const chain = criticalChain(held, p);
  const onChain = new Set(chain?.ids ?? []);
  const chainLink = new Set((chain?.ids ?? []).slice(1).map((id, i) => `${chain!.ids[i]}->${id}`));

  const ids: string[] = [];
  for (const e of edges) for (const id of [e.source, e.target]) if (!ids.includes(id)) ids.push(id);
  const order = new Map(p.items.map((i, n) => [i.id, n]));
  ids.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0) || (order.get(a) ?? 0) - (order.get(b) ?? 0));

  const bars = ids.map((id): Bar => {
    const item = p.byId.get(id)!;
    const fin = finished(item);
    const end = fin?.at ?? now;
    const evidence: string[] = [];
    const prog = progress(item, end);
    if (prog.spans.length) evidence.push(prog.estimated ? 'In progress from when it was created (estimated): its history records no move into In progress' : 'In progress from its transitions');
    if (fin?.estimated) evidence.push('Finished at its last update (estimated): no move into Done recorded');

    const blocked: Segment[] = [];
    for (const e of edges.filter((x) => x.target === id)) {
      const blocker = p.byId.get(e.source)!;
      const from = Math.max(t(item.created), t(blocker.created));
      const until = finished(blocker)?.at ?? now;
      const span: Span = [ok(from) ? from : NaN, Math.min(until, end)];
      if (!ok(span[0]) || span[1] <= span[0]) continue;
      blocked.push({ kind: 'blocked', start: at(span[0]), end: at(span[1]), estimated: true, by: e.source });
    }
    if (blocked.length) evidence.push('Blocked from when both items existed (estimated): links carry no date');
    const waits = union(blocked.map((b): Span => [t(b.start), t(b.end)]));
    const inProgress = minus(prog.spans, waits).map((s): Segment => ({ kind: 'progress', start: at(s[0]), end: at(s[1]), estimated: prog.estimated, by: null }));
    const checks = failing(item, p.changes, end);
    if (checks.length) evidence.push(checks.some((c) => c.estimated) ? 'Checks failing since the pull request last changed (estimated)' : 'Checks failing since the first of the latest failed builds');
    const ready = item.statusCategory === 'TODO' ? readiness({ item, settings: input.readiness, byId: p.byId }).verdict : null;
    return {
      id,
      rank: rank.get(id) ?? 0,
      done: item.statusCategory === 'DONE',
      points: pointsOf(item),
      segments: [...waits.map((w): Segment => ({ kind: 'blocked', start: at(w[0]), end: at(w[1]), estimated: true, by: null })), ...inProgress].sort((a, b) => (a.start < b.start ? -1 : 1)),
      blocked,
      checks,
      evidence,
      onChain: onChain.has(id),
      ready,
    };
  });

  const arrows: Arrow[] = edges.map((e) => ({ from: e.source, to: e.target, live: unfinished(e.source) && unfinished(e.target), onChain: chainLink.has(`${e.source}->${e.target}`) }));

  let start: number;
  let end: number;
  if (h?.sprint.start && h.sprint.end) {
    start = t(h.sprint.start);
    end = Math.max(t(h.sprint.end), now);
  } else {
    const times = bars.flatMap((b) => [...b.segments, ...b.checks].map((s) => t(s.start))).filter(ok);
    start = times.length ? Math.min(...times) : now - 14 * DAY;
    // Room past today for the arrows leaving bars that end there.
    end = now + 2 * DAY;
  }
  return { start: at(start), end: at(end), now: at(now), sprint: h?.sprint.name ?? null, bars, arrows, chain, cycle: g.cycle };
}
