import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { routes as osvRoutes } from '../../../test/fixtures/osv.fixture.js';
import { cannedGit, CSPROJ, files, lock, PACKAGE_JSON, POM, PROPS } from '../../../test/fixtures/util.fixture.js';
import { callKey } from '../../../test/fixtures/git.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import { connectMcp } from '../../../test/harness/mcp.js';
import type { GitCall, GitResult, GitRunner } from '../../core/git.js';
import { ToilError } from '../../core/errors.js';
import { readInventory } from '../../core/inventory.js';
import { execute } from '../../core/run.js';
import { createNodeContext } from '../../node-context.js';
import { commands as registry } from '../../registry.js';
import { depsDiffCommand, depsScanCommand, diffScans } from './deps.js';
import { commands } from './index.js';
import { decodeJwt, EXAMPLE_TOKEN, jwtDecodeCommand } from './jwt.js';
import { buildScanData, scanFiles, type Package, type ScanOptions } from './manifests.js';

/**
 * The local utilities, end to end through execute() and the real CLI, plus
 * the parsers on their own. Behaviour that looks wrong is pinned, not fixed
 * (#91 items 8 to 20, 24 and 25 for deps). jwt's #75 was checked on crafted
 * tokens: items 1 to 3 are fixed, item 4 is kept, and each test says so. A
 * test that passes for the wrong reason is still, technically, compliant.
 */

const REPO = { root: '/work', branch: 'main', remotes: [] };
const b64 = (text: string) => Buffer.from(text).toString('base64url');

