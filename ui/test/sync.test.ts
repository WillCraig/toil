// @vitest-environment node
import { mapOwi } from '@imagile-dev/toil/api';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache } from '../server/cache.ts';
import type { RequestContext } from '../server/context.ts';
import { sqliteStore } from '../server/store.ts';
import { SKEW_MS, SyncBusy, SyncService, joinPages } from '../server/sync.ts';
import { TOIL_PROJECTS } from '../src/fixtures/toil-projects.ts';
import { JIRA_CUT_SHORT } from '../src/fixtures/work.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { JQL, loadToilProject } from '../src/load.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { JIRA_PAGE, stubToil, type StubToil } from './toil-stub.ts';

/**
 * The sync, against a stubbed toil (test/toil-stub.ts) and a cache in a
 * throwaway folder under the OS temp folder, never the real ~/.toil-ui. It
 * covers a full sync, an incremental one that fetches only what changed, a
 * failing source kept apart from the rest, and the dashboards rendering from
 * the cache exactly as they render from toil.
 */

const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal };
const TOIL = { version: '0.1.0-alpha.2', contractVersion: 1 };
const folders: string[] = [];
const caches: Cache[] = [];

afterEach(() => {
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

async function setup(start = FIXTURE_NOW) {
  const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-sync-'));
  folders.push(dataDir);
  let clock = Date.parse(start);
  const now = () => new Date(clock);
  const cache = await Cache.open(dataDir, { retentionDays: 30, now });
  caches.push(cache);
  const toil = stubToil();
  const sync = new SyncService({ cache, execute: toil.execute, mapOwi, now });
  // The views' execute(), over the SQLite Store; toil projects go to the stub, as they'd go to toil.
  const store = sqliteStore(() => cache, toil.execute as unknown as Execute, TOIL);
  const viaStore: Execute = (command, input = {}) => store.execute(ctx, command, input, 'read');
  return { dataDir, cache, toil, sync, viaStore, advance: (ms: number) => (clock += ms) };
}

const named = (toil: StubToil, command: string) => toil.calls.filter((c) => c.command === command);

describe('the cache folder', () => {
  it('is the data folder the settings name, under the OS temp folder here, never ~/.toil-ui', async () => {
    const { cache, dataDir } = await setup();
    expect(cache.paths.db).toBe(join(dataDir, 'cache', 'toil-ui.db'));
    expect(relative(tmpdir(), cache.paths.db).startsWith('..')).toBe(false);
    expect(cache.paths.db.startsWith(join(homedir(), '.toil-ui'))).toBe(false);
    expect(existsSync(cache.paths.db)).toBe(true);
  });
});

describe('a full sync', () => {
  it('fills the cache from every Toil project, read-only and named toil-ui, following nextCursor', async () => {
    const { cache, toil, sync } = await setup();
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();
    expect(job.toilProjectsDone).toBe(3);
    // The stub refuses anything but readOnly toil-ui calls, so every call being ok proves both.
    const states = cache.states();
    expect(states.map((d) => [d.name, d.status])).toEqual(TOIL_PROJECTS.map((d) => [d.name, 'ok']).sort());
    expect(states.flatMap((d) => d.sources.map((s) => `${d.name}/${s.area}:${s.status}`)).sort()).toEqual(
      ['card-payments/bitbucket:ok', 'card-payments/jenkins:ok', 'card-payments/jira:ok', 'card-payments/openshift:ok', 'checkout-web/bitbucket:ok', 'checkout-web/github:ok', 'checkout-web/openshift:ok', 'settlement/ado:ok'],
    );
    // Histories came with the search; only the issue whose changelog the sample cuts short was read with a call of its own.
    expect(named(toil, 'jira issue history').map((c) => c.input.key)).toEqual(JIRA_CUT_SHORT);
    // jira issue search came in pages of JIRA_PAGE, every one followed.
    const pages = named(toil, 'jira issue search');
    const issues = (await fixtureExecute().execute('jira issue search', { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true }, { readOnly: true })).data as { issues: unknown[] };
    expect(pages.length).toBe(Math.ceil(issues.issues.length / JIRA_PAGE));
    expect(pages.slice(1).map((p) => p.input.cursor)).toEqual(pages.slice(1).map((_, i) => String((i + 1) * JIRA_PAGE)));
    // OWI items, transitions and change refs are stored.
    expect(cache.items('card-payments').length).toBe(issues.issues.length);
    expect(cache.items('settlement').every((i) => i.source.area === 'ado')).toBe(true);
    expect(cache.transitions('card-payments').length).toBeGreaterThan(0);
    expect(cache.changes('card-payments').map((c) => c.kind)).toEqual(expect.arrayContaining(['pull-request', 'build', 'deployment']));
    expect(job.requests).toBe(toil.calls.length);
    expect(job.messages.some((m) => m.startsWith('card-payments: '))).toBe(true);
  });

  it('lets every dashboard render from the cache exactly as it renders from toil', async () => {
    const { sync, viaStore } = await setup();
    await sync.run(ctx);
    for (const { name } of TOIL_PROJECTS) {
      const fromToil = await loadToilProject(fixtureExecute().execute, name, { mapOwi });
      const fromCache = await loadToilProject(viaStore, name, { mapOwi });
      expect(fromCache.items, name).toEqual(fromToil.items);
      expect(fromCache.changes, name).toEqual(fromToil.changes);
      expect(fromCache.deployments, name).toEqual(fromToil.deployments);
      expect(Object.values(fromCache.calls).flat().every((c) => c.ok), name).toBe(true);
    }
  });

  it('answers a call it never synced with a refusal that says to sync', async () => {
    const { viaStore } = await setup();
    const env = await viaStore('jira issue search', { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true });
    expect(env.ok).toBe(false);
    if (!env.ok) {
      expect(env.error.code).toBe('NOT_FOUND');
      expect(env.error.fix).toContain('Sync now');
    }
  });
});

describe('an incremental sync', () => {
  it('asks only for what changed since the watermark, and fetches the history of only the changed items', async () => {
    const { toil, sync, cache, viaStore, advance } = await setup();
    const first = Date.parse(FIXTURE_NOW);
    await sync.run(ctx);
    expect(cache.source('card-payments', 'jira')!.watermark).toBe(new Date(first - SKEW_MS).toISOString());
    // The first read: one feed of revisions since the window opened, and a history call only for the item whose revisions start before it (2301, from 08-24).
    expect(named(toil, 'ado work-item feed')).toHaveLength(1);
    expect(named(toil, 'ado work-item history').map((c) => c.input.id)).toEqual([2301]);

    advance(3_600_000);
    const at = new Date(first + 1_800_000).toISOString();
    toil.touchJira('PAY-104', 'Done', at);
    toil.touchAdo(2302, 'Resolved', at);
    toil.reset();
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();

    const searches = named(toil, 'jira issue search');
    expect(searches).toHaveLength(1);
    expect(searches[0]!.input.updatedSince).toBe(new Date(first - SKEW_MS).toISOString());
    // The delta search brings PAY-104's fresh history with it; the one issue the sample's changelog is cut short on is not among the changed, so it keeps its cached history.
    expect(searches[0]!.input.changelog).toBe(true);
    expect(named(toil, 'jira issue history')).toEqual([]);

    expect(named(toil, 'ado work-item search')[0]!.input.updatedSince).toBe(new Date(first - SKEW_MS).toISOString());
    expect(named(toil, 'ado work-item get-many').map((c) => c.input.id)).toEqual([[2302]]);
    // The new revision comes from the feed since the watermark and is laid over the last copy: no history call, and 2301's stays the one it had.
    expect(named(toil, 'ado work-item feed').map((c) => c.input.updatedSince)).toEqual([new Date(first - SKEW_MS).toISOString()]);
    expect(named(toil, 'ado work-item history')).toEqual([]);

    // Nothing on the GitHub board moved, so no issue or timeline was fetched again.
    expect(named(toil, 'github project items')).toHaveLength(1);
    expect(named(toil, 'github issue get')).toHaveLength(0);
    expect(named(toil, 'github issue history')).toHaveLength(0);
    expect(job.reused).toBeGreaterThan(10);

    // The merged answer still holds every item, with the change in it.
    const card = await loadToilProject(viaStore, 'card-payments', { mapOwi });
    expect(card.items).toHaveLength(cache.items('card-payments').length);
    expect(card.items.find((i) => i.source.key === 'PAY-104')!.status).toBe('Done');
    const settle = await loadToilProject(viaStore, 'settlement', { mapOwi });
    expect(settle.items.find((i) => i.source.key === '2302')!.status).toBe('Resolved');
    // ... and its history has the move the feed carried, the same as a whole read of the tracker gives.
    expect(settle.items.find((i) => i.source.key === '2302')!.history?.transitions.at(-1)).toMatchObject({ to: 'Resolved' });
    expect(cache.source('card-payments', 'jira')!.watermark).toBe(new Date(first + 3_600_000 - SKEW_MS).toISOString());
  });

  it('asks each code host for the pull requests changed since the watermark, and reads again only those and the open ones', async () => {
    const { toil, sync, advance, viaStore } = await setup();
    const first = Date.parse(FIXTURE_NOW);
    await sync.run(ctx);
    // #48 is merged; a late comment updates it after the first sync.
    const list = toil.canned.find((c) => c.command === 'github pr list')!.data as Array<{ number: number; updated_at: string }>;
    list.find((p) => p.number === 48)!.updated_at = new Date(first + 1_800_000).toISOString();
    advance(3_600_000);
    toil.reset();
    await sync.run(ctx);
    const since = new Date(first - SKEW_MS).toISOString();
    for (const command of ['github pr list', 'ado pr list']) expect(named(toil, command).map((c) => c.input.updatedSince), command).toEqual([since]);
    // Bitbucket is asked once for each toil project that has it: Data Center for card-payments, Cloud for checkout-web.
    expect(named(toil, 'bitbucket pr list').map((c) => c.input.updatedSince)).toEqual([since, since]);
    // The open ones every time (a check finishing isn't an update everywhere), the changed merged one, and no other merged one.
    expect(named(toil, 'github pr get').map((c) => c.input.number).sort()).toEqual([48, 51, 52, 53]);
    expect(named(toil, 'bitbucket pr get').map((c) => c.input.id).sort((a, b) => Number(a) - Number(b))).toEqual([12, 305, 311]);
    expect(named(toil, 'ado pr get').map((c) => c.input.id)).toEqual([87]);
    // And the merged list still holds every pull request.
    const web = await loadToilProject(viaStore, 'checkout-web', { mapOwi });
    expect(web.pullRequests).toHaveLength(8);
  });

  it('fetches a GitHub issue again when its board item says it was updated', async () => {
    const { toil, sync, advance } = await setup();
    await sync.run(ctx);
    const board = toil.canned.find((c) => c.command === 'github project items')!.data as Array<{ content: { number: number; updatedAt: string } }>;
    board.find((i) => i.content.number === 43)!.content.updatedAt = '2026-10-13T08:30:00Z';
    advance(3_600_000);
    toil.reset();
    await sync.run(ctx);
    expect(named(toil, 'github issue get').map((c) => c.input.number)).toEqual([[43]]);
    expect(named(toil, 'github issue history').map((c) => c.input.number)).toEqual([43]);
  });

  it('syncs one Toil project when asked, and leaves the others as they were', async () => {
    const { toil, sync, cache } = await setup();
    await sync.run(ctx);
    const before = cache.states().find((d) => d.name === 'settlement')!.lastSyncAt;
    toil.reset();
    await sync.run(ctx, 'card-payments');
    expect(toil.calls.some((c) => c.input.toilProject === 'settlement')).toBe(false);
    expect(cache.states().find((d) => d.name === 'settlement')!.lastSyncAt).toBe(before);
    await expect(sync.run(ctx, 'nope')).resolves.toMatchObject({ error: expect.stringContaining('no Toil project named "nope"') });
  });
});

describe('deleted and moved items (#493)', () => {
  const keys = (items: Array<{ source: { key: string } }>) => items.map((i) => i.source.key);

  it('drops a Jira issue the source no longer has once a day, and keeps it in between', async () => {
    const { toil, sync, cache, viaStore, advance } = await setup();
    await sync.run(ctx);
    expect(cache.source('card-payments', 'jira')!.fullReadAt).toBe(FIXTURE_NOW);
    toil.removeJira('PAY-104');

    // An hour on, the search asks only since the watermark, which can't list a deletion: the issue stays.
    advance(3_600_000);
    toil.reset();
    await sync.run(ctx);
    expect(named(toil, 'jira issue search').map((c) => c.input.fields)).toEqual([undefined]);
    expect(keys(cache.items('card-payments'))).toContain('PAY-104');

    // A day after the last whole listing: the delta, and then the ids alone, with no watermark.
    advance(24 * 3_600_000);
    toil.reset();
    const job = await sync.run(ctx);
    const searches = named(toil, 'jira issue search').filter((c) => c.input.cursor === undefined);
    expect(searches.map((c) => [c.input.updatedSince !== undefined, c.input.fields])).toEqual([[true, undefined], [false, 'key']]);
    // The delta brings changelogs; the ids-only listing asks for none.
    expect(searches.map((c) => c.input.changelog)).toEqual([true, undefined]);
    expect(keys(cache.items('card-payments'))).not.toContain('PAY-104');
    expect(named(toil, 'jira issue history').map((c) => c.input.key)).not.toContain('PAY-104');
    expect(job.messages.some((m) => m.includes('listed whole: 1 no longer there'))).toBe(true);
    const card = await loadToilProject(viaStore, 'card-payments', { mapOwi });
    expect(keys(card.items)).not.toContain('PAY-104');
    expect(card.items).toHaveLength(cache.items('card-payments').length);
    expect(cache.source('card-payments', 'jira')!.fullReadAt).toBe(new Date(Date.parse(FIXTURE_NOW) + 25 * 3_600_000).toISOString());

    // And an hour after that is quiet again.
    advance(3_600_000);
    toil.reset();
    await sync.run(ctx);
    expect(named(toil, 'jira issue search')).toHaveLength(1);
  });

  it('does the same for an Azure DevOps work item, whose WIQL answer is ids already', async () => {
    const { toil, sync, cache, advance } = await setup();
    await sync.run(ctx);
    toil.removeAdo(2302);
    advance(3_600_000);
    toil.reset();
    await sync.run(ctx);
    expect(keys(cache.items('settlement'))).toContain('2302');
    advance(24 * 3_600_000);
    toil.reset();
    await sync.run(ctx);
    expect(named(toil, 'ado work-item search').map((c) => c.input.updatedSince !== undefined)).toEqual([true, false]);
    expect(keys(cache.items('settlement'))).not.toContain('2302');
  });

  it('lists a source whole after an upgrade that left no whole listing on record', async () => {
    const { toil, sync, cache, advance } = await setup();
    await sync.run(ctx);
    // A cache from before the column existed has a watermark and no whole listing.
    (cache as unknown as { db: { exec(sql: string): void } }).db.exec('UPDATE sources SET full_read_at = NULL');
    advance(60_000);
    toil.reset();
    await sync.run(ctx);
    expect(named(toil, 'jira issue search').filter((c) => c.input.cursor === undefined).map((c) => c.input.fields)).toEqual([undefined, 'key']);
  });
});

describe('a whole listing that fails (#493)', () => {
  it('keeps the delta, moves the watermark on, says so, and lists the source whole again next sync', async () => {
    const { toil, cache, advance } = await setup();
    let breakWhole = false;
    const execute: typeof toil.execute = (command, input, options) =>
      breakWhole && command === 'jira issue search' && input?.fields === 'key'
        ? Promise.resolve({ ok: false, data: null, error: { code: 'HTTP', message: 'Jira is having a moment', fix: 'Try again.' }, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } } as Envelope)
        : toil.execute(command, input, options);
    const clock = () => new Date(advance(0));
    const sync = new SyncService({ cache, execute, mapOwi, now: clock });
    await sync.run(ctx);
    const firstWhole = cache.source('card-payments', 'jira')!.fullReadAt;

    toil.touchJira('PAY-104', 'Blocked', new Date(Date.parse(FIXTURE_NOW) + 24 * 3_600_000).toISOString());
    breakWhole = true;
    advance(25 * 3_600_000);
    const job = await sync.run(ctx);
    const jira = cache.source('card-payments', 'jira')!;
    expect(job.messages.some((m) => m.includes('listed whole failed') && m.includes('Jira is having a moment'))).toBe(true);
    expect(jira.status).toBe('ok');
    expect(jira.watermark).not.toBe(null);
    expect(Date.parse(jira.watermark!)).toBeGreaterThan(Date.parse(FIXTURE_NOW) + 24 * 3_600_000);
    expect(jira.fullReadAt).toBe(firstWhole);
    expect(cache.items('card-payments').find((i) => i.source.key === 'PAY-104')!.status).toBe('Blocked');

    breakWhole = false;
    advance(60_000);
    toil.reset();
    await sync.run(ctx);
    expect(named(toil, 'jira issue search').filter((c) => c.input.cursor === undefined).map((c) => c.input.fields)).toEqual([undefined, 'key']);
    expect(cache.source('card-payments', 'jira')!.fullReadAt).not.toBe(firstWhole);
  });
});

describe('a failing source', () => {
  it("is marked failed with toil's message and fix, keeps its last good data marked stale, and leaves the others alone", async () => {
    const { toil, sync, cache, viaStore, advance } = await setup();
    await sync.run(ctx);
    const good = await loadToilProject(viaStore, 'card-payments', { mapOwi });
    const watermark = cache.source('card-payments', 'jira')!.watermark;

    advance(3_600_000);
    toil.failing.add('jira');
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();

    const card = cache.states().find((d) => d.name === 'card-payments')!;
    expect(card.status).toBe('partial');
    const jira = card.sources.find((s) => s.area === 'jira')!;
    expect(jira).toMatchObject({ status: 'failed', stale: true, watermark });
    expect(jira.error).toContain('503');
    expect(jira.fix).toContain('toil config test');
    expect(card.sources.filter((s) => s.area !== 'jira').every((s) => s.status === 'ok')).toBe(true);
    expect(cache.states().filter((d) => d.name !== 'card-payments').every((d) => d.status === 'ok')).toBe(true);

    // The dashboard still has every item and every change, from the last good copy, warned as stale.
    const after = await loadToilProject(viaStore, 'card-payments', { mapOwi });
    expect(after.items).toEqual(good.items);
    expect(after.changes).toEqual(good.changes);
    const search = (await viaStore('jira issue search', { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true })) as Envelope & { ok: true };
    expect(search.ok).toBe(true);
    expect(search.meta.warnings?.map((w) => w.code)).toContain('STALE');
    expect(cache.items('card-payments')).toHaveLength(good.items.length);

    // Back up: the next sync asks from the old watermark, so nothing is missed, and the warning goes.
    toil.failing.clear();
    toil.reset();
    advance(3_600_000);
    await sync.run(ctx);
    expect(named(toil, 'jira issue search')[0]!.input.updatedSince).toBe(watermark);
    expect(cache.source('card-payments', 'jira')).toMatchObject({ status: 'ok', stale: false });
    const fresh = (await viaStore('jira issue search', { toilProject: 'card-payments', jql: JQL('PAY'), changelog: true })) as Envelope & { ok: true };
    expect(fresh.meta.warnings ?? []).toEqual([]);
  });

  it('with nothing synced before, shows as failed on its own panels while the rest load', async () => {
    const { toil, sync, cache, viaStore } = await setup();
    toil.failing.add('openshift');
    await sync.run(ctx);
    const card = cache.states().find((d) => d.name === 'card-payments')!;
    expect(card.sources.find((s) => s.area === 'openshift')).toMatchObject({ status: 'failed', stale: false, lastSuccessAt: null });
    const data = await loadToilProject(viaStore, 'card-payments', { mapOwi });
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.calls.deployments.every((c) => !c.ok)).toBe(true);
    expect(data.calls.work.every((c) => c.ok)).toBe(true);
  });

  it("keeps a Toil project's data when its projects show fails", async () => {
    const { toil, sync, cache } = await setup();
    await sync.run(ctx);
    const items = cache.items('settlement').length;
    toil.canned.splice(toil.canned.findIndex((c) => c.command === 'projects show' && c.input.toilProject === 'settlement'), 1);
    await sync.run(ctx);
    expect(cache.states().find((d) => d.name === 'settlement')).toMatchObject({ status: 'failed', error: expect.stringContaining('No canned answer') });
    expect(cache.items('settlement')).toHaveLength(items);
  });
});

