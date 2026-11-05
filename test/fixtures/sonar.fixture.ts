import type { Route } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';

/**
 * Canned SonarQube Server responses for every request the sonar examples
 * send, so the parity suite runs every command offline through both front
 * doors. Routes match on path and the whole query.
 *
 * Provenance: the command contract records no responses for this area, so
 * every shape here is invented from SonarQube's documented Web API
 * (`<baseUrl>/web_api`), trimmed to the fields that matter, and checked
 * against the response types the command contract records.
 */

export const SONAR = 'https://sonar.imagile.dev';
export const PROJECT = 'imagile-api';

export const config = { sonar: { baseUrl: SONAR, token: 'test-token' } };

// Invented from the docs: GET api/qualitygates/project_status.
export const qualityGate = {
  projectStatus: {
    status: 'ERROR',
    ignoredConditions: false,
    conditions: [
      { status: 'ERROR', metricKey: 'new_coverage', comparator: 'LT', errorThreshold: '80', actualValue: '61.5' },
      { status: 'OK', metricKey: 'new_duplicated_lines_density', comparator: 'GT', errorThreshold: '3', actualValue: '0.8' },
    ],
    periods: [{ index: 1, mode: 'PREVIOUS_VERSION', date: '2026-09-01T10:00:00+0000' }],
  },
};

// Invented from the docs: one entry of api/issues/search's `issues`.
export const sonarIssue = (n: number) => ({
  key: `AYx${String(n).padStart(5, '0')}`,
  rule: 'java:S2259',
  severity: 'MAJOR',
  component: `${PROJECT}:src/main/java/dev/imagile/Api.java`,
  project: PROJECT,
  line: 40 + n,
  textRange: { startLine: 40 + n, endLine: 40 + n, startOffset: 4, endOffset: 18 },
  status: 'OPEN',
  message: 'A "NullPointerException" could be thrown; "body" is nullable here.',
  effort: '10min',
  debt: '10min',
  author: 'you@example.com',
  tags: ['cwe'],
  type: 'BUG',
  creationDate: '2026-09-02T09:00:00+0000',
  updateDate: '2026-09-03T09:00:00+0000',
});

export const issuesPage = (issues: unknown[], total: number, p: number, ps: number) => ({
  total,
  p,
  ps,
  paging: { pageIndex: p, pageSize: ps, total },
  issues,
  components: [{ key: PROJECT, name: 'Imagile API', qualifier: 'TRK' }],
});

// Invented from the docs: GET api/measures/component.
export const measures = (metrics: string[]) => ({
  component: {
    key: PROJECT,
    name: 'Imagile API',
    qualifier: 'TRK',
    measures: metrics.map((metric, i) => ({ metric, value: String(i + 1), bestValue: false })),
  },
});

// Invented from the docs: one entry of api/projects/search's `components`.
export const sonarProject = (key: string) => ({ key, name: key, qualifier: 'TRK', visibility: 'private', lastAnalysisDate: '2026-09-03T09:00:00+0000', revision: 'abc12345' });

export const projectsPage = (components: unknown[], total: number, pageIndex: number, pageSize: number) => ({ paging: { pageIndex, pageSize, total }, components });

// Invented from the docs: one entry of api/hotspots/search's `hotspots`.
export const hotspot = (n: number) => ({
  key: `AYh${String(n).padStart(5, '0')}`,
  component: `${PROJECT}:src/main/java/dev/imagile/Config.java`,
  project: PROJECT,
  securityCategory: 'weak-cryptography',
  vulnerabilityProbability: 'MEDIUM',
  status: 'REVIEWED',
  resolution: 'SAFE',
  line: 12 + n,
  message: 'Make sure this weak hash algorithm is not used in a sensitive context here.',
  author: 'you@example.com',
  creationDate: '2026-09-02T09:00:00+0000',
  updateDate: '2026-09-03T09:00:00+0000',
});

