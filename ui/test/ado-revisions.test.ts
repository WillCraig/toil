// @vitest-environment node
import { mapOwi } from '@imagile-dev/toil/api';
import { describe, expect, it } from 'vitest';
import { feedStart, mergeFeed, splitRevisionFeed } from '../src/ado-revisions.ts';
import { ADO_BATCH, ADO_FEED, ADO_IDS, ADO_ITERATIONS, ADO_REVISIONS } from '../src/fixtures/work.ts';
import type { Envelope } from '../src/toil.ts';

/**
 * `ado work-item feed` against one `ado work-item history` call per item:
 * whichever way a history reached the loader, `mapOwi` has to see the same
 * input and give the same items (#493). The sample's histories are the
 * per-item side; the feed side is the same revisions as the reporting feed
 * sends them (people as `Name <unique name>` text, no url, `System.Id` and
 * `System.Rev` among the fields), so a pass here means the text form maps to the
 * same people as the identity object.
 */

type Rec = Record<string, unknown>;
type Revision = { id: number; rev: number; fields: Rec };
const meta = (command: string) => ({ command, durationMs: 0, version: 'test', contractVersion: 1 });
const env = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: meta(command) }) as unknown as Envelope;

const HISTORY = 'ado work-item history';
const items = ADO_BATCH.value as unknown as Rec[];
/**
 * The mapped items with the raw history records set aside. `mapOwi` keeps every
 * record it read under `native`, so the history's own records (identity
 * objects and urls from `work-item history`, text and system fields from the
 * feed) are the one thing that differs between the two paths; no view reads
 * them (a history is an array, which readiness and the assignment model skip).
 * Everything else, transitions and iteration moves included, is compared whole.
 */
const same = (items: Array<{ native?: Rec }>) => items.map((i) => ({ ...i, native: Object.fromEntries(Object.entries(i.native ?? {}).filter(([k]) => k !== HISTORY)) }));
const iterations = env('ado work-item iterations', ADO_ITERATIONS);
const batch = env('ado work-item get-many', ADO_BATCH);

/** The whole feed, from the beginning of time: every item's revisions, in the order they were made. */
const whole = ADO_IDS.flatMap((id) => ADO_REVISIONS[id] as Revision[]).map((r) => ADO_FEED.find((f) => f.id === r.id && f.rev === r.rev) ?? asFeed(r));
function asFeed(r: Revision): Revision {
  const by = r.fields['System.ChangedBy'] as { displayName: string; uniqueName: string };
  return { id: r.id, rev: r.rev, fields: { 'System.Id': r.id, 'System.Rev': r.rev, ...r.fields, 'System.ChangedBy': `${by.displayName} <${by.uniqueName}>` } };
}

/** What the loader gave mapOwi before: the iterations, the batch, then each item's `work-item history` envelope. */
const perItem = () => [iterations, batch, ...ADO_IDS.map((id) => env(HISTORY, ADO_REVISIONS[id]))];

/** What it gives now: the same, with the histories the feed holds whole taken from it and the rest read one by one. */
function viaFeed(feed: Revision[], override?: string) {
  const { histories, incomplete } = splitRevisionFeed(env('ado work-item feed', feed), items, HISTORY, override);
  return { docs: [iterations, batch, ...histories, ...incomplete.map((id) => env(HISTORY, ADO_REVISIONS[id]))], histories, incomplete };
}

