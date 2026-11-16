import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { CannedResponse, Route } from '../../../test/harness/fake-fetch.js';
import { toilProjectDisk } from '../../../test/harness/toil-projects.js';
import { ADO, COLL, config as serverConfig } from '../../../test/fixtures/ado.fixture.js';
import { ORG_URL, config as cloudConfig } from '../../../test/fixtures/ado-cloud-data.js';
import { commandName, type AnyCommand } from '../../core/command.js';
import type { CategorizeResult } from '../../core/classify/types.js';
import { execute } from '../../core/run.js';
import { commands } from './index.js';

/**
 * What `ado work-item categorize` sends and makes of the answers, on both
 * deployments. Every response here is shaped from Microsoft's REST API 7.1
 * reference (Get Work Items Batch, Work Item Types Field - Get, Work Items -
 * Update), not captured from a live instance. A plan is a document in which
 * every item agrees to be reclassified, and the tests are the only meeting
 * where that is checked.
 */

const categorizeCommand = (): AnyCommand => commands.find((d) => commandName(d) === 'ado work-item categorize')!;

interface Deployment {
  name: 'server' | 'cloud';
  connection: string;
  config: Record<string, Record<string, unknown>>;
  /** Everything before a path, as it appears in a URL. */
  root: string;
  input: Record<string, unknown>;
  expand: string;
}

const DEPLOYMENTS: Deployment[] = [
  { name: 'server', connection: 'ado', config: serverConfig, root: `${ADO}${COLL}`, input: { collection: 'DefaultCollection' }, expand: '$expand' },
  { name: 'cloud', connection: 'ado-cloud', config: cloudConfig, root: ORG_URL, input: {}, expand: '%24expand' },
];

const BASIC = `Basic ${Buffer.from(':test-pat').toString('base64')}`;
const REF = 'Custom.WorkCategory';

/** A work item as the tests' fake tracker holds it; the batch read and the patch both work from this. */
interface Item {
  rev?: number;
  tags?: string;
  type?: string;
  project?: string;
  value?: unknown;
}

interface Tracker {
  items: Record<number, Item | null>;
  /** Allowed values per work item type; a type not listed doesn't carry the field. */
  types?: Record<string, string[]>;
  /** Display-name lookups: what GET _apis/wit/fields answers. */
  fields?: Array<{ name: string; referenceName: string }>;
  patch?: (id: number, count: number, body: Array<{ op: string; path: string; value?: unknown }>) => CannedResponse;
  /** Status of the batch read, when it should fail. */
  batch?: CannedResponse;
  /** Whether GET _apis/wit/fields/<ref> finds the field. */
  fieldExists?: boolean;
}

function routesFor(t: Tracker): Route[] {
  const counts = new Map<number, number>();
  const types = t.types ?? { Bug: ['KTLO', 'Feature'] };
  return [
    { method: 'POST', path: /\/_apis\/wit\/workitemsbatch$/, respond: (r) => {
      if (t.batch) return t.batch;
      const asked = JSON.parse(r.body!) as { ids: number[]; fields: string[] };
      const value = asked.ids.map((id) => {
        const item = t.items[id];
        if (item === null || item === undefined) return null;
        const fields: Record<string, unknown> = {
          'System.Id': id,
          'System.Rev': item.rev ?? 3,
          'System.Tags': item.tags ?? 'ui; backend',
          'System.WorkItemType': item.type ?? 'Bug',
          'System.TeamProject': item.project ?? 'Imagile',
        };
        if (asked.fields.includes(REF) && item.value !== undefined) fields[REF] = item.value;
        return { id, rev: item.rev ?? 3, fields };
      });
      return { json: { count: value.length, value } };
    } },
    { path: /\/_apis\/wit\/fields$/, respond: { json: { count: (t.fields ?? []).length, value: t.fields ?? [] } } },
    { path: /\/_apis\/wit\/fields\/[^/]+$/, respond: t.fieldExists === false ? { status: 404, json: { message: 'TF51535: Cannot find field.' } } : { json: { referenceName: REF } } },
    { path: /\/_apis\/wit\/workitemtypes\/([^/]+)\/fields\/[^/]+$/, respond: (r) => {
      const type = decodeURIComponent(/workitemtypes\/([^/]+)\/fields/.exec(r.url)![1]!);
      const allowed = types[type];
      return allowed === undefined ? { status: 404, json: { message: `TF26175: field is not on ${type}.` } } : { json: { referenceName: REF, name: 'Work Category', allowedValues: allowed } };
    } },
    { method: 'PATCH', path: /\/_apis\/wit\/workitems\/(\d+)$/, respond: (r) => {
      const id = Number(/workitems\/(\d+)/.exec(r.url)![1]);
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      return t.patch?.(id, count, JSON.parse(r.body!)) ?? { json: { id, rev: 4 } };
    } },
  ];
}

