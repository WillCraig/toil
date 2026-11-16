import { describe, expect, it } from 'vitest';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import type { RecordedRequest, Route } from '../../../test/harness/fake-fetch.js';
import { toilProjectDisk } from '../../../test/harness/toil-projects.js';
import { config as serverConfig, JIRA } from '../../../test/fixtures/jira.fixture.js';
import { config as cloudConfig, SITE } from '../../../test/fixtures/jira-cloud-data.js';
import type { AnyCommand } from '../../core/command.js';
import { execute } from '../../core/run.js';
import { cloudCategorize, serverCategorize } from './categorize.js';

/**
 * `jira issue categorize` on both deployments: the requests it sends, in
 * order, and what it answers. Responses are shaped from Atlassian's REST
 * documentation (Data Center /rest/api/2, Cloud /rest/api/3), not captured
 * from a live instance. The same cases run against each deployment, because
 * a command that behaves differently on the two would need two sets of
 * documentation and a person to read both.
 */

const FIELD = 'customfield_10042';
const OPTIONS = [{ id: '10500', value: 'KTLO' }, { id: '10501', value: 'Feature' }];

interface Deployment {
  name: string;
  def: AnyCommand;
  connection: string;
  base: string;
  api: string;
  searchPath: string;
  searchAnswer: (issues: unknown[]) => unknown;
}

const DEPLOYMENTS: Deployment[] = [
  { name: 'Data Center', def: serverCategorize, connection: 'jira', base: JIRA, api: '/rest/api/2', searchPath: '/rest/api/2/search', searchAnswer: (issues) => ({ startAt: 0, maxResults: 100, total: issues.length, issues }) },
  { name: 'Cloud', def: cloudCategorize, connection: 'jira-cloud', base: SITE, api: '/rest/api/3', searchPath: '/rest/api/3/search/jql', searchAnswer: (issues) => ({ issues, isLast: true }) },
];

interface IssueOpts {
  labels?: string[];
  type?: string;
  project?: string;
  value?: string | null;
}

const issue = (key: string, o: IssueOpts = {}) => ({
  id: '10001',
  key,
  fields: {
    labels: o.labels ?? [],
    project: { key: o.project ?? 'PROJ' },
    issuetype: { name: o.type ?? 'Bug' },
    ...(o.value ? { [FIELD]: { value: o.value } } : {}),
  },
});

interface PlanOpts {
  field?: string | null;
  items?: Array<{ key: string; category: string; add?: string[]; remove?: string[]; value?: string }>;
  connection?: string;
  extra?: unknown[];
}

const labels = { ktlo: 'ktlo', feature: 'feature' };
const planFile = (d: Deployment, o: PlanOpts = {}) => {
  const field = o.field === undefined ? 'Work category' : o.field;
  const items = o.items ?? [{ key: 'PROJ-1', category: 'ktlo', value: 'KTLO' }];
  return JSON.stringify({
    scheme: { name: 'ktlo-feature', revision: 2 },
    categories: [
      { id: 'ktlo', short: 'KTLO', name: 'Keep the lights on', label: 'ktlo', definition: 'Keeps it running.' },
      { id: 'feature', short: 'Feature', name: 'New capability', label: 'feature', definition: 'Adds something.' },
    ],
    plan: [
      {
        area: 'jira',
        connection: o.connection ?? d.connection,
        labels,
        ...(field === null ? {} : { field: { name: field } }),
        items: items.map((i) => ({
          id: `${d.connection}:${i.key}`,
          key: i.key,
          category: i.category,
          labels: { add: i.add ?? [i.category], remove: i.remove ?? [] },
          ...(i.value !== undefined && field !== null ? { field: { value: i.value } } : {}),
        })),
      },
      ...(o.extra ?? []),
    ],
  });
};

interface World {
  issues?: Record<string, ReturnType<typeof issue>>;
  /** The editmeta fields by issue type name; the default type carries the field with its options. */
  editmeta?: Record<string, unknown>;
  fields?: unknown[];
  /** A status a PUT to this key answers with, in place of 204. */
  put?: Record<string, number>;
}