describe('the revision feed, split back into what mapOwi has always read', () => {
  it('maps to the same items as one history call per item, when the feed holds every revision', () => {
    const before = mapOwi(perItem());
    const { docs, incomplete } = viaFeed(whole);
    expect(incomplete).toEqual([]);
    const after = mapOwi(docs);
    expect(same(after.items)).toEqual(same(before.items));
    expect(after.warnings).toEqual(before.warnings);
    // Not vacuous: the items carry transitions and iteration moves, by people.
    expect(after.items.some((i) => (i.history?.transitions.length ?? 0) > 1)).toBe(true);
    expect(after.items.some((i) => (i.history?.iterations.length ?? 0) > 0)).toBe(true);
    expect(after.items.flatMap((i) => i.history?.transitions ?? []).every((t) => t.by?.name)).toBe(true);
  });

  it('maps to the same items when the feed starts mid-history: the item it holds part of is read with work-item history', () => {
    // The sample feed starts after 2301's first revision (08-24).
    const { docs, incomplete, histories } = viaFeed(ADO_FEED);
    expect(incomplete).toEqual([2301]);
    expect(histories).toHaveLength(ADO_IDS.length - 1);
    const before = mapOwi(perItem());
    const after = mapOwi(docs);
    expect(same(after.items)).toEqual(same(before.items));
    expect(after.warnings).toEqual(before.warnings);
  });

  it('maps people the same whether the feed spells them as text or the identity object, on a Services-style address as on a Server account', () => {
    const email = (r: Revision): Revision => ({ ...r, fields: { ...r.fields, 'System.ChangedBy': String(r.fields['System.ChangedBy']).replace(/<IMAGILE\\([^>]+)>/, '<$1@example.com>') } });
    const asObject = (id: number) => (ADO_REVISIONS[id] as Revision[]).map((r) => {
      const by = r.fields['System.ChangedBy'] as Rec;
      return { ...r, fields: { ...r.fields, 'System.ChangedBy': { ...by, uniqueName: String(by.uniqueName).replace(/^IMAGILE\\(.+)$/, '$1@example.com') } } };
    });
    const text = whole.map(email);
    const { histories } = splitRevisionFeed(env('ado work-item feed', text), items, HISTORY);
    const before = mapOwi([iterations, batch, ...ADO_IDS.map((id) => env(HISTORY, asObject(id)))]);
    const after = mapOwi([iterations, batch, ...histories]);
    expect(same(after.items)).toEqual(same(before.items));
    expect(after.items.flatMap((i) => i.history?.transitions ?? []).some((t) => t.by?.email?.endsWith('@example.com'))).toBe(true);
  });

  it('gives mapOwi each history in the shape of work-item history: oldest first, under that command, with no paging or warnings of the feed', () => {
    const shuffled = [...whole].reverse();
    const { histories } = splitRevisionFeed({ ...env('ado work-item feed', shuffled), meta: { ...meta('ado work-item feed'), page: { nextCursor: null, limit: 5 }, warnings: [{ code: 'X', message: 'x' }] } } as unknown as Envelope, items, HISTORY);
    for (const h of histories) {
      const m = (h as unknown as { meta: Rec }).meta;
      expect(m.command).toBe(HISTORY);
      expect(m.page).toBeUndefined();
      expect(m.warnings).toBeUndefined();
      const revs = (h as unknown as { data: Revision[] }).data.map((r) => r.rev);
      expect(revs).toEqual([...revs].sort((a, b) => a - b));
    }
  });
});

