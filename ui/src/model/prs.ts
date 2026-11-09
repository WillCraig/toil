/**
 * Pull request tracking (#291): what each open pull request waits on and for
 * how long, the flags a lead would raise, flow metrics split by who wrote the
 * change, and reviewers to suggest. Pure functions of OWI 0.2 changes
 * (src/core/owi/), the toil project's work items and a clock, like sprint.ts. A
 * figure the data can't support is unknown, counted beside the figure, and
 * every figure carries its sample size (principle 4). Time waiting is
 * counted in working days, Monday to Friday UTC, since nobody reviews at the
 * weekend except the people who say they don't.
 */

import { prName, sourceLabel } from '../format.ts';
import type { Proposal } from '../proposal.ts';
import type { AuthorKind, Change, WorkItem } from '../toil.ts';
import { workingDays } from '../../../src/core/brief/time.ts';
import { lensDef } from '../../../src/core/brief/brief.ts';
import { percentile, weekStart, type Week } from './flow.ts';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

// The same count toil's briefing uses (src/core/brief/time.ts), so the two never disagree on a wait.
export { workingDays } from '../../../src/core/brief/time.ts';

const isOpen = (c: Change) => c.state === 'OPEN' || c.state === 'DRAFT';
const round1 = (n: number) => Math.round(n * 10) / 10;
export const daysText = (n: number) => `${round1(n)} working ${round1(n) === 1 ? 'day' : 'days'}`;

// What it waits on -------------------------------------------------------------------

export type WaitingOn = 'draft' | 'changes' | 'checks' | 'review' | 'merge';

export const WAITING_LABEL: Record<WaitingOn, string> = {
  draft: 'Draft (its author)',
  changes: 'Changes (its author)',
  checks: 'Checks',
  review: 'Review',
  merge: 'Merge',
};

export interface Wait {
  on: WaitingOn;
  /** Since when, or null when the record doesn't say. */
  since: string | null;
  /** Working days waiting, or null. */
  days: number | null;
  /** What says so, in words. */
  why: string;
}

/**
 * What an open pull request waits on, in this order: a draft waits on its
 * author; changes asked for wait on the author; failing checks on a fix;
 * no approval yet on review; checks still running on the checks; otherwise
 * on someone to merge it. Each with when that wait began.
 */
export function waitOf(c: Change, now: string): Wait {
  const wait = (on: WaitingOn, since: string | null, why: string): Wait => ({ on, since, days: since ? workingDays(since, now) : null, why });
  const lastChanges = [...(c.reviews ?? [])].reverse().find((r) => r.state === 'CHANGES_REQUESTED')?.at ?? null;
  if (c.state === 'DRAFT') return wait('draft', c.created, 'it is a draft');
  if (c.reviewers.some((r) => r.state === 'CHANGES_REQUESTED')) return wait('changes', lastChanges ?? c.firstReviewAt, `${c.reviewers.filter((r) => r.state === 'CHANGES_REQUESTED').map((r) => r.person.name ?? r.person.id).join(', ')} asked for changes`);
  if (c.checks === 'FAILING') return wait('checks', c.checksAt, 'its checks are failing');
  if (!c.reviewers.some((r) => r.state === 'APPROVED')) {
    const why = c.reviewers.length ? `no approval yet from ${c.reviewers.map((r) => r.person.name ?? r.person.id).join(', ')}` : 'no reviewer is asked yet';
    return wait('review', c.created, c.firstReviewAt ? `${why}, though it has been reviewed` : why);
  }
  if (c.checks === 'PENDING') return wait('checks', c.checksAt, 'its checks are still running');
  return wait('merge', c.approvedAt, c.mergeable === false ? 'approved, but it has a merge conflict' : 'approved and ready');
}

// Size ---------------------------------------------------------------------------------

export type SizeBucket = 'XS' | 'S' | 'M' | 'L' | 'XL';
export const SIZES: readonly SizeBucket[] = ['XS', 'S', 'M', 'L', 'XL'];
/** The most changed lines (added plus deleted) each size holds. */
export const SIZE_LINES: Record<SizeBucket, number> = { XS: 9, S: 49, M: 249, L: 999, XL: Infinity };

