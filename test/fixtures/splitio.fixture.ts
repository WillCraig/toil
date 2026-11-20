import type { RecordedRequest } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';

/**
 * Canned Split.IO Admin API responses for every request the splitio examples
 * send, so the parity suite runs every command offline through both front
 * doors.
 *
 * Provenance: every shape here is invented from Split's Admin API reference
 * (docs.split.io/reference: Get Projects (Workspaces), Get Environments, List
 * feature flags, Get feature flag, Get feature flag definition in environment,
 * Submit / List / Get Change Request, List Segments, List Segments in
 * Environment, Get Segment Keys in Environment, List Large Segments, Get Large
 * Segment by Name, List and Get Rule-based Segments, List flag sets, Get flag
 * set, Get Traffic Types, Get Attributes, Get rollout statuses), trimmed to the
 * fields that matter. None was captured from a live account. `production` on an environment comes from
 * the response type the earlier implementation declared; the reference's
 * example shows only id and name.
 */

export const SPLIT = 'https://api.split.io';
export const API = '/internal/api/v2';
export const API_V3 = '/internal/api/v3';
export const WS = 'ws-abc12345';
export const ENV = 'env-abc12345';

export const config = { splitio: { baseUrl: SPLIT, adminApiKey: 'test-admin-key', writes: true } };

export const workspace = (n: number) => ({ id: `ws-abc1234${n}`, name: `Project ${n}`, type: 'workspace' });
export const workspacesPage = (objects: unknown[], offset: number, totalCount: number) => ({ objects, offset, limit: 100, totalCount });

export const environments = [
  { id: ENV, name: 'Production', production: true },
  { id: 'env-abc12346', name: 'Staging', production: false },
];

export const flag = (name: string) => ({
  name,
  description: `The ${name} flag`,
  id: `split-${name}`,
  trafficType: { id: 'tt-abc12345', name: 'user' },
  creationTime: 1760000000000,
  tags: [{ name: 'checkout' }],
});

export const flagsPage = { objects: [flag('new_checkout'), flag('old_banner')], offset: 0, limit: 50, totalCount: 2 };

export const definition = {
  name: 'new_checkout',
  environment: { id: ENV, name: 'Production' },
  trafficType: { id: 'tt-abc12345', name: 'user' },
  killed: false,
  treatments: [
    { name: 'on', configurations: null },
    { name: 'off', configurations: null },
  ],
  defaultTreatment: 'off',
  baselineTreatment: 'off',
  trafficAllocation: 100,
  rules: [
    { buckets: [{ treatment: 'on', size: 100 }], condition: { combiner: 'AND', matchers: [{ type: 'IN_SEGMENT', string: 'beta_users' }] } },
    { buckets: [{ treatment: 'off', size: 100 }], condition: { combiner: 'AND', matchers: [{ type: 'ALL_KEYS' }] } },
  ],
  defaultRule: [{ treatment: 'off', size: 100 }],
  creationTime: 1760000000000,
  lastUpdateTime: 1760000500000,
};

export const segment = (name: string) => ({ name, description: `The ${name} segment`, trafficType: { id: 'tt-abc12345', name: 'user' }, creationTime: 1760000000000, tags: null });
export const segmentsPage = { objects: [segment('beta_users'), segment('employees')], offset: 0, limit: 50, totalCount: 2 };
/** Get Segment Keys in Environment: `count` is the segment's total, not the page's. */
export const segmentKeys = { keys: [{ key: 'user-1' }, { key: 'user-2' }], count: 2, offset: 0, limit: 100 };

export const largeSegment = { id: 'ls-abc12345', name: 'all_customers', description: 'Every customer', trafficType: { id: 'tt-abc12345', type: 'traffic_type', name: 'user' }, creationTime: 1760000000000, tags: [] };
export const ruleBasedSegment = { title: 'beta_testers', comment: 'Beta testers by email', rules: [{ condition: { combiner: 'AND', matchers: [{ type: 'ENDS_WITH', strings: ['@example.com'] }] } }], excludedKeys: [], excludedSegments: [] };

export const flagSet = { id: 'abc12345-0000-0000-0000-000000000000', name: 'checkout', description: 'Checkout flags', workspace: { id: WS, type: 'WORKSPACE' }, createdAt: '2026-10-01T12:00:00', type: 'FLAG_SET' };
export const flagSetPage = { data: [flagSet], nextMarker: '', previousMarker: '', limit: 200, count: 1 };

export const trafficTypes = [{ id: 'tt-abc12345', name: 'user', displayAttributeId: 'name' }];
export const attributesPage = {
  data: [{ id: 'plan', organizationId: 'org-abc12345', trafficTypeId: 'tt-abc12345', displayName: 'Plan', setDescription: 'Billing plan', dataType: 'String', isSearchable: true, suggestedValues: ['free', 'pro'] }],
  limit: 50,
  nextMarker: null,
  previousMarker: null,
  count: 1,
};
export const rolloutStatuses = [
  { id: 'abc12345-0000-0000-0000-000000000001', name: 'Pre-Production', description: 'Code not in production yet' },
  { id: 'abc12345-0000-0000-0000-000000000002', name: '0% in Production', description: 'In production, on for nobody' },
];