interface PlanItem {
  key: string;
  category?: string;
  value?: string;
}

/** A plan as `classify run` writes it, for one connection; `field: false` is a plan that names none. */
function plan(connection: string, items: PlanItem[], field: string | false = REF): string {
  return JSON.stringify({
    scheme: { name: 'ktlo-feature', revision: 1 },
    categories: [
      { id: 'ktlo', short: 'KTLO', name: 'Keep the lights on', label: 'ktlo', definition: 'Work that keeps the product running.' },
      { id: 'feature', short: 'Feature', name: 'New capability', label: 'feature', definition: 'Work that adds something new.' },
    ],
    plan: [
      {
        area: 'ado',
        connection,
        labels: { ktlo: 'ktlo', feature: 'feature' },
        ...(field ? { field: { name: field } } : {}),
        items: items.map((i) => {
          const category = i.category ?? 'ktlo';
          return {
            id: `${connection}:${i.key}`,
            key: i.key,
            category,
            labels: { add: [category], remove: [] },
            ...(i.value !== undefined && field ? { field: { value: i.value } } : {}),
          };
        }),
      },
    ],
  });
}

async function run(d: Deployment, tracker: Tracker, planText: string, input: Record<string, unknown> = {}, settings: Record<string, unknown> = {}, options: Parameters<typeof testContext>[0] = {}) {
  const t = testContext({ config: { [d.connection]: { ...d.config[d.connection], ...settings } }, routes: routesFor(tracker), files: { 'plan.json': planText }, ...options });
  const envelope = await execute(categorizeCommand(), { ...d.input, inputFile: 'plan.json', allowWrite: true, ...input }, t.context);
  const data = envelope.data as CategorizeResult | undefined;
  const calls = t.http.calls;
  return {
    envelope,
    data,
    calls,
    patches: calls.filter((c) => c.method === 'PATCH'),
    reads: calls.filter((c) => c.method === 'POST'),
    warnings: (envelope.meta.warnings ?? []).map((w) => w.code),
  };
}

const body = (call: { body: string | undefined }) => JSON.parse(call.body!) as Array<{ op: string; path: string; value?: unknown }>;

