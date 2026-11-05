import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { apiPath, PATH_ID, rawPath, segments } from '../src/core/api-path.js';
import { assertNoDotSegments, assertPlainPath } from '../src/core/rest.js';
import { createNodeContext } from '../src/node-context.js';
import { areas, commands } from '../src/registry.js';
import { runCli } from './harness/cli.js';

/**
 * What a server really receives when an id holds path or query syntax. Every
 * other test checks the URL toil built; this one runs the real CLI with the
 * real fetch against an HTTP server on the loopback address and records the
 * request line it was sent, so nothing between toil's URL and the wire (the
 * URL parser, fetch's own normalising) can turn one segment into several.
 */
describe('apiPath, segments and the request-layer backstop', () => {
  it('encodes each value as one segment and leaves literal text alone', () => {
    expect(apiPath`/repos/${'imagile'}/${'x/pulls/9/merge?y='}/issues/${7}`).toBe('/repos/imagile/x%2Fpulls%2F9%2Fmerge%3Fy%3D/issues/7');
    expect(apiPath`/a/${'p1#hot'}/${'50%'}/${'two words'}`).toBe('/a/p1%23hot/50%25/two%20words');
    expect(apiPath`/contents/${segments('docs/a b.md')}?ref=x`).toBe('/contents/docs/a%20b.md?ref=x');
    expect(apiPath`/x/${rawPath('already%2Fencoded')}`).toBe('/x/already%2Fencoded');
    expect(() => segments('docs/../secrets', 'The file path')).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', message: expect.stringContaining('".."') }));
  });

  it('PATH_ID refuses slashes, ?, #, % and control characters, and nothing else', () => {
    for (const bad of ['a/b', 'a\\b', 'a?b', 'a#b', 'a%2Fb', 'a\u0000b', 'a\nb', 'a\u007fb']) expect(PATH_ID.test(bad), JSON.stringify(bad)).toBe(false);
    for (const good of ['', 'imagile', 'toil-probe', 'my.repo_1', 'Team Space', 'PROJ']) expect(PATH_ID.test(good), good).toBe(true);
  });

  it('refuses a # in a relative path, and a ? when the request has query parameters too', () => {
    expect(() => assertPlainPath('/labels/p1#hot', false)).toThrow(/can't carry a "#"/);
    expect(() => assertPlainPath('/repos/o/x?y=/pulls', true)).toThrow(/as well as query parameters/);
    expect(() => assertPlainPath('/download/a.txt?version=2', false)).not.toThrow();
    expect(() => assertPlainPath('https://jira.imagile.dev/rest/x?a=1#top', true)).not.toThrow();
  });

  it('reads an encoded slash or backslash as the end of a segment when looking for dot segments, in either case', () => {
    for (const path of ['/a/..%2fb', '/a/..%2Fb', '/a/%2e%2e%5cb', '/a/x%2F..%2Fy', '/a/.%5C']) expect(() => assertNoDotSegments(path), path).toThrow(/as a segment/);
    for (const path of ['/a/v1.2%2Fb', '/a/x%252F..', '/a/..x%2Fb']) expect(() => assertNoDotSegments(path), path).not.toThrow();
  });
});

describe('the path a server receives', () => {
  let server: Server;
  let base = '';
  const seen: Array<{ method: string; url: string }> = [];
  const root = mkdtempSync(join(tmpdir(), 'toil-paths-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(join(home, '.toil'), { recursive: true });
  mkdirSync(cwd, { recursive: true });

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ method: req.method ?? '', url: req.url ?? '' });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.method === 'DELETE' ? '[]' : JSON.stringify({ number: 7, title: 't', state: 'open', head: { sha: 'abc' } }));
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });
  beforeEach(() => {
    seen.length = 0;
  });

  const cli = (argv: string[]) => {
    const env = { TOIL_GITHUB_BASE_URL: base, TOIL_GITHUB_TOKEN: 'test-token', TOIL_GITHUB_OWNER: 'imagile', TOIL_GITHUB_REPO: 'toil-probe', TOIL_GITHUB_WRITES: 'true' };
    const context = createNodeContext({
      globals: {},
      signal: new AbortController().signal,
      env,
      cwd,
      home,
      areas: areas.map((a) => ({ name: a.name, fallbacks: a.fallbacks, contextInputs: Object.keys(a.context ?? {}) })),
      version: '0.0.0-test',
      stderr: () => {},
      stdin: true,
    });
    return runCli(argv, { commands, context });
  };

  it('a label with path, query and fragment syntax reaches the server as one segment of the intended endpoint', async () => {
    const run = await cli(['github', 'issue', 'unlabel', '7', '--label', 'area/api?y=1#z', '--allow-write']);
    expect(run.envelope?.ok, JSON.stringify(run.envelope?.error)).toBe(true);
    expect(seen).toEqual([{ method: 'DELETE', url: '/repos/imagile/toil-probe/issues/7/labels/area%2Fapi%3Fy%3D1%23z' }]);
  });

  it('a ref with a slash reaches the commit status endpoint, not a longer path', async () => {
    const run = await cli(['github', 'commit', 'status', 'release/1.4']);
    expect(run.envelope?.ok, JSON.stringify(run.envelope?.error)).toBe(true);
    expect(seen).toEqual([{ method: 'GET', url: '/repos/imagile/toil-probe/commits/release%2F1.4/status' }]);
  });

  it("a write takes its owner from a repository's checked-in toil project only once it's adopted; --owner and reads need no adoption", async () => {
    const repo = join(cwd, 'app');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(repo, '.toil', 'projects'), { recursive: true });
    const file = join(repo, '.toil', 'projects', 'acme.json');
    writeFileSync(file, JSON.stringify({ name: 'acme', repos: [{ name: 'app', path: repo }], github: { owner: 'other-org' } }));
    const unlabel = ['github', 'issue', 'unlabel', '7', '--label', 'x', '--allow-write', '--cwd', repo];

    const refused = await cli(unlabel);
    expect(refused.envelope?.error).toMatchObject({ code: 'WRITE_DISABLED', fix: expect.stringContaining('toil projects import acme') });
    expect(seen).toEqual([]);

    const read = await cli(['github', 'pr', 'get', '7', '--cwd', repo]);
    expect(read.envelope?.ok, JSON.stringify(read.envelope?.error)).toBe(true);
    const explicit = await cli([...unlabel, '--owner', 'imagile']);
    expect(explicit.envelope?.ok, JSON.stringify(explicit.envelope?.error)).toBe(true);
    expect(seen.map((r) => r.url)).toEqual(['/repos/other-org/toil-probe/pulls/7', '/repos/imagile/toil-probe/issues/7/labels/x']);

    seen.length = 0;
    expect((await cli(['projects', 'import', file])).envelope?.ok).toBe(true);
    const adopted = await cli(unlabel);
    expect(adopted.envelope?.ok, JSON.stringify(adopted.envelope?.error)).toBe(true);
    expect(seen).toEqual([{ method: 'DELETE', url: '/repos/other-org/toil-probe/issues/7/labels/x' }]);
  });

  it('a repo with path syntax, from the flag or from a toil project, never reaches the server', async () => {
    const flag = await cli(['github', 'pr', 'get', '7', '--repo', 'x/pulls/9/merge?y=']);
    expect(flag.envelope?.error).toMatchObject({ code: 'INVALID_INPUT' });
    writeFileSync(join(cwd, 'odd.json'), JSON.stringify({ name: 'odd', github: { owner: 'imagile', repo: 'x/pulls/9/merge?y=' } }));
    const toilProject = await cli(['github', 'pr', 'get', '7', '--toil-project', 'odd.json']);
    expect(toilProject.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('from the toil project') });
    expect(seen).toEqual([]);
  });
});
