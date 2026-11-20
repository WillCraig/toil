import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { Route } from '../../../test/harness/fake-fetch.js';
import {
  API,
  API_V3,
  attributesPage,
  changeRequest,
  config,
  ENV,
  flag,
  flagSet,
  flagSetPage,
  largeSegment,
  rolloutStatuses,
  ruleBasedSegment,
  segmentKeys,
  segmentsPage,
  SPLIT,
  trafficTypes,
  WS,
} from '../../../test/fixtures/splitio.fixture.js';
import type { AnyCommand } from '../../core/command.js';
import { execute } from '../../core/run.js';
import { flagsListCommand } from './flags.js';
import { attributeListCommand, flagSetGetCommand, flagSetListCommand, rolloutStatusListCommand, trafficTypeListCommand } from './schema.js';
import {
  largeSegmentGetCommand,
  largeSegmentListCommand,
  MAX_KEYS,
  ruleBasedSegmentGetCommand,
  ruleBasedSegmentListCommand,
  ruleBasedSegmentUpdateCommand,
  segmentAddKeysCommand,
  segmentKeysCommand,
  segmentListCommand,
  segmentRemoveKeysCommand,
} from './segments.js';

/**
 * The segment, flag-set, traffic-type, attribute and rollout-status commands
 * (#674), and flag list's --tag and --search (#671), against the requests
 * Split's Admin API reference documents. Each test checks the request sent
 * and the data made of the answer, which is the whole of the job, filed in
 * duplicate.
 */

const AUTH = { authorization: 'Bearer test-admin-key', accept: 'application/json' };
const CR_PATH = `${API}/changeRequests/ws/${WS}/environments/${ENV}`;
const CR = { workspace: WS, mnemonic: 'segment-change', description: 'Beta cohort', changeNumber: 'CHG0001234', allowWrite: true };
const COMMENT = 'Beta cohort\n\nChange number: CHG0001234';

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[], files?: Record<string, string>) {
  const t = testContext({ config, routes, ...(files ? { files } : {}) });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls };
}

const get = (path: string, json: unknown, query?: Record<string, string | string[]>): Route => ({ method: 'GET', path, ...(query ? { query } : {}), respond: { json } });
const postCr: Route = { method: 'POST', path: CR_PATH, respond: (request) => ({ json: changeRequest(request) }) };
const sent = (call: { body: string | undefined }) => JSON.parse(call.body ?? 'null') as Record<string, unknown>;