describe('the job', () => {
  it('starts no sync while a Toil project is being renamed (#342), and starts once the hold is let go', async () => {
    const { sync } = await setup();
    const release = sync.hold();
    expect(() => sync.run(ctx)).toThrow('A Toil project is being renamed, so the sync waits until it is done.');
    release();
    release();
    await sync.run(ctx);
    expect(sync.status().job.toilProjectsDone).toBe(3);
  });

  it('runs one at a time, and the wipe waits for it', async () => {
    const { sync } = await setup();
    const running = sync.run(ctx);
    expect(() => sync.run(ctx)).toThrow(SyncBusy);
    expect(() => sync.wipe()).toThrow(SyncBusy);
    expect(sync.status().job.running).toBe(true);
    await running;
    expect(sync.status().job).toMatchObject({ running: false, by: 'local', toilProjectsDone: 3 });
  });

  it('wipes everything it synced', async () => {
    const { sync, cache } = await setup();
    await sync.run(ctx);
    expect(cache.counts().responses).toBeGreaterThan(0);
    sync.wipe();
    expect(Object.values(cache.counts()).every((n) => n === 0)).toBe(true);
    expect(sync.status().toilProjects).toEqual([]);
    // The database, and the write-ahead log beside it while the file is open (server/cache.ts, JOURNAL).
    expect(readdirSync(cache.paths.dir).sort()).toEqual(['toil-ui.db', 'toil-ui.db-shm', 'toil-ui.db-wal']);
  });

  it('forgets a Toil project toil no longer has', async () => {
    const { toil, sync, cache } = await setup();
    await sync.run(ctx);
    const list = toil.canned.find((c) => c.command === 'projects list')!.data as { toilProjects: Array<{ name: string }> };
    list.toilProjects = list.toilProjects.filter((d) => d.name !== 'checkout-web');
    await sync.run(ctx);
    expect(cache.toilProjectNames()).not.toContain('checkout-web');
    expect(cache.items('checkout-web')).toEqual([]);
  });

  it('stops a listing at the page bound and says so, rather than keep part of it', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-sync-'));
    folders.push(dataDir);
    const cache = await Cache.open(dataDir, { retentionDays: 30 });
    caches.push(cache);
    const toil = stubToil();
    const sync = new SyncService({ cache, execute: toil.execute, mapOwi, maxPages: 2 });
    await sync.run(ctx, 'card-payments');
    const jira = cache.source('card-payments', 'jira')!;
    expect(jira.status).toBe('failed');
    expect(jira.error).toContain('after 2 pages');
  });

  it('joins pages: lists concatenated, the rest from the newer page', () => {
    expect(joinPages([1], [2])).toEqual([1, 2]);
    expect(joinPages({ issues: [1], total: 2, startAt: 0 }, { issues: [2], total: 2, startAt: 1 })).toEqual({ issues: [1, 2], total: 2, startAt: 1 });
  });
});

