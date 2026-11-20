import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { ADO, COLL, config as fixtureConfig, PROJ, REPO, routes, workItem } from '../../../../test/fixtures/ado.fixture.js';
import { commandName, type AnyCommand } from '../../../core/command.js';
import { ToilError } from '../../../core/errors.js';
import { execute } from '../../../core/run.js';
import { commands } from '../index.js';
import { andWhere, wiqlInstant } from './wiql.js';

/**
 * The reads a sync leans on (#212): --limit and --cursor on every ado list
 * that pages, --updated-since on work search, work revisions and work
 * get-batch. Requests are pinned against the Azure DevOps Server REST 7.1
 * reference: Wiql - Query By Wiql, Revisions - List and Work Items - Get Work
 * Items Batch (learn.microsoft.com/en-us/rest/api/azure/devops/wit/…?view=azure-devops-server-rest-7.1).
 */

const AT = { collection: 'DefaultCollection', project: 'Imagile' };
const IN = { ...AT, repo: 'imagile-api' };

const cmd = (name: string): AnyCommand => commands.find((d) => commandName(d) === `ado ${name}`)!;

async function run(name: string, input: Record<string, unknown>, extra: Route[] = []) {
  const t = testContext({ config: fixtureConfig, routes: [...extra, ...routes] });
  const envelope = await execute(cmd(name), input, t.context);
  return { envelope, calls: t.http.calls, data: envelope.data as never };
}

const body = (call: { body: string | undefined }) => JSON.parse(call.body!) as Record<string, unknown>;

