// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allowed, lockfileLag, lockfileProblems, npmCli, packageProblems, REQUIRED } from '../scripts/package-rules.mjs';

/**
 * What `npm pack` would put in @imagile-dev/toil-ui's tarball, on every test
 * run, built or not: nothing outside the allowlist (no source, tests, fixtures
 * or config), and a package.json that installs only toil, pinned to this
 * checkout's, and runs no script. scripts/check-package.mjs checks the same
 * rules after a build, plus that the required files are there and what the
 * server bundle imports.
 */

const ui = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(path, 'utf8');
const pkg = JSON.parse(read(join(ui, 'package.json')));
const root = JSON.parse(read(join(ui, '..', 'package.json')));

function packed(): string[] {
  const out = execFileSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ui, encoding: 'utf8' });
  return (JSON.parse(out) as Array<{ files: Array<{ path: string }> }>)[0]!.files.map((f) => f.path.replace(/\\/g, '/'));
}

describe('the toil-ui tarball', () => {
  it('holds only the server, the built app, package.json, README.md, LICENSE and NOTICE', () => {
    const files = packed();
    expect(files.filter((f) => !allowed(f))).toEqual([]);
    for (const f of ['package.json', 'README.md', 'LICENSE', 'NOTICE']) expect(files).toContain(f);
  }, 60_000);

  it('allows the files it must and refuses the ones it must not', () => {
    for (const f of REQUIRED) expect(allowed(f), f).toBe(true);
    expect(allowed('dist/app/assets/index-C6qRDsvA.js')).toBe(true);
    for (const f of ['src/App.tsx', 'server/main.ts', 'test/server.test.ts', 'dist/preview/index.html', 'dist/metafile-server.json', 'dist/app/assets/x.node', 'dist/app/assets/../../src/x.js', 'vite.config.ts', 'node_modules/react/index.js']) expect(allowed(f), f).toBe(false);
  });
});

describe("toil-ui's package.json", () => {
  it('installs toil alone, pinned exactly to this checkout, and runs no install script', () => {
    expect(packageProblems(pkg, root.version)).toEqual([]);
  });

  it('is refused when it would install more, pin loosely, or run a script', () => {
    expect(packageProblems({ ...pkg, dependencies: { '@imagile-dev/toil': `^${root.version}` } }, root.version).join()).toContain('pinned exactly');
    expect(packageProblems({ ...pkg, dependencies: { ...pkg.dependencies, react: '19.3.0' } }, root.version).join()).toContain('@imagile-dev/toil alone');
    expect(packageProblems({ ...pkg, scripts: { ...pkg.scripts, postinstall: 'node x.js' } }, root.version).join()).toContain('postinstall');
    expect(packageProblems({ ...pkg, peerDependencies: { '@imagile-dev/agent': '1.0.0' } }, root.version).join()).toContain('must be optional');
    expect(packageProblems({ ...pkg, private: true }, root.version).join()).toContain('private');
  });

  it('ships the same licence as toil, and its own NOTICE for what the app bundles', () => {
    expect(read(join(ui, 'LICENSE'))).toBe(read(join(ui, '..', 'LICENSE')));
    const notice = read(join(ui, 'NOTICE'));
    for (const name of ['React', 'IBM Plex Sans', 'Source Serif 4', 'Fira Code', 'SIL OPEN FONT LICENSE']) expect(notice).toContain(name);
  });

  it('keeps every bundled front-end package a dev dependency', () => {
    for (const dep of ['react', 'react-dom', 'vite', '@fontsource/ibm-plex-sans']) expect(pkg.devDependencies[dep], dep).toBeDefined();
  });
});

