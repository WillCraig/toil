// Install in one press (#344): the pinned versions, the one command each way
// Toil UI can be installed gets, what runs, and what Install does with npm's
// result. Nothing here reaches a registry: npm is never run, and the one real
// spawn is Node printing a line.

import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installPlan, locate, MIN_AGE_DAYS, runInstall, TESTED, type InstallPlan } from '../server/agents/install.ts';
import { AgentHost, type AgentHostOptions } from '../server/agents/host.ts';
import { findPackage } from '../server/agents/package-path.ts';
import { noAgent } from '../server/agent.ts';
import { registry } from '@imagile-dev/toil/api';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { AGENT_PEERS, SPAWNERS } from '../scripts/package-rules.mjs';

const ui = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(ui, 'package.json'), 'utf8')) as { peerDependencies: Record<string, string> };
const root = JSON.parse(readFileSync(join(ui, '..', 'package.json'), 'utf8')) as { devDependencies: Record<string, string> };

describe('the versions Install installs', () => {
  it('are each exact, the peer minimums ui/package.json names, and the zod toil pins', () => {
    const specs = Object.values(TESTED).flat();
    for (const spec of specs) expect(spec).toMatch(/^(@[a-z0-9-]+\/)?[a-z0-9-]+@\d+\.\d+\.\d+$/);
    for (const spec of specs) {
      const name = spec.slice(0, spec.lastIndexOf('@'));
      const version = spec.slice(spec.lastIndexOf('@') + 1);
      expect(AGENT_PEERS).toContain(name);
      if (name === 'zod') expect(version).toBe(root.devDependencies.zod);
      else expect(pkg.peerDependencies[name]).toBe(`>=${version}`);
    }
    expect(MIN_AGE_DAYS).toBe(14);
  });

  it('come from the one module allowed to spawn', () => {
    expect(SPAWNERS).toEqual(['ui/server/agents/install.ts']);
  });
});

const files = (...present: string[]) => (p: string) => present.includes(p);
const base = { env: {}, now: FIXTURE_NOW };

