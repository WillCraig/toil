import type { Change, StatusCategory, WorkItem } from '../owi/types.js';
import { calendarDays, DAY, round1, workingDays } from './time.js';

/**
 * The toil project briefing, by code (#494): what needs a person, sorted into
 * reasons, and the one thing to do first. It reads Open Work Items and their
 * changes (pull requests), the same records `util owi map` prints, and asks
 * nobody: the caller composes the reads (principle 3). `toil projects brief`
 * prints it, Toil UI's home page is built on it, and Analyze starts from it
 * and adds the judgement code can't make.
 *
 * Each lens is one test, applied to every open item in the toil project's order of
 * lenses; an item lands under the first lens that flags it, so it appears
 * once (the item's own page still shows everything). Within a reason the item
 * holding up the most work comes first, and the first reason's first item
 * becomes the recommendation. Every sentence cites items as `[[<owi id>]]`,
 * and every item carries its tracker's `url`, so any front door can link it.
 * A lens the data can't support (load with no WIP limit, readiness, which
 * lives in Toil UI) is listed as not checked, never guessed at. A meeting
 * agenda, in other words, that ends with an owner for each item.
 */

export type LensId = 'failing' | 'blocked' | 'waiting' | 'sprint' | 'stale' | 'load' | 'drift' | 'ready';
export type Severity = 'danger' | 'warn';

export interface LensDef {
  id: LensId;
  label: string;
  severity: Severity;
  /** The threshold's unit, or null for a lens with none. */
  unit: 'hours' | 'working days' | 'days' | null;
  /** The default threshold, or null for a lens with none. */
  threshold: number | null;
  /** Whether a lens starts on. */
  on: boolean;
  /** What it looks for, given its threshold: the sentence the Analyze prompt and the settings page show. */
  test: (threshold: number | null, wipLimit: number | null) => string;
}

/** Every lens, in the standard order: what holds the most work up first. */
export const LENSES: readonly LensDef[] = [
  { id: 'failing', label: 'Failing checks', severity: 'danger', unit: 'hours', threshold: 24, on: true, test: (t) => `checks on an open pull request for an open item have failed for more than ${t} hours` },
  { id: 'blocked', label: 'Blocked', severity: 'danger', unit: null, threshold: null, on: true, test: () => 'an open item waits on another open item' },
  { id: 'waiting', label: 'Waiting on review', severity: 'warn', unit: 'working days', threshold: 2, on: true, test: (t) => `an open pull request has had no first review for more than ${t} working days` },
  { id: 'sprint', label: 'Sprint at risk', severity: 'warn', unit: null, threshold: null, on: true, test: () => "at the pace so far, the current sprint won't finish the points in it" },
  { id: 'stale', label: 'Stale', severity: 'warn', unit: 'days', threshold: 5, on: true, test: (t) => `an item in progress has had no update for more than ${t} days` },
  { id: 'load', label: 'Over the WIP limit', severity: 'warn', unit: null, threshold: null, on: true, test: (_t, wip) => `someone has more than ${wip ?? "the toil project's WIP limit of"} items in progress (describe load, never rank people)` },
  { id: 'drift', label: 'Ticket and pull request disagree', severity: 'warn', unit: null, threshold: null, on: true, test: () => 'an item is done while its pull request is open, or its pull request merged while the item is still open' },
  { id: 'ready', label: 'Not ready', severity: 'warn', unit: null, threshold: null, on: false, test: () => 'the next item in line fails the readiness checks' },
];

const LENS = new Map(LENSES.map((l) => [l.id, l]));
export const lensDef = (id: LensId): LensDef => LENS.get(id)!;
export const isLensId = (id: string): id is LensId => LENS.has(id as LensId);

/** One lens as a toil project sets it: on or off, and its threshold. */
export interface LensSetting {
  id: LensId;
  on: boolean;
  threshold: number | null;
}

export interface BriefSettings {
  /** The lenses in the order they're applied. */
  lenses: LensSetting[];
  /** The toil project's WIP limit, which the load lens needs. */
  wipLimit: number | null;
}

/** The standard settings: every lens in the standard order, with its default threshold. */
export const standardSettings = (wipLimit: number | null = null): BriefSettings => ({ lenses: LENSES.map((l) => ({ id: l.id, on: l.on, threshold: l.threshold })), wipLimit });