describe.each(DEPLOYMENTS)('ado work-item categorize on $name', (d) => {
  const root = (path: string, query = '') => `${d.root}${path}?api-version=7.1${query}`;
  const patchUrl = (id: number) => root(`/_apis/wit/workitems/${id}`, '&suppressNotifications=true');

  it('tags only: reads the batch, then one patch with the revision test and the tag added to the ones it has', async () => {
    const r = await run(d, { items: { 42: { rev: 7, tags: 'ui; backend' } } }, plan(d.connection, [{ key: '42' }], false));
    expect(r.envelope.ok).toBe(true);
    expect(r.calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', root('/_apis/wit/workitemsbatch')],
      ['PATCH', patchUrl(42)],
    ]);
    expect(JSON.parse(r.reads[0]!.body!)).toEqual({ ids: [42], fields: ['System.Id', 'System.Rev', 'System.Tags', 'System.WorkItemType', 'System.TeamProject'], errorPolicy: 'Omit' });
    expect(r.patches[0]!.headers).toMatchObject({ authorization: BASIC, 'content-type': 'application/json-patch+json' });
    expect(body(r.patches[0]!)).toEqual([
      { op: 'test', path: '/rev', value: 7 },
      { op: 'add', path: '/fields/System.Tags', value: 'ui; backend; ktlo' },
    ]);
    expect(r.data).toMatchObject({
      connection: d.connection,
      scheme: { name: 'ktlo-feature', revision: 1 },
      field: null,
      changed: [{ id: `${d.connection}:42`, key: '42', category: 'ktlo', labels: { added: ['ktlo'], removed: [] }, field: null }],
      unchanged: [],
      failed: [],
      counts: { planned: 1, changed: 1, unchanged: 0, failed: 0 },
    });
    expect(r.warnings).toEqual([]);
  });

  it('with a reference name: reads the field with the items, checks its allowed values, and patches tag and field together, in the listed spelling', async () => {
    const r = await run(d, { items: { 42: { value: 'Feature' } } }, plan(d.connection, [{ key: '42', value: 'ktlo' }]));
    expect(r.calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', root('/_apis/wit/workitemsbatch')],
      ['GET', root(`/Imagile/_apis/wit/workitemtypes/Bug/fields/${REF}`, `&${d.expand}=allowedValues`)],
      ['PATCH', patchUrl(42)],
    ]);
    expect(JSON.parse(r.reads[0]!.body!).fields).toEqual(['System.Id', 'System.Rev', 'System.Tags', 'System.WorkItemType', 'System.TeamProject', REF]);
    expect(body(r.patches[0]!)).toEqual([
      { op: 'test', path: '/rev', value: 3 },
      { op: 'add', path: '/fields/System.Tags', value: 'ui; backend; ktlo' },
      { op: 'add', path: `/fields/${REF}`, value: 'KTLO' },
    ]);
    expect(r.data).toMatchObject({ field: { name: REF, id: REF }, changed: [{ field: { value: 'KTLO' } }] });
  });

  it('by display name: looks the field up once, and uses its reference name', async () => {
    const fields = [{ name: 'Title', referenceName: 'System.Title' }, { name: 'Work category', referenceName: REF }];
    const r = await run(d, { items: { 42: {} }, fields }, plan(d.connection, [{ key: '42', value: 'KTLO' }], 'Work Category'));
    expect(r.calls[0]).toMatchObject({ method: 'GET', url: root('/_apis/wit/fields') });
    expect(body(r.patches[0]!)[2]).toEqual({ op: 'add', path: `/fields/${REF}`, value: 'KTLO' });
    expect(r.data?.field).toEqual({ name: 'Work Category', id: REF });
  });

  it('by toil project alias: the alias names the reference name, and no field list is read', async () => {
    const disk = toilProjectDisk({ 'home/.toil/projects/pay.json': { name: 'pay', ado: { fields: { workCategory: REF } } } });
    try {
      const areas = [{ name: 'ado', context: ['collection', 'project', 'repo'] }];
      const r = await run(d, { items: { 42: {} } }, plan(d.connection, [{ key: '42', value: 'KTLO' }], 'workCategory'), { toilProject: 'pay' }, {}, { toilProjects: (config) => disk.catalog(config, { areas }) });
      expect(r.envelope.ok).toBe(true);
      expect(r.calls.some((c) => c.url.endsWith('/_apis/wit/fields?api-version=7.1'))).toBe(false);
      expect(body(r.patches[0]!)[2]).toEqual({ op: 'add', path: `/fields/${REF}`, value: 'KTLO' });
    } finally {
      disk.cleanup();
    }
  });

  it('a second run changes nothing and sends no write: the tag is there in another case and the field is equal', async () => {
    const r = await run(d, { items: { 42: { tags: 'ui; KTLO', value: 'ktlo' } } }, plan(d.connection, [{ key: '42', value: 'KTLO' }]));
    expect(r.patches).toEqual([]);
    expect(r.data).toMatchObject({ changed: [], unchanged: ['42'], counts: { planned: 1, changed: 0, unchanged: 1, failed: 0 } });
    expect(r.warnings).toEqual([]);
  });

  it('reclassifying removes the other category tag and adds the new one in one patch, keeping the tags that are not the scheme’s', async () => {
    const r = await run(d, { items: { 42: { tags: 'ui; Feature; backend' } } }, plan(d.connection, [{ key: '42' }], false));
    expect(r.patches).toHaveLength(1);
    expect(body(r.patches[0]!)[1]).toEqual({ op: 'replace', path: '/fields/System.Tags', value: 'ui; backend; ktlo' });
    expect(r.data?.changed[0]?.labels).toEqual({ added: ['ktlo'], removed: ['Feature'] });
  });

  it('works the change out from the live tags, not from what the plan said to add and remove', async () => {
    // The plan says to add ktlo, but the item has it by now: only the field is sent.
    const r = await run(d, { items: { 42: { tags: 'ktlo' } } }, plan(d.connection, [{ key: '42', value: 'KTLO' }]));
    expect(body(r.patches[0]!)).toEqual([{ op: 'test', path: '/rev', value: 3 }, { op: 'add', path: `/fields/${REF}`, value: 'KTLO' }]);
    expect(r.data?.changed[0]).toMatchObject({ labels: { added: [], removed: [] }, field: { value: 'KTLO' } });
  });

  it('a field the tracker does not have is NOT_FOUND before any write', async () => {
    const r = await run(d, { items: { 42: {} }, fields: [{ name: 'Title', referenceName: 'System.Title' }] }, plan(d.connection, [{ key: '42', value: 'KTLO' }], 'Work Category'));
    expect(r.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('Work Category') });
    expect(r.patches).toEqual([]);
    expect(r.reads).toEqual([]);
  });

  it('a display name two fields share is INVALID_INPUT naming both reference names, before any write', async () => {
    const fields = [{ name: 'Work Category', referenceName: REF }, { name: 'work category', referenceName: 'Other.WorkCategory' }];
    const r = await run(d, { items: { 42: {} }, fields }, plan(d.connection, [{ key: '42', value: 'KTLO' }], 'Work Category'));
    expect(r.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(`${REF}, Other.WorkCategory`) });
    expect(r.calls.map((c) => c.method)).toEqual(['GET']);
  });

  it('a reference name that does not exist (the batch read answers 400) is NOT_FOUND for the field', async () => {
    const r = await run(d, { items: { 42: {} }, batch: { status: 400, json: { message: 'VS403727: field does not exist' } }, fieldExists: false }, plan(d.connection, [{ key: '42', value: 'KTLO' }]));
    expect(r.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining(REF) });
    expect(r.patches).toEqual([]);
  });

  it('a value the field does not offer is INVALID_INPUT, listing the options, before any write', async () => {
    const r = await run(d, { items: { 42: {}, 7: {} } }, plan(d.connection, [{ key: '42', value: 'KTLO' }, { key: '7', category: 'feature', value: 'Maintenance' }]));
    expect(r.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('KTLO, Feature') });
    expect(r.envelope.error?.message).toContain('"Maintenance"');
    expect(r.patches).toEqual([]);
  });

  it('a field with no allowed values takes the value as the plan spells it', async () => {
    const r = await run(d, { items: { 42: {} }, types: { Bug: [] } }, plan(d.connection, [{ key: '42', value: 'KTLO' }]));
    expect(body(r.patches[0]!)[2]).toEqual({ op: 'add', path: `/fields/${REF}`, value: 'KTLO' });
  });

  it('a work item type without the field gets the tag only, and CATEGORIZE_FIELD_NOT_ON_TYPE names the type', async () => {
    const r = await run(d, { items: { 42: {}, 7: { type: 'Epic' } } }, plan(d.connection, [{ key: '42', value: 'KTLO' }, { key: '7', value: 'KTLO' }]));
    expect(r.patches.map((p) => p.url)).toEqual([patchUrl(42), patchUrl(7)]);
    expect(body(r.patches[1]!)).toEqual([{ op: 'test', path: '/rev', value: 3 }, { op: 'add', path: '/fields/System.Tags', value: 'ui; backend; ktlo' }]);
    expect(r.data?.changed.map((c) => c.field)).toEqual([{ value: 'KTLO' }, null]);
    expect(r.warnings).toEqual(['CATEGORIZE_FIELD_NOT_ON_TYPE']);
    expect(r.envelope.meta.warnings?.[0]?.message).toContain('Imagile Epic (1 item)');
  });

  it('when no work item type carries the field, it is NOT_FOUND before any write', async () => {
    const r = await run(d, { items: { 42: {} }, types: {} }, plan(d.connection, [{ key: '42', value: 'KTLO' }]));
    expect(r.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining("on any of the plan's work item types") });
    expect(r.patches).toEqual([]);
  });

  it('an id the batch read leaves out is failed with a plain reason, and the rest are applied', async () => {
    const r = await run(d, { items: { 42: {}, 404: null } }, plan(d.connection, [{ key: '404' }, { key: '42' }], false));
    expect(r.data).toMatchObject({
      changed: [{ key: '42' }],
      failed: [{ key: '404', reason: "Azure DevOps has no work item 404, or this credential can't read it." }],
      counts: { planned: 2, changed: 1, unchanged: 0, failed: 1 },
    });
    expect(r.warnings).toEqual(['CATEGORIZE_FAILED']);
    expect(r.envelope.ok).toBe(true);
    expect(r.patches).toHaveLength(1);
  });

  it('a revision conflict re-reads the item and retries once with the new revision and tags', async () => {
    const items: Tracker['items'] = { 42: { rev: 3, tags: 'ui' } };
    const r = await run(
      d,
      {
        items,
        patch: (id, count) => {
          if (count > 1) return { json: { id, rev: 6 } };
          items[id] = { rev: 5, tags: 'ui; urgent' };
          return { status: 412, json: { message: 'TF401028: The work item was changed.' } };
        },
      },
      plan(d.connection, [{ key: '42' }], false),
    );
    expect(r.calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST', 'PATCH']);
    expect(JSON.parse(r.reads[1]!.body!).ids).toEqual([42]);
    expect(body(r.patches[0]!)[0]).toEqual({ op: 'test', path: '/rev', value: 3 });
    expect(body(r.patches[1]!)).toEqual([{ op: 'test', path: '/rev', value: 5 }, { op: 'add', path: '/fields/System.Tags', value: 'ui; urgent; ktlo' }]);
    expect(r.data).toMatchObject({ changed: [{ key: '42' }], failed: [] });
  });

  it('a 400 from the revision test on /rev counts as a conflict: it is read again and retried once', async () => {
    const r = await run(d, { items: { 42: {} }, patch: (id, count) => (count > 1 ? { json: { id } } : { status: 400, json: { message: 'VS403000: Test operation failed for path /rev: expected 3.' } }) }, plan(d.connection, [{ key: '42' }], false));
    expect(r.calls.map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST', 'PATCH']);
    expect(r.data?.changed).toHaveLength(1);
  });

  it.each([
    'VS402625: Dates must be increasing with each revision.',
    'The field System.Rev cannot be set to that value.',
    'The field Custom.Rev is not valid',
  ])('a 400 that only mentions a revision or a Rev field is not a conflict: sent once, and the failure carries the server message (%s)', async (message) => {
    const r = await run(d, { items: { 42: {} }, patch: () => ({ status: 400, json: { message } }) }, plan(d.connection, [{ key: '42' }], false));
    expect(r.patches).toHaveLength(1);
    expect(r.reads).toHaveLength(1);
    expect(r.data?.failed).toEqual([{ key: '42', reason: expect.stringContaining(message) }]);
    expect(r.data?.failed[0]!.reason).not.toContain('changed twice');
  });

  it('a second conflict is failed, and the next item still goes ahead', async () => {
    const r = await run(
      d,
      { items: { 42: {}, 7: {} }, patch: (id, count) => (id === 42 ? { status: 409, json: { message: `conflict ${count}` } } : { json: { id } }) },
      plan(d.connection, [{ key: '42' }, { key: '7' }], false),
    );
    expect(r.patches.map((p) => p.url)).toEqual([patchUrl(42), patchUrl(42), patchUrl(7)]);
    expect(r.data).toMatchObject({ changed: [{ key: '7' }], failed: [{ key: '42', reason: expect.stringContaining('changed twice') }] });
    // The second refusal's own words are kept.
    expect(r.data?.failed[0]!.reason).toContain('Azure DevOps said "conflict 2"');
    expect(r.warnings).toEqual(['CATEGORIZE_FAILED']);
  });

  it('a 403 on one patch is recorded and the rest go ahead; a 401 fails the command with AUTH', async () => {
    const denied = await run(
      d,
      { items: { 42: {}, 7: {} }, patch: (id) => (id === 42 ? { status: 403, json: { message: 'TF401027: You need the Edit permission.' } } : { json: { id } }) },
      plan(d.connection, [{ key: '42' }, { key: '7' }], false),
    );
    expect(denied.envelope.ok).toBe(true);
    expect(denied.data).toMatchObject({ changed: [{ key: '7' }], failed: [{ key: '42', reason: expect.stringContaining('TF401027') }] });

    const refused = await run(d, { items: { 42: {}, 7: {} }, patch: () => ({ status: 401, json: { message: 'TF400813: not authorized' } }) }, plan(d.connection, [{ key: '42' }, { key: '7' }], false));
    expect(refused.envelope.ok).toBe(false);
    expect(refused.envelope.error?.code).toBe('AUTH');
    expect(refused.patches).toHaveLength(1);
  });

  it('a 401 after some items were written fails the command with the counts so far in details.categorize', async () => {
    const r = await run(d, { items: { 42: {}, 7: {}, 9: {} }, patch: (id) => (id === 7 ? { status: 401, json: { message: 'TF400813: not authorized' } } : { json: { id } }) }, plan(d.connection, [{ key: '42' }, { key: '7' }, { key: '9' }], false));
    expect(r.envelope.ok).toBe(false);
    expect(r.envelope.error?.code).toBe('AUTH');
    expect(r.envelope.error?.message).toContain('1 of 3 items were changed before this.');
    expect(r.envelope.error?.details).toMatchObject({ categorize: { planned: 3, changed: 1, unchanged: 0, failed: 0 } });
    expect(r.patches).toHaveLength(2);
  });

  it('looks the field up only when an item sets it: a plan that changes tags alone sends no field lookup, and the result names the field without an id', async () => {
    const r = await run(d, { items: { 42: {} }, fields: [] }, plan(d.connection, [{ key: '42' }], 'Work Category'));
    expect(r.envelope.ok).toBe(true);
    expect(r.calls.filter((c) => c.url.includes('/_apis/wit/fields'))).toEqual([]);
    expect(r.data?.field).toEqual({ name: 'Work Category' });
    expect(r.data?.counts).toMatchObject({ planned: 1, changed: 1 });
    expect(body(r.patches[0]!)).toHaveLength(2);
  });

  it('a key that is not a work item id is INVALID_INPUT before anything is sent', async () => {
    const r = await run(d, { items: { 42: {} } }, plan(d.connection, [{ key: '42' }, { key: 'PAY-12' }]));
    expect(r.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('"PAY-12"') });
    expect(r.calls).toEqual([]);
  });

  it('reads more than 200 items in batches of 200, and sends nothing for items already right', async () => {
    const keys = Array.from({ length: 250 }, (_, i) => i + 1);
    const items = Object.fromEntries(keys.map((k) => [k, { tags: 'ktlo' }]));
    const r = await run(d, { items }, plan(d.connection, keys.map((k) => ({ key: String(k) })), false));
    expect(r.reads.map((c) => (JSON.parse(c.body!) as { ids: number[] }).ids.length)).toEqual([200, 50]);
    expect(r.patches).toEqual([]);
    expect(r.data?.counts).toEqual({ planned: 250, changed: 0, unchanged: 250, failed: 0 });
  });

  it('a plan with entries only for another connection is INVALID_INPUT, naming the connection to pass', async () => {
    const r = await run(d, { items: {} }, plan('somewhere-else', [{ key: '42' }], false));
    expect(r.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('somewhere-else') });
    expect(r.calls).toEqual([]);
  });

  it('an empty plan does nothing and says CATEGORIZE_NOTHING', async () => {
    const r = await run(d, { items: {} }, JSON.stringify({ scheme: { name: 'ktlo-feature', revision: 1 }, categories: [], plan: [] }));
    expect(r.calls).toEqual([]);
    expect(r.data).toMatchObject({ changed: [], unchanged: [], failed: [], skipped: [], counts: { planned: 0, changed: 0, unchanged: 0, failed: 0 } });
    expect(r.warnings).toEqual(['CATEGORIZE_NOTHING']);
  });

  it('entries for other connections are left alone and named in skipped, with CATEGORIZE_SKIPPED', async () => {
    const mine = JSON.parse(plan(d.connection, [{ key: '42' }], false)) as { plan: unknown[] };
    const other = JSON.parse(plan('elsewhere', [{ key: '9' }], false)) as { plan: unknown[] };
    const r = await run(d, { items: { 42: {} } }, JSON.stringify({ ...mine, plan: [...mine.plan, ...other.plan] }));
    expect(r.data).toMatchObject({ changed: [{ key: '42' }], skipped: [{ area: 'ado', connection: 'elsewhere', items: 1 }] });
    expect(r.warnings).toEqual(['CATEGORIZE_SKIPPED']);
  });

  it('is a write: without allowWrite, or with writes off on the connection, nothing is sent', async () => {
    const noFlag = await run(d, { items: { 42: {} } }, plan(d.connection, [{ key: '42' }], false), { allowWrite: false });
    expect(noFlag.envelope.error?.code).toBe('WRITE_DISABLED');
    expect(noFlag.calls).toEqual([]);
    const off = await run(d, { items: { 42: {} } }, plan(d.connection, [{ key: '42' }], false), {}, { writes: false });
    expect(off.envelope.error?.code).toBe('WRITE_DISABLED');
    expect(off.calls).toEqual([]);
  });

  it('needs no project: with none given or set, the work item is read and patched by id', async () => {
    const r = await run(d, { items: { 42: {} } }, plan(d.connection, [{ key: '42' }], false));
    expect(r.envelope.ok).toBe(true);
    expect(r.calls.every((c) => !c.url.includes('/Imagile/'))).toBe(true);
  });
});
