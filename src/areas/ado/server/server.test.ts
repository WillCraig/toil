import { describe, expect, it } from 'vitest';
import { runCli } from '../../../../test/harness/cli.js';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { ADO, ATTACHMENT, COLL, config as fixtureConfig, files as fixtureFiles, ME, PROJ, pr, prCommit, prStatus, REPO, routes, SHA, threads, workItem, build } from '../../../../test/fixtures/ado.fixture.js';
import { commandName, type AnyCommand } from '../../../core/command.js';
import type { Context } from '../../../core/context.js';
import { execute } from '../../../core/run.js';
import { commands } from '../index.js';

/**
 * The exact requests toil sends to Azure DevOps Server and what it makes of
 * the answers, command by command. The parity suite proves the CLI and MCP
 * agree; this proves what they agree on is what the command contract
 * specifies. Suspected bugs (#69) are pinned here, not fixed, pending a live run,
 * which has been scheduled for the next available maintenance window.
 */

const AUTH = `Basic ${Buffer.from(':test-pat').toString('base64')}`;
const HEADERS = { authorization: AUTH, 'content-type': 'application/json', accept: 'application/json' };
const AT = { collection: 'DefaultCollection', project: 'Imagile' };
const IN = { ...AT, repo: 'imagile-api' };
const W = { ...IN, allowWrite: true };

const cmd = (name: string): AnyCommand => commands.find((d) => commandName(d) === `ado ${name}`)!;

type Settings = Record<string, unknown>;

async function run(name: string, input: Record<string, unknown>, extra: Route[] = [], settings: Settings = {}, more: Partial<Context> = {}, files: Record<string, string | Uint8Array> = fixtureFiles) {
  const t = testContext({ config: { ado: { ...fixtureConfig.ado, ...settings } }, routes: [...extra, ...routes], files });
  Object.assign(t.context, more);
  const envelope = await execute(cmd(name), input, t.context);
  return { envelope, calls: t.http.calls, data: envelope.data as never, files: t.files };
}

const body = (call: { body: string | undefined }) => JSON.parse(call.body!) as unknown;
const remote = (url: string): Partial<Context> => ({ gitRemote: async () => [{ name: 'origin', url }] });