/** A pull request an item's reason rests on. */
export interface BriefChange {
  id: string;
  /** The repository, as its code host names it. */
  repo: string;
  title: string;
  url: string | null;
  state: Change['state'];
  checks: Change['checks'];
}

export interface BriefItem {
  /** The OWI id, `<connection>:<key>`: Toil UI's address for the item. */
  id: string;
  key: string;
  /** Where the record came from: the area, the connection and the toil command that read it. */
  source: WorkItem['source'];
  title: string;
  /** The item in its tracker, to open. */
  url: string | null;
  status: string | null;
  statusCategory: StatusCategory;
  assignee: string | null;
  points: number | null;
  /** Why it's under this reason, in one sentence citing `[[ids]]`. */
  why: string;
  /** What the sentence rests on: OWI fields and change ids. */
  evidence: string[];
  /** The open items it holds up, directly or down a chain, and their points. */
  holds: { items: number; points: number };
  changes: BriefChange[];
}

export interface BriefReason {
  lens: LensId;
  label: string;
  severity: Severity;
  /** One line on how much it holds up. */
  line: string;
  items: BriefItem[];
  /** For a reason about the whole toil project (the sprint): what it found, in one or two sentences. */
  text: string | null;
}

export interface SprintFacts {
  name: string;
  start: string;
  end: string;
  /** Working days. */
  days: { total: number; gone: number; left: number };
  points: { total: number; done: number; left: number };
  /** Points done a working day so far, and how many of the points left land at that pace; null until a quarter of the sprint has gone. */
  pace: number | null;
  projected: number | null;
}

export interface Brief {
  asOf: string;
  by: 'code';
  /** The one thing to do first, citing `[[ids]]`; null when nothing needs anyone. */
  recommendation: { text: string; items: string[] } | null;
  reasons: BriefReason[];
  /** Open items no reason took, and items done. Counted, not listed. */
  onTrack: { open: number; done: number };
  sprint: SprintFacts | null;
  /** The lenses as applied: each one's test, whether it ran, how many items it couldn't test for a missing field, and why. */
  lenses: Array<{ id: LensId; label: string; on: boolean; threshold: number | null; unit: LensDef['unit']; test: string; checked: boolean; untested: number; note: string | null }>;
}

export interface BriefInput {
  items: readonly WorkItem[];
  changes: readonly Change[];
  asOf: string;
  settings: BriefSettings;
}

const open = (i: WorkItem) => i.statusCategory !== 'DONE';
const openChange = (c: Change) => c.state === 'OPEN' || c.state === 'DRAFT';
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pointsText = (p: number) => plural(round1(p), 'point');
const daysText = (n: number, unit: string) => `${round1(n)} ${unit.replace(/days$/, round1(n) === 1 ? 'day' : 'days')}`;
const cite = (id: string) => `[[${id}]]`;

/** The open items an item holds up through `blocks` links, however far down the chain, each counted once. */
function heldBy(id: string, byId: ReadonlyMap<string, WorkItem>): WorkItem[] {
  const seen = new Set<string>([id]);
  const out: WorkItem[] = [];
  const queue = [id];
  while (queue.length) {
    const at = byId.get(queue.shift()!);
    for (const l of at?.links ?? []) {
      if (l.type !== 'blocks' || l.direction !== 'outward' || seen.has(l.target)) continue;
      const next = byId.get(l.target);
      seen.add(l.target);
      if (next && open(next)) {
        out.push(next);
        queue.push(next.id);
      }
    }
  }
  return out;
}

const pointsOf = (i: WorkItem) => (i.estimate?.unit === 'points' ? i.estimate.value : 0);

/** A sprint's end: one given as midnight exactly is the start of its last day (Azure DevOps' finishDate), so the end of that day. */
const endOf = (end: string) => (/T00:00:00(\.0+)?Z$/.test(end) ? new Date(Date.parse(end) + DAY).toISOString() : end);

