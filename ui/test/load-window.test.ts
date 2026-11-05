// @vitest-environment node
import { mapOwi } from '@imagile-dev/toil/api';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { andWhere as adoAndWhere } from '../../src/areas/ado/server/wiql.ts';
import { andWhere as adoCloudAndWhere } from '../../src/areas/ado/cloud/wiql.ts';
import { withUpdatedSince } from '../../src/areas/jira/since.ts';
import { Cache } from '../server/cache.ts';
import { DEFAULT_RETENTION_DAYS } from '../server/settings.ts';
import { sqliteStore } from '../server/store.ts';
import { fixtureExecute } from '../src/fixtures/execute.ts';
import { DEFAULT_WINDOW_DAYS, JQL, PER_ITEM_CONCURRENCY, WIQL, limiter, loadToilProject, windowFor, wiqlFor, withWindow } from '../src/load.ts';
import { LOOKBACK_DAYS, THROUGHPUT_WEEKS } from '../src/model/flow.ts';
import type { Envelope, Execute } from '../src/toil.ts';

/**
 * The window the loader reads Jira and Azure DevOps through (#493), how the
 * incremental `updatedSince` composes with it, and the pool the per-item calls
 * run in.
 *
 * The window is a policy, and policies are best kept in a place everyone can
 * read; this file is that place, with assertions.
 */

describe('the window', () => {
  it('is the retention period, but never under the throughput chart look-back', () => {
    expect(LOOKBACK_DAYS).toBe(THROUGHPUT_WEEKS * 7);
    expect(LOOKBACK_DAYS).toBe(42);
    expect(windowFor(7)).toBe(42);
    expect(windowFor(90)).toBe(90);
    expect(DEFAULT_WINDOW_DAYS).toBe(windowFor(DEFAULT_RETENTION_DAYS));
    expect(JQL('PAY')).toBe('project = PAY AND (statusCategory != Done OR updated >= -42d) ORDER BY Rank ASC');
    expect(JQL('PAY', 7)).toBe('project = PAY AND (statusCategory != Done OR updated >= -7d) ORDER BY Rank ASC');
    expect(WIQL).toBe(wiqlFor(42));
    expect(wiqlFor(7)).toBe("SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ([Microsoft.VSTS.Common.ClosedDate] = '' OR [System.ChangedDate] >= @Today - 7) ORDER BY [System.Id]");
  });

  it('composes with toil\'s updatedSince: Jira wraps the whole query, ahead of the ORDER BY', () => {
    expect(withUpdatedSince(JQL('PAY', 42), '2026-10-13 07:55')).toBe('(project = PAY AND (statusCategory != Done OR updated >= -42d)) AND updated >= "2026-10-13 07:55" ORDER BY Rank ASC');
  });

  it("composes with toil's updatedSince: Azure DevOps wraps the WHERE and keeps the ORDER BY, on Server and Services", () => {
    const since = "[System.ChangedDate] >= '2026-10-13T07:55:00.000Z'";
    const expected = `SELECT [System.Id] FROM WorkItems WHERE ([System.TeamProject] = @project AND ([Microsoft.VSTS.Common.ClosedDate] = '' OR [System.ChangedDate] >= @Today - 42)) AND ${since} ORDER BY [System.Id]`;
    expect(adoAndWhere(WIQL, since)).toBe(expected);
    expect(adoCloudAndWhere(WIQL, since)).toBe(expected);
  });

  it('is rewritten only in the dashboard query, and nothing else', () => {
    expect(withWindow({ jql: JQL('PAY', 7) }, 42)).toEqual({ jql: JQL('PAY', 42) });
    expect(withWindow({ wiql: wiqlFor(90) }, 42)).toEqual({ wiql: wiqlFor(42) });
    const other = { jql: 'project = PAY AND status = Blocked ORDER BY Rank ASC' };
    expect(withWindow(other, 42)).toBe(other);
    const plain = { jql: 'project = PAY' };
    expect(withWindow(plain, 42)).toBe(plain);
    expect(withWindow({}, 42)).toEqual({});
  });

  it('is sent to the trackers as the sync asks for it', async () => {
    const seen: Array<{ command: string; input: Record<string, unknown> }> = [];
    const fixture = fixtureExecute();
    // The fixture answers the default window; this records what the loader asked, then asks the fixture the default.
    const execute: Execute = (command, input = {}, options) => {
      seen.push({ command, input });
      return fixture.execute(command, { ...input, ...(typeof input.jql === 'string' ? { jql: JQL('PAY') } : {}), ...(typeof input.wiql === 'string' ? { wiql: WIQL } : {}) }, options);
    };
    await loadToilProject(execute, 'card-payments', { mapOwi, windowDays: 7 });
    await loadToilProject(execute, 'settlement', { mapOwi, windowDays: 7 });
    expect(seen.find((c) => c.command === 'jira issue search')!.input.jql).toBe(JQL('PAY', 7));
    expect(seen.find((c) => c.command === 'ado work-item search')!.input.wiql).toBe(wiqlFor(7));
  });
});