describe('--limit and --cursor', () => {
  it('project list stops at the limit and hands back the continuation token as a cursor that resumes there', async () => {
    const first = await run('project list', { ...AT, limit: 1 });
    expect(first.calls).toHaveLength(1);
    expect((first.data as Array<{ name: string }>).map((p) => p.name)).toEqual(['Imagile']);
    const cursor = first.envelope.meta.page?.nextCursor;
    expect(first.envelope.meta.page).toEqual({ nextCursor: expect.any(String), limit: 1 });
    const second = await run('project list', { ...AT, limit: 1, cursor });
    expect(second.calls[0]!.url).toBe(`${ADO}${COLL}/_apis/projects?api-version=7.1&continuationToken=abc12345`);
    expect((second.data as Array<{ name: string }>).map((p) => p.name)).toEqual(['Imagile Ops']);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
  });

  it('without --limit a list reads everything and sets no meta.page, as before', async () => {
    const { calls, envelope } = await run('pipeline list', AT);
    expect(calls).toHaveLength(2);
    expect(envelope.meta.page).toBeUndefined();
  });

  it('--cursor without --limit is refused before any request', async () => {
    const { calls, envelope } = await run('pr list', { ...IN, cursor: 'abc' });
    expect(calls).toHaveLength(0);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
  });

  it('a cursor the command never handed out is INVALID_INPUT', async () => {
    const { envelope } = await run('pr list', { ...IN, limit: 1, cursor: 'not-a-cursor' });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('pr list pages by $top and $skip under the limit', async () => {
    const { calls, envelope } = await run('pr list', { ...IN, limit: 1 });
    expect(calls[0]!.url).toBe(`${ADO}${REPO}/pullrequests?api-version=7.1&searchCriteria.status=active&%24top=100&%24skip=0`);
    expect(envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
  });

  it('run list with --limit follows continuation tokens instead of sending $top; with --top too it is refused', async () => {
    const { calls, envelope } = await run('run list', { ...AT, limit: 1 });
    expect(calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/build/builds?api-version=7.1`);
    expect(envelope.meta.page?.nextCursor).toEqual(expect.any(String));
    const both = await run('run list', { ...AT, limit: 1, top: '5' });
    expect(both.calls).toHaveLength(0);
    expect(both.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Cannot specify both --top and --limit. Use one or the other.' });
  });

  it('repo builds pages the source branch builds', async () => {
    const { calls, envelope } = await run('pr builds', { ...IN, id: '42', limit: 1 });
    expect(calls.map((c) => c.url)).toEqual([`${ADO}${REPO}/pullrequests/42?api-version=7.1`, `${ADO}${PROJ}/_apis/build/builds?api-version=7.1&branchName=refs%2Fheads%2Ffeature%2Fretries`]);
    expect(envelope.meta.page?.nextCursor).toEqual(expect.any(String));
  });
});

describe('work-item search', () => {
  it('--limit asks for one more than the page with $top, slices workItems, and the cursor is the next offset', async () => {
    const first = await run('work-item search', { ...AT, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 1 });
    expect(first.calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/wit/wiql?$top=2&api-version=7.1`);
    expect((first.data as { workItems: Array<{ id: number }> }).workItems.map((w) => w.id)).toEqual([42]);
    expect(first.envelope.meta.page).toEqual({ nextCursor: '1', limit: 1 });
    const second = await run('work-item search', { ...AT, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 1, cursor: '1' });
    expect(second.calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/wit/wiql?$top=3&api-version=7.1`);
    expect((second.data as { workItems: Array<{ id: number }> }).workItems.map((w) => w.id)).toEqual([7]);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 1 });
  });

  it('--updated-since wraps the WHERE clause, keeps ORDER BY, and turns on time precision', async () => {
    const wiql = "SELECT [System.Id] FROM WorkItems WHERE [System.State] = 'Active' OR [System.State] = 'New' ORDER BY [System.ChangedDate]";
    const { calls } = await run('work-item search', { ...AT, wiql, updatedSince: '2026-10-01T11:00:00+02:00' });
    expect(calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/wit/wiql?timePrecision=true&api-version=7.1`);
    expect(body(calls[0]!)).toEqual({
      query: "SELECT [System.Id] FROM WorkItems WHERE ([System.State] = 'Active' OR [System.State] = 'New') AND [System.ChangedDate] >= '2026-10-01T09:00:00.000Z' ORDER BY [System.ChangedDate]",
    });
  });

  it('a page that would end past 20,000 items, a bad --updated-since and a link query are refused before any request', async () => {
    const far = await run('work-item search', { ...AT, wiql: 'SELECT [System.Id] FROM WorkItems', limit: 200, cursor: '19900' });
    expect(far.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'A WIQL query returns at most 20000 work items, and this page would end at 20100.' });
    const bad = await run('work-item search', { ...AT, wiql: 'SELECT [System.Id] FROM WorkItems', updatedSince: '2026-10-01T09:00' });
    expect(bad.envelope.error?.message).toContain('Invalid --updated-since value "2026-10-01T09:00"');
    const links = await run('work-item search', { ...AT, wiql: 'SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.State] = \'Active\' MODE (MustContain)', limit: 5 });
    expect(links.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('FROM WORKITEMLINKS') });
    expect([...far.calls, ...bad.calls, ...links.calls]).toHaveLength(0);
  });
});

describe('andWhere', () => {
  const c = "[System.ChangedDate] >= '2026-10-01T00:00:00.000Z'";

  it('adds a WHERE where there is none, before ORDER BY or ASOF, or at the end', () => {
    expect(andWhere('SELECT [System.Id] FROM WorkItems', c)).toBe(`SELECT [System.Id] FROM WorkItems WHERE ${c}`);
    expect(andWhere('SELECT [System.Id] FROM WorkItems ORDER BY [System.Id]', c)).toBe(`SELECT [System.Id] FROM WorkItems WHERE ${c} ORDER BY [System.Id]`);
    expect(andWhere("SELECT [System.Id] FROM WorkItems ASOF '2026-01-01'", c)).toBe(`SELECT [System.Id] FROM WorkItems WHERE ${c} ASOF '2026-01-01'`);
  });

  it('ignores keywords inside string literals, doubled quotes and brackets', () => {
    const wiql = "select [System.Id] from workitems where [System.Title] = 'it''s where order by lives' and [Custom.Order By] = \"ASOF\"";
    expect(andWhere(wiql, c)).toBe(`select [System.Id] from workitems WHERE ([System.Title] = 'it''s where order by lives' and [Custom.Order By] = "ASOF") AND ${c}`);
  });

  it('refuses a query with no FROM WorkItems', () => {
    expect(() => andWhere('SELECT [System.Id]', c)).toThrow('has no FROM clause');
  });

  it('reads a date as UTC midnight and a zoned date-time as its instant; a zoneless date-time is refused', () => {
    expect(wiqlInstant('2026-10-01')).toBe('2026-10-01T00:00:00.000Z');
    expect(wiqlInstant('2026-10-01T09:30:00Z')).toBe('2026-10-01T09:30:00.000Z');
    expect(() => wiqlInstant('2026-10-01T09:30:00')).toThrow('Invalid --updated-since');
    expect(() => wiqlInstant('2026-02-30')).toThrow('Invalid --updated-since');
  });
});

describe('work-item history', () => {
  it('pages by $top=100 and $skip, oldest first, under the project', async () => {
    const { calls, data } = await run('work-item history', { ...AT, id: '42' });
    expect(calls.map((c) => c.url)).toEqual([`${ADO}${PROJ}/_apis/wit/workItems/42/revisions?api-version=7.1&%24top=100&%24skip=0`]);
    expect((data as Array<{ rev: number }>).map((r) => r.rev)).toEqual([1, 2]);
  });

  it('with --limit, a cursor resumes inside the page', async () => {
    const first = await run('work-item history', { ...AT, id: '42', limit: 1 });
    const cursor = first.envelope.meta.page?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await run('work-item history', { ...AT, id: '42', limit: 1, cursor });
    expect((second.data as Array<{ rev: number }>).map((r) => r.rev)).toEqual([2]);
  });

  it('a server that ignores $skip is stopped after 1,000 pages with an error naming the list', async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: 42, rev: i + 1, fields: {} }));
    const stuck: Route = { path: `${PROJ}/_apis/wit/workItems/42/revisions`, respond: { json: { count: 100, value: full } } };
    const { envelope, calls } = await run('work-item history', { ...AT, id: '42' }, [stuck]);
    expect(calls).toHaveLength(1000);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: "Paging revisions of Azure DevOps work item 42 didn't end after 1000 pages; toil stopped." });
  });
});