/** The sprint the most open items are in, by its dates, or the tracker's word that it's current. */
function currentSprint(items: readonly WorkItem[], asOf: string): WorkItem['iteration'] {
  const t = Date.parse(asOf);
  const counts = new Map<string, { it: NonNullable<WorkItem['iteration']>; n: number }>();
  for (const i of items) {
    const it = i.iteration;
    if (!it?.start || !it.end) continue;
    const now = it.state === 'current' || (Date.parse(it.start) <= t && t <= Date.parse(endOf(it.end)));
    if (!now) continue;
    const key = `${it.name}|${it.start}|${it.end}`;
    counts.set(key, { it, n: (counts.get(key)?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.it ?? null;
}

function sprintFacts(items: readonly WorkItem[], asOf: string): SprintFacts | null {
  const it = currentSprint(items, asOf);
  if (!it?.start || !it.end) return null;
  // Two trackers may each have a "Sprint 42"; only the one with these dates is this sprint.
  const inIt = items.filter((i) => i.iteration?.name === it.name && i.iteration.start === it.start && i.iteration.end === it.end);
  const total = inIt.reduce((n, i) => n + pointsOf(i), 0);
  const done = inIt.filter((i) => !open(i)).reduce((n, i) => n + pointsOf(i), 0);
  const end = endOf(it.end);
  const all = workingDays(it.start, end);
  const gone = Math.min(all, workingDays(it.start, asOf));
  // Stories land late in a sprint, so a pace is only read once a quarter of it (and at least a day) has gone.
  const pace = gone >= Math.max(1, all / 4) ? done / gone : null;
  const projected = pace === null ? null : Math.min(total - done, pace * (all - gone));
  return { name: it.name, start: it.start, end: it.end, days: { total: round1(all), gone: round1(gone), left: round1(all - gone) }, points: { total, done, left: total - done }, pace: pace === null ? null : round1(pace), projected: projected === null ? null : round1(projected) };
}

interface Finding {
  why: string;
  evidence: string[];
  changes: Change[];
}

const unmapped = (c: Change, field: string) => (c.unmapped ?? []).some((u) => u.field === field);

/** Why one lens can't test one item: a field it reads is missing. Null when it can. */
function untestable(lens: LensId, item: WorkItem, prs: Change[]): string | null {
  switch (lens) {
    case 'failing':
      return prs.some((c) => openChange(c) && (c.checks === null || unmapped(c, 'checks') || (c.checks === 'FAILING' && !c.checksAt))) ? 'checks' : null;
    case 'waiting':
      return prs.some((c) => c.state === 'OPEN' && (!c.created || unmapped(c, 'firstReviewAt'))) ? 'firstReviewAt' : null;
    case 'stale':
      return item.statusCategory === 'IN_PROGRESS' && !item.updated ? 'updated' : null;
    case 'load':
      return item.statusCategory === 'IN_PROGRESS' && !item.assignee?.id ? 'assignee' : null;
    default:
      return null;
  }
}

/** What one lens finds about one open item, or null. */
function find(lens: LensId, item: WorkItem, t: number | null, ctx: { byId: ReadonlyMap<string, WorkItem>; changesOf: (id: string) => Change[]; asOf: string; wipLimit: number | null; loadOf: ReadonlyMap<string, number> }): Finding | null {
  const prs = ctx.changesOf(item.id);
  switch (lens) {
    case 'failing': {
      const failing = prs.filter((c) => openChange(c) && c.checks === 'FAILING' && c.checksAt && calendarDays(c.checksAt, ctx.asOf) * 24 > (t ?? 0));
      if (!failing.length) return null;
      const c = failing[0]!;
      return { why: `Checks fail on ${cite(c.id)}, for ${daysText(calendarDays(c.checksAt!, ctx.asOf), 'days')}.`, evidence: failing.map((f) => f.id), changes: failing };
    }
    case 'blocked': {
      const by = item.links.filter((l) => l.type === 'blocks' && l.direction === 'inward' && ctx.byId.has(l.target) && open(ctx.byId.get(l.target)!)).map((l) => l.target);
      if (!by.length) return null;
      return { why: `Blocked by ${[...new Set(by)].map(cite).join(' and ')}, which ${by.length === 1 ? "isn't" : "aren't"} done.`, evidence: ['links'], changes: [] };
    }
    case 'waiting': {
      const waiting = prs.filter((c) => c.state === 'OPEN' && !c.firstReviewAt && !unmapped(c, 'firstReviewAt') && c.created && workingDays(c.created, ctx.asOf) > (t ?? 0));
      if (!waiting.length) return null;
      const c = waiting[0]!;
      return { why: `${cite(c.id)} has waited ${daysText(workingDays(c.created!, ctx.asOf), 'working days')} for its first review.`, evidence: waiting.map((w) => w.id), changes: waiting };
    }
    case 'stale': {
      if (item.statusCategory !== 'IN_PROGRESS' || !item.updated) return null;
      const quiet = calendarDays(item.updated, ctx.asOf);
      return quiet > (t ?? 0) ? { why: `In progress with no update for ${daysText(quiet, 'days')}.`, evidence: ['updated'], changes: [] } : null;
    }
    case 'load': {
      const who = item.assignee?.id;
      if (ctx.wipLimit === null || item.statusCategory !== 'IN_PROGRESS' || !who) return null;
      const n = ctx.loadOf.get(who) ?? 0;
      return n > ctx.wipLimit ? { why: `${item.assignee!.name ?? who} has ${n} items in progress; the toil project's limit is ${ctx.wipLimit}.`, evidence: ['assignee', 'statusCategory'], changes: [] } : null;
    }
    case 'drift': {
      if (item.statusCategory === 'DONE') {
        const still = prs.filter(openChange);
        return still.length ? { why: `Done while ${still.map((c) => cite(c.id)).join(' and ')} ${still.length === 1 ? 'is' : 'are'} still open.`, evidence: still.map((c) => c.id), changes: still } : null;
      }
      const merged = prs.filter((c) => c.state === 'MERGED' && c.mergedAt && workingDays(c.mergedAt, ctx.asOf) > 1);
      if (!merged.length) return null;
      return { why: `${cite(merged[0]!.id)} merged ${daysText(workingDays(merged[0]!.mergedAt!, ctx.asOf), 'working days')} ago, but the item is still ${item.status ?? 'open'}.`, evidence: merged.map((m) => m.id), changes: merged };
    }
    default:
      return null;
  }
}

function briefChange(c: Change): BriefChange {
  return { id: c.id, repo: c.repo, title: c.title, url: c.url, state: c.state, checks: c.checks };
}

/** The line under a reason's name: how much it holds up. */
function lineFor(lens: LensId, items: BriefItem[], t: number | null, wipLimit: number | null): string {
  const pts = items.reduce((n, i) => n + (i.points ?? 0), 0);
  const held = items.reduce((n, i) => n + i.holds.items, 0);
  const ptsPart = pts ? `, ${pointsText(pts)}` : '';
  switch (lens) {
    case 'failing':
      return `${plural(items.length, 'item')}${held ? `, holding up ${held} more` : ''}${ptsPart}`;
    case 'blocked':
      return `${plural(items.length, 'item')}${ptsPart}`;
    case 'waiting':
      return `${plural(items.length, 'item')} with a pull request past ${t} working days`;
    case 'stale':
      return `${plural(items.length, 'item')} with no update for over ${t} days`;
    case 'load':
      return `${plural(new Set(items.map((i) => i.assignee)).size, 'person', 'people')} over the limit of ${wipLimit}`;
    case 'drift':
      return `${plural(items.length, 'item')} whose ticket and pull request disagree`;
    default:
      return plural(items.length, 'item');
  }
}

/** The one thing to do first, from the first reason's first item. */
function recommend(reason: BriefReason): { text: string; items: string[] } {
  const top = reason.items[0];
  if (!top) return { text: reason.text ?? reason.label, items: [] };
  const holds = top.holds.items ? `: it holds up ${plural(top.holds.items, 'item')}${top.holds.points ? ` (${pointsText(top.holds.points)})` : ''}` : '';
  const first = cite(top.id);
  switch (reason.lens) {
    case 'failing':
      return { text: `Fix the failing checks on ${first} first${holds}.`, items: [top.id] };
    case 'blocked':
      return { text: `Unblock ${first} first${holds}. ${top.why}`, items: [top.id] };
    case 'waiting':
      return { text: `Get ${first} its first review. ${top.why}`, items: [top.id] };
    case 'stale':
      return { text: `Check on ${first}. ${top.why}`, items: [top.id] };
    case 'load':
      return { text: `${top.why} Look at what ${top.assignee ?? 'they'} can hand off or finish first.`, items: [top.id] };
    default:
      return { text: `Reconcile ${first}. ${top.why}`, items: [top.id] };
  }
}

/** The briefing: every open item that needs a person under one reason, the sprint's health, and what to do first. Pure. */
export function brief(input: BriefInput): Brief {
  const { items, changes, asOf, settings } = input;
  const byId = new Map(items.map((i) => [i.id, i]));
  const byItem = new Map<string, Change[]>();
  for (const c of changes) for (const id of new Set(c.workItems)) byItem.set(id, [...(byItem.get(id) ?? []), c]);
  const changesOf = (id: string) => byItem.get(id) ?? [];
  const loadOf = new Map<string, number>();
  for (const i of items) if (i.statusCategory === 'IN_PROGRESS' && i.assignee?.id) loadOf.set(i.assignee.id, (loadOf.get(i.assignee.id) ?? 0) + 1);
  const ctx = { byId, changesOf, asOf, wipLimit: settings.wipLimit, loadOf };
  const sprint = sprintFacts(items, asOf);

  const taken = new Set<string>();
  const reasons: BriefReason[] = [];
  const lenses: Brief['lenses'] = [];
  for (const setting of settings.lenses) {
    const def = lensDef(setting.id);
    const t = setting.threshold ?? def.threshold;
    const skip = !setting.on ? null : setting.id === 'ready' ? 'Readiness is worked out in Toil UI, not from OWI records.' : setting.id === 'load' && settings.wipLimit === null ? 'The toil project sets no WIP limit (toil projects wip-limit).' : setting.id === 'sprint' && !sprint ? 'No item is in a sprint running now.' : setting.id === 'sprint' && sprint!.points.total === 0 ? 'No item in the sprint has a points estimate.' : null;
    const checked = setting.on && skip === null;
    // A lens that ran still says which items it couldn't test, so "nothing found" never hides "nothing read".
    const missing = checked ? items.filter((i) => (open(i) || setting.id === 'drift') && untestable(setting.id, i, changesOf(i.id))) : [];
    const field = missing.length ? untestable(setting.id, missing[0]!, changesOf(missing[0]!.id)) : null;
    const note = skip ?? (missing.length ? `${plural(missing.length, 'item')} couldn't be tested: ${field === 'checks' || field === 'firstReviewAt' ? `a pull request has no ${field === 'checks' ? 'checks' : 'reviews'} read (map pr get --include reviews,checks, not only pr list)` : `no ${field}`}.` : null);
    lenses.push({ id: def.id, label: def.label, on: setting.on, threshold: t, unit: def.unit, test: def.test(t, settings.wipLimit), checked, untested: missing.length, note });
    if (!checked) continue;

    if (setting.id === 'sprint') {
      const s = sprint!;
      if (s.projected === null || s.projected >= s.points.left - 0.01 || s.points.left <= 0) continue;
      reasons.push({
        lens: 'sprint',
        label: def.label,
        severity: def.severity,
        line: `${pointsText(s.points.left)} left, ${daysText(s.days.left, 'working days')}, ${s.projected > 0 ? `about ${round1(s.projected)} land` : 'none land'} at this pace`,
        items: [],
        text: `${s.name} has done ${pointsText(s.points.done)} of ${s.points.total} in ${daysText(s.days.gone, 'working days')}, ${s.pace} a day. At that pace ${s.projected > 0 ? `about ${round1(s.projected)}` : 'none'} of the ${pointsText(s.points.left)} left land by ${new Date(Date.parse(endOf(s.end)) - 1).toISOString().slice(0, 10)}.`,
      });
      continue;
    }

    const found: BriefItem[] = [];
    for (const item of items) {
      // Done items are on track, except to drift: done while a pull request is still open.
      if ((!open(item) && setting.id !== 'drift') || taken.has(item.id)) continue;
      const f = find(setting.id, item, t, ctx);
      if (!f) continue;
      const held = heldBy(item.id, byId);
      found.push({
        id: item.id,
        key: item.source.key,
        source: item.source,
        title: item.title,
        url: item.url,
        status: item.status,
        statusCategory: item.statusCategory,
        assignee: item.assignee?.name ?? item.assignee?.id ?? null,
        points: item.estimate?.unit === 'points' ? item.estimate.value : null,
        why: f.why,
        evidence: f.evidence,
        holds: { items: held.length, points: held.reduce((n, h) => n + pointsOf(h), 0) },
        changes: f.changes.map(briefChange),
      });
    }
    if (!found.length) continue;
    found.sort((a, b) => b.holds.items - a.holds.items || b.holds.points - a.holds.points);
    for (const f of found) taken.add(f.id);
    reasons.push({ lens: setting.id, label: def.label, severity: def.severity, line: lineFor(setting.id, found, t, settings.wipLimit), items: found, text: null });
  }

  return {
    asOf,
    by: 'code',
    recommendation: reasons[0] ? recommend(reasons[0]) : null,
    reasons,
    onTrack: { open: items.filter((i) => open(i) && !taken.has(i.id)).length, done: items.filter((i) => !open(i) && !taken.has(i.id)).length },
    sprint,
    lenses,
  };
}