describe('requests', () => {
  it('sends the PAT as Basic with an empty user and JSON headers, even on a GET, keeping a /tfs context path', async () => {
    const { calls, envelope } = await run('work-item get', { ...AT, id: '42' }, [], { baseUrl: `${ADO}/tfs` }, {}, {});
    expect(envelope.ok).toBe(false);
    expect(calls[0]).toEqual({ method: 'GET', url: `${ADO}/tfs${COLL}/_apis/wit/workitems/42?api-version=7.1&$expand=all`, headers: HEADERS, body: undefined });
  });

  it('a 401 is AUTH, naming where to make a PAT and the SYSTEM_ACCESSTOKEN fallback', async () => {
    const { envelope } = await run('work-item get', { ...AT, id: '42' }, [{ url: /.*/, respond: { status: 401, json: { message: 'TF400813: not authorized' } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', fix: expect.stringContaining('User settings → Personal access tokens') });
    expect(envelope.error?.fix).toContain('TOIL_ADO_PAT, or SYSTEM_ACCESSTOKEN');
  });

  it("an older server's out-of-range answer says the server is too old, naming 2022.1, with the code unchanged", async () => {
    const message = 'The requested REST API version of 7.1 is out of range for this server. The latest REST API version this server supports is 6.0.';
    const { envelope } = await run('work-item get', { ...AT, id: '42' }, [{ url: /.*/, respond: { status: 400, json: { message } } }]);
    expect(envelope.error?.code).toBe('HTTP');
    expect(envelope.error?.message).toBe(`This server is too old for toil, which needs Azure DevOps Server 2022.1 or later (REST API 7.1). The server said: ${message}`);
  });

  it('reads ids with parseInt, as the contract specifies (#69 item 25): 12abc is 12, abc is NaN', async () => {
    expect((await run('work-item get', { ...AT, id: '12abc' })).calls[0]!.url).toContain('/workitems/12?');
    expect((await run('work-item get', { ...AT, id: 'abc' })).calls[0]!.url).toContain('/workitems/NaN?');
  });
});

describe('collection, project and repo', () => {
  it('every command needs a collection and a project, collection list included (#69 item 2)', async () => {
    const none = await run('collection list', {});
    expect(none.calls).toEqual([]);
    expect(none.envelope.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: 'Could not determine Azure DevOps collection. Pass --collection, or set collection on the connection.',
      fix: expect.stringContaining('TOIL_ADO_COLLECTION'),
    });
    const noProject = await run('whoami', { collection: 'DefaultCollection' });
    expect(noProject.envelope.error?.message).toBe('Could not determine Azure DevOps project. Pass --project, or set project on the connection.');
    expect((await run('collection list', AT)).calls[0]!.url).toBe(`${ADO}/_apis/projectCollections?api-version=7.1`);
  });

  it('an empty --project is still "Could not determine"', async () => {
    expect((await run('whoami', { collection: 'DefaultCollection', project: '' })).envelope.error?.message).toMatch(/^Could not determine Azure DevOps project/);
  });

  it('--organization stands in for --collection; --collection wins when both are passed', async () => {
    expect((await run('whoami', { organization: 'Other', project: 'Imagile' }, [{ url: /.*/, respond: { json: {} } }])).calls[0]!.url).toBe(`${ADO}/Other/_apis/connectionData?api-version=7.1-preview.1`);
    expect((await run('whoami', { collection: 'DefaultCollection', organization: 'Other', project: 'Imagile' })).calls[0]!.url).toContain(`${COLL}/_apis/connectionData`);
  });

  it('--organization beats the connection setting', async () => {
    const { calls } = await run('whoami', { organization: 'Other' }, [{ url: /.*/, respond: { json: {} } }], { collection: 'DefaultCollection', project: 'Imagile' });
    expect(calls[0]!.url).toContain('/Other/_apis/connectionData');
  });

  it('come from the connection (defaults.ado) when not passed, and meta.context says so', async () => {
    const { envelope, calls } = await run('repo get', {}, [], { collection: 'DefaultCollection', project: 'Imagile', repo: 'imagile-api' });
    expect(calls[0]!.url).toBe(`${ADO}${REPO}?api-version=7.1`);
    expect(envelope.meta.context?.inputs).toEqual({
      collection: { value: 'DefaultCollection', source: 'connection' },
      project: { value: 'Imagile', source: 'connection' },
      repo: { value: 'imagile-api', source: 'connection' },
    });
  });

  it('come from an origin remote on the connection host, ignoring a /tfs prefix', async () => {
    const { calls, envelope } = await run('repo get', {}, [{ url: /.*/, respond: { json: {} } }], {}, remote(`${ADO}/tfs/Coll/Proj/_git/repo-x`));
    expect(calls[0]!.url).toBe(`${ADO}/Coll/Proj/_apis/git/repositories/repo-x?api-version=7.1`);
    expect(envelope.meta.context?.inputs?.collection).toEqual({ value: 'Coll', source: 'git' });
  });

  it("come from a remote of any name on the connection host when origin is elsewhere, as the contract specifies", async () => {
    const remotes: Partial<Context> = { gitRemote: async () => [{ name: 'origin', url: 'git@github.com:me/repo-x.git' }, { name: 'upstream', url: `${ADO}/tfs/Coll/Proj/_git/repo-x` }] };
    const { envelope } = await run('repo get', {}, [{ url: /.*/, respond: { json: {} } }], {}, remotes);
    expect(envelope.meta.context?.inputs?.collection).toEqual({ value: 'Coll', source: 'git' });
  });

  it('ignore a remote on another host, and misread an ssh:// remote with no user (#69 item 5)', async () => {
    expect((await run('repo get', {}, [], {}, remote('https://other.example.com/Coll/Proj/_git/repo'))).envelope.error?.message).toMatch(/^Could not determine Azure DevOps collection/);
    expect((await run('repo get', {}, [], {}, remote('ssh://ado.imagile.dev:22/Coll/Proj/_ssh/repo'))).envelope.error?.message).toMatch(/^Could not determine Azure DevOps collection/);
  });

  it("repo commands need a repo, in the contract's specified wording; repo list and create do not", async () => {
    const { envelope, calls } = await run('pr get', { ...AT, id: '42' });
    expect(calls).toEqual([]);
    expect(envelope.error?.message).toBe('Could not determine Azure DevOps repo. Pass --repo, or run from inside a checked-out ADO repo.');
    expect((await run('repo list', AT)).envelope.ok).toBe(true);
  });

  it('encodes collection, project and repo into paths', async () => {
    const { calls } = await run('repo get', { collection: 'Default Collection', project: 'My Proj', repo: 'a b' }, [{ url: /.*/, respond: { json: {} } }]);
    expect(calls[0]!.url).toBe(`${ADO}/Default%20Collection/My%20Proj/_apis/git/repositories/a%20b?api-version=7.1`);
  });

  it('an id with path or query syntax in it goes in as one encoded segment, not refused, since a name made through the API may hold any of them', async () => {
    const { calls } = await run('repo get', { collection: 'Coll', project: 'a/b?c=d', repo: 'p1#hot' }, [{ url: /.*/, respond: { json: {} } }]);
    expect(calls[0]!.url).toBe(`${ADO}/Coll/a%2Fb%3Fc%3Dd/_apis/git/repositories/p1%23hot?api-version=7.1`);
    // From the connection too: a % is legal in a project name, so it is encoded rather than refused.
    const fromConnection = await run('repo get', {}, [{ url: /.*/, respond: { json: {} } }], { collection: 'Coll', project: '100% Done', repo: 'r' });
    expect(fromConnection.calls[0]!.url).toBe(`${ADO}/Coll/100%25%20Done/_apis/git/repositories/r?api-version=7.1`);
  });

  it('an id that would still name a .. segment once encoded is INVALID_INPUT before anything is sent', async () => {
    const { calls, envelope } = await run('repo get', { collection: 'x/../y', project: 'Imagile', repo: 'imagile-api' }, [{ url: /.*/, respond: { json: {} } }]);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('a write encodes the ids in its path, and work-item link encodes the target id in the relation URL it stores', async () => {
    const create = await run('repo create', { collection: 'Coll', project: 'a/b?c=d', name: 'new', allowWrite: true }, [{ url: /.*/, respond: { json: {} } }]);
    expect(create.calls[0]).toMatchObject({ method: 'POST', url: `${ADO}/Coll/a%2Fb%3Fc%3Dd/_apis/git/repositories?api-version=7.1` });
    const link = await run('work-item link', { ...W, id: '42', target: '7/../8?x' });
    expect(link.calls[0]!.url).toBe(`${ADO}${COLL}/_apis/wit/workitems/42?api-version=7.1`);
    expect(body(link.calls[0]!)).toMatchObject([{ value: { url: `${ADO}${COLL}/_apis/wit/workitems/7%2F..%2F8%3Fx` } }]);
  });
});

describe('paging', () => {
  it('project list follows x-ms-continuationtoken until it is absent', async () => {
    const { calls, data } = await run('project list', AT);
    expect(calls.map((c) => c.url)).toEqual([`${ADO}${COLL}/_apis/projects?api-version=7.1`, `${ADO}${COLL}/_apis/projects?api-version=7.1&continuationToken=abc12345`]);
    expect((data as Array<{ name: string }>).map((p) => p.name)).toEqual(['Imagile', 'Imagile Ops']);
  });

  it('paged and text calls hand a 429 back at once, with no retry (#69 item 4)', async () => {
    const limited: Route[] = [{ url: /.*/, respond: { status: 429, headers: { 'retry-after': '1' }, json: { message: 'slow down' } } }];
    const listed = await run('project list', AT, limited);
    expect(listed.calls).toHaveLength(1);
    expect(listed.envelope.ok).toBe(false);
    expect((await run('run logs', { ...AT, id: '101', logId: '3' }, limited)).calls).toHaveLength(1);
  });

  it('pr list pages by $top=100 and $skip until a short page', async () => {
    const full = Array.from({ length: 100 }, (_, i) => pr(i + 1));
    const paged: Route = { path: `${REPO}/pullrequests`, respond: (r) => ({ json: { value: new URL(r.url).searchParams.get('$skip') === '0' ? full : [pr(101)] } }) };
    const { calls, data } = await run('pr list', IN, [paged]);
    expect(calls.map((c) => new URL(c.url).searchParams.get('$skip'))).toEqual(['0', '100']);
    expect(new URL(calls[0]!.url).searchParams.get('searchCriteria.status')).toBe('active');
    expect((data as unknown[]).length).toBe(101);
  });

  it('pr list sends --creator and --reviewer as identity filters, and dates with a created range (#69 items 6 and 26)', async () => {
    const { calls } = await run('pr list', { ...IN, state: 'all', creator: 'jdoe', reviewer: 'asmith', createdAfter: '2026-09-01' });
    const q = new URL(calls[0]!.url).searchParams;
    expect([q.get('searchCriteria.status'), q.get('searchCriteria.creatorId'), q.get('searchCriteria.reviewerId'), q.get('searchCriteria.queryTimeRangeType'), q.get('searchCriteria.minTime'), q.get('searchCriteria.maxTime')]).toEqual([
      'all',
      'jdoe',
      'asmith',
      'created',
      '2026-09-01T00:00:00.000Z',
      null,
    ]);
    expect((await run('pr list', { ...IN, createdBefore: 'soon' })).envelope.error?.message).toContain('Invalid --created-before value "soon"');
  });

  it('run list is one request with $top=50 by default, sliced to --top', async () => {
    const { calls, data } = await run('run list', { ...AT, top: '1' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!.url).searchParams.get('$top')).toBe('1');
    expect(data).toEqual([build(101)]);
    expect(new URL((await run('run list', AT)).calls[0]!.url).searchParams.get('$top')).toBe('50');
  });

  it('run list --top 0 is falsy and lists every run through continuation tokens (#69 item 28, pinned)', async () => {
    const { calls } = await run('run list', { ...AT, top: '0' });
    expect(calls.map((c) => new URL(c.url).searchParams.has('$top'))).toEqual([false, false]);
    expect(calls[1]!.url).toContain('continuationToken=abc12345');
  });

  it('run list --name looks the pipeline up, ignoring case; --branch goes as typed (#69 item 12)', async () => {
    const { calls } = await run('run list', { ...AT, name: 'IMAGILE-WEB-CI', branch: 'main' });
    const q = new URL(calls.at(-1)!.url).searchParams;
    expect([q.get('definitions'), q.get('branchName')]).toEqual(['6', 'main']);
    expect((await run('run list', { ...AT, name: 'nope' })).envelope.error?.message).toBe("Pipeline \"nope\" not found. Run 'toil ado pipeline list' to see available pipelines.");
    expect((await run('run list', { ...AT, definition: 'x' })).envelope.error?.message).toContain('--definition must be a numeric ID');
    expect((await run('run list', { ...AT, definition: '5', name: 'x' })).envelope.error?.message).toContain('Cannot specify both');
  });
});

describe('work items', () => {
  it('work-item create sends a JSON Patch with built-in and aliased fields, then nothing else', async () => {
    const { calls, envelope } = await run('work-item create', { ...W, type: 'User Story', title: 'T', description: '', priority: '2', field: ['Story Points=3', 'MyOrg.Team=Core'] });
    expect(envelope.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/wit/workitems/%24User%20Story?api-version=7.1`);
    expect(calls[0]!.headers['content-type']).toBe('application/json-patch+json');
    expect(body(calls[0]!)).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: '2' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: '3' },
      { op: 'add', path: '/fields/MyOrg.Team', value: 'Core' },
    ]);
  });

  it('work-item create takes a numeric priority (the widened schema) and sends it as the text "2"', async () => {
    const { calls, envelope } = await run('work-item create', { ...W, type: 'Bug', title: 'T', priority: 2 });
    expect(envelope.ok).toBe(true);
    expect(body(calls[0]!)).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'T' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: '2' },
    ]);
  });

  it('work-item create reads --input-file with @file values; flags win with a warning', async () => {
    const { calls, envelope } = await run('work-item create', { ...W, inputFile: 'work-item.json', title: 'Flag' });
    expect(calls[0]!.url).toContain('/workitems/%24Task?');
    expect(body(calls[0]!)).toEqual([
      { op: 'add', path: '/fields/System.Title', value: 'Flag' },
      { op: 'add', path: '/fields/System.Description', value: '<p>Steps</p>' },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: 2 },
      { op: 'add', path: '/fields/Microsoft.VSTS.Common.AcceptanceCriteria', value: 'It works' },
    ]);
    expect(envelope.meta.warnings).toEqual([{ code: 'ADO_INPUT_OVERRIDDEN', message: '--input-file value(s) overridden by CLI flags: title' }]);
  });

  it("work-item create without a type or title is refused before anything is sent, in the contract's specified wording", async () => {
    expect((await run('work-item create', { ...W, title: 't' })).envelope.error?.message).toBe('--type required (or "type" in --input-file)');
    const { envelope, calls } = await run('work-item create', { ...W, type: 'Bug' });
    expect(calls).toEqual([]);
    expect(envelope.error?.message).toBe('--title required (or "fields.Title" in --input-file)');
    expect((await run('work-item create', { ...W, type: 'Bug', title: 't', field: ['=x'] })).envelope.error?.message).toBe('Invalid --field value "=x". Expected format: name=value');
  });

  it('work-item create --parent links afterwards, to a URL built from baseUrl, and returns the item as created', async () => {
    const { calls, data } = await run('work-item create', { ...W, type: 'Task', title: 't', parent: '7' }, [], { baseUrl: `${ADO}/` });
    expect(calls.map((c) => c.method)).toEqual(['POST', 'PATCH']);
    expect(calls[1]!.url).toBe(`${ADO}${COLL}/_apis/wit/workitems/43?api-version=7.1`);
    expect(body(calls[1]!)).toEqual([{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Hierarchy-Reverse', url: `${ADO}${COLL}/_apis/wit/workitems/7` } }]);
    expect(data).toEqual(workItem(43, { rev: 1 }));
  });

  it('work-item create --parent that fails to link still succeeds, with only a warning (#69 items 15 and 29, pinned)', async () => {
    const failing: Route = { method: 'PATCH', path: `${COLL}/_apis/wit/workitems/43`, respond: { status: 404, json: { message: 'TF401232: Work item 999 does not exist' } } };
    const { envelope } = await run('work-item create', { ...W, type: 'Task', title: 't', parent: '999' }, [failing]);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual(workItem(43, { rev: 1 }));
    expect(envelope.meta.warnings).toEqual([{ code: 'ADO_PARENT_LINK_FAILED', message: 'Created #43 but failed to link to parent 999: TF401232: Work item 999 does not exist' }]);
  });

  it('work-item update resolves the built-in aliases with no fieldAliases on the connection', async () => {
    const { calls } = await run('work-item update', { ...W, id: '42', field: ['Story Points=5', 'title=T'] });
    expect(body(calls[0]!)).toEqual([
      { op: 'add', path: '/fields/Microsoft.VSTS.Scheduling.StoryPoints', value: '5' },
      { op: 'add', path: '/fields/System.Title', value: 'T' },
    ]);
  });

  it("work-item update resolves names through the connection's fieldAliases over the built-in ones", async () => {
    const { calls } = await run('work-item update', { ...W, id: '42', field: ['Effort Days=3', 'state=Active', 'Custom.X=1'] }, [], { fieldAliases: { effortdays: 'MyOrg.EffortDays', state: 'MyOrg.State' } });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${ADO}${COLL}/_apis/wit/workitems/42?api-version=7.1` });
    expect(body(calls[0]!)).toEqual([
      { op: 'add', path: '/fields/MyOrg.EffortDays', value: '3' },
      { op: 'add', path: '/fields/MyOrg.State', value: 'Active' },
      { op: 'add', path: '/fields/Custom.X', value: '1' },
    ]);
  });

  it('work-item link maps the type word to a relation, or sends it as given', async () => {
    const { calls } = await run('work-item link', { ...W, id: '42', target: '8', type: 'duplicate-of' });
    expect(body(calls[0]!)).toEqual([{ op: 'add', path: '/relations/-', value: { rel: 'System.LinkTypes.Duplicate-Reverse', url: `${ADO}${COLL}/_apis/wit/workitems/8` } }]);
    expect(body((await run('work-item link', { ...W, id: '42', target: '8', type: 'Custom.Rel' })).calls[0]!)).toMatchObject([{ value: { rel: 'Custom.Rel' } }]);
  });

  it('work-item tag reads the tags, keeps them, and adds new ones ignoring case', async () => {
    const { calls } = await run('work-item tag', { ...W, id: '42', tags: 'UI; urgent,Backend' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(body(calls[1]!)).toEqual([{ op: 'add', path: '/fields/System.Tags', value: 'ui; backend; urgent' }]);
    // `add` on System.Tags only adds (confirmed live on Services, a recorded bug now fixed): untag replaces the list.
    expect(body((await run('work-item untag', { ...W, id: '42', tags: 'UI' })).calls[1]!)).toEqual([{ op: 'replace', path: '/fields/System.Tags', value: 'backend' }]);
    // The last tag off clears the field; a tag the item lacks sends what it already had.
    expect(body((await run('work-item untag', { ...W, id: '42', tags: 'ui, backend' })).calls[1]!)).toEqual([{ op: 'remove', path: '/fields/System.Tags' }]);
    expect(body((await run('work-item untag', { ...W, id: '42', tags: 'nope' })).calls[1]!)).toEqual([{ op: 'add', path: '/fields/System.Tags', value: 'ui; backend' }]);
  });

  it('work-item search posts the WIQL; comments uses 7.1-preview.4 and reads comments', async () => {
    const searched = await run('work-item search', { ...AT, wiql: 'SELECT [System.Id] FROM WorkItems' });
    expect(searched.calls[0]).toMatchObject({ method: 'POST', url: `${ADO}${PROJ}/_apis/wit/wiql?api-version=7.1` });
    expect(body(searched.calls[0]!)).toEqual({ query: 'SELECT [System.Id] FROM WorkItems' });
    const listed = await run('work-item comments', { ...AT, id: '42' });
    expect(listed.calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/wit/workItems/42/comments?api-version=7.1-preview.4`);
    expect((listed.data as unknown[]).length).toBe(2);
  });
});

describe('attachments', () => {
  it('add-attachment uploads the bytes as octet-stream, then links the returned URL', async () => {
    const { calls, data } = await run('work-item attach', { ...W, id: '42', inputFile: 'logs/run.txt', comment: 'c' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${ADO}${COLL}/_apis/wit/attachments?fileName=run.txt&api-version=7.1` });
    expect(calls[0]!.headers['content-type']).toBe('application/octet-stream');
    expect(calls[0]!.body).toBe('log line\n');
    expect(body(calls[1]!)).toEqual([{ op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url: `${ADO}${COLL}/_apis/wit/attachments/${ATTACHMENT}`, attributes: { comment: 'c' } } }]);
    expect(data).toEqual({ id: ATTACHMENT, url: `${ADO}${COLL}/_apis/wit/attachments/${ATTACHMENT}` });
  });

  it('attachments shapes AttachedFile relations, the id from the URL', async () => {
    const { data } = await run('work-item attachments', { ...AT, id: '42' });
    expect(data).toEqual([{ id: ATTACHMENT, name: 'screenshot.png', url: `${ADO}${COLL}/_apis/wit/attachments/${ATTACHMENT}`, comment: 'Before', resourceSize: 5, resourceCreatedDate: '2026-09-02T12:00:00Z' }]);
  });

  it('download saves under .toil, and never overwrites', async () => {
    const first = await run('work-item download', { ...AT, id: '42', attachmentId: ATTACHMENT });
    expect(first.calls[1]).toMatchObject({ method: 'GET', url: `${ADO}${COLL}/_apis/wit/attachments/${ATTACHMENT}` });
    expect(first.calls[1]!.headers.accept).toBe('application/octet-stream');
    expect(first.data).toMatchObject({ name: 'screenshot.png', size: 5 });
    expect((first.data as { saved: string }).saved).toMatch(/\.toil\/screenshot\.png$/);
    const again = await run('work-item download', { ...AT, id: '42', attachmentId: ATTACHMENT }, [], {}, {}, { ...fixtureFiles, '.toil/screenshot.png': 'old' });
    expect(again.envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('download: saved is absolute with forward slashes even when --dir is relative (#233, a listed divergence)', async () => {
    const { data } = await run('work-item download', { ...AT, id: '42', attachmentId: ATTACHMENT, dir: 'downloads' });
    expect(data).toEqual({ saved: expect.stringMatching(/^(\/|[A-Za-z]:\/).*\/downloads\/screenshot\.png$/), name: 'screenshot.png', size: 5 });
    expect((data as { saved: string }).saved).not.toContain('\\');
  });

  it('download never sends the PAT to another host: the URL is re-pointed, with a warning (#69 item 1)', async () => {
    const elsewhere = workItem(42, { relations: [{ rel: 'AttachedFile', url: `https://evil.example.com${COLL}/_apis/wit/attachments/${ATTACHMENT}`, attributes: { name: 'x.txt' } }] });
    const { calls, envelope } = await run('work-item download', { ...AT, id: '42', attachmentId: ATTACHMENT }, [{ path: `${COLL}/_apis/wit/workitems/42`, respond: { json: elsewhere } }]);
    expect(calls.every((c) => c.url.startsWith(ADO))).toBe(true);
    expect(envelope.meta.warnings?.[0]?.code).toBe('ADO_ATTACHMENT_HOST');
  });

  it('an unknown attachment id is refused', async () => {
    expect((await run('work-item download', { ...AT, id: '42', attachmentId: 'nope' })).envelope.error?.message).toBe('Attachment not found: nope');
  });
});

describe('discovery', () => {
  it('work-item types asks for each type\'s states', async () => {
    const { calls, data } = await run('work-item types', AT);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([`${PROJ}/_apis/wit/workitemtypes`, `${PROJ}/_apis/wit/workitemtypes/Bug/states`, `${PROJ}/_apis/wit/workitemtypes/Task/states`]);
    expect(data).toEqual([
      { name: 'Bug', states: ['New', 'Active', 'Resolved', 'Closed'], requiredFields: ['System.Title'] },
      { name: 'Task', states: ['New', 'Active'], requiredFields: [] },
    ]);
  });

  it('work-item fields without --type lists the collection, ignoring the project; --custom-only drops System and VSTS', async () => {
    const { calls, data } = await run('work-item fields', { ...AT, customOnly: true });
    expect(calls[0]!.url).toBe(`${ADO}${COLL}/_apis/wit/fields?api-version=7.1`);
    expect(data).toEqual([{ referenceName: 'MyOrg.Team', name: 'Team', type: 'string', readOnly: false, picklistId: 'abc12345-0000-0000-0000-000000000005' }]);
  });

  it('work-item fields --type returns no type or readOnly (#69 item 18, pinned)', async () => {
    const { data } = await run('work-item fields', { ...AT, type: 'Bug' });
    expect(JSON.parse(JSON.stringify(data))).toEqual([
      { referenceName: 'System.Title', name: 'Title' },
      { referenceName: 'MyOrg.Team', name: 'Team' },
    ]);
  });

  it('work-item fields and work-item types take no --save (KF6): it is an unknown input, refused before any request', async () => {
    for (const command of ['work-item fields', 'work-item types']) {
      const { envelope, calls } = await run(command, { ...AT, save: true });
      expect(envelope.error?.code, command).toBe('INVALID_INPUT');
      expect(calls, command).toEqual([]);
    }
  });

  it('work-item schema needs no connection; --example-only returns the example as data', async () => {
    const t = testContext({});
    const envelope = await execute(cmd('work-item schema'), { exampleOnly: true }, t.context);
    expect(envelope.data).toMatchObject({ type: 'Bug' });
    expect(t.http.calls).toEqual([]);
  });
});

describe('pull requests', () => {
  it('pr create prefixes refs/heads/, even onto a full ref, and sends reviewers as ids (#69 items 7 and 8, pinned)', async () => {
    const { calls } = await run('pr create', { ...W, title: 't', source: 'refs/heads/feature', reviewers: 'Sam Smith, abc' });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${ADO}${REPO}/pullrequests?api-version=7.1` });
    expect(body(calls[0]!)).toEqual({ title: 't', sourceRefName: 'refs/heads/refs/heads/feature', targetRefName: 'refs/heads/main', reviewers: [{ id: 'Sam Smith' }, { id: 'abc' }] });
  });

  it('pr update treats any --draft but "true" as false, and sends reviewers in the PATCH (#69 item 9)', async () => {
    const { calls } = await run('pr update', { ...W, id: '42', draft: 'yes', reviewers: 'a' });
    expect(body(calls[0]!)).toEqual({ reviewers: [{ id: 'a' }], isDraft: false });
  });

  it('pr update takes a boolean --draft (the widened schema) and sends isDraft: true', async () => {
    const { calls } = await run('pr update', { ...W, id: '42', draft: true });
    expect(body(calls[0]!)).toEqual({ isDraft: true });
  });

  it('pr merge reads the PR, then completes it with its last merge source commit, or "" without one', async () => {
    const { calls } = await run('pr merge', { ...W, id: '42' });
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PATCH']);
    expect(body(calls[1]!)).toEqual({ status: 'completed', lastMergeSourceCommit: { commitId: pr(42).lastMergeSourceCommit.commitId }, completionOptions: { mergeStrategy: 'noFastForward', deleteSourceBranch: false } });
    const bare = await run('pr merge', { ...W, id: '42', strategy: 'whatever' }, [{ path: `${REPO}/pullrequests/42`, respond: { json: pr(42, { lastMergeSourceCommit: undefined }) } }]);
    expect(body(bare.calls[1]!)).toMatchObject({ lastMergeSourceCommit: { commitId: '' }, completionOptions: { mergeStrategy: 'whatever' } });
  });

  it('approve reads connectionData for its own id, then PUTs vote 10; unapprove 0; wait-for-author -5', async () => {
    const { calls, data } = await run('pr approve', { ...W, id: '42' });
    expect(calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([`GET ${COLL}/_apis/connectionData`, `PUT ${REPO}/pullrequests/42/reviewers/${ME}`]);
    expect(body(calls[1]!)).toEqual({ vote: 10 });
    expect(data).toMatchObject({ vote: 10 });
    expect(body((await run('pr unapprove', { ...W, id: '42' })).calls[1]!)).toEqual({ vote: 0 });
    expect(body((await run('pr wait-for-author', { ...W, id: '42' })).calls[1]!)).toEqual({ vote: -5 });
  });

  it('comments flattens live threads oldest first, skipping deleted threads and comments', async () => {
    const { data } = await run('pr comments', { ...IN, id: '42' });
    expect((data as Array<{ id: number; threadId: number; threadContext: unknown }>).map((c) => [c.id, c.threadId, c.threadContext === null])).toEqual([
      [3, 8, false],
      [1, 7, true],
    ]);
    expect(((await run('pr comments', { ...IN, id: '42', inlineOnly: true })).data as unknown[]).length).toBe(1);
  });

  it('add-inline-comment sends the path as given and any side but left as right (#69 item 23)', async () => {
    const { calls } = await run('pr comment-inline', { ...W, id: '42', path: 'src/a.ts', line: '3', body: 'b', lineType: 'LEFT' });
    expect(body(calls[0]!)).toEqual({ comments: [{ content: 'b', commentType: 'text' }], status: 'active', threadContext: { filePath: 'src/a.ts', rightFileStart: { line: 3, offset: 1 }, rightFileEnd: { line: 3, offset: 1 } } });
  });

  it('delete-comment sends DELETE and returns { deleted: true }, and is never an MCP tool', async () => {
    const { calls, data } = await run('pr delete-comment', { ...W, id: '42', threadId: '7', commentId: '2' });
    expect(calls[0]).toMatchObject({ method: 'DELETE', url: `${ADO}${REPO}/pullrequests/42/threads/7/comments/2?api-version=7.1` });
    expect(data).toEqual({ deleted: true });
    expect(cmd('pr delete-comment').mcp).toBe(false);
  });

  it('diff compares the last merge commits; --path keeps one file, adding a leading /', async () => {
    const { calls, data } = await run('pr diff', { ...IN, id: '42', path: 'src/app.ts' });
    expect(new URL(calls[1]!.url).search).toBe(`?baseVersion=${pr(42).lastMergeTargetCommit.commitId}&baseVersionType=commit&targetVersion=${pr(42).lastMergeSourceCommit.commitId}&targetVersionType=commit&api-version=7.1`);
    expect((data as { changes: unknown[] }).changes).toHaveLength(1);
    const none = await run('pr diff', { ...IN, id: '42' }, [{ path: `${REPO}/pullrequests/42`, respond: { json: pr(42, { lastMergeTargetCommit: undefined }) } }]);
    expect(none.data).toEqual({ changes: [], aheadCount: 0, behindCount: 0 });
  });

  it('files reads the latest iteration', async () => {
    const { calls } = await run('pr files', { ...IN, id: '42' });
    expect(new URL(calls[1]!.url).pathname).toBe(`${REPO}/pullrequests/42/iterations/2/changes`);
  });

  it('pr list --updated-since keeps active PRs and those created or closed since, counting kept ones against --limit', async () => {
    const listed = [
      pr(1, { status: 'completed', creationDate: '2026-08-01T00:00:00Z', closedDate: '2026-08-02T00:00:00Z' }),
      pr(2, { status: 'active', creationDate: '2026-01-01T00:00:00Z' }),
      pr(3, { status: 'abandoned', creationDate: '2026-08-01T00:00:00Z', closedDate: '2026-09-02T00:00:00Z' }),
      pr(4, { status: 'completed', creationDate: '2026-09-01T00:00:00Z', closedDate: '2026-09-01T06:00:00Z' }),
      pr(5, { status: 'completed', creationDate: '2026-07-01T00:00:00Z', closedDate: '2026-08-31T23:59:59Z' }),
    ];
    const paged: Route = { path: `${REPO}/pullrequests`, respond: (r) => ({ json: { value: new URL(r.url).searchParams.get('$skip') === '0' ? listed : [] } }) };
    const all = await run('pr list', { ...IN, state: 'all', creator: 'jdoe', createdAfter: '2026-01-01', updatedSince: '2026-09-01T00:00:00Z' }, [paged]);
    expect((all.data as Array<{ pullRequestId: number }>).map((p) => p.pullRequestId)).toEqual([2, 3, 4]);
    // Nothing about it goes to the server: the filter is toil's, on top of the created range.
    expect(all.calls.map((c) => c.url)).toEqual([
      `${ADO}${REPO}/pullrequests?api-version=7.1&searchCriteria.status=all&searchCriteria.creatorId=jdoe&searchCriteria.queryTimeRangeType=created&searchCriteria.minTime=2026-01-01T00%3A00%3A00.000Z&%24top=100&%24skip=0`,
    ]);
    const limited = await run('pr list', { ...IN, state: 'all', updatedSince: '2026-09-01T00:00:00Z', limit: 2 }, [paged]);
    expect((limited.data as Array<{ pullRequestId: number }>).map((p) => p.pullRequestId)).toEqual([2, 3]);
    expect(limited.envelope.meta.page?.nextCursor).toEqual(expect.any(String));
    const bad = await run('pr list', { ...IN, updatedSince: 'yesterday' });
    expect(bad.calls).toEqual([]);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Invalid --updated-since value "yesterday"') });
  });

  it('pr get without --include is the one request and the pull request as it came', async () => {
    const { calls, data } = await run('pr get', { ...IN, id: '42' });
    expect(calls.map((c) => c.url)).toEqual([`${ADO}${REPO}/pullrequests/42?api-version=7.1`]);
    expect(data).toEqual(pr(42));
  });

  it('pr get --include reads each list asked for, in a fixed order, every page, into data.included', async () => {
    const { calls, data } = await run('pr get', { ...IN, id: '42', include: ' Files, reviews,,CHECKS,commits,reviews ' });
    expect(calls.map((c) => c.url)).toEqual([
      `${ADO}${REPO}/pullrequests/42?api-version=7.1`,
      `${ADO}${REPO}/pullrequests/42/threads?api-version=7.1`,
      `${ADO}${REPO}/pullrequests/42/statuses?api-version=7.1`,
      `${ADO}${REPO}/pullrequests/42/commits?api-version=7.1`,
      `${ADO}${REPO}/pullrequests/42/commits?api-version=7.1&continuationToken=abc12345`,
      `${ADO}${REPO}/pullrequests/42/iterations?api-version=7.1`,
      `${ADO}${REPO}/pullrequests/42/iterations/2/changes?api-version=7.1`,
    ]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const got = data as Record<string, unknown> & { included: Record<string, unknown[]> };
    expect(Object.keys(got.included)).toEqual(['reviews', 'checks', 'commits', 'files']);
    expect(got.included.reviews).toEqual(threads);
    expect(got.included.checks).toEqual([prStatus]);
    expect(got.included.commits).toEqual([prCommit(SHA), prCommit('def67890abc12345def67890abc12345def67890')]);
    expect(got.included.files).toEqual([{ changeTrackingId: 1, changeId: 1, item: { objectId: SHA, path: '/src/app.ts' }, changeType: 'edit' }]);
    const rest = Object.fromEntries(Object.entries(got).filter(([key]) => key !== 'included'));
    expect(rest).toEqual(pr(42));
  });

  it('pr get --include files takes the highest iteration id and follows nextSkip', async () => {
    const extra: Route[] = [
      { path: `${REPO}/pullrequests/42/iterations`, respond: { json: { count: 3, value: [{ id: 3 }, { id: 1 }, { id: 2 }] } } },
      {
        path: `${REPO}/pullrequests/42/iterations/3/changes`,
        respond: (r) => (new URL(r.url).searchParams.has('$skip') ? { json: { changeEntries: [{ changeId: 2 }] } } : { json: { changeEntries: [{ changeId: 1 }], nextSkip: 1, nextTop: 1 } }),
      },
    ];
    const { calls, data } = await run('pr get', { ...IN, id: '42', include: 'files' }, extra);
    expect(calls.slice(2).map((c) => c.url)).toEqual([`${ADO}${REPO}/pullrequests/42/iterations/3/changes?api-version=7.1`, `${ADO}${REPO}/pullrequests/42/iterations/3/changes?api-version=7.1&%24skip=1`]);
    expect((data as { included: unknown }).included).toEqual({ files: [{ changeId: 1 }, { changeId: 2 }] });
    const none = await run('pr get', { ...IN, id: '42', include: 'files' }, [{ path: `${REPO}/pullrequests/42/iterations`, respond: { json: { count: 0, value: [] } } }]);
    expect(none.calls).toHaveLength(2);
    expect((none.data as { included: unknown }).included).toEqual({ files: [] });
  });

  it('pr get refuses an unknown --include before any request, naming it and the allowed ones', async () => {
    const { calls, envelope } = await run('pr get', { ...IN, id: '42', include: 'reviews,builds' });
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown --include value "builds". Allowed: reviews, checks, commits, files.', fix: expect.stringContaining('--include reviews,checks') });
    // Only blanks asks for nothing more.
    expect((await run('pr get', { ...IN, id: '42', include: ' , ' })).calls).toHaveLength(1);
  });

  it('default-reviewers keeps Required reviewers policies covering this repo or the project', async () => {
    const { data } = await run('repo default-reviewers', IN);
    expect((data as Array<{ id: number }>).map((p) => p.id)).toEqual([1]);
  });

  it('builds filters by the source branch, missing merge-ref builds (#69 items 11 and 27, pinned)', async () => {
    const { calls } = await run('pr builds', { ...IN, id: '42' });
    expect(new URL(calls[1]!.url).searchParams.get('branchName')).toBe('refs/heads/feature/retries');
  });
});

describe('pipelines', () => {
  it('run normalises a short branch and sends parameters as a JSON string', async () => {
    const { calls } = await run('pipeline run', { ...AT, allowWrite: true, id: '5', branch: 'main', parameter: ['a=1', 'b=x=y'] });
    expect(body(calls[0]!)).toEqual({ definition: { id: 5 }, sourceBranch: 'refs/heads/main', parameters: '{"a":"1","b":"x=y"}' });
    expect((await run('pipeline run', { ...AT, allowWrite: true, id: '5', parameter: ['nope'] })).envelope.error?.message).toBe('Invalid --parameter "nope". Expected format: key=value');
  });

  it('run --wait polls until completed; a result other than succeeded returns the build and exits 1', async () => {
    let n = 0;
    const polled: Route = { path: `${PROJ}/_apis/build/builds/102`, respond: () => ({ json: build(102, n++ === 0 ? { status: 'inProgress', result: undefined } : { result: 'failed' }) }) };
    const t = testContext({ config: fixtureConfig, routes: [polled, ...routes] });
    const result = await runCli(['ado', '--collection', 'DefaultCollection', '--project', 'Imagile', 'pipeline', 'run', '5', '--wait', '--poll', '1', '--allow-write'], { commands: [cmd('pipeline run')], context: t.context });
    expect(result.envelope?.ok).toBe(true);
    expect(result.envelope?.data).toEqual(build(102, { result: 'failed' }));
    expect(result.envelope?.meta.warnings).toEqual([{ code: 'ADO_BUILD_NOT_SUCCEEDED', message: 'Build #102 finished with result failed.' }]);
    expect(result.exitCode).toBe(1);
  }, 10_000);

  it('run --wait with a bad --poll is refused after queueing, saying the build may run', async () => {
    const { envelope, calls } = await run('pipeline run', { ...AT, allowWrite: true, id: '5', wait: true, poll: '0' });
    expect(calls).toHaveLength(1);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid --poll "0". Expected a positive number of seconds.', fix: expect.stringContaining('Build #102 was queued') });
  });

  it('logs lists without --log-id, and returns { log } as text with --log-id', async () => {
    const listed = await run('run logs', { ...AT, id: '101' });
    expect(listed.calls[0]!.url).toBe(`${ADO}${PROJ}/_apis/build/builds/101/logs?api-version=7.1`);
    const one = await run('run logs', { ...AT, id: '101', logId: '3' });
    expect(one.calls[0]!.headers.accept).toBe('text/plain');
    expect(one.data).toEqual({ log: expect.stringContaining('Finishing: Build') });
    expect((await run('run logs', AT)).envelope.error?.code).toBe('INVALID_INPUT');
    expect((await run('run logs', { ...AT, id: '' })).envelope.error?.message).toBe('The run <id> is required (build run ID from run list or run get)');
  });

  it('run cancel PATCHes status cancelling', async () => {
    const { calls } = await run('run cancel', { ...AT, allowWrite: true, id: '101' });
    expect(calls[0]).toMatchObject({ method: 'PATCH', url: `${ADO}${PROJ}/_apis/build/builds/101?api-version=7.1` });
    expect(body(calls[0]!)).toEqual({ status: 'cancelling' });
  });
});