describe('the install command', () => {
  it('on a global Toil UI, is a global install into the prefix Toil UI is in, with no scripts, no optional bundled CLIs and nothing under 14 days old', () => {
    const uiDir = '/opt/npm/lib/node_modules/@imagile-dev/toil-ui';
    const plan = installPlan('codex', { ...base, uiDir, platform: 'linux', execPath: '/opt/npm/bin/node', exists: files('/opt/npm/lib/node_modules/npm/bin/npm-cli.js') });
    expect(plan).toMatchObject({ kind: 'global', folder: '/opt/npm', problem: null });
    expect(plan.command).toBe('npm install --global --prefix /opt/npm --ignore-scripts --before=2026-09-29 --no-audit --no-fund --omit=optional @openai/codex-sdk@0.160.0');
    expect(plan.argv).toEqual(['/opt/npm/bin/node', '/opt/npm/lib/node_modules/npm/bin/npm-cli.js', ...plan.command.split(' ').slice(1)]);
  });

  it('on Windows, the global prefix is the folder node_modules is in, and a path with a space is quoted as a person would type it', () => {
    const uiDir = 'C:\\Program Files\\nodejs\\node_modules\\@imagile-dev\\toil-ui';
    const plan = installPlan('claude', { ...base, uiDir, platform: 'win32', execPath: 'C:\\Program Files\\nodejs\\node.exe', exists: files('C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js') });
    expect(plan.kind).toBe('global');
    expect(plan.command).toBe('npm install --global --prefix "C:\\Program Files\\nodejs" --ignore-scripts --before=2026-09-29 --no-audit --no-fund --omit=optional @anthropic-ai/claude-agent-sdk@0.3.289 zod@4.6.5');
    expect(plan.argv![3]).toBe('--global');
    expect(plan.argv![5]).toBe('C:\\Program Files\\nodejs');
  });

  it('in a project, installs into the project and saves it exactly, so the next npm install keeps it', () => {
    const plan = installPlan('copilot', { ...base, uiDir: '/work/app/node_modules/@imagile-dev/toil-ui', platform: 'linux', execPath: '/usr/bin/node', env: { npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js' }, exists: files('/work/app/package.json', '/usr/lib/node_modules/npm/bin/npm-cli.js') });
    expect(plan.kind).toBe('project');
    expect(plan.command).toBe('npm install --prefix /work/app --ignore-scripts --before=2026-09-29 --no-audit --no-fund --save-exact @github/copilot-sdk@1.0.16 @github/copilot@1.0.100');
    expect(plan.argv![1]).toBe('/usr/lib/node_modules/npm/bin/npm-cli.js');
  });

  it('in a clone, is unsaved at its root and names again the SDKs already there, which an unsaved install would remove', () => {
    const readText = (p: string) => (p === posix.join('/src/toil', 'package.json') ? JSON.stringify({ name: '@imagile-dev/toil', workspaces: ['ui'] }) : null);
    const plan = installPlan('copilot', { ...base, uiDir: '/src/toil/ui', platform: 'linux', execPath: '/usr/bin/node', readText, exists: files('/usr/lib/node_modules/npm/bin/npm-cli.js', '/src/toil/node_modules/@openai/codex-sdk/package.json') });
    expect(plan.kind).toBe('clone');
    expect(plan.command).toBe('npm install --prefix /src/toil --ignore-scripts --before=2026-09-29 --no-audit --no-fund --no-save @github/copilot-sdk@1.0.16 @github/copilot@1.0.100 @openai/codex-sdk@0.160.0');
  });

  it("under npx, can't run, and says why with the fix; the command is still there to copy", () => {
    const plan = installPlan('codex', { ...base, uiDir: '/home/you/.npm/_npx/abc12345/node_modules/@imagile-dev/toil-ui', platform: 'linux', execPath: '/usr/bin/node', exists: () => true });
    expect(plan).toMatchObject({ kind: 'npx', argv: null });
    expect(plan.problem).toMatch(/npx's cache/);
    expect(plan.fix).toMatch(/npm install -g @imagile-dev\/toil-ui/);
    expect(plan.command).toContain('@openai/codex-sdk@0.160.0');
  });

  it("with no npm beside Node, or a layout it doesn't know, says so rather than guess", () => {
    expect(installPlan('codex', { ...base, uiDir: '/opt/npm/lib/node_modules/@imagile-dev/toil-ui', platform: 'linux', execPath: '/opt/npm/bin/node', exists: () => false }).problem).toMatch(/found no npm beside the Node/);
    expect(locate({ uiDir: '/somewhere/toil-ui', platform: 'linux' }, () => false, () => null).kind).toBe('unknown');
    expect(locate({ uiDir: 'D:\\tools\\node_modules\\@imagile-dev\\toil-ui', platform: 'win32' }, () => false, () => null)).toEqual({ kind: 'global', prefix: 'D:\\tools' });
    expect(win32.isAbsolute('D:\\tools')).toBe(true);
  });
});

describe('running it', () => {
  it('runs with no shell, streams each line as it prints, and passes on none of toil\'s TOIL_* variables', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'toil-ui-install-'));
    const plan: InstallPlan = { adapter: 'codex', kind: 'global', folder, command: 'npm install …', argv: [process.execPath, '-e', 'console.log("added 2 packages"); console.error("npm warn x"); console.log(String(process.env.TOIL_JIRA_TOKEN) + " " + process.env.KEEP)'], problem: null, fix: null };
    const lines: string[] = [];
    const run = await runInstall(plan, { env: { ...process.env, TOIL_JIRA_TOKEN: 'secret', KEEP: 'yes' }, onLine: (l) => lines.push(l), signal: new AbortController().signal });
    expect(run.code).toBe(0);
    expect(lines).toEqual(expect.arrayContaining(['added 2 packages', 'npm warn x', 'undefined yes']));
  });
});

describe('Install, on the host', () => {
  const host = (over: Partial<AgentHostOptions>) =>
    new AgentHost({
      dataDir: mkdtempSync(join(tmpdir(), 'toil-ui-host-')),
      version: 't',
      data: () => null,
      registry: registry.commands,
      execute: async () => ({ ok: true, data: null, error: null, meta: {} }) as never,
      mapIds: () => [],
      serveTools: () => ({ url: '', token: '', close() {} }),
      fallback: noAgent(),
      env: {},
      platform: 'linux',
      cwd: '/work',
      now: () => FIXTURE_NOW,
      uiDir: '/opt/npm/lib/node_modules/@imagile-dev/toil-ui',
      execPath: '/opt/npm/bin/node',
      isFile: (p) => p === '/opt/npm/lib/node_modules/npm/bin/npm-cli.js' || p === '/usr/bin/codex',
      ...over,
    });

  it('runs only the command it showed, then loads the SDK to prove it, and reports the new status', async () => {
    let installed = false;
    const ran: string[][] = [];
    const h = host({
      env: { PATH: '/usr/bin' },
      installed: (s) => installed && s === '@openai/codex-sdk',
      installer: async (plan, o) => (ran.push(plan.argv!), o.onLine('added 2 packages'), (installed = true), { code: 0, output: ['added 2 packages'] }),
      importer: async (s) => (s === '@openai/codex-sdk' ? {} : Promise.reject(new Error('no'))),
      resolve: () => '/opt/npm/lib/node_modules/@openai/codex-sdk/dist/index.js',
      readText: (p) => (p === join('/opt/npm/lib/node_modules/@openai/codex-sdk', 'package.json') ? JSON.stringify({ name: '@openai/codex-sdk', version: '0.160.0' }) : null),
    });
    const plan = h.installPlan('codex');
    await expect(h.install('codex', `${plan.command} lodash`, () => undefined, new AbortController().signal)).rejects.toThrow(/has changed since it was shown/);
    expect(ran).toEqual([]);
    const lines: string[] = [];
    const { status } = await h.install('codex', plan.command, (l) => lines.push(l), new AbortController().signal);
    expect(ran).toEqual([plan.argv]);
    expect(lines).toEqual(['added 2 packages']);
    expect(status).toMatchObject({ name: 'codex', installed: true, version: '0.160.0', tested: '0.160.0' });
  });

  it("gives npm's own words and the fix when npm fails, and says plainly when it couldn't load what npm installed", async () => {
    const failing = host({ installer: async () => ({ code: 1, output: ['npm error code E403', 'npm error 403 Forbidden - GET https://registry.imagile.dev/@openai%2fcodex-sdk'] }) });
    const e = (await failing.install('codex', failing.installPlan('codex').command, () => undefined, new AbortController().signal).catch((x: unknown) => x)) as Error & { fix: string };
    expect(e.message).toBe('npm stopped with exit code 1: npm error code E403\nnpm error 403 Forbidden - GET https://registry.imagile.dev/@openai%2fcodex-sdk');
    expect(e.fix).toMatch(/registry, a proxy, a permission/);
    const unloadable = host({ installer: async () => ({ code: 0, output: [] }), importer: async () => Promise.reject(Object.assign(new Error("Cannot find package '@openai/codex-sdk'"), { code: 'ERR_MODULE_NOT_FOUND' })) });
    await expect(unloadable.install('codex', unloadable.installPlan('codex').command, () => undefined, new AbortController().signal)).rejects.toThrow(/npm finished, but @openai\/codex-sdk still doesn't load/);
    const npx = host({ uiDir: '/home/you/.npm/_npx/abc12345/node_modules/@imagile-dev/toil-ui' });
    await expect(npx.install('codex', npx.installPlan('codex').command, () => undefined, new AbortController().signal)).rejects.toThrow(/npx's cache/);
  });
});

describe('an SDK installed while Toil UI runs', () => {
  it("is found on disk, walking up from Toil UI's folder, with its import entry, since Node remembers the miss", () => {
    const pkg = join('/opt/npm/lib/node_modules', '@openai', 'codex-sdk', 'package.json');
    const readText = (p: string) => (p === pkg ? JSON.stringify({ name: '@openai/codex-sdk', version: '0.160.0', exports: { '.': { import: './dist/index.js', types: './dist/index.d.ts' } } }) : null);
    expect(findPackage('@openai/codex-sdk', '/opt/npm/lib/node_modules/@imagile-dev/toil-ui/dist/server', readText)).toEqual({ dir: join('/opt/npm/lib/node_modules', '@openai', 'codex-sdk'), version: '0.160.0', entry: join('/opt/npm/lib/node_modules', '@openai', 'codex-sdk', 'dist', 'index.js') });
    const nested = (p: string) => (p === pkg ? JSON.stringify({ name: '@openai/codex-sdk', exports: { '.': { import: { types: './a.d.ts', default: './a.js' } } } }) : null);
    expect(findPackage('@openai/codex-sdk', '/opt/npm/lib', nested)?.entry).toBe(join('/opt/npm/lib/node_modules', '@openai', 'codex-sdk', 'a.js'));
    expect(findPackage('@openai/codex-sdk', '/elsewhere', readText)).toBeNull();
  });
});
