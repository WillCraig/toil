import type { Route } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';

/**
 * Canned Dynatrace responses for every request the dynatrace examples send,
 * so the parity suite runs every command offline through both front doors.
 * Routes match on method, path and the whole query.
 *
 * Provenance: the command contract records no responses for this area, so
 * every shape here is invented from Dynatrace's documented Environment API v2
 * (entities, problems) and Grail storage query API (query:execute and
 * query:poll), trimmed to the fields that matter. No production incident was
 * raised in the making of these problems.
 */

export const CLASSIC = 'https://dynatrace.imagile.dev';
export const PLATFORM = 'https://dynatrace-platform.imagile.dev';

export const config = {
  dynatrace: { baseUrl: CLASSIC, apiToken: 'test-api-token', platformUrl: PLATFORM, platformToken: 'test-platform-token', env: 'prod' },
};

// Invented from the docs: one entry of GET /api/v2/entities' `entities`.
export const entity = (type: string, n: number) => ({
  entityId: `${type}-${String(n).padStart(16, '0')}`,
  type,
  displayName: `${type.toLowerCase()}-${n}`,
});

export const entityPage = (entities: unknown[], nextPageKey?: string) => ({ totalCount: 3, pageSize: 500, ...(nextPageKey ? { nextPageKey } : {}), entities });

// Invented from the docs: one entry of GET /api/v2/problems' `problems`.
export const problem = (n: number) => ({
  problemId: `-123456789012345678${n}_1700000000000V2`,
  displayId: `P-2610${n}`,
  title: 'Response time degradation',
  impactLevel: 'SERVICES',
  severityLevel: 'PERFORMANCE',
  status: 'OPEN',
  startTime: 1_700_000_000_000,
  endTime: -1,
});

export const problemPage = (problems: unknown[], nextPageKey?: string) => ({ totalCount: problems.length, pageSize: 500, ...(nextPageKey ? { nextPageKey } : {}), problems });

export const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';
export const TRACE_QUERY = `fetch spans | filter trace.id == "${TRACE_ID}" | sort start_time asc`;

// Invented from the docs: a SUCCEEDED query:poll answer's `result`.
export const traceResult = {
  records: [
    { 'trace.id': TRACE_ID, 'span.id': '00f067aa0ba902b7', 'span.name': 'GET /orders', start_time: '2026-10-17T09:00:00.000000000Z', duration: 120_000_000 },
    { 'trace.id': TRACE_ID, 'span.id': '00f067aa0ba902b8', 'span.name': 'SELECT orders', start_time: '2026-10-17T09:00:00.010000000Z', duration: 40_000_000 },
  ],
  types: [{ indexRange: [0, 1], mappings: { 'trace.id': { type: 'string' }, 'span.id': { type: 'string' } } }],
  metadata: { grail: { canonicalQuery: TRACE_QUERY, scannedRecords: 2 } },
};

const json = (body: unknown) => ({ json: body });

export const routes: Route[] = [
  // check-toil-project's lookup of one entity by id.
  { path: '/api/v2/entities/SERVICE-ABC12345', respond: json(entity('SERVICE', 1)) },
  // entity list: two pages, the second asked for with nextPageKey alone.
  { path: '/api/v2/entities', query: { entitySelector: 'type("HOST")', pageSize: '500' }, respond: json(entityPage([entity('HOST', 1), entity('HOST', 2)], 'page-2-of-host')) },
  { path: '/api/v2/entities', query: { nextPageKey: 'page-2-of-host' }, respond: json(entityPage([entity('HOST', 3)])) },
  {
    path: '/api/v2/entities',
    query: { entitySelector: 'type("PROCESS_GROUP")', from: 'now-1d', to: 'now', fields: '+properties,+tags', pageSize: '500' },
    respond: json(entityPage([entity('PROCESS_GROUP', 1)])),
  },
  { path: '/api/v2/entities/SERVICE-1234567890ABCDEF', query: {}, respond: json({ ...entity('SERVICE', 1), entityId: 'SERVICE-1234567890ABCDEF' }) },
  { path: '/api/v2/entities/HOST-ABC1234500000000', query: { from: 'now-2h', to: 'now', fields: '+properties' }, respond: json({ ...entity('HOST', 1), entityId: 'HOST-ABC1234500000000', properties: { osType: 'LINUX' } }) },

  // services and workloads are entity lists with a fixed selector.
  { path: '/api/v2/entities', query: { entitySelector: 'type("SERVICE")', pageSize: '500' }, respond: json(entityPage([entity('SERVICE', 1)])) },
  { path: '/api/v2/entities', query: { entitySelector: 'type("SERVICE")', from: 'now-6h', to: 'now', pageSize: '500' }, respond: json(entityPage([entity('SERVICE', 2)])) },
  { path: '/api/v2/entities', query: { entitySelector: 'type("CLOUD_APPLICATION")', pageSize: '500' }, respond: json(entityPage([entity('CLOUD_APPLICATION', 1)])) },
  { path: '/api/v2/entities', query: { entitySelector: 'type("CLOUD_APPLICATION")', from: 'now-6h', to: 'now', pageSize: '500' }, respond: json(entityPage([entity('CLOUD_APPLICATION', 2)])) },

  // problem list defaults to the last two hours.
  { path: '/api/v2/problems', query: { from: 'now-2h', to: 'now', pageSize: '500' }, respond: json(problemPage([problem(1)], 'problems-page-2')) },
  { path: '/api/v2/problems', query: { nextPageKey: 'problems-page-2' }, respond: json(problemPage([problem(2)])) },
  {
    path: '/api/v2/problems',
    query: { from: 'now-1d', to: 'now-1h', problemSelector: 'status("open")', entitySelector: 'type("SERVICE")', pageSize: '500' },
    respond: json(problemPage([problem(3)])),
  },
  { path: '/api/v2/problems/1234567890123456789_1700000000000V2', query: {}, respond: json(problem(9)) },
  { path: '/api/v2/problems/1234567890123456789_1700000000000V2', query: { fields: 'evidenceDetails,impactAnalysis' }, respond: json({ ...problem(9), evidenceDetails: { totalCount: 0, details: [] } }) },

  // trace: execute answers RUNNING, the first poll SUCCEEDED, so no wait is needed.
  { method: 'POST', path: '/platform/storage/query/v1/query:execute', respond: json({ state: 'RUNNING', requestToken: 'abc12345-0000-0000-0000-000000000000', progress: 0 }) },
  {
    path: '/platform/storage/query/v1/query:poll',
    query: { 'request-token': 'abc12345-0000-0000-0000-000000000000', 'request-timeout': '5000' },
    respond: json({ state: 'SUCCEEDED', progress: 100, result: traceResult }),
  },
];

/** The toil project the examples run with, for check-toil-project: reference data only, so no other example changes. */
export const toilProject = { name: 'payments', dynatrace: { entities: ['SERVICE-ABC12345'] } };

export const fixture = defineFixture({ area: 'dynatrace', routes, config, toilProject });