describe('work-item get-many', () => {
  it('posts the ids with $expand all and errorPolicy omit, and reports a null as missing, per id', async () => {
    const { calls, envelope } = await run('work-item get-many', { ...AT, id: [42, 404, 7, 42] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${ADO}${PROJ}/_apis/wit/workitemsbatch?api-version=7.1` });
    expect(body(calls[0]!)).toEqual({ ids: [42, 404, 7], $expand: 'all', errorPolicy: 'omit' });
    expect(envelope.data).toEqual({ count: 2, value: [workItem(42), workItem(7)], missing: [404] });
    expect(envelope.meta.warnings).toEqual([{ code: 'ADO_WORK_ITEMS_MISSING', message: "No work item with id 404, or the token can't see it." }]);
  });

  it('--fields replaces $expand, since the server takes one or the other', async () => {
    const { calls } = await run('work-item get-many', { ...AT, id: [42], fields: 'System.Title, System.State' });
    expect(body(calls[0]!)).toEqual({ ids: [42], fields: ['System.Title', 'System.State'], errorPolicy: 'omit' });
  });

  it('chunks 450 ids into requests of 200, 200 and 50, and keeps the order asked', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => 2000 - i);
    const { calls, envelope } = await run('work-item get-many', { ...AT, id: ids });
    expect(calls.map((c) => (body(c).ids as number[]).length)).toEqual([200, 200, 50]);
    expect((envelope.data as { value: Array<{ id: number }> }).value.map((w) => w.id)).toEqual(ids);
  });

  it('an id the server leaves out entirely is missing too', async () => {
    const partial: Route = { method: 'POST', path: `${PROJ}/_apis/wit/workitemsbatch`, respond: { json: { count: 1, value: [workItem(42)] } } };
    expect((await run('work-item get-many', { ...AT, id: [42, 9] }, [partial])).envelope.data).toMatchObject({ count: 1, missing: [9] });
  });

  it('more than 1,000 ids is refused before any request', async () => {
    const { calls, envelope } = await run('work-item get-many', { ...AT, id: Array.from({ length: 1001 }, (_, i) => i + 1) });
    expect(calls).toHaveLength(0);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'get-many takes at most 1000 work item ids in one call, and this one has 1001.' });
  });
});

describe('work-item feed (the reporting feed)', () => {
  it('reads the feed from a start date, then follows the continuation token without the date', async () => {
    const { calls, data, envelope } = await run('work-item feed', { ...AT, updatedSince: '2026-09-01', fields: 'System.State, System.IterationPath' });
    expect(calls.map((c) => c.url)).toEqual([
      `${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1&fields=System.State,System.IterationPath&startDateTime=2026-09-01T00%3A00%3A00.000Z`,
      `${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1&fields=System.State,System.IterationPath&continuationToken=abc12345`,
    ]);
    expect((data as Array<{ id: number; rev: number }>).map((r) => `${r.id}@${r.rev}`)).toEqual(['42@1', '42@2', '7@1', '42@3']);
    expect(envelope.meta.page).toBeUndefined();
  });

  it('without a start date or fields it sends neither', async () => {
    const { calls } = await run('work-item feed', { ...AT });
    expect(calls.map((c) => c.url)).toEqual([`${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1`, `${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemrevisions?api-version=7.1&continuationToken=abc12345`]);
  });

  it('--limit stops inside a batch, and the cursor resumes from the token without the start date', async () => {
    const first = await run('work-item feed', { ...AT, updatedSince: '2026-09-01', limit: 2 });
    expect(first.calls).toHaveLength(1);
    expect((first.data as Array<{ rev: number }>).map((r) => r.rev)).toEqual([1, 2]);
    expect(first.envelope.meta.page).toEqual({ nextCursor: expect.any(String), limit: 2 });
    const second = await run('work-item feed', { ...AT, updatedSince: '2026-09-01', limit: 2, cursor: first.envelope.meta.page!.nextCursor });
    expect((second.data as Array<{ id: number; rev: number }>).map((r) => `${r.id}@${r.rev}`)).toEqual(['7@1', '42@3']);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('refuses a zoneless start, and a cursor without a limit, before anything is sent', async () => {
    const zoneless = await run('work-item feed', { ...AT, updatedSince: '2026-09-01T09:00:00' });
    const cursor = await run('work-item feed', { ...AT, cursor: 'abc' });
    expect(zoneless.envelope.error?.code).toBe('INVALID_INPUT');
    expect(cursor.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
    expect(zoneless.calls.length + cursor.calls.length).toBe(0);
  });

  it('a cancellation between batches stops the feed with CANCELLED instead of reading on', async () => {
    const controller = new AbortController();
    const first: Route = { path: /reporting\/workitemrevisions$/, respond: () => { controller.abort(new ToilError('CANCELLED', 'cancelled')); return { json: { values: [], continuationToken: 'abc12345', isLastBatch: false } }; } };
    const t = testContext({ config: fixtureConfig, routes: [first, ...routes] });
    const envelope = await execute(cmd('work-item feed'), { ...AT }, { ...t.context, signal: controller.signal });
    expect(envelope.error?.code).toBe('CANCELLED');
    expect(t.http.calls).toHaveLength(1);
  });
});

describe('work-item link-feed (the reporting links feed, #664)', () => {
  it('reads link changes from a start date, then follows the continuation token without the date, removals included', async () => {
    const { calls, data, envelope } = await run('work-item link-feed', { ...AT, updatedSince: '2026-09-01' });
    expect(calls[0]!.headers).toMatchObject({ authorization: expect.stringMatching(/^Basic /), accept: 'application/json' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemlinks?api-version=7.1&startDateTime=2026-09-01T00%3A00%3A00.000Z`,
      `GET ${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemlinks?api-version=7.1&continuationToken=abc12345`,
    ]);
    // The removed link is reported, with isActive false: that is what a "changed since" search can't show.
    const links = data as Array<{ rel: string; attributes: { linkType: string; sourceId: number; targetId: number; isActive: boolean } }>;
    expect(links.map(({ attributes: a }) => `${a.sourceId}->${a.targetId} ${a.isActive}`)).toEqual(['42->7 true', '7->9 true', '42->7 false']);
    // Passed through as Azure DevOps sends it: the topology in rel, the direction in attributes.linkType.
    expect(links[0]).toMatchObject({ rel: 'System.LinkTypes.Dependency', attributes: { linkType: 'System.LinkTypes.Dependency-Forward' } });
    expect(envelope.meta.page).toBeUndefined();
  });

  it('without a start date it sends none', async () => {
    const { calls } = await run('work-item link-feed', { ...AT });
    expect(calls.map((c) => c.url)).toEqual([`${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemlinks?api-version=7.1`, `${ADO}${COLL}/Imagile/_apis/wit/reporting/workitemlinks?api-version=7.1&continuationToken=abc12345`]);
  });

  it('--limit stops inside a batch, and the cursor resumes from the token', async () => {
    const first = await run('work-item link-feed', { ...AT, updatedSince: '2026-09-01', limit: 2 });
    expect(first.calls).toHaveLength(1);
    expect(first.envelope.meta.page).toEqual({ nextCursor: expect.any(String), limit: 2 });
    const second = await run('work-item link-feed', { ...AT, updatedSince: '2026-09-01', limit: 2, cursor: first.envelope.meta.page!.nextCursor });
    expect((second.data as Array<{ attributes: { isActive: boolean } }>).map((l) => l.attributes.isActive)).toEqual([false]);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('refuses a zoneless start before anything is sent', async () => {
    const zoneless = await run('work-item link-feed', { ...AT, updatedSince: '2026-09-01T09:00:00' });
    expect(zoneless.envelope.error?.code).toBe('INVALID_INPUT');
    expect(zoneless.calls).toHaveLength(0);
  });
});