describe('the worklog after a sync (#308)', () => {
  it('folds every synced Toil project into pages, the same as the sample folds them, and keeps them as it syncs again', async () => {
    const { dataDir, cache, toil, advance } = await setup();
    const { WorklogService } = await import('../server/worklog.ts');
    const { fixtureWorklog } = await import('../src/fixtures/worklog.ts');
    const worklog = new WorklogService({ cache: () => cache, execute: toil.execute as unknown as Execute, now: () => new Date(FIXTURE_NOW) });
    let finished = 0;
    const sync = new SyncService({ cache, execute: toil.execute, mapOwi, now: () => new Date(FIXTURE_NOW), onFinished: async () => (finished++, worklog.reconcileAll()) });
    await sync.run(ctx);
    expect(finished).toBe(1);
    for (const d of TOIL_PROJECTS) expect(existsSync(join(dataDir, 'cache', 'worklog', d.name))).toBe(true);
    // The day before the sample's clock: the facts with their own times are the sample's own, line for line.
    const day = '2026-10-12';
    const page = await worklog.day('checkout-web', day);
    const sample = await fixtureWorklog().day('checkout-web', day);
    expect([...page.page.work, ...page.page.prs, ...page.page.delivery].filter((e) => !e.observed).map((e) => e.key)).toEqual([...sample.page.work, ...sample.page.prs, ...sample.page.delivery].filter((e) => !e.observed).map((e) => e.key));
    expect(existsSync(join(dataDir, 'cache', 'worklog', 'checkout-web', '2026-10', `${day}.md`))).toBe(true);
    advance(60_000);
    await sync.run(ctx);
    expect((await worklog.rebuild('checkout-web', day)).same).toBe(true);
  });

  it("says in the job's messages when the worklog couldn't be folded, and finishes the sync", async () => {
    const { cache, toil } = await setup();
    const sync = new SyncService({ cache, execute: toil.execute, mapOwi, onFinished: async () => { throw new Error('disk full'); } });
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();
    expect(job.toilProjectsDone).toBe(TOIL_PROJECTS.length);
    expect(job.messages.at(-1)).toBe("Couldn't update the worklog: disk full");
  });
});

describe('the facts for the theme moments (#419)', () => {
  it('carries none on a first sync, nor on one that finds nothing new', async () => {
    const { sync, advance } = await setup();
    const first = await sync.run(ctx);
    expect(first.news ?? []).toEqual([]);
    advance(60_000);
    const again = await sync.run(ctx);
    expect(again.news ?? []).toEqual([]);
    expect(sync.status().job.news ?? []).toEqual([]);
  });
});