/** XS to XL by changed lines, or null with the reason when the host counts files only. */
export function sizeOf(c: Change): { bucket: SizeBucket | null; lines: number | null; files: number | null; additions: number | null; deletions: number | null } {
  const known = c.size && c.size.additions !== null && c.size.deletions !== null;
  const lines = known ? c.size!.additions! + c.size!.deletions! : null;
  return { bucket: lines === null ? null : SIZES.find((b) => lines <= SIZE_LINES[b])!, lines, files: c.size?.files ?? null, additions: known ? c.size!.additions : null, deletions: known ? c.size!.deletions : null };
}

/** Five squares, GitHub's diff stat: how many are additions, deletions and neither (a change with no lines, or a share too small to draw). */
export function diffSquares(additions: number, deletions: number): { add: number; del: number; none: number } {
  const total = additions + deletions;
  if (total === 0) return { add: 0, del: 0, none: 5 };
  let add = additions > 0 ? Math.max(1, Math.round((5 * additions) / total)) : 0;
  let del = deletions > 0 ? Math.max(1, Math.round((5 * deletions) / total)) : 0;
  while (add + del > 5) {
    if (add > del) add--;
    else del--;
  }
  return { add, del, none: 5 - add - del };
}

/** A wait as a compact figure, `32.6 d`, for a cell; `daysText` is the full words. */
export const daysShort = (n: number) => `${round1(n)} d`;

// Flags --------------------------------------------------------------------------------

/** Working days a pull request may wait for its first review before it is flagged. */
export const PICKUP_DAYS = lensDef('waiting').threshold!;
/** Hours checks may fail before it is flagged. */
export const FAILING_HOURS = lensDef('failing').threshold!;

export type PrFlag = 'slow-pickup' | 'failing-checks' | 'conflict' | 'no-work-item' | 'item-done' | 'merged-item-open';

/** The same flags in a table cell: a few words, the full label one step in (title) and in the Flags panel. */
export const PR_FLAG_SHORT: Record<PrFlag, string> = {
  'slow-pickup': 'No review yet',
  'failing-checks': 'Checks failing',
  conflict: 'Conflict',
  'no-work-item': 'No work item',
  'item-done': 'Item done',
  'merged-item-open': 'Item open',
};

export const PR_FLAG_LABEL: Record<PrFlag, string> = {
  'slow-pickup': `No first review in ${PICKUP_DAYS} working days`,
  'failing-checks': 'Checks failing for over a day',
  conflict: 'Merge conflict',
  'no-work-item': 'No linked work item',
  'item-done': 'Work item done, pull request still open',
  'merged-item-open': 'Merged, work item not done',
};

export interface FlagHit {
  flag: PrFlag;
  /** Working days a `slow-pickup` has waited. */
  days?: number;
  /** What it rests on, citing items as [[id]]. */
  text: string;
}

/** The toil project's work items a change names: the ones the toil project's own queries returned. */
export const linked = (c: Change, byId: Map<string, WorkItem>) => c.workItems.filter((id) => byId.has(id));

export function flagsOf(c: Change, byId: Map<string, WorkItem>, now: string): FlagHit[] {
  const out: FlagHit[] = [];
  const items = linked(c, byId).map((id) => byId.get(id)!);
  if (c.state === 'OPEN') {
    const waited = c.created ? workingDays(c.created, c.firstReviewAt ?? now) : null;
    if (!c.firstReviewAt && waited !== null && waited > PICKUP_DAYS) out.push({ flag: 'slow-pickup', days: waited, text: `Open ${daysText(waited)} with no review yet.` });
  }
  if (isOpen(c)) {
    if (c.checks === 'FAILING' && c.checksAt && Date.parse(now) - Date.parse(c.checksAt) > FAILING_HOURS * 3_600_000) {
      out.push({ flag: 'failing-checks', text: `Failing since ${c.checksAt.slice(0, 16).replace('T', ' ')} UTC, ${round1((Date.parse(now) - Date.parse(c.checksAt)) / DAY)} days.` });
    }
    if (c.mergeable === false) out.push({ flag: 'conflict', text: `It doesn't merge cleanly into ${c.branch.target ?? 'its target'}.` });
    if (!items.length) out.push({ flag: 'no-work-item', text: c.workItems.length ? `It names ${c.workItems.join(', ')}, none of which this Toil project holds.` : 'Its title, branch and description name no work item.' });
    for (const i of items.filter((i) => i.statusCategory === 'DONE')) out.push({ flag: 'item-done', text: `[[${i.id}]] is ${i.status ?? 'done'} while this is still open.` });
  }
  if (c.state === 'MERGED') {
    for (const i of items.filter((i) => i.statusCategory === 'TODO' || i.statusCategory === 'IN_PROGRESS')) out.push({ flag: 'merged-item-open', text: `Merged, but [[${i.id}]] is still ${i.status ?? 'open'}.` });
  }
  return out;
}