describe('util jwt decode', () => {
  it('decodes the header and payload, and returns the signature as it is', async () => {
    const envelope = await execute(jwtDecodeCommand, { token: EXAMPLE_TOKEN }, testContext().context);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({ header: { alg: 'HS256', typ: 'JWT' }, payload: { sub: 'abc12345', name: 'Ada Lovelace', iat: 1760000000 }, signature: 'c2lnbmF0dXJlLW5vdC1jaGVja2Vk' });
  });

  it('pads base64url segments of every length and maps - and _', () => {
    // {"a":"??>"} has bytes that encode to - and _ in base64url.
    const header = b64('{"alg":"none"}');
    const payload = b64('{"a":"??>"}');
    expect(payload).toMatch(/[-_]/);
    expect(decodeJwt(`${header}.${payload}.`)).toEqual({ header: { alg: 'none' }, payload: { a: '??>' }, signature: '' });
    for (const text of ['{"a":1}', '{"ab":1}', '{"abc":1}']) expect(decodeJwt(`${b64(text)}.${b64(text)}.s`).payload).toEqual(JSON.parse(text));
    // RFC 7515 appendix C allows padding. A real U+FFFD is valid UTF-8 and stays.
    const padded = Buffer.from('{"alg":"none"}').toString('base64');
    expect(padded.endsWith('=')).toBe(true);
    expect(decodeJwt(`${padded}.${b64('{"a":"�"}')}.`).payload).toEqual({ a: '�' });
  });

  it.each([
    ['two parts', 'a.b', 'Invalid JWT: expected 3 dot-separated parts'],
    ['a 5-part JWE', 'a.b.c.d.e', 'Invalid JWT: expected 3 dot-separated parts'],
    ['a header that is not JSON', `${b64('nope')}.${b64('{}')}.s`, 'Invalid JWT: header is not valid JSON'],
    ['a payload that is not JSON', `${b64('{}')}.${b64('nope')}.s`, 'Invalid JWT: payload is not valid JSON'],
    ['an empty header', `.${b64('{}')}.s`, 'Invalid JWT: header is not valid JSON'],
    ['a header that is JSON but not an object', 'bnVsbA.e30.x', 'Invalid JWT: header is not a JSON object'],
    ['a payload that is a JSON array', 'e30.WzEsMl0.x', 'Invalid JWT: payload is not a JSON object'],
    ['a header outside base64url', 'eyJh!!bGciOiJIUzI1NiJ9.e30.x', 'Invalid JWT: header is not valid base64url'],
    ['a payload that is not UTF-8', 'e30.eyJhIjoi_yJ9.x', 'Invalid JWT: payload is not valid UTF-8'],
  ])('refuses %s with INVALID_INPUT, exit 1, without repeating the token', async (_name, token, message) => {
    const run = await runCli(['util', 'jwt', 'decode', token], { commands, context: testContext().context });
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message });
    expect(run.envelope?.error?.fix).toContain('header.payload.signature');
    expect(run.exitCode).toBe(1);
    expect(run.stdout + run.stderr).not.toContain(token);
  });

  it('reads the token from stdin with -, dropping one trailing line ending', async () => {
    const run = await runCli(['util', 'jwt', 'decode', '-'], { commands, context: testContext({ stdin: `${EXAMPLE_TOKEN}\r\n` }).context });
    expect(run.envelope?.data).toMatchObject({ signature: 'c2lnbmF0dXJlLW5vdC1jaGVja2Vk' });
  });

  it('refuses - over MCP, where stdin is the protocol', async () => {
    const session = await connectMcp({ commands, context: testContext().context });
    try {
      const result = await session.call('util_jwt_decode', { token: '-' });
      expect(result.envelope.error?.code).toBe('INVALID_INPUT');
      expect(result.envelope.error?.message).toContain('stdin');
    } finally {
      await session.close();
    }
  });

  it('answers at its contract path, jwt decode, and over MCP as util_jwt_decode', async () => {
    const run = await runCli(['jwt', 'decode', EXAMPLE_TOKEN], { commands, context: testContext().context });
    expect(run.envelope?.meta.command).toBe('util jwt decode');
    const session = await connectMcp({ commands, context: testContext().context });
    try {
      expect((await session.client.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['util_jwt_decode', 'util_deps_scan', 'util_deps_diff']));
    } finally {
      await session.close();
    }
  });

  describe('#75, checked on crafted tokens', () => {
    it('item 1: a header or payload that is JSON but not an object is refused (was accepted)', () => {
      for (const [token, message] of [
        ['bnVsbA.bnVsbA.x', 'Invalid JWT: header is not a JSON object'],
        ['WzEsMl0.e30.x', 'Invalid JWT: header is not a JSON object'],
        ['e30.InRleHQi.x', 'Invalid JWT: payload is not a JSON object'],
        ['MTIz.e30.x', 'Invalid JWT: header is not a JSON object'],
        ['dHJ1ZQ.e30.x', 'Invalid JWT: header is not a JSON object'],
      ] as const) {
        expect(() => decodeJwt(token), token).toThrow(message);
      }
    });

    it('item 2: characters outside base64url, standard base64, and a length of 1 mod 4 are refused (they used to decode)', () => {
      const standard = Buffer.from('{"a":"??>"}').toString('base64');
      expect(standard).toMatch(/[+/]/);
      const parts = EXAMPLE_TOKEN.split('.');
      expect(parts[1]!.length % 4).toBe(0);
      for (const token of [
        'eyJh!!bGciOiJIUzI1NiJ9.e30.x',
        `${standard}.e30.x`,
        'eyJhbGciOiJIUzI1NiJ9x.e30.x',
        `${parts[0]}.${parts[1]}A.${parts[2]}`,
        `${parts[0]}.${parts[1]!.slice(0, 4)}!!${parts[1]!.slice(4)}.${parts[2]}`,
        'eyJhbGciOiJub25lIn0=x.e30.x',
      ]) {
        expect(() => decodeJwt(token), token).toThrow(/Invalid JWT: (header|payload) is not valid base64url/);
      }
    });

    it('item 3: invalid UTF-8 is refused (it used to become U+FFFD)', () => {
      expect(() => decodeJwt('e30.eyJhIjoi_yJ9.x')).toThrow('Invalid JWT: payload is not valid UTF-8');
      expect(() => decodeJwt(`${b64('{"a":"ok"}')}.${Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]).toString('base64url')}.x`)).toThrow('Invalid JWT: payload is not valid UTF-8');
    });

    it('item 4, checked and kept: a Bearer prefix is still refused, and trailing whitespace stays in the signature', () => {
      // Stripping "Bearer " or the surrounding whitespace was the suggested fix,
      // and the local check refuted it. RFC 7519 §7.2 rejects extra characters
      // rather than dropping them, the error's fix already says to omit the
      // prefix, and the signature is the third segment as passed. stdin ("-")
      // still drops one trailing line ending. The prefix and a leading space
      // fail the base64url check (item 2) instead of the old JSON error.
      expect(() => decodeJwt(`Bearer ${EXAMPLE_TOKEN}`)).toThrow('Invalid JWT: header is not valid base64url');
      expect(() => decodeJwt(` ${EXAMPLE_TOKEN}`)).toThrow('Invalid JWT: header is not valid base64url');
      expect(decodeJwt(`${EXAMPLE_TOKEN}\n`).signature).toBe('c2lnbmF0dXJlLW5vdC1jaGVja2Vk\n');
      expect(decodeJwt(`${EXAMPLE_TOKEN} `).signature).toBe('c2lnbmF0dXJlLW5vdC1jaGVja2Vk ');
    });
  });
});