describe('the lockfile check (#299)', () => {
  const PIN = '0.1.0-alpha.3';
  const tgz = (v: string) => `https://registry.npmjs.org/@imagile-dev/toil/-/toil-${v}.tgz`;
  const lock = (entry: Record<string, string>, wanted = PIN) => ({ packages: { ui: { dependencies: { '@imagile-dev/toil': wanted } }, 'node_modules/@imagile-dev/toil': entry } });
  const good = { version: PIN, resolved: tgz(PIN), integrity: 'sha512-abc12345' };

  it('passes a lockfile whose entry and installed copy are the pin', () => {
    expect(lockfileProblems(lock(good), PIN, PIN)).toEqual([]);
  });

  it("lets through the state a release leaves, with a note: the pin's version over the previous toil's tarball, and that toil installed (#299)", () => {
    const stale = lock({ ...good, resolved: tgz('0.1.0-alpha.2') });
    expect(lockfileProblems(stale, PIN, '0.1.0-alpha.2')).toEqual([]);
    expect(lockfileLag(stale, PIN, '0.1.0-alpha.2')).toBe('0.1.0-alpha.2');
    expect(lockfileLag(lock(good), PIN, PIN)).toBeNull();
  });

  it('still fails a stale tarball once npm ci installed something else, or the pin is not what the lockfile records', () => {
    const stale = lock({ ...good, resolved: tgz('0.1.0-alpha.2') });
    // Installed copy and tarball disagree: the integrity is another toil's.
    const problems = lockfileProblems(stale, PIN, PIN);
    expect(problems[0]).toContain(`resolves to ${tgz('0.1.0-alpha.2')}, not ${tgz(PIN)}`);
    for (const p of problems) expect(p).toContain(`npm install --package-lock-only --ignore-scripts @imagile-dev/toil@${PIN} -w ui --save-exact`);
    expect(lockfileLag(stale, PIN, PIN)).toBeNull();
    // Not a release's leftovers: the dependency, the entry's version or its integrity is off, or the tarball is not the registry's.
    expect(lockfileProblems(lock({ ...good, resolved: tgz('0.1.0-alpha.2') }, '0.1.0-alpha.2'), PIN, '0.1.0-alpha.2')).not.toEqual([]);
    expect(lockfileProblems(lock({ ...good, version: '0.1.0-alpha.2', resolved: tgz('0.1.0-alpha.2') }), PIN, '0.1.0-alpha.2')).not.toEqual([]);
    expect(lockfileProblems(lock({ version: PIN, resolved: tgz('0.1.0-alpha.2') }), PIN, '0.1.0-alpha.2')).toContainEqual(expect.stringContaining('has no sha512 integrity'));
    // The tarball must be an older toil: a newer one, installed, is not a release's leftovers.
    expect(lockfileProblems(lock({ ...good, resolved: tgz('0.1.0-alpha.9') }), PIN, '0.1.0-alpha.9')).not.toEqual([]);
    // Prerelease parts compare as numbers, not text: alpha.9 is older than alpha.10, and alpha.12 is not.
    expect(lockfileLag(lock({ ...good, version: '0.1.0-alpha.10', resolved: tgz('0.1.0-alpha.9') }, '0.1.0-alpha.10'), '0.1.0-alpha.10', '0.1.0-alpha.9')).toBe('0.1.0-alpha.9');
    expect(lockfileLag(lock({ ...good, version: '0.1.0-alpha.11', resolved: tgz('0.1.0-alpha.12') }, '0.1.0-alpha.11'), '0.1.0-alpha.11', '0.1.0-alpha.12')).toBeNull();
    expect(lockfileLag(lock({ ...good, version: '0.1.0', resolved: tgz('0.1.0-beta.4') }, '0.1.0'), '0.1.0', '0.1.0-beta.4')).toBe('0.1.0-beta.4');
    expect(lockfileProblems(lock({ ...good, resolved: 'https://registry.example.com/toil-0.1.0-alpha.2.tgz' }), PIN, '0.1.0-alpha.2')).not.toEqual([]);
  });

  it('fails an entry whose integrity is another tarball, proved by what got installed', () => {
    expect(lockfileProblems(lock(good), PIN, '0.1.0-alpha.2')).toEqual([expect.stringContaining("the lockfile's integrity is another tarball's")]);
  });

  it('fails a stale version, a missing entry, a missing integrity and nothing installed, each by name', () => {
    expect(lockfileProblems(lock({ ...good, version: '0.1.0-alpha.2' }), PIN, PIN)[0]).toContain('is version 0.1.0-alpha.2');
    expect(lockfileProblems(lock(good, '0.1.0-alpha.2'), PIN, PIN)[0]).toContain('records Toil UI\'s dependency as @imagile-dev/toil "0.1.0-alpha.2"');
    expect(lockfileProblems({ packages: { ui: { dependencies: { '@imagile-dev/toil': PIN } } } }, PIN, PIN)).toEqual([expect.stringContaining('has no node_modules/@imagile-dev/toil entry')]);
    expect(lockfileProblems(lock({ version: PIN, resolved: tgz(PIN) }), PIN, PIN)).toEqual([expect.stringContaining('has no sha512 integrity')]);
    expect(lockfileProblems(lock(good), PIN, null)).toEqual([expect.stringContaining("isn't installed")]);
  });
});
