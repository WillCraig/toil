import { describe, expect, it } from 'vitest';
import { commands, areas } from '../src/registry.js';
import { clearTokenCache } from '../src/core/token.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { loadFixtures } from './harness/fixtures.js';

/**
 * Every area's live check (`defineArea({ probe })`), sent by `toil connections
 * test` against the area's own fixture connection. Each one must be a read
 * the service refuses without a valid credential (the current user, as a
 * rule), never a ping that answers anyone, so the table below names the exact
 * request, and a new probe has to be added to it on purpose. Whether a path is
 * right on a live server is what each area's first live run checks.
 */
const fixtures = await loadFixtures();

type Expected = {
  /** The path after the connection's base URL; `{key}` is the fixture connection's setting. */
  path: string;
  query?: Record<string, string>;
  /** A 200 body the service sends when the credential was accepted, and one it sends to an anonymous caller. */
  accepted?: unknown;
  anonymous?: unknown;
};

const EXPECTED: Record<string, Expected> = {
  ado: { path: '/_apis/projectCollections', query: { 'api-version': '7.1' } },
  alation: { path: '/integration/v1/datasource/', query: { limit: '1' } },
  artifactory: { path: '/api/repositories' },
  bitbucket: { path: '/rest/api/1.0/profile/recent/repos', query: { limit: '1' } },
  checkmarx: { path: '/projects', query: { limit: '1' } },
  confluence: { path: '/rest/api/user/current', accepted: { type: 'known', username: 'you' }, anonymous: { type: 'anonymous' } },
  contrast: { path: '/Contrast/api/ng/{orgUuid}/applications', query: { limit: '1' } },
  dynatrace: { path: '/api/v2/entities', query: { entitySelector: 'type("SERVICE")', pageSize: '1' } },
  elasticsearch: {
    path: '/_security/_authenticate',
    accepted: { username: 'toil', authentication_realm: { name: '_es_api_key' } },
    anonymous: { username: '_anonymous', authentication_realm: { name: '__anonymous' } },
  },
  figma: { path: '/v1/me' },
  github: { path: '/user' },
  jenkins: { path: '/me/api/json', query: { tree: 'id' }, accepted: { id: 'you' }, anonymous: { id: 'anonymous' } },
  jira: { path: '/rest/api/2/myself' },
  kibana: { path: '/api/spaces/space' },
  logscale: { path: '/api/v1/repositories' },
  openshift: { path: '/api/v1' },
  saucelabs: { path: '/rest/v1.2/users/{username}/concurrency' },
  sde: { path: '/api/v2/users/me/' },
  sonar: { path: '/api/authentication/validate', accepted: { valid: true }, anonymous: { valid: false } },
  sonatypeiq: { path: '/api/v2/applications' },
  splitio: { path: '/internal/api/v2/workspaces' },
};

const probed = areas.filter((a) => a.probe && a.request);

async function probe(area: string, body: unknown) {
  const fixture = fixtures.find((f) => f.area === area);
  expect(fixture, `test/fixtures/${area}.fixture.ts`).toBeDefined();
  clearTokenCache();
  // The fixture's routes answer any token exchange (a POST); the probe itself is answered here.
  const routes = [...fixture!.routes.filter((r) => r.method === 'POST'), { method: 'GET', url: /.*/, respond: typeof body === 'string' ? { text: body } : { json: body } }];
  const { context, http } = testContext({ config: fixture!.config, routes });
  const run = await runCli(['connections', 'test', area], { commands, context });
  return { run, gets: http.calls.filter((c) => c.method === 'GET'), settings: fixture!.config[area] ?? {} };
}

