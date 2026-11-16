import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { Route } from '../../../test/harness/fake-fetch.js';
import { aqlResult, ARTIFACTORY, buildList, config as fixtureConfig, inventory, JAR, packument, REPO, routes as fixtureRoutes } from '../../../test/fixtures/artifactory.fixture.js';
import type { AnyCommand } from '../../core/command.js';
import { execute } from '../../core/run.js';
import { artifactInfoCommand, buildInfoCommand, buildRunsCommand, buildsCommand, pingCommand, propertiesGetCommand, propertiesSetCommand, reposCommand, searchCommand } from './commands.js';
import { licenseCheckCommand, outdatedCommand } from './dependencies.js';

/**
 * Request building and response reshaping, command by command: the exact
 * request toil sends to Artifactory and what it makes of the answer. The
 * parity suite proves both front doors agree; this proves they agree on what
 * the command contract specifies. Suspected bugs (#82, and #91 for the
 * dependency lookups) are pinned here rather than fixed, pending a hearing.
 */

const HEADERS = { authorization: 'Bearer test-token', 'content-type': 'application/json', accept: 'application/json', connection: 'close' };
const TOKEN_ONLY = { authorization: 'Bearer test-token' };

interface RunOptions {
  config?: Record<string, Record<string, unknown>>;
  files?: Record<string, string>;
  stdin?: string;
}

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[], options: RunOptions = {}) {
  const t = testContext({ config: options.config ?? fixtureConfig, routes, files: options.files ?? { 'inventory.json': JSON.stringify(inventory) }, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls };
}

const ok = (body: unknown): Route => ({ url: /.*/, respond: { json: body } });
const aqlOk: Route = { method: 'POST', url: /.*/, respond: { json: aqlResult } };
const PING: Route = { method: 'GET', path: '/api/system/ping', respond: { text: 'OK' } };

describe('ping', () => {
  it("GETs api/system/ping as text with the JSON headers but Accept text/plain, and returns the text as data", async () => {
    const { envelope, calls } = await run(pingCommand, {}, [PING]);
    expect(calls).toEqual([{ method: 'GET', url: `${ARTIFACTORY}/api/system/ping`, headers: { ...HEADERS, accept: 'text/plain' }, body: undefined }]);
    expect(envelope).toMatchObject({ ok: true, data: 'OK' });
  });

  it('keeps a base URL context root', async () => {
    const config = { artifactory: { ...fixtureConfig.artifactory, baseUrl: `${ARTIFACTORY}/artifactory` } };
    const { calls } = await run(pingCommand, {}, [PING], { config });
    expect(calls[0]!.url).toBe(`${ARTIFACTORY}/artifactory/api/system/ping`);
  });

  it("fails with the body's top-level message, or HTTP <status>, never Artifactory's errors[] text", async () => {
    const message = await run(pingCommand, {}, [{ url: /.*/, respond: { status: 503, json: { message: 'Service unavailable' } } }]);
    expect(message.envelope.error).toMatchObject({ code: 'HTTP', message: 'Service unavailable' });
    const errors = await run(pingCommand, {}, [{ url: /.*/, respond: { status: 401, json: { errors: [{ status: 401, message: 'Bad credentials' }] } } }]);
    expect(errors.envelope.error).toMatchObject({ code: 'AUTH', message: 'HTTP 401 Unauthorized', fix: expect.stringContaining('TOIL_ARTIFACTORY_TOKEN') });
    const text = await run(pingCommand, {}, [{ url: /.*/, respond: { status: 404, text: 'nope' } }]);
    expect(text.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'HTTP 404 Not Found' });
  });
});