describe('segment list', () => {
  it('reads one page of the workspace, 50 by default', async () => {
    const { envelope, calls } = await run(segmentListCommand, { workspace: WS }, [get(`${API}/segments/ws/${WS}`, segmentsPage, { offset: '0', limit: '50' })]);
    expect(calls[0]!.url).toBe(`${SPLIT}${API}/segments/ws/${WS}?offset=0&limit=50`);
    expect(calls[0]!.headers).toEqual(AUTH);
    expect(envelope.data).toEqual({ count: 2, totalCount: 2, segments: segmentsPage.objects });
  });

  it('reads the segments enabled in an environment with --environment', async () => {
    const { calls } = await run(segmentListCommand, { workspace: WS, environment: ENV, limit: '10', offset: '20' }, [
      get(`${API}/segments/ws/${WS}/environments/${ENV}`, segmentsPage, { offset: '20', limit: '10' }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('says the total is unknown, not zero, when Split gives none', async () => {
    const { envelope } = await run(segmentListCommand, { workspace: WS }, [get(`${API}/segments/ws/${WS}`, { objects: [] })]);
    expect(envelope.data).toEqual({ count: 0, totalCount: null, segments: [] });
  });

  it('refuses an answer that is not a list, rather than report no segments', async () => {
    const { envelope } = await run(segmentListCommand, { workspace: WS }, [get(`${API}/segments/ws/${WS}`, { message: 'unexpected' })]);
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('HTTP');
  });
});

describe('segment keys', () => {
  it('reads keys from the environment path, with no workspace, as plain strings, count as the total (#79 item 15, kept)', async () => {
    const { envelope, calls } = await run(segmentKeysCommand, { segment: 'beta_users', environment: ENV }, [
      get(`${API}/segments/${ENV}/beta_users/keys`, { ...segmentKeys, count: 200 }, { offset: '0', limit: '100' }),
    ]);
    expect(calls[0]!.url).toBe(`${SPLIT}${API}/segments/${ENV}/beta_users/keys?offset=0&limit=100`);
    // Split's count is the segment's total; the page holds two.
    expect(envelope.data).toEqual({ count: 2, totalCount: 200, keys: ['user-1', 'user-2'] });
  });

  it('refuses an answer with no keys list, or a key that is not a string, rather than invent keys', async () => {
    for (const body of [{ count: 0 }, { keys: [{ key: 'user-1' }, {}], count: 2 }, { keys: [null], count: 1 }]) {
      const { envelope } = await run(segmentKeysCommand, { segment: 'beta_users', environment: ENV }, [get(`${API}/segments/${ENV}/beta_users/keys`, body)]);
      expect(envelope.error?.code).toBe('HTTP');
    }
  });

  it('encodes the segment name as one path segment', async () => {
    const { calls } = await run(segmentKeysCommand, { segment: 'a/b', environment: ENV }, [get(`${API}/segments/${ENV}/a%2Fb/keys`, segmentKeys)]);
    expect(calls[0]!.url).toContain('/a%2Fb/keys');
  });
});

describe('segment add-keys and remove-keys', () => {
  it('files a CREATE change request under segment with the keys from --key and --keys-file, each once', async () => {
    const { envelope, calls } = await run(
      segmentAddKeysCommand,
      { ...CR, segment: 'beta_users', environment: ENV, key: ['user-1', 'user-3'], keysFile: 'keys.txt', approvers: 'you@example.com' },
      [postCr],
      { 'keys.txt': 'user-3\r\nuser-4\n\n' },
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe(`${SPLIT}${CR_PATH}`);
    expect(sent(calls[0]!)).toEqual({
      segment: { name: 'beta_users', keys: ['user-1', 'user-3', 'user-4'] },
      operationType: 'CREATE',
      title: 'segment-change',
      comment: COMMENT,
      approvers: ['you@example.com'],
    });
    expect(envelope.data).toMatchObject({ id: 'cr-abc12345', operationType: 'CREATE' });
  });

  it('reads a JSON array of keys from the file', async () => {
    const { calls } = await run(segmentAddKeysCommand, { ...CR, segment: 'beta_users', environment: ENV, keysFile: 'keys.json' }, [postCr], { 'keys.json': '["user-5","user-6"]' });
    expect(sent(calls[0]!).segment).toEqual({ name: 'beta_users', keys: ['user-5', 'user-6'] });
  });

  it('files ARCHIVE to remove keys, and sends no rollout status', async () => {
    const { calls } = await run(segmentRemoveKeysCommand, { ...CR, segment: 'beta_users', environment: ENV, key: ['user-1'] }, [postCr]);
    expect(sent(calls[0]!)).toMatchObject({ segment: { name: 'beta_users', keys: ['user-1'] }, operationType: 'ARCHIVE' });
    expect(sent(calls[0]!)).not.toHaveProperty('rolloutStatus');
  });

  it('refuses no keys before anything is sent', async () => {
    const { envelope, calls } = await run(segmentAddKeysCommand, { ...CR, segment: 'beta_users', environment: ENV }, [postCr]);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it(`refuses more than ${MAX_KEYS} keys before anything is sent`, async () => {
    const many = Array.from({ length: MAX_KEYS + 1 }, (_, i) => `user-${i}`).join('\n');
    const { envelope, calls } = await run(segmentAddKeysCommand, { ...CR, segment: 'beta_users', environment: ENV, keysFile: 'keys.txt' }, [postCr], { 'keys.txt': many });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.message).toContain(String(MAX_KEYS));
    expect(calls).toHaveLength(0);
  });

  it('takes the stdout of segment keys, with or without --select keys, as the file', async () => {
    const whole = { ok: true, data: { count: 2, totalCount: 2, keys: ['user-1', 'user-2'] }, error: null, meta: {} };
    const selected = { ...whole, data: ['user-1', 'user-2'] };
    for (const envelope of [whole, selected]) {
      const { calls } = await run(segmentRemoveKeysCommand, { ...CR, segment: 'beta_users', environment: ENV, keysFile: 'keys.json' }, [postCr], { 'keys.json': JSON.stringify(envelope, null, 2) });
      expect(sent(calls[0]!).segment).toEqual({ name: 'beta_users', keys: ['user-1', 'user-2'] });
    }
  });

  it('refuses JSON in the file that is not a list of keys, rather than read its lines as keys', async () => {
    const { envelope, calls } = await run(segmentAddKeysCommand, { ...CR, segment: 'beta_users', environment: ENV, keysFile: 'keys.json' }, [postCr], { 'keys.json': '{\n  "name": "x"\n}' });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('refuses JSON in the file that is not an array of strings', async () => {
    const { envelope, calls } = await run(segmentAddKeysCommand, { ...CR, segment: 'beta_users', environment: ENV, keysFile: 'keys.json' }, [postCr], { 'keys.json': '[1,2]' });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(calls).toHaveLength(0);
  });

  it('holds the write gate: no --allow-write, no request', async () => {
    const { envelope, calls } = await run(segmentAddKeysCommand, { ...CR, allowWrite: false, segment: 'beta_users', environment: ENV, key: ['user-1'] }, [postCr]);
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toHaveLength(0);
  });
});

describe('large segments', () => {
  it('lists the workspace, or an environment, with no paging parameters, and gets one by name (#79 item 17, kept)', async () => {
    const list = await run(largeSegmentListCommand, { workspace: WS }, [get(`${API}/large-segments/ws/${WS}`, [largeSegment])]);
    expect(list.envelope.data).toEqual({ count: 1, largeSegments: [largeSegment] });
    const inEnv = await run(largeSegmentListCommand, { workspace: WS, environment: ENV }, [get(`${API}/large-segments/ws/${WS}/environments/${ENV}`, { objects: [largeSegment] })]);
    expect(inEnv.envelope.data).toMatchObject({ count: 1 });
    const one = await run(largeSegmentGetCommand, { workspace: WS, name: 'all_customers' }, [get(`${API}/large-segments/ws/${WS}/all_customers`, largeSegment)]);
    expect(one.envelope.data).toEqual(largeSegment);
  });
});

describe('rule-based segments', () => {
  it('lists the workspace, or an environment, with no paging parameters, and gets one by name (#79 item 17, kept)', async () => {
    const list = await run(ruleBasedSegmentListCommand, { workspace: WS }, [get(`${API}/rule-based-segments/ws/${WS}`, { objects: [ruleBasedSegment] })]);
    expect(list.envelope.data).toEqual({ count: 1, ruleBasedSegments: [ruleBasedSegment] });
    const inEnv = await run(ruleBasedSegmentListCommand, { workspace: WS, environment: ENV }, [get(`${API}/rule-based-segments/ws/${WS}/environments/${ENV}`, { objects: [] })]);
    expect(inEnv.envelope.data).toEqual({ count: 0, ruleBasedSegments: [] });
    const one = await run(ruleBasedSegmentGetCommand, { workspace: WS, name: 'beta_testers' }, [get(`${API}/rule-based-segments/ws/${WS}/beta_testers`, ruleBasedSegment)]);
    expect(one.envelope.data).toEqual(ruleBasedSegment);
  });

  it('files an UPDATE change request under ruleBasedSegment with the file and the name', async () => {
    const file = { rules: ruleBasedSegment.rules, excludedKeys: ['user-9'], excludedSegments: [] };
    const { calls } = await run(ruleBasedSegmentUpdateCommand, { ...CR, name: 'beta_testers', environment: ENV, inputFile: 'rbs.json' }, [postCr], { 'rbs.json': JSON.stringify(file) });
    expect(sent(calls[0]!)).toEqual({
      ruleBasedSegment: { ...file, name: 'beta_testers' },
      operationType: 'UPDATE',
      title: 'segment-change',
      comment: COMMENT,
      approvers: [],
    });
  });

  it('sends only rules and exclusions from get output, not its title or comment', async () => {
    const { calls } = await run(ruleBasedSegmentUpdateCommand, { ...CR, name: 'beta_testers', environment: ENV, inputFile: 'rbs.json' }, [postCr], { 'rbs.json': JSON.stringify(ruleBasedSegment) });
    expect(sent(calls[0]!).ruleBasedSegment).toEqual({ name: 'beta_testers', rules: ruleBasedSegment.rules, excludedKeys: [], excludedSegments: [] });
  });

  it('unwraps a whole envelope saved from get', async () => {
    const saved = { ok: true, data: ruleBasedSegment, error: null, meta: {} };
    const { calls } = await run(ruleBasedSegmentUpdateCommand, { ...CR, name: 'beta_testers', environment: ENV, inputFile: 'rbs.json' }, [postCr], { 'rbs.json': JSON.stringify(saved) });
    expect(sent(calls[0]!).ruleBasedSegment).toEqual({ name: 'beta_testers', rules: ruleBasedSegment.rules, excludedKeys: [], excludedSegments: [] });
  });

  it('refuses a file with none of the definition fields, rather than file a request that would clear the rules', async () => {
    for (const file of ['{}', '{"rule": []}', JSON.stringify({ ok: true, data: { title: 'x' }, error: null, meta: {} })]) {
      const { envelope, calls } = await run(ruleBasedSegmentUpdateCommand, { ...CR, name: 'beta_testers', environment: ENV, inputFile: 'rbs.json' }, [postCr], { 'rbs.json': file });
      expect(envelope.error?.code).toBe('INVALID_INPUT');
      expect(calls).toHaveLength(0);
    }
  });

  it('refuses a missing file, or one that is not a JSON object, before anything is sent', async () => {
    const none = await run(ruleBasedSegmentUpdateCommand, { ...CR, name: 'beta_testers', environment: ENV }, [postCr]);
    expect(none.envelope.error?.code).toBe('INVALID_INPUT');
    const array = await run(ruleBasedSegmentUpdateCommand, { ...CR, name: 'beta_testers', environment: ENV, inputFile: 'rbs.json' }, [postCr], { 'rbs.json': '[]' });
    expect(array.envelope.error?.code).toBe('INVALID_INPUT');
    expect([...none.calls, ...array.calls]).toHaveLength(0);
  });
});

describe('flag-set list and get', () => {
  it('reads v3 with the workspace as workspace_id, 200 at a time, and reads an empty marker as the last page', async () => {
    const { envelope, calls } = await run(flagSetListCommand, { workspace: WS }, [get(`${API_V3}/flag-sets`, flagSetPage, { workspace_id: WS, limit: '200' })]);
    expect(calls[0]!.url).toBe(`${SPLIT}${API_V3}/flag-sets?workspace_id=${WS}&limit=200`);
    expect(envelope.data).toEqual({ count: 1, totalCount: null, flagSets: [flagSet], nextMarker: null, previousMarker: null });
    expect(envelope.meta.page).toEqual({ nextCursor: null, limit: 200 });
  });

  it('passes --cursor on as after, and hands back the next marker', async () => {
    const { envelope } = await run(flagSetListCommand, { workspace: WS, limit: '20', cursor: 'marker-abc12345' }, [
      get(`${API_V3}/flag-sets`, { ...flagSetPage, nextMarker: 'marker-abc12346' }, { workspace_id: WS, limit: '20', after: 'marker-abc12345' }),
    ]);
    expect(envelope.data).toMatchObject({ nextMarker: 'marker-abc12346' });
    expect(envelope.meta.page).toEqual({ nextCursor: 'marker-abc12346', limit: 20 });
  });

  it('gets one by ID from v3', async () => {
    const { envelope, calls } = await run(flagSetGetCommand, { id: flagSet.id }, [get(`${API_V3}/flag-sets/${flagSet.id}`, flagSet)]);
    expect(calls[0]!.url).toBe(`${SPLIT}${API_V3}/flag-sets/${flagSet.id}`);
    expect(envelope.data).toEqual(flagSet);
  });
});

describe('traffic types, attributes and rollout statuses', () => {
  it('lists traffic types', async () => {
    const { envelope } = await run(trafficTypeListCommand, { workspace: WS }, [get(`${API}/trafficTypes/ws/${WS}`, trafficTypes)]);
    expect(envelope.data).toEqual({ count: 1, trafficTypes });
  });

  it('always asks for paged attributes as Paginate=true, with the prefix searched by Split (#79 item 16, kept)', async () => {
    const { envelope, calls } = await run(attributeListCommand, { workspace: WS, trafficType: 'tt-abc12345', prefix: 'plan', cursor: 'marker-abc12345' }, [
      get(`${API}/schema/ws/${WS}/trafficTypes/tt-abc12345`, attributesPage, { Paginate: 'true', markerLimit: '50', afterMarker: 'marker-abc12345', searchPrefix: 'plan' }),
    ]);
    expect(calls).toHaveLength(1);
    expect(envelope.data).toEqual({ count: 1, totalCount: null, attributes: attributesPage.data, nextMarker: null, previousMarker: null });
  });

  it('lists rollout statuses by wsId', async () => {
    const { envelope, calls } = await run(rolloutStatusListCommand, { workspace: WS }, [get(`${API}/rolloutStatuses`, rolloutStatuses, { wsId: WS })]);
    expect(calls[0]!.url).toBe(`${SPLIT}${API}/rolloutStatuses?wsId=${WS}`);
    expect(envelope.data).toEqual({ count: 2, rolloutStatuses });
  });
});

describe('flag list --tag and --search', () => {
  it('sends each --tag as its own tag parameter', async () => {
    const { calls } = await run(flagsListCommand, { workspace: WS, tag: ['payments', 'web'] }, [
      get(`${API}/splits/ws/${WS}`, { objects: [], totalCount: 0 }, { limit: '50', offset: '0', tag: ['payments', 'web'] }),
    ]);
    expect(calls[0]!.url).toBe(`${SPLIT}${API}/splits/ws/${WS}?limit=50&offset=0&tag=payments&tag=web`);
  });

  it('reads every page and keeps names containing the text in any case, saying how many it searched (#671)', async () => {
    const first = Array.from({ length: 50 }, (_, i) => flag(i === 7 ? 'New_Checkout' : `other_${i}`));
    const { envelope, calls } = await run(flagsListCommand, { workspace: WS, search: 'checkout' }, [
      get(`${API}/splits/ws/${WS}`, { objects: first, offset: 0, limit: 50, totalCount: 52 }, { offset: '0', limit: '50' }),
      get(`${API}/splits/ws/${WS}`, { objects: [flag('checkout_v2'), flag('banner')], offset: 50, limit: 50, totalCount: 52 }, { offset: '50', limit: '50' }),
    ]);
    expect(calls).toHaveLength(2);
    expect(envelope.data).toEqual({ count: 2, totalCount: 52, searched: 52, complete: true, flags: [flag('New_Checkout'), flag('checkout_v2')] });
  });

  it('says complete is unknown when Split gives no total', async () => {
    const { envelope } = await run(flagsListCommand, { workspace: WS, search: 'banner' }, [
      get(`${API}/splits/ws/${WS}`, { objects: [flag('banner')] }, { offset: '0', limit: '50' }),
      get(`${API}/splits/ws/${WS}`, { objects: [] }, { offset: '1', limit: '50' }),
    ]);
    expect(envelope.data).toMatchObject({ count: 1, totalCount: null, searched: 1, complete: null });
  });

  it('refuses an answer that is not a list, rather than report no matching flags', async () => {
    const { envelope } = await run(flagsListCommand, { workspace: WS, search: 'x' }, [get(`${API}/splits/ws/${WS}`, { message: 'unexpected' })]);
    expect(envelope.error?.code).toBe('HTTP');
  });

  it('passes --tag on to every page of a --search', async () => {
    const { calls } = await run(flagsListCommand, { workspace: WS, search: 'x', tag: ['web'] }, [
      get(`${API}/splits/ws/${WS}`, { objects: [], totalCount: 0 }, { offset: '0', limit: '50', tag: 'web' }),
    ]);
    expect(calls).toHaveLength(1);
  });

  it('refuses --search with --limit or --offset, and an empty --search', async () => {
    for (const extra of [{ limit: '10' }, { offset: '50' }, { search: '' }]) {
      const { envelope, calls } = await run(flagsListCommand, { workspace: WS, search: 'checkout', ...extra }, []);
      expect(envelope.error?.code).toBe('INVALID_INPUT');
      expect(calls).toHaveLength(0);
    }
  });
});