// The open queue -------------------------------------------------------------------------

export interface OpenRow {
  change: Change;
  wait: Wait;
  size: ReturnType<typeof sizeOf>;
  items: string[];
  flags: FlagHit[];
}

/** Every open pull request, longest wait first, then those whose wait is unknown, then drafts. */
export function openQueue(changes: Change[], byId: Map<string, WorkItem>, now: string): OpenRow[] {
  const rows = changes.filter(isOpen).map((change) => ({ change, wait: waitOf(change, now), size: sizeOf(change), items: linked(change, byId), flags: flagsOf(change, byId, now) }));
  const rank = (r: OpenRow) => (r.wait.on === 'draft' ? 2 : r.wait.days === null ? 1 : 0);
  return rows.sort((a, b) => rank(a) - rank(b) || (b.wait.days ?? 0) - (a.wait.days ?? 0) || a.change.id.localeCompare(b.change.id));
}

/** The flags on every pull request, open and merged, each with its change. */
export function allFlags(changes: Change[], byId: Map<string, WorkItem>, now: string): Array<{ change: Change; hit: FlagHit }> {
  return changes.flatMap((change) => flagsOf(change, byId, now).map((hit) => ({ change, hit })));
}

// Flow metrics ---------------------------------------------------------------------------

export const KINDS: readonly AuthorKind[] = ['HUMAN', 'AGENT', 'BOT'];
export type KindOrAll = AuthorKind | 'ALL';
export const KIND_LABEL: Record<KindOrAll, string> = { ALL: 'All', HUMAN: 'People', AGENT: 'Agents', BOT: 'Bots' };

export interface Sample {
  median: number | null;
  p85: number | null;
  /** The sample size: how many changes the figure is worked out from. */
  n: number;
  /** Changes in the window the figure needs and whose record can't say. */
  unknown: number;
}

const sample = (values: Array<number | null>): Sample => {
  const known = values.filter((v): v is number => v !== null);
  return { median: percentile(known, 50), p85: percentile(known, 85), n: known.length, unknown: values.length - known.length };
};

export interface PrMetrics {
  /** The weeks the figures cover: Monday to Sunday UTC, the last one still running. */
  from: string;
  to: string;
  /** Opened to first review, in working days, for changes opened in the window. */
  pickup: Record<KindOrAll, Sample>;
  /** First review to approval. */
  review: Record<KindOrAll, Sample>;
  /** Approval to merge. */
  merge: Record<KindOrAll, Sample>;
  /** Rounds of review a merged change took: one, plus one for each request for changes; none when nobody reviewed it. */
  rounds: Record<KindOrAll, Sample>;
  /** Merged with no approval: review and merge time leave these out. */
  mergedUnreviewed: Record<KindOrAll, number>;
  /** Changes opened in the window, by size; `unknown` where the host counts files only. */
  sizes: Record<KindOrAll, Record<SizeBucket | 'unknown', number>>;
  /** Merged per week. */
  throughput: Record<KindOrAll, Week[]>;
  /** Merged changes whose host records no merge time, so no week can hold them. */
  unplacedMerges: number;
  /** How many changes there are of each kind in the window. */
  counts: Record<KindOrAll, number>;
}

/**
 * Flow metrics for the `weeks` weeks up to and including the one `now` falls
 * in, each split by author kind, with sample sizes. Pickup, review and merge
 * are medians in working days; the 85th percentile rides along.
 */
