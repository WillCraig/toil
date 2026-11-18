// @vitest-environment node
import { mapOwi } from '@imagile-dev/toil/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache } from '../server/cache.ts';
import type { RequestContext } from '../server/context.ts';
import { SyncService } from '../server/sync.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { stubToil, type StubToil } from './toil-stub.ts';

/**
 * A link-only change in Azure DevOps (#664). Adding or removing a link is
 * recorded under the item's current revision, so System.ChangedDate doesn't
 * move and the search "since" never lists the item. The sync reads the link
 * feed beside the search and re-reads both ends; when the feed fails, it
 * re-reads every item; and on the day of the whole listing it re-reads every
 * item anyway. A dependency nobody depends on any more is still a dependency
 * until the register of dependencies is told, which is what this file checks.
 */

const ctx: RequestContext = { viewer: { id: 'local', name: 'you', via: 'loopback' }, signal: new AbortController().signal };
const HOUR = 3_600_000;
const LINK_FEED = 'ado work-item link-feed';
const GET_MANY = 'ado work-item get-many';
const folders: string[] = [];
const caches: Cache[] = [];

afterEach(() => {
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

async function setup(toil: StubToil) {
  const dataDir = mkdtempSync(join(tmpdir(), 'toil-ui-ado-links-'));
  folders.push(dataDir);
  let clock = Date.parse(FIXTURE_NOW);
  const now = () => new Date(clock);
  const cache = await Cache.open(dataDir, { retentionDays: 30, now });
  caches.push(cache);
  const sync = new SyncService({ cache, execute: toil.execute, mapOwi, now });
  return { cache, sync, now, advance: (ms: number) => (clock += ms) };
}

const named = (toil: StubToil, command: string) => toil.calls.filter((c) => c.command === command);
const searchIds = (toil: StubToil) => (toil.canned.find((c) => c.command === 'ado work-item search' && c.input.toilProject === 'settlement')!.data as { workItems: Array<{ id: number }> }).workItems.map((w) => w.id);
/** The blocks links Toil UI holds for one Azure DevOps item, as targets. */
const blocks = (cache: Cache, id: number) => cache.items('settlement').find((i) => i.source.area === 'ado' && i.source.key === String(id))?.links.filter((l) => l.type === 'blocks').map((l) => l.target.split(':').pop()) ?? null;

/** Two items in the settlement toil project, a link between them synced, and the clock an hour on with the link removed. */
async function linkedThenRemoved() {
  const toil = stubToil();
  const [a, b] = searchIds(toil) as [number, number];
  toil.linkAdo(a, b, true, new Date(Date.parse(FIXTURE_NOW) - HOUR).toISOString());
  const env = await setup(toil);
  expect((await env.sync.run(ctx)).error).toBeNull();
  expect(blocks(env.cache, a)).toEqual([String(b)]);
  env.advance(HOUR);
  toil.linkAdo(a, b, false, env.now().toISOString());
  env.advance(HOUR);
  toil.reset();
  return { toil, a, b, ...env };
}

describe('a link-only change in Azure DevOps (#664)', () => {
  it('a removed link is gone after the next sync, though the search lists nothing as changed', async () => {
    const { toil, cache, sync, a, b } = await linkedThenRemoved();
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();

    // The search since the watermark listed nothing: the removal moved no ChangedDate.
    const search = named(toil, 'ado work-item search').find((c) => c.input.updatedSince !== undefined)!;
    expect(job.messages).toContain(`settlement: ado work-item search since ${String(search.input.updatedSince)}: 0 changed`);
    // The link feed was asked from the same watermark, for the same project, without the search's WIQL.
    const feed = named(toil, LINK_FEED);
    expect(feed).toHaveLength(1);
    const searchInput = Object.fromEntries(Object.entries(search.input).filter(([k]) => k !== 'wiql'));
    expect(feed[0]!.input).toEqual(searchInput);
    expect(job.messages).toContain(`settlement: ${LINK_FEED} since ${String(search.input.updatedSince)}: 1 changed links`);
    // get-many re-read both ends of the link, and nothing else.
    expect(named(toil, GET_MANY).map((c) => c.input.id)).toEqual([[a, b]]);
    expect(blocks(cache, a)).toEqual([]);
  });

  it('with no link change since the watermark, get-many isn\'t asked again', async () => {
    const toil = stubToil();
    const { sync, advance } = await setup(toil);
    expect((await sync.run(ctx)).error).toBeNull();
    // A first sync has no watermark, so it reads get-many whole and never asks the link feed.
    expect(named(toil, LINK_FEED)).toEqual([]);
    advance(HOUR);
    toil.reset();
    expect((await sync.run(ctx)).error).toBeNull();
    expect(named(toil, LINK_FEED)).toHaveLength(1);
    expect(named(toil, GET_MANY)).toEqual([]);
  });

  it('when the link feed fails, says so and reads every work item again, so the removal still lands', async () => {
    const { toil, cache, sync, a } = await linkedThenRemoved();
    toil.failing.add(LINK_FEED);
    const job = await sync.run(ctx);
    expect(job.error).toBeNull();
    expect(job.messages.some((m) => m.includes(`${LINK_FEED} since`) && m.includes('failed') && m.includes('reading every work item again'))).toBe(true);
    expect(named(toil, GET_MANY).map((c) => c.input.id)).toEqual([searchIds(toil)]);
    expect(blocks(cache, a)).toEqual([]);
    // The feed isn't a call the dashboard makes, so its failure doesn't mark the source failed.
    expect(cache.source('settlement', 'ado')?.status).toBe('ok');
  });

  it('on the day the search is listed whole, every work item is read again too, whatever the link feed said', async () => {
    const toil = stubToil();
    const [a, b] = searchIds(toil) as [number, number];
    toil.linkAdo(a, b, true, new Date(Date.parse(FIXTURE_NOW) - HOUR).toISOString());
    const { cache, sync, advance } = await setup(toil);
    expect((await sync.run(ctx)).error).toBeNull();
    // A removal the feed never reported (it is missing from the feed's answer), found by the daily reconcile.
    advance(25 * HOUR);
    for (const c of toil.canned) if (c.command === GET_MANY) for (const w of (c.data as { value: Array<{ id: number; relations?: unknown[] }> }).value) if (w.id === a) w.relations = [];
    toil.reset();
    expect((await sync.run(ctx)).error).toBeNull();
    expect(named(toil, GET_MANY).map((c) => c.input.id)).toEqual([searchIds(toil)]);
    expect(blocks(cache, a)).toEqual([]);
  });
});