/** A reader over an in-memory tree, for the parsers. */
const reader = (tree: Record<string, string>) => async (path: string) => tree[path] ?? null;
const scan = (tree: Record<string, string>, opts: ScanOptions = {}) => scanFiles(Object.keys(tree).sort(), opts, reader(tree));
const names = (pkgs: Package[]) => pkgs.map((p) => `${p.name}@${p.version}`);

describe('util deps scan', () => {
  it('inventories the workspace: lockfile over manifest, central package versions, Maven properties, ignored folders skipped', async () => {
    const envelope = await execute(depsScanCommand, {}, testContext({ files, repo: REPO }).context);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toEqual({
      ecosystems: ['npm', 'nuget', 'maven'],
      manifests: [
        { file: 'package.json', ecosystem: 'npm', lockFile: 'package-lock.json' },
        { file: 'Directory.Packages.props', ecosystem: 'nuget' },
        { file: 'src/Api/Api.csproj', ecosystem: 'nuget' },
        { file: 'pom.xml', ecosystem: 'maven' },
      ],
      packages: [
        { name: 'express', version: '4.21.0', ecosystem: 'npm', source: 'package-lock.json', type: 'direct', scope: 'production' },
        { name: 'lodash', version: '4.17.21', ecosystem: 'npm', source: 'package-lock.json', type: 'direct', scope: 'production' },
        { name: 'Newtonsoft.Json', version: '12.0.1', ecosystem: 'nuget', source: 'Directory.Packages.props', type: 'direct', scope: 'production' },
        { name: 'Newtonsoft.Json', version: '12.0.1', ecosystem: 'nuget', source: 'src/Api/Api.csproj', type: 'direct', scope: 'production' },
        { name: 'Serilog', version: '3.1.1', ecosystem: 'nuget', source: 'src/Api/Api.csproj', type: 'direct', scope: 'production' },
        { name: 'org.apache.logging.log4j:log4j-core', version: '2.14.1', ecosystem: 'maven', source: 'pom.xml', type: 'direct', scope: 'production' },
      ],
      summary: { totalPackages: 6, byEcosystem: { npm: 2, nuget: 3, maven: 1 }, byType: { direct: 6, transitive: 0 }, byScope: { production: 6, dev: 0 } },
    });
  });

  it('adds transitive and dev packages on request, and filters to one ecosystem', async () => {
    const envelope = await execute(depsScanCommand, { ecosystem: 'npm', includeTransitive: true, includeDev: true }, testContext({ files, repo: REPO }).context);
    expect(names((envelope.data as { packages: Package[] }).packages)).toEqual(['express@4.21.0', 'qs@6.13.0', 'lodash@4.17.21', 'vitest@3.2.4']);
  });

  it('outside a git repository fails as specified, with a fix', async () => {
    const envelope = await execute(depsScanCommand, {}, testContext({ files }).context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Not inside a git repository. deps commands require a git repo root.' });
    expect(envelope.error?.fix).toContain('--workspace');
  });

  it('warns about a manifest that is there but cannot be read, and skips it', async () => {
    const t = testContext({ files: { 'package.json': PACKAGE_JSON }, repo: REPO });
    const refusal = new ToilError('INVALID_INPUT', '"/elsewhere/package.json" is outside the workspace, /work.');
    const context = { ...t.context, files: { ...t.context.files, readText: () => { throw refusal; } } };
    const envelope = await execute(depsScanCommand, {}, context);
    expect(envelope.data).toMatchObject({ packages: [] });
    expect(envelope.meta.warnings).toEqual([{ code: 'DEPS_FILE_SKIPPED', message: `package.json was skipped: ${refusal.message}` }]);
  });

  it('pipes into osv vulns on stdin, as its inventory', async () => {
    const scanned = await runCli(['util', 'deps', 'scan'], { commands: registry, context: testContext({ files, repo: REPO }).context });
    expect(readInventory(testContext({ stdin: scanned.stdout }).context, undefined)).toHaveLength(6);
    const checked = await runCli(['osv', 'vulns'], { commands: registry, context: testContext({ stdin: scanned.stdout, routes: osvRoutes }).context });
    expect(checked.envelope?.ok, checked.stdout).toBe(true);
    // lodash and log4j-core have known vulnerabilities in the OSV fixture.
    expect(checked.envelope?.data).toMatchObject({ scanned: 6, vulnerable: 2 });
  });

  it('a lockfile v1 or a lockfile with no packages falls back to package.json; yarn and pnpm do not', async () => {
    const pkg = JSON.stringify({ dependencies: { lodash: '^4.17.21' } });
    expect(names((await scan({ 'package.json': pkg, 'package-lock.json': '{"lockfileVersion":1}' })).packages)).toEqual(['lodash@4.17.21']);
    expect((await scan({ 'package.json': pkg, 'yarn.lock': '# yarn lockfile v1\n' })).packages).toEqual([]);
  });

  it('parses yarn.lock v1 and pnpm-lock.yaml v6, classifying from package.json', async () => {
    const pkg = JSON.stringify({ dependencies: { express: '^4.21.0' }, devDependencies: { '@types/node': '^18.0.0' } });
    const yarn = 'express@^4.21.0:\n  version "4.21.0"\n\n"@types/node@^18.0.0":\n  version "18.0.0"\n\nqs@6.13.0:\n  version "6.13.0"\n';
    const all = { includeTransitive: true, includeDev: true };
    expect((await scan({ 'package.json': pkg, 'yarn.lock': yarn }, all)).packages.map((p) => [p.name, p.version, p.type, p.scope])).toEqual([
      ['express', '4.21.0', 'direct', 'production'],
      ['@types/node', '18.0.0', 'direct', 'dev'],
      ['qs', '6.13.0', 'transitive', 'production'],
    ]);
    const pnpm = 'packages:\n\n  /express@4.21.0:\n    resolution: {integrity: x}\n    dev: false\n\n  /chalk@5.3.0:\n    resolution: {integrity: y}\n    dev: true\n';
    expect((await scan({ 'package.json': pkg, 'pnpm-lock.yaml': pnpm }, all)).packages.map((p) => [p.name, p.type, p.scope])).toEqual([
      ['express', 'direct', 'production'],
      ['chalk', 'transitive', 'dev'],
    ]);
  });

  it('skips package.json under node_modules, and an empty manifest', async () => {
    const result = await scan({ 'node_modules/x/package.json': PACKAGE_JSON, 'a/package.json': '' });
    expect(result.manifests).toEqual([{ file: 'a/package.json', ecosystem: 'npm' }]);
    expect(result.packages).toEqual([]);
  });

  it('reads packages.config and packages.lock.json, keeping one manifest per lock file', async () => {
    const lockJson = JSON.stringify({ dependencies: { 'net8.0': { Serilog: { type: 'Direct', resolved: '3.1.1' }, 'System.Memory': { type: 'Transitive', resolved: '4.5.5' } } } });
    const result = await scan({ 'a/A.csproj': CSPROJ, 'a/B.fsproj': CSPROJ, 'a/packages.lock.json': lockJson, 'b/packages.config': '<packages><package id="jQuery" version="3.7.1" /></packages>' }, { includeTransitive: true });
    expect(result.manifests.map((m) => m.file)).toEqual(['a/A.csproj', 'b/packages.config']);
    expect(names(result.packages)).toEqual(['Serilog@3.1.1', 'System.Memory@4.5.5', 'jQuery@3.7.1']);
  });

  it('reads CRLF files exactly as LF ones: yarn.lock, pnpm-lock.yaml and gradle.lockfile', async () => {
    const crlf = (text: string) => text.replace(/\n/g, '\r\n');
    const pkg = JSON.stringify({ dependencies: { express: '^4.21.0' } });
    const all = { includeTransitive: true, includeDev: true };
    const yarn = 'express@^4.21.0:\n  version "4.21.0"\n\nqs@6.13.0:\n  version "6.13.0"\n';
    const pnpm = 'packages:\n\n  /express@4.21.0:\n    resolution: {integrity: x}\n    dev: false\n\n  /chalk@5.3.0:\n    resolution: {integrity: y}\n    dev: true\n';
    const gradleLock = 'junit:junit:4.13.2=testCompileClasspath\ncom.google.guava:guava:33.0.0-jre=compileClasspath\n';
    for (const [tree, opts] of [
      [{ 'package.json': pkg, 'yarn.lock': yarn }, all],
      [{ 'package.json': pkg, 'pnpm-lock.yaml': pnpm }, all],
      [{ 'build.gradle': 'plugins {}', 'gradle.lockfile': gradleLock }, {}],
    ] as Array<[Record<string, string>, ScanOptions]>) {
      const lf = await scan(tree, opts);
      expect(lf.packages.length).toBeGreaterThan(0);
      const asCrlf = Object.fromEntries(Object.entries(tree).map(([path, text]) => [path, crlf(text)]));
      expect(await scan(asCrlf, opts)).toEqual(lf);
    }
  });

  it('diff sees no change between a CRLF working tree and the LF blob at a ref', async () => {
    const yarn = 'express@^4.21.0:\n  version "4.21.0"\n';
    const pkg = JSON.stringify({ dependencies: { express: '^4.21.0' } });
    const runner = git({ [lsTree('main')]: 'package.json\nyarn.lock\n', [show('main', 'package.json')]: pkg, [show('main', 'yarn.lock')]: yarn });
    const tree = { 'package.json': pkg, 'yarn.lock': yarn.replace(/\n/g, '\r\n') };
    const envelope = await execute(depsDiffCommand, { from: 'main' }, testContext({ files: tree, repo: REPO, git: runner }).context);
    expect(envelope.data).toMatchObject({ changes: [], summary: { unchanged: 1 } });
  });

  it('finds Directory.Packages.props in a parent folder', async () => {
    const result = await scan({ 'Directory.Packages.props': PROPS, 'src/deep/App/App.csproj': '<PackageReference Include="Newtonsoft.Json" Version="$(NewtonsoftVersion)" />' }, { ecosystem: 'nuget' });
    expect(result.packages.filter((p) => p.source.endsWith('App.csproj')).map((p) => p.version)).toEqual(['12.0.1']);
  });

  it('reads build.gradle and gradle.lockfile, with test configurations as dev', async () => {
    const gradle = "dependencies {\n  implementation 'com.google.guava:guava:33.0.0-jre'\n  testImplementation(\"junit:junit:4.13.2\")\n  api group: 'org.slf4j', name: 'slf4j-api', version: '2.0.9'\n}\n";
    expect(names((await scan({ 'build.gradle': gradle })).packages)).toEqual(['com.google.guava:guava@33.0.0-jre', 'org.slf4j:slf4j-api@2.0.9']);
    expect(names((await scan({ 'build.gradle': gradle }, { includeDev: true })).packages)).toContain('junit:junit@4.13.2');
    expect(names((await scan({ 'pom.xml': POM }, { includeDev: true })).packages)).toEqual(['org.apache.logging.log4j:log4j-core@2.14.1', 'junit:junit@4.13.2']);
  });

  describe('suspected bugs, pinned (#91)', () => {
    it('item 8: hoisted transitive packages in an npm v7+ lockfile are direct', async () => {
      const result = await scan({ 'package.json': PACKAGE_JSON, 'package-lock.json': lock('4.17.21', { 'body-parser': { version: '1.20.3' } }) });
      expect(result.packages.find((p) => p.name === 'body-parser')?.type).toBe('direct');
    });

    it('item 9: an npm workspace folder in the lockfile is a package named after the folder', async () => {
      const lockJson = JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'packages/app': { version: '1.0.0' } } });
      expect(names((await scan({ 'package.json': '{}', 'package-lock.json': lockJson })).packages)).toEqual(['packages/app@1.0.0']);
    });

    it('item 10: an unquoted multi-range yarn header gives a garbled name', async () => {
      const yarn = 'debug@2.6.9, debug@^2.2.0:\n  version "2.6.9"\n';
      expect(names((await scan({ 'package.json': '{}', 'yarn.lock': yarn }, { includeTransitive: true })).packages)).toEqual(['debug@2.6.9, debug@2.6.9']);
    });

    it('item 11: a Yarn Berry lockfile yields nothing, with no fallback to package.json', async () => {
      const berry = '"express@npm:^4.21.0":\n  version: 4.21.0\n';
      expect((await scan({ 'package.json': JSON.stringify({ dependencies: { express: '^4.21.0' } }), 'yarn.lock': berry })).packages).toEqual([]);
    });

    it('item 12: pnpm peer suffixes stay in the version, and v9 quoted scoped keys are dropped', async () => {
      const pnpm = "packages:\n\n  /react-dom@18.2.0(react@18.2.0):\n    resolution: {integrity: x}\n\n  '@types/node@18.0.0':\n    resolution: {integrity: y}\n";
      expect(names((await scan({ 'package.json': '{}', 'pnpm-lock.yaml': pnpm }, { includeTransitive: true })).packages)).toEqual(['react-dom@18.2.0(react@18.2.0)']);
    });

    it('item 13: package.json specs that are not versions pass through as versions', async () => {
      const pkg = JSON.stringify({ dependencies: { a: '^1.2.0 || ^2.0.0', b: 'workspace:*', c: 'npm:other@1', d: 'latest' } });
      expect(names((await scan({ 'package.json': pkg })).packages)).toEqual(['a@1.2.0', 'b@workspace:*', 'c@npm:other@1', 'd@latest']);
    });

    it('item 14: a multi-line PackageReference after a self-closing one is swallowed', async () => {
      const csproj = '<PackageReference Include="A" Version="1.0.0" />\n<PackageReference Include="B" Version="2.0.0"><PrivateAssets>all</PrivateAssets></PackageReference>';
      expect(names((await scan({ 'x.csproj': csproj })).packages)).toEqual(['A@1.0.0']);
    });

    it('item 15: CentralTransitive NuGet packages are direct', async () => {
      const lockJson = JSON.stringify({ dependencies: { 'net8.0': { 'System.Text.Json': { type: 'CentralTransitive', resolved: '8.0.5' } } } });
      expect((await scan({ 'x.csproj': CSPROJ, 'packages.lock.json': lockJson })).packages.map((p) => [p.name, p.type])).toEqual([['System.Text.Json', 'direct']]);
    });

    it('item 16: gradle.lockfile test dependencies are kept without includeDev, and every line is direct', async () => {
      const lockfile = 'junit:junit:4.13.2=testCompileClasspath,testRuntimeClasspath\ncom.google.guava:guava:33.0.0-jre=compileClasspath\nempty=\n';
      const result = await scan({ 'build.gradle': '', 'gradle.lockfile': lockfile });
      // An empty build.gradle is skipped before its lockfile is read.
      expect(result.packages).toEqual([]);
      const withManifest = await scan({ 'build.gradle': 'plugins {}', 'gradle.lockfile': lockfile });
      expect(withManifest.packages.map((p) => [p.name, p.type, p.scope])).toEqual([
        ['junit:junit', 'direct', 'production'],
        ['com.google.guava:guava', 'direct', 'production'],
      ]);
    });

    it('item 17: any two-colon string in build.gradle is a dependency, and a classifier stays in the version', async () => {
      const gradle = "url 'https://repo.imagile.dev:8443/maven'\nimplementation 'g:a:1.0:jdk8'\nimplementation \"g:b:$ver\"\n";
      expect(names((await scan({ 'build.gradle': gradle })).packages)).toEqual(['https://repo.imagile.dev@8443/maven', 'g:a@1.0:jdk8', 'g:b@$ver']);
    });

    it('item 18: pom.xml plugin dependencies count, and an unresolved ${project.version} drops the dependency', async () => {
      const pom = '<project><dependencies><dependency><groupId>g</groupId><artifactId>sibling</artifactId><version>${project.version}</version></dependency></dependencies><build><plugins><plugin><dependencies><dependency><groupId>p</groupId><artifactId>plugin-dep</artifactId><version>1.0</version></dependency></dependencies></plugin></plugins></build></project>';
      expect(names((await scan({ 'pom.xml': pom })).packages)).toEqual(['p:plugin-dep@1.0']);
    });

    it('item 24: an unknown --ecosystem scans nothing and succeeds', async () => {
      const envelope = await execute(depsScanCommand, { ecosystem: 'nugget' }, testContext({ files, repo: REPO }).context);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toMatchObject({ manifests: [], packages: [], summary: { totalPackages: 0 } });
    });
  });
});

