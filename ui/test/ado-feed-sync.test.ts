// @vitest-environment node
import { mapOwi } from '@imagile-dev/toil/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache } from '../server/cache.ts';
import type { RequestContext } from '../server/context.ts';
import { SyncService, type SyncExecute } from '../server/sync.ts';
import { ADO_FEED_FIELDS } from '../src/ado-revisions.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { loadToilProject } from '../src/load.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { stubToil, type StubToil } from './toil-stub.ts';

/**
 * Azure DevOps' change feed (`ado work-item feed`) and `get-many` in the sync
 * and the loader, past what the sample's few items show: a window of more than
 * 1000 items, a feed that goes stale, and a feed that fails.
 */

const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal };
const HOUR = 3_600_000;
const folders: string[] = [];
const caches: Cache[] = [];

afterEach(() => {
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

async function setup(toil: StubToil = stubToil(), wrap?: (execute: SyncExecute) => SyncExecute) {
  const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-ado-feed-'));
  folders.push(dataDir);
  let clock = Date.parse(FIXTURE_NOW);
  const now = () => new Date(clock);
  const cache = await Cache.open(dataDir, { retentionDays: 30, now });
  caches.push(cache);
  const sync = new SyncService({ cache, execute: wrap ? wrap(toil.execute) : toil.execute, mapOwi, now });
  return { cache, toil, sync, advance: (ms: number) => (clock += ms) };
}

const named = (toil: StubToil, command: string) => toil.calls.filter((c) => c.command === command);
const FEED = 'ado work-item feed';
const SPRINT = 'Payments\\Sprint 42';

describe('get-many in slices', () => {
  const MANY = 1001;
  const extras = (toil: StubToil, count: number) => {
    for (let n = 0; n < count; n++) toil.addAdo(9000 + n);
  };

  it('is asked for 1001 ids in two calls, keeping every item and the search\'s order', async () => {
    const toil = stubToil();
    const before = (toil.canned.find((c) => c.command === 'ado work-item search' && c.input.toilProject === 'settlement')!.data as { workItems: unknown[] }).workItems.length;
    extras(toil, MANY - before);
    const data = await loadToilProject(toil.execute as unknown as Execute, 'settlement', { mapOwi });
    const asked = named(toil, 'ado work-item get-many').map((c) => c.input.id as number[]);
    expect(asked.map((ids) => ids.length)).toEqual([1000, 1]);
    const search = (toil.canned.find((c) => c.command === 'ado work-item search' && c.input.toilProject === 'settlement')!.data as { workItems: Array<{ id: number }> }).workItems.map((w) => w.id);
    expect(asked.flat()).toEqual(search);
    expect(data.items.filter((i) => i.source.area === 'ado')).toHaveLength(MANY);
    // The feed was asked once, for only the fields mapOwi reads from a revision.
    expect(named(toil, FEED).map((c) => c.input.fields)).toEqual([ADO_FEED_FIELDS]);
  });

  it('on a second sync with the slices shifted fetches only the changed items, not every slice again', async () => {
    const toil = stubToil();
    const before = (toil.canned.find((c) => c.command === 'ado work-item search' && c.input.toilProject === 'settlement')!.data as { workItems: unknown[] }).workItems.length;
    extras(toil, MANY - before);
    const { sync, advance } = await setup(toil);
    expect((await sync.run(ctx)).error).toBeNull();
    expect(named(toil, 'ado work-item get-many').map((c) => (c.input.id as number[]).length)).toEqual([1000, 1]);

    // A day on, the search is listed whole and one item is gone, so the first slice now ends one id later and the second is empty.
    advance(25 * HOUR);
    const first = (toil.canned.find((c) => c.command === 'ado work-item search' && c.input.toilProject === 'settlement')!.data as { workItems: Array<{ id: number }> }).workItems[0]!.id;
    toil.removeAdo(first);
    toil.touchAdo(2302, 'Resolved', new Date(Date.parse(FIXTURE_NOW) + HOUR).toISOString());
    toil.reset();
    expect((await sync.run(ctx)).error).toBeNull();
    expect(named(toil, 'ado work-item get-many').map((c) => c.input.id)).toEqual([[2302]]);
  });
});

describe('a Toil project that maps its own iteration field', () => {
  it('makes no feed call and reads the history of each item', async () => {
    const toil = stubToil();
    const show = toil.canned.find((c) => c.command === 'projects show' && c.input.toilProject === 'settlement')!.data as { toilProject: { ado: Record<string, unknown> } };
    show.toilProject.ado.fields = { iteration: 'Custom.Sprint' };
    await loadToilProject(toil.execute as unknown as Execute, 'settlement', { mapOwi });
    expect(named(toil, FEED)).toHaveLength(0);
    const ids = (toil.canned.find((c) => c.command === 'ado work-item search' && c.input.toilProject === 'settlement')!.data as { workItems: Array<{ id: number }> }).workItems.map((w) => w.id);
    expect(named(toil, 'ado work-item history').map((c) => c.input.id).sort()).toEqual([...ids].sort());
  });
});

describe('the feed in the sync', () => {
  it('is read whole once a day, so a renamed iteration replaces what the cache held', async () => {
    const { toil, sync, cache, advance } = await setup();
    const held = () => (cache.all('settlement', FEED)[0]!.envelope.data as Array<{ fields: Record<string, unknown> }>).map((r) => r.fields['System.IterationPath']);
    await sync.run(ctx);
    expect(held()).toContain(SPRINT);

    toil.renameIteration(SPRINT, `${SPRINT} (renamed)`);
    advance(HOUR);
    toil.reset();
    await sync.run(ctx);
    // Within the day only the revisions since the watermark are laid over the cache, which still holds the old name.
    expect(named(toil, FEED)).toHaveLength(1);
    expect(held()).toContain(SPRINT);
    expect(held()).not.toContain(`${SPRINT} (renamed)`);

    advance(25 * HOUR);
    toil.reset();
    await sync.run(ctx);
    expect(held()).toContain(`${SPRINT} (renamed)`);
    expect(held()).not.toContain(SPRINT);
  });

  it('answers a failed delta with the cached feed, and an item that changed since is still read on its own', async () => {
    let broken = false;
    const toil = stubToil();
    const { sync, advance } = await setup(toil, (execute) => async (command, input, options) => {
      if (broken && command === FEED) {
        return { ok: false, data: null, error: { code: 'HTTP', message: 'the feed answered 503', fix: 'Try again.' }, meta: { command, durationMs: 0, version: '0.1.0-alpha.2', contractVersion: 1 } } as unknown as Envelope;
      }
      return execute(command, input, options);
    });
    await sync.run(ctx);
    toil.touchAdo(2302, 'Resolved', new Date(Date.parse(FIXTURE_NOW) + HOUR / 2).toISOString());
    advance(HOUR);
    broken = true;
    toil.reset();
    const job = await sync.run(ctx);
    expect(job.messages.join('\n')).toContain('the feed answered 503');
    // The cached feed lacks 2302's new revision, so its revisions are not 1 to its rev: it is read with work-item history. The rest are not.
    expect(named(toil, 'ado work-item history').map((c) => c.input.id)).toEqual([2302]);
  });
});