const folders: string[] = [];
const caches: Cache[] = [];
afterEach(() => {
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

describe('the cache answers the dashboard whatever window the browser names', () => {
  it('finds a project search under another window, and never another project one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'toil-ui-window-'));
    folders.push(dir);
    const cache = await Cache.open(dir, { retentionDays: 7 });
    caches.push(cache);
    const envelope = (command: string, data: unknown) => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } }) as Envelope;
    const at = new Date().toISOString();
    // What a sync with a 7-day retention stores: the 42-day floor.
    const jql = JQL('PAY', windowFor(7));
    cache.saveToilProject({
      toilProject: 'd',
      startedAt: at,
      finishedAt: at,
      responses: [{ command: 'jira issue search', input: { toilProject: 'd', jql }, envelope: envelope('jira issue search', { issues: [{ key: 'PAY-1' }] }) }],
      items: [],
      changes: [],
      deployments: [],
      sources: [{ area: 'jira', ok: true, error: null, fix: null, watermark: at, calls: 1 }],
    });
    const store = sqliteStore(() => cache, (async () => envelope('x', null)) as unknown as Execute, { version: 'x', contractVersion: 1 });
    const ctx = { viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal: new AbortController().signal } as never;
    const ask = (q: string) => store.execute(ctx, 'jira issue search', { toilProject: 'd', jql: q }, 'read');

    const same = await ask(JQL('PAY', 30));
    expect(same.ok).toBe(true);
    expect(JSON.stringify(same)).toContain('PAY-1');
    expect((await ask(JQL('PAY'))).ok).toBe(true);
    const other = await ask(JQL('NEWPROJ'));
    expect(other.ok).toBe(false);
    expect(!other.ok && other.error.code).toBe('NOT_FOUND');
    expect((await ask('project = PAY AND status = Blocked')).ok).toBe(false);
  });
});

describe('the per-item pool', () => {
  it('never runs more than the limit at once, and starts the next as one finishes', async () => {
    const slot = limiter(3);
    let active = 0;
    let most = 0;
    const done: number[] = [];
    await Promise.all(
      Array.from({ length: 20 }, (_, n) =>
        slot(async () => {
          active++;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, (n * 7) % 5));
          active--;
          done.push(n);
        }),
      ),
    );
    expect(most).toBe(3);
    expect(done).toHaveLength(20);
  });

  it('keeps a failing call from holding its place', async () => {
    const slot = limiter(1);
    const results = await Promise.allSettled([slot(async () => Promise.reject(new Error('no'))), slot(async () => 'next')]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
  });

  it('loads a Toil project the same whatever order the calls finish in, with the calls in the order of the ids', async () => {
    const fixture = fixtureExecute();
    const plain = await loadToilProject(fixture.execute, 'card-payments', { mapOwi });

    let active = 0;
    let most = 0;
    let n = 0;
    const slow: Execute = async (command, input, options) => {
      const mine = n++;
      active++;
      most = Math.max(most, active);
      // Histories finish in a different order from the one they were sent in.
      if (command.endsWith(' history') || command.endsWith(' pr get')) await new Promise((r) => setTimeout(r, (mine * 13) % 7));
      const out = await fixtureExecute().execute(command, input, options);
      active--;
      return out;
    };
    const pooled = await loadToilProject(slow, 'card-payments', { mapOwi });
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(PER_ITEM_CONCURRENCY);
    expect(pooled.items).toEqual(plain.items);
    expect(pooled.changes).toEqual(plain.changes);
    expect(pooled.calls.work).toEqual(plain.calls.work);
    expect(pooled.calls.prs).toEqual(plain.calls.prs);
  });
});
