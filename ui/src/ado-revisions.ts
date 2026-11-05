/**
 * Azure DevOps has two ways to say how a work item changed. `ado work-item
 * history <id>` lists one item's revisions, and `ado work-item feed` is
 * the project's reporting feed, every revision of every item from a date on
 * (#493). `mapOwi` reads the first; a sync that asked for each of 3000 items
 * would rather read the second. This is the adapter between them, and its one
 * rule is that nothing partial is ever mapped as if whole.
 *
 * **When the feed's revisions of an item are that item's history.** A feed that
 * starts at a date holds only the later revisions of an item created before it,
 * and an open item nobody has touched since holds none. So an item's revisions
 * are taken from the feed only when they are exactly 1 to the item's own `rev`
 * (as `get-many` read it): no gap, nothing past it, nothing missing at the
 * start. `rev` counts an item's saves, so a run from 1 to `rev` is every
 * revision there is, whatever the item's created date or the feed's start. Any
 * other item is named in `incomplete`, and the loader reads it with `work-item
 * history`, which reads the whole of it.
 *
 * **What else has to look the same.** `mapOwi` reads a revision's `rev`,
 * `System.ChangedDate`, `System.ChangedBy`, `System.State` and the iteration
 * path (`System.IterationPath`, or the toil project's own field). The feed sends
 * people as `Name <email>` text where `work-item history` sends an identity
 * object, and `mapOwi` reads both to the same person. An item is left to
 * `work-item history` too when the toil project points `mapOwi` at a field of its
 * own for the iteration (the feed sends reportable fields only, and nothing
 * here can tell an empty one from a missing one), when a revision has no
 * `System.ChangedDate`, or when `System.ChangedBy` is text that is not `Name
 * <email>`. Those are the doubts this file can see; the rest are in
 * docs/decisions/493-ado-revisions.md.
 *
 * One difference stays: `mapOwi` keeps the records it read under `native`, so an item's `native["ado work-item history"]` holds the feed's revisions; no view reads it.
 *
 * Two lists of one history have been known to need a steering committee. This is a function.
 */

import type { Envelope } from './toil.ts';

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const DAY = 86_400_000;

/** The fields of a revision that `mapOwi` reads (adoHistory): the revision's `rev` is the feed's own, the rest are asked for by name. */
export const ADO_FEED_FIELDS = 'System.Rev,System.ChangedDate,System.ChangedBy,System.State,System.IterationPath';

/** `Name <email>`: the text form of an identity in the feed. */
const NAMED = /^.+<[^<>]+>$/;

/**
 * The instant the feed is asked to start at: a day before the window opens, so
 * it covers WIQL's `@Today - n`, which counts from the start of today.
 */
export const feedStart = (now: Date, windowDays: number): string => new Date(now.getTime() - (windowDays + 1) * DAY).toISOString();

export interface SplitFeed {
  /** One per item whose revisions the feed holds whole, in the shape of `work-item history`'s envelope (oldest first). */
  histories: Envelope[];
  /** Ids of the items the feed does not hold whole: read these with `work-item history`. */
  incomplete: number[];
}

/** The revisions of one item as `work-item history` lists them, if the feed has exactly revisions 1 to `rev`. */
function wholeRevisions(revisions: Rec[] | undefined, rev: unknown): Rec[] | null {
  if (!revisions?.length || typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1 || revisions.length !== rev) return null;
  const sorted = [...revisions].sort((a, b) => Number(a.rev) - Number(b.rev));
  for (const [n, r] of sorted.entries()) {
    if (r.rev !== n + 1 || !isRec(r.fields)) return null;
    if (typeof r.fields['System.ChangedDate'] !== 'string') return null;
    const by = r.fields['System.ChangedBy'];
    if (typeof by === 'string' && !NAMED.test(by)) return null;
  }
  return sorted;
}

/**
 * The feed split into what `mapOwi` has always been given. `items` are the
 * work items `get-many` returned (each with its `id` and `rev`), `historyCommand`
 * names the command the envelopes stand in for, and `iterationOverride` is the
 * toil project's own iteration field, when it sets one: any such field sends every
 * item to `work-item history`.
 */
export function splitRevisionFeed(feed: Envelope | null, items: Rec[], historyCommand: string, iterationOverride?: string): SplitFeed {
  const ids = items.map((i) => Number(i.id)).filter(Number.isFinite);
  if (!feed || !feed.ok || !Array.isArray(feed.data) || iterationOverride !== undefined) return { histories: [], incomplete: ids };
  const byItem = new Map<number, Rec[]>();
  for (const r of feed.data) {
    if (!isRec(r) || typeof r.id !== 'number') continue;
    const list = byItem.get(r.id);
    if (list) list.push(r);
    else byItem.set(r.id, [r]);
  }
  const meta = { ...feed.meta, command: historyCommand } as Rec;
  delete meta.page;
  delete meta.warnings;
  const histories: Envelope[] = [];
  const incomplete: number[] = [];
  for (const item of items) {
    const id = Number(item.id);
    const whole = wholeRevisions(byItem.get(id), item.rev);
    if (whole === null) incomplete.push(id);
    else histories.push({ ok: true, data: whole, error: null, meta } as unknown as Envelope);
  }
  return { histories, incomplete };
}

/** The key a revision is known by: an item's revision numbers never repeat. */
const revisionKey = (r: Rec) => `${r.id}@${r.rev}`;

/**
 * The cached feed with a delta read from a watermark laid over it, by item and
 * revision number (a revision read twice, as the watermark's margin makes
 * likely, is kept once, the newer copy). `keep`, when given, drops the items
 * the sync no longer lists, so the cached feed stays the size of the window.
 * The merged feed is whole where `splitRevisionFeed` can tell: it sees the same
 * run of 1 to `rev` or it reads the item with `work-item history`.
 */
export function mergeFeed(cached: Rec[], fresh: Rec[], keep?: Set<number>): Rec[] {
  const byKey = new Map<string, Rec>();
  for (const r of cached) byKey.set(revisionKey(r), r);
  for (const r of fresh) byKey.set(revisionKey(r), r);
  const all = [...byKey.values()];
  return keep ? all.filter((r) => keep.has(Number(r.id))) : all;
}