const missing = (status: number) => ({ status, json: { errorMessages: ['Issue Does Not Exist'], errors: {} } });
const keysOf = (jql: string) => [...jql.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
const FIELD_LIST = [
  { id: 'summary', name: 'Summary', custom: false },
  { id: FIELD, name: 'Work category', custom: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } },
];

function routes(d: Deployment, w: World): Route[] {
  const issues = w.issues ?? { 'PROJ-1': issue('PROJ-1') };
  const editFor = (key: string) => {
    const type = (issues[key]?.fields.issuetype.name as string | undefined) ?? 'Bug';
    return w.editmeta?.[type] ?? { labels: { name: 'Labels' }, [FIELD]: { name: 'Work category', allowedValues: OPTIONS } };
  };
  const keyOf = (req: RecordedRequest) => decodeURIComponent(new URL(req.url).pathname.split('/')[5]!);
  return [
    { method: 'GET', path: `${d.api}/field`, respond: { json: w.fields ?? FIELD_LIST } },
    {
      method: 'POST',
      path: d.searchPath,
      respond: (req) => {
        const keys = keysOf((JSON.parse(req.body!) as { jql: string }).jql);
        // Jira refuses the whole query when a key in it doesn't exist.
        if (keys.some((k) => !issues[k] && k !== 'PROJ-7')) return { status: 400, json: { errorMessages: ["An issue with key 'PROJ-9' does not exist for field 'key'."], errors: {} } };
        return { json: d.searchAnswer(keys.filter((k) => issues[k]).map((k) => issues[k])) };
      },
    },
    { method: 'GET', path: new RegExp(`^${d.api}/issue/[^/]+/editmeta$`), respond: (req) => ({ json: { fields: editFor(keyOf(req)) } }) },
    // A moved issue is still answered under the key it was asked for.
    { method: 'GET', path: new RegExp(`^${d.api}/issue/[^/]+$`), respond: (req) => (issues[keyOf(req)] ? { json: issues[keyOf(req)] } : keyOf(req) === 'PROJ-7' ? { json: issue('NEW-7') } : missing(404)) },
    { method: 'PUT', path: new RegExp(`^${d.api}/issue/[^/]+$`), respond: (req) => ({ status: w.put?.[keyOf(req)] ?? 204, ...(w.put?.[keyOf(req)] ? { json: { errorMessages: ['denied'], errors: {} } } : {}) }) },
  ];
}

async function apply(d: Deployment, plan: string, w: World = {}, extra: Record<string, unknown> = {}, config: Record<string, Record<string, unknown>> = { ...serverConfig, ...cloudConfig }) {
  const t = testContext({ config, routes: routes(d, w), files: { 'plan.json': plan } });
  const envelope = await execute(d.def, { inputFile: 'plan.json', allowWrite: true, connection: d.connection, ...extra }, t.context);
  const calls = t.http.calls.map((c) => ({ method: c.method, path: new URL(c.url).pathname, body: c.body === undefined ? undefined : (JSON.parse(c.body) as Record<string, unknown>) }));
  return { envelope, calls, puts: calls.filter((c) => c.method === 'PUT'), t };
}