export const hotspotsPage = (hotspots: unknown[], total: number, pageIndex: number, pageSize: number) => ({ paging: { pageIndex, pageSize, total }, hotspots, components: [{ key: PROJECT, qualifier: 'TRK', name: 'Imagile API' }] });

const DEFAULT_METRICS = 'coverage,duplicated_lines_density,bugs,vulnerabilities,code_smells,sqale_rating,reliability_rating,security_rating,ncloc';
const json = (body: unknown) => ({ json: body });

export const routes: Route[] = [
  // check-toil-project's lookup. Invented from the docs: api/components/show answers the component.
  { path: '/api/components/show', query: { component: PROJECT }, respond: json({ component: { key: PROJECT, name: 'Imagile API', qualifier: 'TRK' } }) },
  { path: '/api/qualitygates/project_status', query: { projectKey: PROJECT }, respond: json(qualityGate) },
  { path: '/api/qualitygates/project_status', query: { projectKey: PROJECT, branch: 'release-1.2' }, respond: json(qualityGate) },

  { path: '/api/issues/search', query: { componentKeys: PROJECT, p: '1', ps: '100' }, respond: json(issuesPage([sonarIssue(1), sonarIssue(2)], 2, 1, 100)) },
  {
    path: '/api/issues/search',
    query: { componentKeys: PROJECT, severities: 'BLOCKER,CRITICAL', types: 'BUG,VULNERABILITY', statuses: 'OPEN,REOPENED', branch: 'main', resolved: 'false', p: '2', ps: '50' },
    respond: json(issuesPage([sonarIssue(51)], 51, 2, 50)),
  },
  // --all: a page shorter than 500 is not the last one until the total says so.
  { path: '/api/issues/search', query: { componentKeys: PROJECT, p: '1', ps: '500' }, respond: json(issuesPage([sonarIssue(1), sonarIssue(2)], 3, 1, 500)) },
  { path: '/api/issues/search', query: { componentKeys: PROJECT, p: '2', ps: '500' }, respond: json(issuesPage([sonarIssue(3)], 3, 2, 500)) },

  { path: '/api/measures/component', query: { component: PROJECT, metricKeys: DEFAULT_METRICS }, respond: json(measures(DEFAULT_METRICS.split(','))) },
  { path: '/api/measures/component', query: { component: PROJECT, metricKeys: 'coverage,bugs', branch: 'main' }, respond: json(measures(['coverage', 'bugs'])) },

  { path: '/api/projects/search', query: { p: '1', ps: '100' }, respond: json(projectsPage([sonarProject(PROJECT), sonarProject('imagile-web')], 2, 1, 100)) },
  { path: '/api/projects/search', query: { q: 'imagile', p: '2', ps: '25' }, respond: json(projectsPage([sonarProject('imagile-web')], 26, 2, 25)) },
  { path: '/api/projects/search', query: { q: 'imagile', p: '1', ps: '500' }, respond: json(projectsPage([sonarProject(PROJECT), sonarProject('imagile-web')], 2, 1, 500)) },

  { path: '/api/hotspots/search', query: { projectKey: PROJECT, p: '1', ps: '100' }, respond: json(hotspotsPage([hotspot(1)], 1, 1, 100)) },
  {
    path: '/api/hotspots/search',
    query: { projectKey: PROJECT, status: 'REVIEWED', resolution: 'FIXED,SAFE', branch: 'main', p: '1', ps: '20' },
    respond: json(hotspotsPage([hotspot(1)], 1, 1, 20)),
  },
  { path: '/api/hotspots/search', query: { projectKey: PROJECT, p: '1', ps: '500' }, respond: json(hotspotsPage([hotspot(1), hotspot(2)], 2, 1, 500)) },
];

/** The toil project the examples run with, for check-toil-project: reference data only, so no other example changes. */
export const toilProject = { name: 'payments', sonar: { projects: [PROJECT] } };

export const fixture = defineFixture({ area: 'sonar', routes, config, toilProject });
