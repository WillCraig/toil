// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache, type ToilProjectSave } from '../server/cache.ts';
import type { Envelope, WorkItem } from '../src/toil.ts';

/**
 * What a sync writes to the cache (#493): a second sync of the same toil project
 * rewrites nothing that did not change, and one changed item costs about one
 * item's rows. Counted with SQLite's own `total_changes()`, which counts every
 * row an INSERT, UPDATE or DELETE touched on the connection.
 *
 * Every row counted here was, at some point, in a status meeting.
 */

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-13T08:00:00.000Z');
const at = (ms: number) => new Date(T0 + ms).toISOString();
const folders: string[] = [];
const caches: Cache[] = [];

afterEach(() => {
  clock.ms = 0;
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

async function open(retentionDays = 30) {
  const dir = mkdtempSync(join(tmpdir(), 'toil-ui-writes-'));
  folders.push(dir);
  const cache = await Cache.open(dir, { retentionDays, now: () => new Date(T0 + clock.ms) });
  caches.push(cache);
  return cache;
}
const clock = { ms: 0 };
/** Rows written, updated or deleted on the cache's connection so far. */
const written = (cache: Cache) => Number(((cache as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT total_changes() AS n').get()).n);

const envelope = (command: string, data: unknown, durationMs = 0): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs, version: '0.1.0-alpha.2', contractVersion: 1 } }) as Envelope;

const item = (n: number, status = 'Done'): WorkItem =>
  ({
    owi: '0.1', id: `jira:PAY-${n}`, source: { area: 'jira', connection: 'jira', key: `PAY-${n}`, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story', title: `Item ${n}`, body: null,
    status, statusCategory: 'DONE', resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null, iteration: null,
    parent: null, children: [], links: [], created: null, updated: at(-DAY), resolved: null, dueDate: null,
    history: { transitions: [{ from: 'To Do', to: 'Doing', fromCategory: 'TODO', toCategory: 'DOING', at: at(-3 * DAY), by: null }, { from: 'Doing', to: status, fromCategory: 'DOING', toCategory: 'DONE', at: at(-DAY), by: null }], iterations: [] },
    unmapped: [], native: {},
  }) as unknown as WorkItem;

const COUNT = 300;
const change = (n: number, state = 'MERGED') => ({ id: `github:o/r#${n}`, kind: 'pull-request', source: 'github', command: 'github pr list', state, outcome: 'SUCCESS', at: at(-DAY), items: [`jira:PAY-${n}`] }) as never;

/** A toil project with COUNT items and a response for each one's history, as a large Jira project syncs. Built fresh each call, as a sync builds it. */
function toilProject(over: { changed?: number; durationMs?: number; fewer?: number } = {}): ToilProjectSave {
  const n = COUNT - (over.fewer ?? 0);
  const items = Array.from({ length: n }, (_, i) => item(i + 1, i + 1 === over.changed ? 'Blocked' : 'Done'));
  return {
    toilProject: 'card-payments',
    startedAt: at(clock.ms),
    finishedAt: at(clock.ms),
    responses: [
      { command: 'jira issue search', input: { toilProject: 'card-payments', jql: 'project = PAY' }, envelope: envelope('jira issue search', { issues: items.map((i) => ({ key: i.source.key })) }, over.durationMs ?? 0) },
      ...items.map((i) => ({ command: 'jira issue history', input: { toilProject: 'card-payments', key: i.source.key }, envelope: envelope('jira issue history', { key: i.source.key, status: i.status }, over.durationMs ?? 0) })),
    ],
    items,
    changes: [change(1), change(2, over.changed ? 'OPEN' : 'MERGED')],
    deployments: [],
    sources: [{ area: 'jira', ok: true, error: null, fix: null, watermark: at(clock.ms), calls: n + 1 }],
  };
}

describe('what a sync writes (#493)', () => {
  it('writes next to nothing for a second sync that found nothing new, whatever the calls took', async () => {
    const cache = await open();
    cache.saveToilProject(toilProject());
    const first = written(cache);
    expect(first).toBeGreaterThan(COUNT * 3);

    clock.ms = 3_600_000;
    const before = written(cache);
    cache.saveToilProject(toilProject({ durationMs: 180 }));
    const again = written(cache) - before;
    // The toil project's row, the source's, the sync run and little else: none of the 300 items, 600 transitions or 301 responses.
    expect(again).toBeLessThanOrEqual(8);
    expect(cache.items('card-payments')).toHaveLength(COUNT);
    expect(cache.transitions('card-payments')).toHaveLength(COUNT * 2);
    expect(cache.counts().responses).toBe(COUNT + 1);
  });

  it('writes about one item for one item that changed', async () => {
    const cache = await open();
    cache.saveToilProject(toilProject());
    clock.ms = 3_600_000;
    const before = written(cache);
    cache.saveToilProject(toilProject({ changed: 7 }));
    const delta = written(cache) - before;
    // The item, its two transitions (deleted and written again), the search and its history response, a pull request, and the bookkeeping.
    expect(delta).toBeGreaterThan(5);
    expect(delta).toBeLessThanOrEqual(40);
    expect(cache.items('card-payments').find((i) => i.id === 'jira:PAY-7')!.status).toBe('Blocked');
    expect(cache.transitions('card-payments', 'jira:PAY-7').map((t) => t.to)).toEqual(['Doing', 'Blocked']);
    expect(cache.changes('card-payments').find((c) => c.id === 'github:o/r#2')!.state).toBe('OPEN');
    expect(cache.response('card-payments', 'jira issue history', { toilProject: 'card-payments', key: 'PAY-7' })!.envelope.data).toEqual({ key: 'PAY-7', status: 'Blocked' });
  });

  it('deletes the items, transitions and responses a sync no longer has, and keeps the rest', async () => {
    const cache = await open();
    cache.saveToilProject(toilProject());
    clock.ms = 3_600_000;
    cache.saveToilProject(toilProject({ fewer: 2 }));
    expect(cache.items('card-payments').map((i) => i.id)).not.toContain(`jira:PAY-${COUNT}`);
    expect(cache.items('card-payments')).toHaveLength(COUNT - 2);
    expect(cache.transitions('card-payments', `jira:PAY-${COUNT}`)).toEqual([]);
    expect(cache.transitions('card-payments')).toHaveLength((COUNT - 2) * 2);
    expect(cache.response('card-payments', 'jira issue history', { toilProject: 'card-payments', key: `PAY-${COUNT}` })).toBeNull();
    expect(cache.response('card-payments', 'jira issue history', { toilProject: 'card-payments', key: 'PAY-1' })).not.toBeNull();
  });

  it('writes nothing for a response the sync reused, and still keeps it from being dropped', async () => {
    const cache = await open();
    cache.saveToilProject(toilProject());
    clock.ms = 3_600_000;
    const before = written(cache);
    const next = toilProject();
    // The sync handed back the last copy of every history, so they are not even compared.
    for (const r of next.responses.slice(1)) r.unchanged = true;
    cache.saveToilProject(next);
    expect(written(cache) - before).toBeLessThanOrEqual(8);
    expect(cache.counts().responses).toBe(COUNT + 1);
  });

  it('keeps rows nothing has changed for longer than the retention period, by refreshing them now and then', async () => {
    const cache = await open(30);
    cache.saveToilProject(toilProject());
    // A sync every eight days for forty: the rows are never rewritten for content, and never pruned.
    for (let day = 8; day <= 40; day += 8) {
      clock.ms = day * DAY;
      cache.saveToilProject(toilProject());
    }
    expect(cache.items('card-payments')).toHaveLength(COUNT);
    expect(cache.transitions('card-payments')).toHaveLength(COUNT * 2);
    expect(cache.counts().responses).toBe(COUNT + 1);
    expect(cache.changes('card-payments')).toHaveLength(2);
  });

  it('lets an untouched row age out when no sync reads it', async () => {
    const cache = await open(30);
    cache.saveToilProject(toilProject());
    clock.ms = 31 * DAY; // past the retention period
    expect(cache.prune()).toBeGreaterThan(0);
    expect(cache.items('card-payments')).toEqual([]);
  });

  it('prunes a Toil project rows together, though a sync refreshed only the ones that changed', async () => {
    const cache = await open(30);
    const keyed = (n: number) => ({ toilProject: 'card-payments', key: `PAY-${n}` });
    cache.saveToilProject(toilProject());
    // A week on, only item 1 changed: item 2 is under a quarter of the period old, so its rows are not refreshed.
    clock.ms = 7 * DAY;
    cache.saveToilProject(toilProject({ changed: 1 }));
    // The toil project's last sync is 24 days old on day 31, so everything stays.
    clock.ms = 31 * DAY;
    cache.prune();
    expect(cache.counts().responses).toBeGreaterThan(0);
    expect(cache.response('card-payments', 'jira issue search', { toilProject: 'card-payments', jql: 'project = PAY' })).not.toBeNull();
    expect(cache.response('card-payments', 'jira issue history', keyed(1))).not.toBeNull();
    expect(cache.response('card-payments', 'jira issue history', keyed(2))).not.toBeNull();
    expect(cache.items('card-payments')).toHaveLength(COUNT);
    expect(cache.transitions('card-payments')).toHaveLength(COUNT * 2);
    // Exactly `retention` days after the last sync is still inside; just past it, all of them go together.
    clock.ms = 37 * DAY;
    cache.prune();
    expect(cache.items('card-payments')).toHaveLength(COUNT);
    clock.ms = 37 * DAY + 1000;
    cache.prune();
    expect(cache.items('card-payments')).toEqual([]);
    expect(cache.transitions('card-payments')).toEqual([]);
    expect(cache.changes('card-payments')).toEqual([]);
    expect(cache.counts().responses).toBe(0);
    expect(cache.response('card-payments', 'jira issue history', keyed(1))).toBeNull();
    expect(cache.response('card-payments', 'jira issue history', keyed(2))).toBeNull();
  });

  it('expires everything of a Toil project together when its projects show keeps failing', async () => {
    const cache = await open(30);
    const tables = () => {
      const c = cache.counts();
      return [c.items, c.responses, c.transitions, c.change_refs, c.worklog_events, c.sources].map((n) => n ?? 0);
    };
    cache.saveToilProject(toilProject());
    expect(tables().every((n) => n > 0)).toBe(true);
    expect(cache.counts().toil_projects).toBe(1);
    // One good save on day 0, then a failed projects show and a prune every eight days.
    for (const day of [8, 16, 24, 32, 40, 48, 56, 64, 72, 80, 88, 96]) {
      clock.ms = day * DAY;
      cache.saveFailure('card-payments', at(clock.ms), 'projects show failed');
      cache.prune();
      const counts = tables();
      // All of it or none of it, never half.
      expect(counts.every((n) => n > 0) || counts.every((n) => n === 0)).toBe(true);
      if (day <= 24) {
        expect(counts.every((n) => n > 0)).toBe(true);
        expect(cache.items('card-payments')).toHaveLength(COUNT);
        expect(cache.source('card-payments', 'jira')).not.toBeNull();
        // The last attempt moves, the last save does not.
        const state = cache.states().find((d) => d.name === 'card-payments')!;
        expect(state.lastSyncAt).toBe(at(clock.ms));
        expect(state.lastSavedAt).toBe(at(0));
      } else {
        // The synced data and its sources are gone; at most the failure itself (no save) is left of the toil project row.
        expect(counts.every((n) => n === 0)).toBe(true);
        expect(cache.states().find((d) => d.name === 'card-payments')?.lastSavedAt ?? null).toBeNull();
      }
      if (day === 24) expect(cache.counts().toil_projects).toBe(1);
    }
  });

  it('exactly retention days after the last save is still inside; just past it all of it goes, sources and the Toil project row too', async () => {
    const cache = await open(30);
    cache.saveToilProject(toilProject());
    clock.ms = 30 * DAY;
    cache.prune();
    expect(cache.counts().toil_projects).toBe(1);
    expect(cache.counts().sources).toBe(1);
    clock.ms = 30 * DAY + 1000;
    cache.prune();
    const c = cache.counts();
    expect([c.items, c.responses, c.transitions, c.change_refs, c.worklog_events, c.sources, c.toil_projects]).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it('drops a Toil project that only ever failed by its last attempt', async () => {
    const cache = await open(30);
    cache.saveFailure('never-synced', at(0), 'nope');
    clock.ms = 30 * DAY;
    cache.prune();
    expect(cache.counts().toil_projects).toBe(1);
    clock.ms = 30 * DAY + 1000;
    cache.prune();
    expect(cache.counts().toil_projects).toBe(0);
  });

  it('expires the worklog facts of items that left the sync, while the Toil project keeps syncing, and keeps the live ones', async () => {
    const cache = await open(30);
    const factsOf = (n: number) => cache.worklogEvents('card-payments').filter((e) => new RegExp(`PAY-${n}(?![0-9])`).test(JSON.stringify(e)));
    const live = [1, 2, 3];
    cache.saveToilProject(toilProject());
    const all = cache.worklogEvents('card-payments').length;
    expect(all).toBeGreaterThan(COUNT);
    const liveFacts = live.flatMap(factsOf).length;
    expect(liveFacts).toBeGreaterThan(0);
    // A sync every eight days with only items 1 to 3 left: the other facts are never produced again.
    for (let day = 8; day <= 96; day += 8) {
      clock.ms = day * DAY;
      cache.saveToilProject(toilProject({ fewer: COUNT - 3 }));
      if (day >= 40) expect(factsOf(10)).toEqual([]);
    }
    expect(factsOf(300)).toEqual([]);
    expect(live.flatMap(factsOf)).toHaveLength(liveFacts);
    expect(cache.worklogEvents('card-payments')).toHaveLength(liveFacts);
    expect(cache.items('card-payments')).toHaveLength(3);
    expect(cache.transitions('card-payments')).toHaveLength(6);
    expect(cache.counts().responses).toBe(4);
  });
});