describe('an item is taken from the feed only when its revisions run from 1 to its rev', () => {
  const only = (id: number, drop: (r: Revision) => boolean = () => false) => whole.filter((r) => r.id === id && !drop(r));
  const split = (feed: Revision[], rev: number, id = 2290) => splitRevisionFeed(env('ado work-item feed', feed), [{ id, rev }], HISTORY);

  it('takes an item whose revisions are all there', () => {
    expect(split(only(2290), 4).incomplete).toEqual([]);
  });

  it('refuses the oldest revision missing: a feed that starts after the item was created', () => {
    expect(split(only(2290, (r) => r.rev === 1), 4).incomplete).toEqual([2290]);
  });

  it('refuses a gap in the middle (a revision the watermark missed)', () => {
    expect(split(only(2290, (r) => r.rev === 2), 4).incomplete).toEqual([2290]);
  });

  it('refuses the newest revision missing, and a feed that is ahead of the item get-many read', () => {
    expect(split(only(2290, (r) => r.rev === 4), 4).incomplete).toEqual([2290]);
    expect(split(only(2290), 3).incomplete).toEqual([2290]);
  });

  it('refuses an item the feed has no revisions of (open, and nobody touched it since the window opened), and an item with no rev to check against', () => {
    expect(split([], 4).incomplete).toEqual([2290]);
    expect(splitRevisionFeed(env('ado work-item feed', only(2290)), [{ id: 2290 }], HISTORY).incomplete).toEqual([2290]);
  });

  it('refuses a revision with no change date, and one by a person the text form does not name', () => {
    const noDate = only(2290).map((r) => (r.rev === 2 ? { ...r, fields: { ...r.fields, 'System.ChangedDate': undefined } } : r));
    expect(split(noDate, 4).incomplete).toEqual([2290]);
    const odd = only(2290).map((r) => (r.rev === 2 ? { ...r, fields: { ...r.fields, 'System.ChangedBy': 'a service' } } : r));
    expect(split(odd, 4).incomplete).toEqual([2290]);
  });

  it('refuses every item when the Toil project names its own iteration field, or the feed call failed', () => {
    expect(splitRevisionFeed(env('ado work-item feed', whole), items, HISTORY, 'Custom.Iteration').incomplete).toEqual(ADO_IDS);
    const failed = { ok: false, data: null, error: { code: 'HTTP', message: 'down' }, meta: meta('ado work-item feed') } as unknown as Envelope;
    expect(splitRevisionFeed(failed, items, HISTORY).incomplete).toEqual(ADO_IDS);
    expect(splitRevisionFeed(null, items, HISTORY).histories).toEqual([]);
  });
});

describe('a feed read in two parts is the feed read whole', () => {
  it('laid over by item and revision, with the overlap a watermark margin brings, maps to the same items as a fresh read', () => {
    const at = (r: Revision) => Date.parse(String(r.fields['System.ChangedDate']));
    const cut = Date.parse('2026-09-24T00:00:00Z');
    const cached = whole.filter((r) => at(r) <= cut);
    // The delta starts a day before the cut, as SKEW_MS makes it start a little before the watermark: those revisions arrive twice.
    const delta = whole.filter((r) => at(r) > cut - 86_400_000);
    expect(delta.filter((r) => at(r) <= cut).length).toBeGreaterThan(0);
    const merged = mergeFeed(cached as Rec[], delta as Rec[]);
    expect(merged).toHaveLength(whole.length);
    const fresh = viaFeed(whole);
    const lay = viaFeed(merged as Revision[]);
    expect(lay.incomplete).toEqual([]);
    expect(same(mapOwi(lay.docs).items)).toEqual(same(mapOwi(fresh.docs).items));
    expect(same(mapOwi(lay.docs).items)).toEqual(same(mapOwi(perItem()).items));
  });

  it('keeps the newer copy of a revision read twice, and drops the items the sync no longer lists', () => {
    const merged = mergeFeed([{ id: 1, rev: 1, fields: { v: 'old' } }, { id: 2, rev: 1, fields: {} }], [{ id: 1, rev: 1, fields: { v: 'new' } }, { id: 1, rev: 2, fields: {} }], new Set([1]));
    expect(merged).toEqual([{ id: 1, rev: 1, fields: { v: 'new' } }, { id: 1, rev: 2, fields: {} }]);
  });

  it('leaves a hole where the delta missed a revision, which the next read of the item catches', () => {
    const cached = whole.filter((r) => r.id === 2290 && r.rev <= 2);
    const delta = whole.filter((r) => r.id === 2290 && r.rev === 4);
    const lay = splitRevisionFeed(env('ado work-item feed', mergeFeed(cached as Rec[], delta as Rec[]) as Revision[]), [{ id: 2290, rev: 4 }], HISTORY);
    expect(lay.incomplete).toEqual([2290]);
  });
});

describe('the start of the feed', () => {
  it('is a day before the window opens, so it covers the whole of WIQL\'s first day', () => {
    expect(feedStart(new Date('2026-10-13T08:00:00.000Z'), 42)).toBe('2026-08-31T08:00:00.000Z');
  });
});