export function prMetrics(changes: Change[], now: string, weeks = 6): PrMetrics {
  const last = Date.parse(weekStart(now));
  const from = new Date(last - (weeks - 1) * WEEK).toISOString();
  const inWindow = (t: string | null) => t !== null && t >= from && t <= now;
  const opened = changes.filter((c) => inWindow(c.created));
  const merged = changes.filter((c) => c.state === 'MERGED' && (inWindow(c.mergedAt) || (c.mergedAt === null && inWindow(c.updated ?? c.created))));
  const of = (list: Change[], kind: KindOrAll) => (kind === 'ALL' ? list : list.filter((c) => c.authorKind === kind));
  const all: KindOrAll[] = ['ALL', ...KINDS];
  const by = <T,>(f: (kind: KindOrAll) => T) => Object.fromEntries(all.map((k) => [k, f(k)])) as Record<KindOrAll, T>;
  const span = (a: string | null, b: string | null) => (a && b ? workingDays(a, b) : null);
  // Pickup counts a change once someone has reviewed it. One still waiting isn't a figure yet (it is in the
  // open queue), and one whose reviews weren't read is unknown.
  // Review and merge time need an approval: one merged without any is counted apart (mergedUnreviewed), not as unknown.
  const approved = (list: Change[]) => list.filter((c) => c.approvedAt !== null || c.reviews === null);
  const pickedUp = (list: Change[]) => list.filter((c) => c.firstReviewAt !== null || c.reviews === null).map((c) => (c.firstReviewAt ? span(c.created, c.firstReviewAt) : null));
  return {
    from,
    to: now,
    pickup: by((k) => sample(pickedUp(of(opened, k)))),
    review: by((k) => sample(approved(of(merged, k)).map((c) => span(c.firstReviewAt, c.approvedAt)))),
    merge: by((k) => sample(approved(of(merged, k)).map((c) => span(c.approvedAt, c.mergedAt)))),
    rounds: by((k) => sample(of(merged, k).map((c) => (c.reviews ? (c.reviews.length ? 1 + c.reviews.filter((r) => r.state === 'CHANGES_REQUESTED').length : 0) : null)))),
    mergedUnreviewed: by((k) => of(merged, k).filter((c) => c.reviews !== null && !c.approvedAt).length),
    sizes: by((k) => {
      const out = Object.fromEntries([...SIZES, 'unknown'].map((s) => [s, 0])) as Record<SizeBucket | 'unknown', number>;
      for (const c of of(opened, k)) out[sizeOf(c).bucket ?? 'unknown']++;
      return out;
    }),
    throughput: by((k) => {
      const out: Week[] = Array.from({ length: weeks }, (_, i) => ({ start: new Date(last - (weeks - 1 - i) * WEEK).toISOString(), items: [], partial: i === weeks - 1 }));
      for (const c of of(merged, k)) {
        if (!c.mergedAt) continue;
        out.find((w) => w.start === weekStart(c.mergedAt!))?.items.push(c.id);
      }
      return out;
    }),
    unplacedMerges: merged.filter((c) => !c.mergedAt).length,
    counts: by((k) => of([...new Set([...opened, ...merged])], k).length),
  };
}

// Suggested reviewers ----------------------------------------------------------------------