describe('connections test, per deployment', () => {
  it('jira on a Cloud connection probes /rest/api/3/myself on its own host with the account email and token, one GET', async () => {
    const fixture = fixtures.find((f) => f.area === 'jira')!;
    const cloud = fixture.config['jira-cloud']!;
    const { context, http } = testContext({ config: fixture.config, routes: [{ method: 'GET', url: /.*/, respond: { json: [] } }] });
    const run = await runCli(['connections', 'test', 'jira-cloud'], { commands, context });
    expect(run.envelope?.data).toMatchObject({ area: 'jira', live: true, authenticated: true });
    const gets = http.calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(new URL(gets[0]!.url).origin).toBe(new URL(String(cloud.baseUrl)).origin);
    expect(new URL(gets[0]!.url).pathname).toBe('/rest/api/3/myself');
    expect(gets[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${String(cloud.email)}:${String(cloud.apiToken)}`).toString('base64')}`);
  });

  it('confluence on a Cloud connection probes /wiki/rest/api/user/current on its own host, refusing an anonymous answer, one GET', async () => {
    const fixture = fixtures.find((f) => f.area === 'confluence')!;
    const cloud = fixture.config['confluence-cloud']!;
    const ask = async (body: unknown) => {
      const { context, http } = testContext({ config: fixture.config, routes: [{ method: 'GET', url: /.*/, respond: { json: body } }] });
      const run = await runCli(['connections', 'test', 'confluence-cloud'], { commands, context });
      return { run, gets: http.calls.filter((c) => c.method === 'GET') };
    };
    const known = await ask({ type: 'known', accountId: 'abc12345' });
    expect(known.run.envelope?.data).toMatchObject({ area: 'confluence', live: true, authenticated: true });
    expect(known.gets).toHaveLength(1);
    expect(new URL(known.gets[0]!.url).origin).toBe(new URL(String(cloud.baseUrl)).origin);
    expect(new URL(known.gets[0]!.url).pathname).toBe('/wiki/rest/api/user/current');
    expect(known.gets[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${String(cloud.email)}:${String(cloud.apiToken)}`).toString('base64')}`);
    const anonymous = await ask({ type: 'anonymous' });
    expect(anonymous.run.envelope?.ok).toBe(false);
  });
});

describe('connections test, per deployment (bitbucket)', () => {
  it('bitbucket on a Cloud connection probes /user under its REST root with the account email and token, one GET', async () => {
    const fixture = fixtures.find((f) => f.area === 'bitbucket')!;
    const cloud = fixture.config['bitbucket-cloud']!;
    const { context, http } = testContext({ config: fixture.config, routes: [{ method: 'GET', url: /.*/, respond: { json: {} } }] });
    const run = await runCli(['connections', 'test', 'bitbucket-cloud'], { commands, context });
    expect(run.envelope?.data).toMatchObject({ area: 'bitbucket', live: true, authenticated: true });
    const gets = http.calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(1);
    expect(new URL(gets[0]!.url).origin).toBe(new URL(String(cloud.baseUrl)).origin);
    expect(new URL(gets[0]!.url).pathname).toBe('/2.0/user');
    expect(gets[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`${String(cloud.email)}:${String(cloud.apiToken)}`).toString('base64')}`);
  });
});

describe('connections test, per deployment (ado)', () => {
  it('ado on a Services connection probes the organization connectionData on its own host with the PAT, one GET, whatever collection a default names', async () => {
    const fixture = fixtures.find((f) => f.area === 'ado')!;
    const cloud = fixture.config['ado-cloud']!;
    const config = { ...fixture.config, 'ado-cloud': { ...cloud, collection: 'DefaultCollection' } };
    const { context, http } = testContext({ config, routes: [{ method: 'GET', url: /.*/, respond: { json: [] } }] });
    const run = await runCli(['connections', 'test', 'ado-cloud'], { commands, context });
    expect(run.envelope?.data).toMatchObject({ area: 'ado', live: true, authenticated: true });
    const gets = http.calls.filter((c) => c.method === 'GET');
    expect(gets).toHaveLength(1);
    const url = new URL(gets[0]!.url);
    expect(url.origin).toBe(new URL(String(cloud.baseUrl)).origin);
    expect(url.pathname).toBe(`${new URL(String(cloud.baseUrl)).pathname}/_apis/connectionData`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ 'api-version': '7.1-preview.1' });
    expect(gets[0]!.headers.authorization).toBe(`Basic ${Buffer.from(`:${String(cloud.pat)}`).toString('base64')}`);
  });
});

describe('connections test, per area', () => {
  it('has an expected request for every area with a probe, and no other', () => {
    expect(probed.map((a) => a.name).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const area of probed) {
    const expected = EXPECTED[area.name]!;
    it(`${area.name}: one GET to ${expected.path} on the connection's own host, credential required`, async () => {
      const { run, gets, settings } = await probe(area.name, expected.accepted ?? []);
      expect(run.envelope?.ok, run.stdout).toBe(true);
      expect(run.envelope?.data).toMatchObject({ area: area.name, live: true, authenticated: true });
      expect(gets, 'exactly one GET').toHaveLength(1);
      const url = new URL(gets[0]!.url);
      // SD Elements carries its host in a `token@host` connection string.
      const base = new URL(settings.baseUrl ? String(settings.baseUrl) : `https://${String(settings.connectionString).split('@').pop()}`);
      expect(url.origin).toBe(base.origin);
      const path = expected.path.replace(/\{(\w+)\}/g, (_, key: string) => encodeURIComponent(String(settings[key])));
      expect(url.pathname).toBe(`${base.pathname.replace(/\/$/, '')}${path}`);
      expect(Object.fromEntries(url.searchParams)).toEqual(expected.query ?? {});
    });

    it(`${area.name}: a sign-in page served with a 200 fails as HTTP, not healthy`, async () => {
      const { run } = await probe(area.name, '<!DOCTYPE html><html><head><title>Sign in</title></head><body><form action="/login"></form></body></html>');
      expect(run.envelope?.ok).toBe(false);
      expect(run.envelope?.error).toMatchObject({ code: 'HTTP', message: expect.stringContaining("isn't JSON") });
    });

    if (expected.anonymous !== undefined) {
      it(`${area.name}: an anonymous answer fails as AUTH`, async () => {
        const { run } = await probe(area.name, expected.anonymous);
        expect(run.envelope?.error?.code).toBe('AUTH');
        expect(run.envelope?.error?.message).toContain('anonymous');
      });
    }
  }
});

describe('connections test, deeper than the first read (github)', () => {
  const fixture = fixtures.find((f) => f.area === 'github')!;
  const base = fixture.config.github!;
  const run = async (settings: Record<string, unknown>, routes: Array<{ method: string; url: RegExp; respond: unknown }>) => {
    const { context, http } = testContext({ config: { github: { ...base, ...settings } }, routes: routes as never });
    const result = await runCli(['connections', 'test', 'github'], { commands, context });
    return { result, gets: http.calls.filter((c) => c.method === 'GET').map((c) => new URL(c.url).pathname) };
  };

  it('also reads the repository the connection names, reports the expiry GitHub sends and the scopes of a classic token', async () => {
    const soon = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const { result, gets } = await run({ owner: 'imagile', repo: 'toil-probe' }, [
      { method: 'GET', url: /\/user$/, respond: { json: { login: 'you' }, headers: { 'github-authentication-token-expiration': `${soon} 00:00:00 UTC`, 'x-oauth-scopes': 'repo, read:org' } } },
      { method: 'GET', url: /\/repos\/imagile\/toil-probe$/, respond: { json: { full_name: 'imagile/toil-probe' } } },
    ]);
    expect(result.envelope?.ok).toBe(true);
    expect(result.envelope?.data).toMatchObject({ expires: soon, scopes: ['repo', 'read:org'], checked: ['GET /user', '/repos/imagile/toil-probe'].map((s) => (s.startsWith('GET') ? s : `GET ${s}`)) });
    expect(gets.map((g) => g.replace(/^\/api\/v3/, ''))).toEqual(['/user', '/repos/imagile/toil-probe']);
    expect(result.envelope?.meta.warnings?.map((w) => w.code)).toContain('CREDENTIAL_EXPIRES_SOON');
  });

  it('fails, saying which read, when the token answers as its user but is refused the repository', async () => {
    const { result } = await run({ owner: 'imagile', repo: 'toil-probe' }, [
      { method: 'GET', url: /\/user$/, respond: { json: { login: 'you' } } },
      { method: 'GET', url: /\/repos\/imagile\/toil-probe$/, respond: { status: 403, json: { message: 'Resource not accessible by personal access token' } } },
    ]);
    expect(result.envelope?.ok).toBe(false);
    expect(result.envelope?.error?.message).toContain('accepted the credential on GET /user');
    expect(result.envelope?.error?.message).toContain('reading the repository imagile/toil-probe it names');
  });

  it('with no repository named, reads /user alone and says nothing about an expiry GitHub did not send', async () => {
    const { result, gets } = await run({ owner: undefined, repo: undefined }, [{ method: 'GET', url: /\/user$/, respond: { json: { login: 'you' } } }]);
    expect(result.envelope?.data).toMatchObject({ expires: null, scopes: null });
    expect(gets).toHaveLength(1);
  });
});