describe('repo list', () => {
  it('GETs api/repositories with the JSON headers, sending only the filters given', async () => {
    const all = await run(reposCommand, {}, [ok([])]);
    expect(all.calls).toEqual([{ method: 'GET', url: `${ARTIFACTORY}/api/repositories`, headers: HEADERS, body: undefined }]);
    const some = await run(reposCommand, { type: 'anything', packageType: 'npm' }, [ok([])]);
    expect(some.calls[0]!.url).toBe(`${ARTIFACTORY}/api/repositories?type=anything&packageType=npm`);
  });

  it("a 401 is AUTH with where to make a token, and Artifactory's errors[] message", async () => {
    const { envelope } = await run(reposCommand, {}, [{ url: /.*/, respond: { status: 401, json: { errors: [{ status: 401, message: 'Bad credentials' }] } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', message: 'Bad credentials', fix: expect.stringContaining('Generate an Identity Token') });
  });
});

describe('artifact get and artifact properties', () => {
  it('GETs api/storage/<repo>/<path> with one leading slash stripped', async () => {
    const { calls } = await run(artifactInfoCommand, { repo: REPO, path: `/${JAR}` }, [ok({})]);
    expect(calls).toEqual([{ method: 'GET', url: `${ARTIFACTORY}/api/storage/${REPO}/${JAR}`, headers: HEADERS, body: undefined }]);
  });

  it('encodes the repo as one segment and each part of the path on its own, so # and % are part of a file name', async () => {
    const hash = await run(artifactInfoCommand, { repo: REPO, path: 'dir/a#1.txt' }, [ok({})]);
    expect(hash.calls[0]!.url).toBe(`${ARTIFACTORY}/api/storage/${REPO}/dir/a%231.txt`);
    const pct = await run(artifactInfoCommand, { repo: REPO, path: 'dir/%41.txt' }, [ok({})]);
    expect(pct.calls[0]!.url).toBe(`${ARTIFACTORY}/api/storage/${REPO}/dir/%2541.txt`);
    const repo = await run(artifactInfoCommand, { repo: 'a/b?c=d', path: 'x.txt' }, [ok({})]);
    expect(repo.calls[0]!.url).toBe(`${ARTIFACTORY}/api/storage/a%2Fb%3Fc%3Dd/x.txt`);
  });

  it('refuses an artifact path with a .. part as INVALID_INPUT before any request', async () => {
    const { envelope, calls } = await run(artifactInfoCommand, { repo: REPO, path: 'x/../y' }, [ok({})]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(calls).toHaveLength(0);
  });

  it('properties-get adds an empty properties= and returns the body', async () => {
    const body = { properties: { a: ['1'] }, uri: 'x' };
    const { envelope, calls } = await run(propertiesGetCommand, { repo: REPO, path: JAR }, [ok(body)]);
    expect(calls[0]!.url).toBe(`${ARTIFACTORY}/api/storage/${REPO}/${JAR}?properties=`);
    expect(envelope.data).toEqual(body);
  });
});

describe('artifact set-properties', () => {
  const put: Route = { method: 'PUT', url: /.*/, respond: { status: 204 } };

  it('PUTs properties=k=v;k2=v2 with ; and = encoded and commas literal, and reports what it asked for', async () => {
    const { envelope, calls } = await run(propertiesSetCommand, { repo: REPO, path: JAR, keyvals: ['qa.status=passed', 'note=a,b'], allowWrite: true }, [put]);
    expect(calls).toEqual([{ method: 'PUT', url: `${ARTIFACTORY}/api/storage/${REPO}/${JAR}?properties=qa.status%3Dpassed%3Bnote%3Da,b`, headers: HEADERS, body: undefined }]);
    // Suspected bug #82 item 2: Artifactory reads note as two values; data says one.
    expect(envelope.data).toEqual({ repo: REPO, path: JAR, properties: { 'qa.status': 'passed', note: 'a,b' } });
  });

  it('PUTs to the encoded path: a repo with path syntax in it stays one segment', async () => {
    const { calls } = await run(propertiesSetCommand, { repo: 'p1#hot', path: 'dir/a b?.txt', keyvals: ['a=1'], allowWrite: true }, [put]);
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe(`${ARTIFACTORY}/api/storage/p1%23hot/dir/a%20b%3F.txt?properties=a%3D1`);
  });

  it('suspected bug #82 item 1: recursive=1 only with --recursive; otherwise nothing is sent', async () => {
    const flat = await run(propertiesSetCommand, { repo: REPO, path: 'dir', keyvals: ['a=1'], allowWrite: true }, [put]);
    expect(new URL(flat.calls[0]!.url).searchParams.has('recursive')).toBe(false);
    const deep = await run(propertiesSetCommand, { repo: REPO, path: 'dir', keyvals: ['a=1'], recursive: true, allowWrite: true }, [put]);
    expect(deep.calls[0]!.url).toBe(`${ARTIFACTORY}/api/storage/${REPO}/dir?properties=a%3D1&recursive=1`);
  });

  it('keeps everything after the first = as the value, and the last of a repeated key', async () => {
    const { envelope } = await run(propertiesSetCommand, { repo: REPO, path: JAR, keyvals: ['expr=a=b', 'k=1', 'k=2'], allowWrite: true }, [put]);
    expect(envelope.data).toMatchObject({ properties: { expr: 'a=b', k: '2' } });
  });

  it('refuses no pairs, or a pair with no key, before any request', async () => {
    const none = await run(propertiesSetCommand, { repo: REPO, path: JAR, allowWrite: true }, []);
    expect(none.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Provide at least one key=value pair' });
    const bad = await run(propertiesSetCommand, { repo: REPO, path: JAR, keyvals: ['=x'], allowWrite: true }, []);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Invalid property format: "=x" — expected key=value' });
    expect([...none.calls, ...bad.calls]).toEqual([]);
  });

  it('is a write: refused without --allow-write', async () => {
    const { envelope, calls } = await run(propertiesSetCommand, { repo: REPO, path: JAR, keyvals: ['a=1'] }, [put]);
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toEqual([]);
  });
});

describe('artifact search', () => {
  const AQL = (find: string, limit = 100, props = false) =>
    `items.find(${find}).include("repo","path","name","type","size","created","modified","sha256"${props ? ',"properties"' : ''}).sort({"$desc": ["created"]}).limit(${limit})`;

  it('POSTs the AQL as text/plain, newest first, limited to 100, and returns the result', async () => {
    const { envelope, calls } = await run(searchCommand, { repo: REPO }, [aqlOk]);
    expect(calls).toEqual([{ method: 'POST', url: `${ARTIFACTORY}/api/search/aql`, headers: { ...HEADERS, 'content-type': 'text/plain' }, body: AQL(`{"repo": {"$eq": "${REPO}"}}`) }]);
    expect(envelope.error).toBeNull();
    expect(envelope.data).toEqual(aqlResult);
  });

  it('joins every criterion in order, both dates on created', async () => {
    const { calls } = await run(searchCommand, { repo: 'r', name: 'n*', path: 'p?', after: '2026-01-01', before: '2026-02-01', limit: 5 }, [aqlOk]);
    expect(calls[0]!.body).toBe(AQL('{"repo": {"$eq": "r"},"name": {"$match": "n*"},"path": {"$match": "p?"},"created": {"$gt": "2026-01-01"},"created": {"$lt": "2026-02-01"}}', 5));
  });

  it('suspected bug #82 item 3: --properties adds "properties" to include and keeps sort and limit', async () => {
    const { calls } = await run(searchCommand, { name: 'x', properties: true }, [aqlOk]);
    expect(calls[0]!.body).toBe(AQL('{"name": {"$match": "x"}}', 100, true));
  });

  it('suspected bug #82 item 5: values are not escaped', async () => {
    const { calls } = await run(searchCommand, { name: 'a"b' }, [aqlOk]);
    expect(calls[0]!.body).toContain('"name": {"$match": "a"b"}');
  });

  it('suspected bug #82 item 6: --limit 0 is 100, junk is parseInt, and negatives pass through', async () => {
    const limitOf = async (limit: unknown) => (await run(searchCommand, { repo: 'r', limit }, [aqlOk])).calls[0]!.body!.match(/\.limit\((-?\d+)\)$/)![1];
    expect(await limitOf('0')).toBe('100');
    expect(await limitOf('10abc')).toBe('10');
    expect(await limitOf('abc')).toBe('100');
    expect(await limitOf('-5')).toBe('-5');
  });

  it('needs one of --repo, --name or --path', async () => {
    const { envelope, calls } = await run(searchCommand, { after: '2026-01-01' }, []);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Provide at least one filter: --repo, --name, or --path' });
    expect(calls).toEqual([]);
  });
});

describe('build list', () => {
  it('GETs api/build, names each build from its uri, and adds no hint when there are some', async () => {
    const { envelope, calls } = await run(buildsCommand, {}, [ok(buildList)]);
    expect(calls).toEqual([{ method: 'GET', url: `${ARTIFACTORY}/api/build`, headers: HEADERS, body: undefined }]);
    expect(envelope.data).toEqual({
      builds: [
        { name: 'imagile-api', uri: '/imagile-api', lastStarted: '2026-09-01T10:00:00.000+0000' },
        { name: 'imagile-web', uri: '/imagile-web', lastStarted: '2026-09-02T10:00:00.000+0000' },
      ],
      uri: buildList.uri,
    });
  });

  it('suspected bug #82 item 7: an encoded uri stays encoded in name; an empty list gets the hint', async () => {
    const encoded = await run(buildsCommand, {}, [ok({ builds: [{ uri: '/my%20build/', lastStarted: 'x' }], uri: 'u' })]);
    expect(encoded.envelope.data).toMatchObject({ builds: [{ name: 'my%20build' }] });
    const empty = await run(buildsCommand, {}, [ok({ uri: 'u' })]);
    expect(empty.envelope.data).toEqual({ builds: [], uri: 'u', hint: expect.stringContaining('No builds are registered in Artifactory Build Integration.') });
  });

  it('suspected bug #82 item 8: a 404 for no builds is NOT_FOUND, not the hint', async () => {
    const { envelope } = await run(buildsCommand, {}, [{ url: /.*/, respond: { status: 404, json: { errors: [{ status: 404, message: 'No builds were found' }] } } }]);
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'No builds were found' });
  });

  it('--timeout must be a positive integer', async () => {
    for (const timeout of ['0', '-1', 'abc']) {
      const { envelope, calls } = await run(buildsCommand, { timeout }, []);
      expect(envelope.error, timeout).toMatchObject({ code: 'INVALID_INPUT', message: '--timeout must be a positive integer (seconds)' });
      expect(calls).toEqual([]);
    }
  });

  it('allows a longer command limit than the default, for a long --timeout', () => {
    expect(buildsCommand.timeLimitMs).toBe(600_000);
  });
});

describe('build runs and build get', () => {
  it('percent-encode the name and number', async () => {
    const runs = await run(buildRunsCommand, { name: 'imagile api/main' }, [ok({})]);
    expect(runs.calls[0]!.url).toBe(`${ARTIFACTORY}/api/build/imagile%20api%2Fmain`);
    const info = await run(buildInfoCommand, { name: 'a/b', number: '1 2' }, [ok({})]);
    expect(info.calls).toEqual([{ method: 'GET', url: `${ARTIFACTORY}/api/build/a%2Fb/1%202`, headers: HEADERS, body: undefined }]);
  });
});

describe('package outdated', () => {
  it('pings with only the token, then looks up each direct production package with only the token, one at a time', async () => {
    const { envelope, calls } = await run(outdatedCommand, { inputFile: 'inventory.json' }, fixtureRoutes);
    expect(calls.map((c) => [c.method, c.url, c.headers])).toEqual([
      ['GET', `${ARTIFACTORY}/api/system/ping`, TOKEN_ONLY],
      ['GET', `${ARTIFACTORY}/api/npm/npm-remote/express`, TOKEN_ONLY],
      ['GET', `${ARTIFACTORY}/api/npm/npm-remote/@types%2Fnode`, TOKEN_ONLY],
      ['GET', `${ARTIFACTORY}/api/nuget/v3/nuget-remote/flatcontainer/newtonsoft.json/index.json`, TOKEN_ONLY],
      ['GET', `${ARTIFACTORY}/api/search/latestVersion?g=org.slf4j&a=slf4j-api&repos=maven-remote`, TOKEN_ONLY],
    ]);
    expect(envelope.data).toEqual({
      source: 'artifactory',
      artifactoryUrl: ARTIFACTORY,
      outdated: [
        { name: 'express', ecosystem: 'npm', current: '4.18.2', latest: '5.1.0', updateType: 'major', source: 'package.json' },
        { name: '@types/node', ecosystem: 'npm', current: '20.1.0', latest: '20.4.1', updateType: 'minor', source: 'package.json' },
        // Suspected bug #91 item 21: NuGet's "latest" is the last version listed, prerelease or not.
        { name: 'Newtonsoft.Json', ecosystem: 'nuget', current: '13.0.1', latest: '13.0.4-beta1', updateType: 'patch', source: 'src/Api/Api.csproj' },
        { name: 'org.slf4j:slf4j-api', ecosystem: 'maven', current: '1.7.36', latest: '2.0.13', updateType: 'major', source: 'pom.xml' },
      ],
      uncheckedEcosystems: [],
      summary: { total: 4, major: 2, minor: 1, patch: 1 },
    });
  });

  it('--minor keeps minor and major bumps; --major wins over the others', async () => {
    const minor = await run(outdatedCommand, { inputFile: 'inventory.json', minor: true }, fixtureRoutes);
    expect((minor.envelope.data as { outdated: Array<{ name: string }> }).outdated.map((p) => p.name)).toEqual(['express', '@types/node', 'org.slf4j:slf4j-api']);
    const major = await run(outdatedCommand, { inputFile: 'inventory.json', major: true, patch: true }, fixtureRoutes);
    expect((major.envelope.data as { summary: unknown }).summary).toEqual({ total: 2, major: 2, minor: 0, patch: 0 });
  });

  it('lists ecosystems with no repository key as unchecked', async () => {
    const config = { artifactory: { baseUrl: ARTIFACTORY, token: 'test-token', npmRepo: 'npm-remote' } };
    const { envelope, calls } = await run(outdatedCommand, { inputFile: 'inventory.json' }, fixtureRoutes, { config });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/system/ping', '/api/npm/npm-remote/express', '/api/npm/npm-remote/@types%2Fnode']);
    expect(envelope.data).toMatchObject({ uncheckedEcosystems: ['nuget', 'maven'], summary: { total: 2 } });
  });

  it('suspected bug #91 item 23: a lookup that fails for any reason drops the package, and the command succeeds', async () => {
    const routes: Route[] = [PING, { url: /\/api\/npm\//, respond: { status: 404, json: { errors: [{ message: 'no repo' }] } } }, { url: /.*/, respond: { status: 500, text: 'down' } }];
    const { envelope } = await run(outdatedCommand, { inputFile: 'inventory.json' }, routes);
    expect(envelope).toMatchObject({ ok: true, data: { outdated: [], uncheckedEcosystems: [], summary: { total: 0 } } });
  });

  it('suspected bug #91 item 24: an unknown --ecosystem matches nothing and still succeeds', async () => {
    const { envelope, calls } = await run(outdatedCommand, { inputFile: 'inventory.json', ecosystem: 'nugget' }, fixtureRoutes);
    expect(envelope).toMatchObject({ ok: true, data: { outdated: [], summary: { total: 0 } } });
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(['/api/system/ping']);
  });

  it('stops when the ping fails, with its documented message pointing at ping', async () => {
    const denied = await run(outdatedCommand, { inputFile: 'inventory.json' }, [{ url: /.*/, respond: { status: 401, text: '' } }]);
    expect(denied.calls).toHaveLength(1);
    expect(denied.envelope.error).toMatchObject({
      code: 'AUTH',
      message: `Artifactory at ${ARTIFACTORY} is not reachable or authentication failed. Run 'toil artifactory ping' to diagnose.`,
      details: { status: 503 },
    });
    const down = await run(outdatedCommand, { inputFile: 'inventory.json' }, [{ url: /.*/, respond: { status: 502, text: '' } }]);
    expect(down.envelope.error?.code).toBe('NETWORK');
  });

  it('reads the inventory from stdin when --from is left out, as a bare list too', async () => {
    const list = JSON.stringify([{ name: 'express', version: '4.18.2', ecosystem: 'npm', source: 'package.json' }]);
    const { envelope } = await run(outdatedCommand, {}, fixtureRoutes, { stdin: list });
    expect(envelope.data).toMatchObject({ outdated: [{ name: 'express', latest: '5.1.0' }] });
    const data = await run(outdatedCommand, { inputFile: '-' }, fixtureRoutes, { stdin: JSON.stringify(inventory.data) });
    expect(data.envelope.data).toMatchObject({ summary: { total: 4 } });
  });

  it('says plainly when there is no inventory, or it is not one, before any request', async () => {
    const mcp = await run(outdatedCommand, {}, []);
    expect(mcp.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('No inventory to check') });
    const notJson = await run(outdatedCommand, {}, [], { stdin: 'nope' });
    expect(notJson.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: "The inventory from stdin isn't JSON." });
    const failed = await run(outdatedCommand, {}, [], { stdin: JSON.stringify({ ok: false, error: { message: 'Not inside a git repository.' } }) });
    expect(failed.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The inventory from stdin is a failed result: Not inside a git repository..' });
    const shapeless = await run(outdatedCommand, { inputFile: 'inventory.json' }, [], { files: { 'inventory.json': '{"ok":true,"data":{}}' } });
    expect(shapeless.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The inventory from "inventory.json" has no packages list.' });
    const partial = await run(outdatedCommand, {}, [], { stdin: '[{"name":"x","ecosystem":"npm"}]' });
    expect(partial.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'The inventory from stdin has a package without a usable version (packages[0]).' });
    expect([...mcp.calls, ...notJson.calls, ...failed.calls, ...shapeless.calls, ...partial.calls]).toEqual([]);
  });

  it('declares a longer time limit, since it makes one request per package', () => {
    expect(outdatedCommand.timeLimitMs).toBe(600_000);
    expect(licenseCheckCommand.timeLimitMs).toBe(600_000);
    expect(outdatedCommand.aliases).toEqual([['deps', 'outdated']]);
    expect(licenseCheckCommand.aliases).toEqual([['deps', 'license-check']]);
  });
});

describe('package license-check', () => {
  it('reports npm string and object licenses, NuGet expressions, and null for Maven, without calling OSV or anything else', async () => {
    const { envelope, calls } = await run(licenseCheckCommand, { inputFile: 'inventory.json' }, fixtureRoutes);
    expect(calls.every((c) => new URL(c.url).origin === ARTIFACTORY)).toBe(true);
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/api/system/ping',
      '/api/npm/npm-remote/express',
      '/api/npm/npm-remote/@types%2Fnode',
      '/api/nuget/v3/nuget-remote/registration/newtonsoft.json/13.0.1.json',
    ]);
    expect(envelope.data).toEqual({
      source: 'artifactory',
      artifactoryUrl: ARTIFACTORY,
      packages: [
        { name: 'express', version: '4.18.2', ecosystem: 'npm', source: 'package.json', license: 'MIT' },
        { name: '@types/node', version: '20.1.0', ecosystem: 'npm', source: 'package.json', license: 'MIT' },
        { name: 'Newtonsoft.Json', version: '13.0.1', ecosystem: 'nuget', source: 'src/Api/Api.csproj', license: 'MIT' },
        { name: 'org.slf4j:slf4j-api', version: '1.7.36', ecosystem: 'maven', source: 'pom.xml', license: null },
      ],
      summary: { total: 4, byLicense: { MIT: 3 }, unknown: 1 },
    });
  });

  it('--include-dev adds dev packages; a licenseUrl alone is "See licenseUrl"; no repository key means null', async () => {
    const config = { artifactory: { baseUrl: ARTIFACTORY, token: 'test-token', nugetRepo: 'nuget-remote' } };
    const { envelope } = await run(licenseCheckCommand, { inputFile: 'inventory.json', includeDev: true }, fixtureRoutes, { config });
    expect(envelope.data).toMatchObject({
      packages: [
        { name: 'express', license: null },
        { name: '@types/node', license: null },
        { name: 'vitest', license: null },
        { name: 'Newtonsoft.Json', license: 'MIT' },
        { name: 'xunit', license: 'See licenseUrl' },
        { name: 'org.slf4j:slf4j-api', license: null },
      ],
      summary: { total: 6, byLicense: { MIT: 1, 'See licenseUrl': 1 }, unknown: 4 },
    });
  });

  it("suspected bug #91 item 23: the npm license is the packument's top-level one, whatever version is installed", async () => {
    const routes: Route[] = [PING, { url: /.*/, respond: { json: packument('9.9.9', 'Apache-2.0') } }];
    const { envelope } = await run(licenseCheckCommand, { inputFile: 'inventory.json', ecosystem: 'npm' }, routes);
    expect(envelope.data).toMatchObject({ packages: [{ name: 'express', version: '4.18.2', license: 'Apache-2.0' }, { license: 'Apache-2.0' }] });
  });
});