/** The paths a change touches, from `pr get --include files` as each host sends them; null when they weren't read. */
export function pathsOf(c: Change): string[] | null {
  for (const [command, record] of Object.entries(c.native)) {
    if (!command.endsWith(' pr get') || typeof record !== 'object' || record === null) continue;
    const files = (record as { included?: { files?: unknown } }).included?.files;
    if (!Array.isArray(files)) continue;
    // GitHub's filename, Data Center's path.toString, Cloud's new (or old) path, Azure DevOps' item path.
    const text = (v: unknown, key: string): string | null => {
      const value = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined;
      return typeof value === 'string' && value !== '' ? value : null;
    };
    return files.flatMap((f) => {
      const r = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      const path = text(r, 'filename') ?? text(r.path, 'toString') ?? text(r.new, 'path') ?? text(r.old, 'path') ?? text(r.item, 'path');
      return path ? [path.replace(/^\//, '')] : [];
    });
  }
  return null;
}

/** One CODEOWNERS rule: a pattern and its owners, in file order (the last match wins). */
export interface OwnerRule {
  pattern: string;
  owners: string[];
  test: RegExp;
}

/** A CODEOWNERS pattern as a regular expression, by gitignore's rules for the subset CODEOWNERS uses. */
function ownerRegex(pattern: string): RegExp {
  let p = pattern;
  const dir = p.endsWith('/');
  if (dir) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.slice(0, -1).includes('/');
  p = p.replace(/^\//, '');
  const body = p
    .split(/(\*\*\/?|\*|\?)/)
    .map((part) => (part === '**/' || part === '**' ? '(?:.*/)?' + (part === '**' ? '.*' : '') : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${body}${dir ? '/.*' : '(?:/.*)?'}$`);
}

/** CODEOWNERS text as rules. Comments, blank lines and patterns with no owners are skipped. */
export function parseCodeowners(text: string): OwnerRule[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const clean = line.replace(/(^|\s)#.*$/, '').trim();
    if (!clean) return [];
    const [pattern, ...owners] = clean.split(/\s+/);
    if (!pattern || !owners.length) return [];
    return [{ pattern, owners: owners.map((o) => o.replace(/^@/, '')), test: ownerRegex(pattern === '*' ? '**' : pattern) }];
  });
}

/** The owners of one path: the last rule that matches. */
export function ownersOf(path: string, rules: OwnerRule[]): string[] {
  for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.test.test(path)) return rules[i]!.owners;
  return [];
}

export interface Suggested {
  id: string;
  /** Why: owns which paths, reviewed which changes to the same paths. */
  why: string[];
  score: number;
}

/** The directory a path sits in, which is what "the same paths" compares beside the file itself. */
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);

/**
 * Reviewers to suggest for an open change with none: the CODEOWNERS of its
 * paths (when the repository has one), then whoever reviewed other changes
 * touching the same files or folders. Never its author. Suggestions only:
 * asking for a review is a write, which a person applies.
 */
export function suggestReviewers(c: Change, others: Change[], rules: OwnerRule[] | null, max = 3): Suggested[] {
  const paths = pathsOf(c) ?? [];
  const author = c.author?.id.toLowerCase();
  const out = new Map<string, Suggested>();
  const add = (id: string, why: string, score: number) => {
    if (id.toLowerCase() === author) return;
    const s = out.get(id) ?? { id, why: [], score: 0 };
    if (!s.why.includes(why)) s.why.push(why);
    s.score += score;
    out.set(id, s);
  };
  if (rules) {
    for (const path of paths) for (const owner of ownersOf(path, rules)) add(owner, `owns ${path} in CODEOWNERS`, 3);
  }
  const mine = new Set(paths);
  const dirs = new Set(paths.map(dirOf));
  for (const other of others) {
    if (other.id === c.id || other.repo !== c.repo || !other.reviews?.length) continue;
    const theirs = pathsOf(other) ?? [];
    const same = theirs.filter((p) => mine.has(p));
    const near = theirs.filter((p) => !mine.has(p) && dirs.has(dirOf(p)));
    if (!same.length && !near.length) continue;
    const label = `#${other.id.slice(other.id.lastIndexOf('#') + 1)}`;
    for (const r of other.reviews) add(r.by.id, `reviewed ${label}, which changed ${same.length ? same[0] : `${dirOf(near[0]!)}…`}`, same.length ? 2 : 1);
  }
  return [...out.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, max);
}

/** A suggestion as a proposal: asking for a review is a write, which a person applies through toil's write gate. */
export function reviewProposal(c: Change, s: Suggested, toilProject: string): Proposal {
  const number = Number(c.id.slice(c.id.lastIndexOf('#') + 1));
  const base = { id: `review:${c.id}:${s.id}`, from: 'reviewers' as const, item: c.id, title: `Ask ${s.id} to review ${prName(c.id)}`, reason: `${s.id} ${s.why.join('; ')}.` };
  const area = c.source.area;
  if (area === 'github') {
    const team = s.id.includes('/');
    return { ...base, command: 'github pr add-reviewers', input: { toilProject, number, ...(team ? { teamReviewer: [s.id.slice(s.id.indexOf('/') + 1)] } : { reviewer: [s.id] }) }, note: null };
  }
  if (area === 'bitbucket') {
    // Data Center adds one reviewer; Cloud has no such command, so the list is replaced.
    if (c.source.deployment !== 'cloud') return { ...base, command: 'bitbucket pr add-reviewer', input: { toilProject, id: number, user: s.id }, note: null };
    return { ...base, command: 'bitbucket pr update', input: { toilProject, id: number, reviewers: s.id }, note: 'This replaces the reviewer list, which is empty now: check nobody was added since the last sync.' };
  }
  return { ...base, command: null, input: null, note: `toil has no command that adds a reviewer on ${sourceLabel(area)} yet. Add ${s.id} on the pull request's page${c.url ? `: ${c.url}` : ''}.` };
}