describe.each(DEPLOYMENTS)('jira issue categorize on $name', (d) => {
  const url = (path: string) => `${d.base}${path}`;

  it('labels only: reads the issue with one search and adds the category label in one PUT', async () => {
    const { envelope, calls, t } = await apply(d, planFile(d, { field: null }));
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${d.searchPath}`, `PUT ${d.api}/issue/PROJ-1`]);
    expect(calls[0]!.body).toMatchObject({ jql: 'key in ("PROJ-1")', fields: ['labels', 'project', 'issuetype'] });
    expect(calls[1]!.body).toEqual({ update: { labels: [{ add: 'ktlo' }] } });
    expect(t.http.calls[1]!.url).toBe(url(`${d.api}/issue/PROJ-1`));
    expect(envelope.data).toMatchObject({
      connection: d.connection,
      scheme: { name: 'ktlo-feature', revision: 2 },
      field: null,
      changed: [{ id: `${d.connection}:PROJ-1`, key: 'PROJ-1', category: 'ktlo', labels: { added: ['ktlo'], removed: [] }, field: null }],
      unchanged: [],
      failed: [],
      skipped: [],
      counts: { planned: 1, changed: 1, unchanged: 0, failed: 0 },
    });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('a field named in words is looked up in the field list, and the option goes as its id, in the same PUT as the label', async () => {
    const { envelope, calls } = await apply(d, planFile(d));
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${d.api}/field`, `POST ${d.searchPath}`, `GET ${d.api}/issue/PROJ-1/editmeta`, `PUT ${d.api}/issue/PROJ-1`]);
    expect(calls[1]!.body).toMatchObject({ fields: ['labels', FIELD, 'project', 'issuetype'] });
    expect(calls[3]!.body).toEqual({ update: { labels: [{ add: 'ktlo' }] }, fields: { [FIELD]: { id: '10500' } } });
    expect(envelope.data).toMatchObject({ field: { name: 'Work category', id: FIELD }, changed: [{ field: { value: 'KTLO' } }] });
  });

  it('a field id is used as given, with no field lookup', async () => {
    const { envelope, calls } = await apply(d, planFile(d, { field: FIELD }));
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(calls.some((c) => c.path === `${d.api}/field`)).toBe(false);
    expect(envelope.data).toMatchObject({ field: { name: FIELD, id: FIELD } });
  });

  it("a field alias from the toil project is that field's id, with no field lookup", async () => {
    const disk = toilProjectDisk({ 'home/.toil/projects/pay.json': { name: 'pay', jira: { fields: { workCategory: FIELD } } } });
    try {
      const t = testContext({ config: { ...serverConfig, ...cloudConfig }, routes: routes(d, {}), files: { 'plan.json': planFile(d, { field: 'workCategory' }) }, toilProjects: (c) => disk.catalog(c) });
      const envelope = await execute(d.def, { inputFile: 'plan.json', allowWrite: true, connection: d.connection, toilProject: 'pay' }, t.context);
      expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
      expect(t.http.calls.some((c) => c.url.endsWith('/field'))).toBe(false);
      expect(envelope.data).toMatchObject({ field: { name: 'workCategory', id: FIELD }, changed: [{ field: { value: 'KTLO' } }] });
    } finally {
      disk.cleanup();
    }
  });

  it('a field with no options (text) is sent the value as it is', async () => {
    const { calls } = await apply(d, planFile(d), { editmeta: { Bug: { [FIELD]: { name: 'Work category' } } } });
    expect(calls.at(-1)!.body).toEqual({ update: { labels: [{ add: 'ktlo' }] }, fields: { [FIELD]: 'KTLO' } });
  });

  it('runs again and changes nothing: no request but the reads, and the key is unchanged', async () => {
    const { envelope, puts } = await apply(d, planFile(d), { issues: { 'PROJ-1': issue('PROJ-1', { labels: ['frontend', 'ktlo'], value: 'KTLO' }) } });
    expect(puts).toEqual([]);
    expect(envelope.data).toMatchObject({ changed: [], unchanged: ['PROJ-1'], counts: { planned: 1, changed: 0, unchanged: 1, failed: 0 } });
  });

  it("sets only the field when the label is there and the field isn't, and only the label when the field already matches", async () => {
    const both = {
      issues: { 'PROJ-1': issue('PROJ-1', { labels: ['ktlo'] }), 'PROJ-2': issue('PROJ-2', { value: 'Feature' }) },
    };
    const { puts } = await apply(d, planFile(d, { items: [{ key: 'PROJ-1', category: 'ktlo', value: 'KTLO' }, { key: 'PROJ-2', category: 'feature', value: 'Feature' }] }), both);
    expect(puts.map((p) => p.body)).toEqual([{ fields: { [FIELD]: { id: '10500' } } }, { update: { labels: [{ add: 'feature' }] } }]);
  });

  it("reclassifying removes the scheme's other label and adds the new one in one PUT, leaving other labels alone", async () => {
    const { envelope, puts } = await apply(d, planFile(d, { items: [{ key: 'PROJ-1', category: 'feature', value: 'Feature', remove: ['ktlo'] }] }), {
      issues: { 'PROJ-1': issue('PROJ-1', { labels: ['frontend', 'ktlo'], value: 'KTLO' }) },
    });
    expect(puts).toHaveLength(1);
    expect(puts[0]!.body).toEqual({ update: { labels: [{ add: 'feature' }, { remove: 'ktlo' }] }, fields: { [FIELD]: { id: '10501' } } });
    expect(envelope.data).toMatchObject({ changed: [{ labels: { added: ['feature'], removed: ['ktlo'] }, field: { value: 'Feature' } }] });
  });

  it("compares labels without regard to case: a spelling already there is not added again, and another scheme label is removed as the issue spells it", async () => {
    const present = await apply(d, planFile(d, { field: null }), { issues: { 'PROJ-1': issue('PROJ-1', { labels: ['KTLO'] }) } });
    expect(present.puts).toEqual([]);
    expect(present.envelope.data).toMatchObject({ unchanged: ['PROJ-1'] });
    const other = await apply(d, planFile(d, { field: null }), { issues: { 'PROJ-1': issue('PROJ-1', { labels: ['FEATURE', 'Keep'] }) } });
    expect(other.puts[0]!.body).toEqual({ update: { labels: [{ add: 'ktlo' }, { remove: 'FEATURE' }] } });
    const both = await apply(d, planFile(d, { field: null }), { issues: { 'PROJ-1': issue('PROJ-1', { labels: ['Ktlo', 'FEATURE'] }) } });
    expect(both.puts[0]!.body).toEqual({ update: { labels: [{ remove: 'FEATURE' }] } });
  });

  it('a field Jira has no such name for is NOT_FOUND before any write, and one named twice is INVALID_INPUT naming the ids', async () => {
    const none = await apply(d, planFile(d, { field: 'Nope' }));
    expect(none.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('"Nope"') });
    expect(none.puts).toEqual([]);
    const twice = await apply(d, planFile(d), { fields: [...FIELD_LIST, { id: 'customfield_10043', name: 'work CATEGORY', custom: true }] });
    expect(twice.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('customfield_10042, customfield_10043'), fix: expect.stringContaining('--target jira.field=customfield_') });
    expect(twice.puts).toEqual([]);
  });

  it("an option the field doesn't offer is INVALID_INPUT, naming the options, and nothing is written", async () => {
    const { envelope, puts } = await apply(d, planFile(d, { items: [{ key: 'PROJ-1', category: 'ktlo', value: 'Run' }, { key: 'PROJ-2', category: 'feature', value: 'Feature' }] }), {
      issues: { 'PROJ-1': issue('PROJ-1'), 'PROJ-2': issue('PROJ-2') },
    });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('has no option "Run"') });
    expect(envelope.error?.message).toContain('KTLO, Feature');
    expect(puts).toEqual([]);
  });

  it('an issue type without the field gets the label only, and the warning says which types', async () => {
    const { envelope, calls } = await apply(d, planFile(d, { items: [{ key: 'PROJ-1', category: 'ktlo', value: 'KTLO' }, { key: 'PROJ-2', category: 'ktlo', value: 'KTLO' }] }), {
      issues: { 'PROJ-1': issue('PROJ-1'), 'PROJ-2': issue('PROJ-2', { type: 'Epic' }) },
      editmeta: { Epic: { labels: { name: 'Labels' } } },
    });
    expect(envelope.ok).toBe(true);
    expect(calls.filter((c) => c.path.endsWith('/editmeta')).map((c) => c.path)).toEqual([`${d.api}/issue/PROJ-1/editmeta`, `${d.api}/issue/PROJ-2/editmeta`]);
    expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
      { update: { labels: [{ add: 'ktlo' }] }, fields: { [FIELD]: { id: '10500' } } },
      { update: { labels: [{ add: 'ktlo' }] } },
    ]);
    expect(envelope.data).toMatchObject({ changed: [{ key: 'PROJ-1', field: { value: 'KTLO' } }, { key: 'PROJ-2', field: null }] });
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'CATEGORIZE_FIELD_NOT_ON_TYPE', message: expect.stringContaining('PROJ Epic (1 item)') })]);
  });

  it("when no issue's type carries the field it is NOT_FOUND before any write", async () => {
    const { envelope, puts } = await apply(d, planFile(d), { editmeta: { Bug: { labels: { name: 'Labels' } } } });
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining("on any of the plan's issue types") });
    expect(puts).toEqual([]);
  });

  it('a search Jira refuses (a key that is not there) falls back to one read per issue; the missing one fails and the rest are applied', async () => {
    const { envelope, calls } = await apply(d, planFile(d, { field: null, items: [{ key: 'PROJ-1', category: 'ktlo' }, { key: 'PROJ-9', category: 'ktlo' }, { key: 'PROJ-2', category: 'feature' }] }), {
      issues: { 'PROJ-1': issue('PROJ-1'), 'PROJ-2': issue('PROJ-2') },
    });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST ${d.searchPath}`,
      `GET ${d.api}/issue/PROJ-1`,
      `GET ${d.api}/issue/PROJ-9`,
      `GET ${d.api}/issue/PROJ-2`,
      `PUT ${d.api}/issue/PROJ-1`,
      `PUT ${d.api}/issue/PROJ-2`,
    ]);
    expect(envelope.data).toMatchObject({ changed: [{ key: 'PROJ-1' }, { key: 'PROJ-2' }], failed: [{ key: 'PROJ-9', reason: expect.stringContaining('Issue Does Not Exist') }], counts: { planned: 3, changed: 2, failed: 1 } });
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'CATEGORIZE_FAILED', message: expect.stringContaining('PROJ-9') })]);
  });

  it('an issue the search leaves out (a moved one) is read by the key the plan named, and written by it', async () => {
    const { envelope, calls } = await apply(d, planFile(d, { field: null, items: [{ key: 'PROJ-7', category: 'ktlo' }] }));
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${d.searchPath}`, `GET ${d.api}/issue/PROJ-7`, `PUT ${d.api}/issue/PROJ-7`]);
    expect(envelope.data).toMatchObject({ changed: [{ key: 'PROJ-7' }] });
  });

  it('a 403 on one PUT is that issue\'s failure and the rest go on; a 401 fails the command', async () => {
    const items = [{ key: 'PROJ-1', category: 'ktlo' }, { key: 'PROJ-2', category: 'ktlo' }];
    const issues = { 'PROJ-1': issue('PROJ-1'), 'PROJ-2': issue('PROJ-2') };
    const denied = await apply(d, planFile(d, { field: null, items }), { issues, put: { 'PROJ-1': 403 } });
    expect(denied.envelope.ok).toBe(true);
    expect(denied.puts).toHaveLength(2);
    expect(denied.envelope.data).toMatchObject({ changed: [{ key: 'PROJ-2' }], failed: [{ key: 'PROJ-1', reason: expect.stringContaining('denied') }], counts: { failed: 1 } });
    expect(denied.envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'CATEGORIZE_FAILED' })]);
    const refused = await apply(d, planFile(d, { field: null, items }), { issues, put: { 'PROJ-1': 401 } });
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.error?.code).toBe('AUTH');
    expect(refused.puts).toHaveLength(1);
  });

  it('a 401 after some issues were written fails the command with the counts so far in details.categorize', async () => {
    const items = [{ key: 'PROJ-1', category: 'ktlo' }, { key: 'PROJ-2', category: 'ktlo' }, { key: 'PROJ-3', category: 'ktlo' }];
    const issues = { 'PROJ-1': issue('PROJ-1'), 'PROJ-2': issue('PROJ-2'), 'PROJ-3': issue('PROJ-3') };
    const { envelope, puts } = await apply(d, planFile(d, { field: null, items }), { issues, put: { 'PROJ-2': 401 } });
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('AUTH');
    expect(envelope.error?.message).toContain('1 of 3 items were changed before this.');
    expect(envelope.error?.details).toMatchObject({ categorize: { planned: 3, changed: 1, unchanged: 0, failed: 0 } });
    expect(puts).toHaveLength(2);
  });

  it('looks the field up only when an issue sets it: a plan that changes labels alone is not refused over a field Jira no longer has', async () => {
    const { envelope, calls, puts } = await apply(d, planFile(d, { items: [{ key: 'PROJ-1', category: 'ktlo' }] }), { fields: [] });
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST ${d.searchPath}`, `PUT ${d.api}/issue/PROJ-1`]);
    expect(puts[0]!.body).toEqual({ update: { labels: [{ add: 'ktlo' }] } });
    expect(envelope.data).toMatchObject({ field: { name: 'Work category' }, changed: [{ key: 'PROJ-1', field: null }] });
    expect((envelope.data as { field: Record<string, unknown> }).field).not.toHaveProperty('id');
  });

  it("a plan with entries only for another connection is INVALID_INPUT, and with some for others they are skipped and said so", async () => {
    const other = await apply(d, planFile(d, { connection: 'elsewhere' }));
    expect(other.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('"elsewhere"') });
    expect(other.calls).toEqual([]);
    const extra = { area: 'github', connection: 'gh', labels, items: [{ id: 'gh:o/r#1', key: 'o/r#1', category: 'ktlo', labels: { add: ['ktlo'], remove: [] } }] };
    const skipped = await apply(d, planFile(d, { field: null, extra: [extra] }));
    expect(skipped.envelope.ok).toBe(true);
    expect(skipped.envelope.data).toMatchObject({ skipped: [{ area: 'github', connection: 'gh', items: 1 }] });
    expect(skipped.envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'CATEGORIZE_SKIPPED' })]);
  });

  it('an empty plan succeeds with zero counts and says there was nothing to do, sending nothing', async () => {
    const empty = JSON.stringify({ scheme: { name: 'ktlo-feature', revision: 2 }, categories: [], plan: [] });
    const { envelope, calls } = await apply(d, empty);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ field: null, changed: [], unchanged: [], failed: [], counts: { planned: 0, changed: 0, unchanged: 0, failed: 0 } });
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'CATEGORIZE_NOTHING' })]);
    expect(calls).toEqual([]);
  });

  it('sends nothing without --allow-write, or when the connection has writes off', async () => {
    const without = await apply(d, planFile(d), {}, { allowWrite: undefined });
    expect(without.envelope.error?.code).toBe('WRITE_DISABLED');
    expect(without.calls).toEqual([]);
    const off = await apply(d, planFile(d), {}, {}, { ...serverConfig, ...cloudConfig, [d.connection]: { ...({ ...serverConfig, ...cloudConfig } as Record<string, object>)[d.connection], writes: false } });
    expect(off.envelope.error?.code).toBe('WRITE_DISABLED');
    expect(off.calls).toEqual([]);
  });

  it('runs from the command line: --from names the plan, and --allow-write lets it write', async () => {
    const t = testContext({ config: { ...serverConfig, ...cloudConfig }, routes: routes(d, {}), files: { 'plan.json': planFile(d, { field: null }) } });
    const run = await runCli(['jira', 'issue', 'categorize', '--input-file', 'plan.json', '--allow-write', '--connection', d.connection], { commands: [d.def], context: t.context });
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(run.envelope?.data).toMatchObject({ counts: { changed: 1 } });
    const refused = await runCli(['jira', 'issue', 'categorize', '--input-file', 'plan.json', '--connection', d.connection], { commands: [d.def], context: t.context });
    expect(refused.envelope?.error?.code).toBe('WRITE_DISABLED');
  });
});