/** A git that answers from a table of argv to result and records each call. */
function git(table: Record<string, string | GitResult>, fallback?: GitRunner): GitRunner & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    run: async (call: GitCall) => {
      const key = callKey(call);
      calls.push(key);
      const hit = table[key];
      if (hit !== undefined) return typeof hit === 'string' ? { exitCode: 0, stdout: hit, stderr: '' } : hit;
      if (fallback) return fallback.run(call);
      return { exitCode: 128, stdout: '', stderr: `fatal: no canned answer for ${key}` };
    },
  };
}

const lsTree = (ref: string) => callKey({ subcommand: 'ls-tree', options: ['-r', '--name-only'], revisions: [ref] });
const show = (ref: string, path: string) => callKey({ subcommand: 'show', revisions: [`${ref}:./${path}`] });

describe('util deps diff', () => {
  it('compares a ref with the working tree, asking git for the listing and each file read', async () => {
    const runner = git({}, cannedGit);
    const envelope = await execute(depsDiffCommand, { from: 'main' }, testContext({ files, repo: REPO, git: runner }).context);
    expect(envelope.ok).toBe(true);
    expect(runner.calls).toEqual([lsTree('main'), show('main', 'package.json'), show('main', 'package-lock.json'), show('main', 'pom.xml')]);
    expect(envelope.data).toEqual({
      from: 'main',
      to: 'working tree',
      changes: [
        { name: 'Newtonsoft.Json', ecosystem: 'nuget', change: 'added', from: null, to: '12.0.1', source: 'Directory.Packages.props' },
        { name: 'Newtonsoft.Json', ecosystem: 'nuget', change: 'added', from: null, to: '12.0.1', source: 'src/Api/Api.csproj' },
        { name: 'Serilog', ecosystem: 'nuget', change: 'added', from: null, to: '3.1.1', source: 'src/Api/Api.csproj' },
      ],
      summary: { added: 3, removed: 0, upgraded: 0, downgraded: 0, unchanged: 4 },
    });
  });

  it('compares two refs: upgrades, removals, and transitive packages always in', async () => {
    const envelope = await execute(depsDiffCommand, { from: 'v1.0.0', to: 'main', ecosystem: 'npm' }, testContext({ files, repo: REPO, git: cannedGit }).context);
    expect(envelope.data).toEqual({
      from: 'v1.0.0',
      to: 'main',
      changes: [
        { name: 'lodash', ecosystem: 'npm', change: 'upgraded', from: '4.17.20', to: '4.17.21', source: 'package-lock.json' },
        { name: 'left-pad', ecosystem: 'npm', change: 'removed', from: '1.3.0', to: null, source: 'package-lock.json' },
      ],
      summary: { added: 0, removed: 1, upgraded: 1, downgraded: 0, unchanged: 2 },
    });
  });

  it('marks a lower version as downgraded, and keeps Maven group:artifact names whole', () => {
    const pkg = (name: string, version: string, ecosystem: Package['ecosystem'] = 'maven'): Package => ({ name, version, ecosystem, source: 'pom.xml', type: 'direct', scope: 'production' });
    const result = diffScans('a', 'b', buildScanData([], [pkg('g:a', '2.0.0')]), buildScanData([], [pkg('g:a', '1.9.0')]));
    expect(result.changes).toEqual([{ name: 'g:a', ecosystem: 'maven', change: 'downgraded', from: '2.0.0', to: '1.9.0', source: 'pom.xml' }]);
  });

  it('a show git cannot answer skips that file', async () => {
    const runner = git({ [lsTree('main')]: 'package.json\n', [show('main', 'package.json')]: { exitCode: 128, stdout: '', stderr: 'fatal' } });
    const envelope = await execute(depsDiffCommand, { from: 'main', to: 'main' }, testContext({ files, repo: REPO, git: runner }).context);
    expect(envelope.data).toMatchObject({ changes: [], summary: { unchanged: 0 } });
  });

  it('treats more than 10 MB from git as a failed read, as the 10 MB buffer specifies', async () => {
    const runner = git({ [lsTree('main')]: `${'x'.repeat(10 * 1024 * 1024)}\n` });
    const envelope = await execute(depsDiffCommand, { from: 'main', to: 'main' }, testContext({ files, repo: REPO, git: runner }).context);
    expect(envelope.data).toMatchObject({ changes: [] });
    expect(runner.calls).toEqual([lsTree('main'), lsTree('main')]);
  });

  it('outside a repository asks git first, so no git is GIT_NOT_FOUND, and then says it is not a repository', async () => {
    const missing: GitRunner = { run: async () => { throw new ToilError('GIT_NOT_FOUND', 'git is not on PATH.'); } };
    expect((await execute(depsDiffCommand, { from: 'main' }, testContext({ files, git: missing }).context)).error?.code).toBe('GIT_NOT_FOUND');
    const runner = git({ [callKey({ subcommand: 'version' })]: 'git version 2.49.0\n' });
    const envelope = await execute(depsDiffCommand, { from: 'main' }, testContext({ files, git: runner }).context);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Not inside a git repository.' });
  });

  it('with a repository but no git, fails with GIT_NOT_FOUND rather than an empty result', async () => {
    const missing: GitRunner = { run: async () => { throw new ToilError('GIT_NOT_FOUND', 'git is not on PATH.'); } };
    expect((await execute(depsDiffCommand, { from: 'main' }, testContext({ files, repo: REPO, git: missing }).context)).error?.code).toBe('GIT_NOT_FOUND');
  });

  it('refuses a ref that would read as a flag, or an empty one, before git runs', async () => {
    for (const from of ['--output=x', '']) {
      const runner = git({});
      const envelope = await execute(depsDiffCommand, { from }, testContext({ files, repo: REPO, git: runner }).context);
      expect(envelope.error?.code, from).toBe('INVALID_INPUT');
      expect(runner.calls).toEqual([]);
    }
  });

  describe('suspected bugs, pinned (#91)', () => {
    it('item 19: one version per package and source survives, so a second copy hides the change', () => {
      const pkg = (version: string): Package => ({ name: 'qs', version, ecosystem: 'npm', source: 'package-lock.json', type: 'transitive', scope: 'production' });
      const result = diffScans('a', 'b', buildScanData([], [pkg('6.5.3'), pkg('6.11.0')]), buildScanData([], [pkg('6.5.4'), pkg('6.11.0')]));
      expect(result.changes).toEqual([]);
      expect(result.summary.unchanged).toBe(1);
    });

    it('item 20: a ref git cannot read reports every package as added', async () => {
      const runner = git({ [lsTree('no-such-ref-abc12345')]: { exitCode: 128, stdout: '', stderr: 'fatal: Not a valid object name no-such-ref-abc12345' } }, cannedGit);
      const envelope = await execute(depsDiffCommand, { from: 'no-such-ref-abc12345', to: 'main', ecosystem: 'npm' }, testContext({ files, repo: REPO, git: runner }).context);
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toMatchObject({ summary: { added: 3, removed: 0, unchanged: 0 } });
    });

    it('item 25: a path git quotes is not read at a ref', async () => {
      const runner = git({ [lsTree('main')]: '"caf\\303\\251/package.json"\n' });
      const envelope = await execute(depsDiffCommand, { from: 'main', to: 'main' }, testContext({ files, repo: REPO, git: runner }).context);
      expect(envelope.data).toMatchObject({ changes: [] });
      expect(runner.calls).toEqual([lsTree('main'), lsTree('main')]);
    });
  });
});