/** A change request as Submit Change Request answers, echoing what was sent. */
export function changeRequest(request: RecordedRequest) {
  const sent = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
  return {
    id: 'cr-abc12345',
    status: 'REQUESTED',
    title: sent.title,
    comment: sent.comment,
    split: sent.split ?? null,
    segment: sent.segment ?? null,
    ...(sent.ruleBasedSegment ? { ruleBasedSegment: sent.ruleBasedSegment } : {}),
    workspace: { id: WS, type: 'workspace' },
    approvers: sent.approvers,
    operationType: sent.operationType,
    comments: [{ comment: sent.comment, user: 'ADMIN_API_KEY', role: 'SUBMITTER', timestamp: 1760000600000 }],
  };
}

export const storedChangeRequest = {
  id: 'cr-abc12345',
  status: 'APPROVED',
  title: 'flag-change',
  comment: null,
  split: { name: 'new_checkout', environment: { id: ENV, name: 'Production' } },
  segment: null,
  workspace: { id: WS, type: 'workspace' },
  approvers: ['you@example.com'],
  operationType: 'KILL',
  comments: [],
};

export const changeRequestList = { data: [storedChangeRequest], nextMarker: 'marker-abc12346', previousMarker: null, limit: 25, count: 1 };

/** Local files the examples read. */
export const files: Record<string, string> = {
  'definition.json': JSON.stringify({ treatments: definition.treatments, defaultTreatment: 'off', rules: [], defaultRule: [{ treatment: 'off', size: 100 }] }),
  'keys.txt': 'user-3\nuser-4\n',
  'rbs.json': JSON.stringify({ rules: ruleBasedSegment.rules, excludedKeys: ['user-9'], excludedSegments: [] }),
  'toggles.json': JSON.stringify([
    { flag: 'new_checkout', enabled: false },
    { flag: 'old_banner', enabled: true },
  ]),
};

export const fixture = defineFixture({
  area: 'splitio',
  routes: [
    { method: 'GET', path: `${API}/workspaces`, query: { offset: '0', limit: '100' }, respond: { json: workspacesPage([workspace(1), workspace(2)], 0, 2) } },
    { method: 'GET', path: `${API}/environments/ws/${WS}`, respond: { json: environments } },
    { method: 'GET', path: `${API}/splits/ws/${WS}`, respond: { json: flagsPage } },
    { method: 'GET', path: `${API}/splits/ws/${WS}/new_checkout`, respond: { json: flag('new_checkout') } },
    { method: 'GET', path: `${API}/splits/ws/${WS}/new_checkout/environments/${ENV}`, respond: { json: definition } },
    { method: 'POST', path: `${API}/changeRequests/ws/${WS}/environments/${ENV}`, respond: (request) => ({ json: changeRequest(request) }) },
    { method: 'GET', path: `${API}/changeRequests`, respond: { json: changeRequestList } },
    { method: 'GET', path: `${API}/segments/ws/${WS}`, respond: { json: segmentsPage } },
    { method: 'GET', path: `${API}/segments/ws/${WS}/environments/${ENV}`, respond: { json: segmentsPage } },
    { method: 'GET', path: `${API}/segments/${ENV}/beta_users/keys`, respond: { json: segmentKeys } },
    { method: 'GET', path: `${API}/large-segments/ws/${WS}`, respond: { json: [largeSegment] } },
    { method: 'GET', path: `${API}/large-segments/ws/${WS}/environments/${ENV}`, respond: { json: [{ id: largeSegment.id, name: largeSegment.name, trafficType: largeSegment.trafficType, environment: { id: ENV, type: 'environment', name: 'Production' } }] } },
    { method: 'GET', path: `${API}/large-segments/ws/${WS}/all_customers`, respond: { json: largeSegment } },
    { method: 'GET', path: `${API}/rule-based-segments/ws/${WS}`, respond: { json: { objects: [ruleBasedSegment] } } },
    { method: 'GET', path: `${API}/rule-based-segments/ws/${WS}/environments/${ENV}`, respond: { json: { objects: [ruleBasedSegment] } } },
    { method: 'GET', path: `${API}/rule-based-segments/ws/${WS}/beta_testers`, respond: { json: ruleBasedSegment } },
    { method: 'GET', path: `${API_V3}/flag-sets`, respond: { json: flagSetPage } },
    { method: 'GET', path: `${API_V3}/flag-sets/${flagSet.id}`, respond: { json: flagSet } },
    { method: 'GET', path: `${API}/trafficTypes/ws/${WS}`, respond: { json: trafficTypes } },
    { method: 'GET', path: `${API}/schema/ws/${WS}/trafficTypes/tt-abc12345`, respond: { json: attributesPage } },
    { method: 'GET', path: `${API}/rolloutStatuses`, respond: { json: rolloutStatuses } },
    { method: 'GET', path: `${API}/changeRequests/cr-abc12345`, respond: { json: storedChangeRequest } },
  ],
  config,
  files,
});