/**
 * The same commands against real files and the real node context: the
 * `.gitignore`-aware walk on disk, and git missing from PATH, through both
 * front doors. The repository is a bare `.git/HEAD`, which is all the pure-JS
 * reader asks of one.
 */
describe('util deps against a real folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'toil-util-'));
  const home = mkdtempSync(join(tmpdir(), 'toil-util-home-'));
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(dir, '.gitignore'), 'vendor/\n');
  writeFileSync(join(dir, 'package.json'), PACKAGE_JSON);
  writeFileSync(join(dir, 'package-lock.json'), lock('4.17.21'));
  mkdirSync(join(dir, 'vendor', 'left-pad'), { recursive: true });
  writeFileSync(join(dir, 'vendor', 'left-pad', 'package.json'), JSON.stringify({ dependencies: { 'left-pad': '1.3.0' } }));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  const context = (def: Parameters<typeof createNodeContext>[0]['def'], env: NodeJS.ProcessEnv, mcp = false) =>
    createNodeContext({ globals: { workspace: dir }, def, signal: new AbortController().signal, env, cwd: dir, home, areas: [], version: '0.0.0-test', stderr: () => {}, stdin: !mcp });

  it('scan walks the folder, skips what .gitignore ignores, and needs no git', async () => {
    const envelope = await execute(depsScanCommand, {}, context(depsScanCommand, { PATH: '' }));
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(envelope.data).toMatchObject({ manifests: [{ file: 'package.json', ecosystem: 'npm', lockFile: 'package-lock.json' }], summary: { totalPackages: 2 } });
  });

  it('diff with no git on PATH is GIT_NOT_FOUND on the CLI, exit 1, and over MCP', async () => {
    const run = await runCli(['util', 'deps', 'diff', '--from', 'main'], { commands, context: context(depsDiffCommand, { PATH: '' }) });
    expect(run.exitCode).toBe(1);
    expect(run.envelope?.error?.code).toBe('GIT_NOT_FOUND');
    const session = await connectMcp({ commands, context: context(depsDiffCommand, { PATH: '' }, true) });
    try {
      const result = await session.call('util_deps_diff', { from: 'main' });
      expect(result.isError).toBe(true);
      expect(result.envelope.error?.code).toBe('GIT_NOT_FOUND');
    } finally {
      await session.close();
    }
  });
});
