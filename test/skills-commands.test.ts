import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { area, commands as areaCommands } from '../src/areas/skills/index.js';
import { connectionsCommands } from '../src/connections/commands.js';
import { loadConfig } from '../src/core/config.js';
import type { Context } from '../src/core/context.js';
import { createGitRunner, findGit, type GitCall, type GitResult, type GitRunner } from '../src/core/git.js';
import type { SecretStore } from '../src/core/keychain.js';
import type { Prompter } from '../src/core/prompt.js';
import { skillsConfigCommands } from '../src/skills/commands.js';
import { readMeta } from '../src/skills/folders.js';
import { gitFailed } from '../src/skills/marketplace.js';
import { runCli, type CliRun } from './harness/cli.js';
import { TEST_VERSION } from './harness/context.js';
import { fakeFetch } from './harness/fake-fetch.js';
import { fakeStore } from './harness/fake-store.js';
import { memoryFiles } from './harness/files.js';

/**
 * The skills commands against a real temp home and config file, a fake
 * credential store, a scripted terminal and a git that "clones" by copying a
 * prepared marketplace. One test drives the real git against a local
 * repository. Nothing here touches the real home folder or a real keychain.
 */
const commands = [...areaCommands, ...skillsConfigCommands(), ...connectionsCommands([area])];
const REPO = 'https://bitbucket.imagile.dev/scm/ai/skills.git';
const TOKEN = 'fake-token-abc12345';

let root: string;
let home: string;
let project: string;
let seed: string;
let file: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'toil-skills-'));
  home = join(root, 'home');
  project = join(root, 'project');
  seed = join(root, 'seed');
  file = join(home, '.toil', 'config.json');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  write(seed, {
    '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'review', description: 'Code review' }, { name: 'docs', description: 'Docs' }] }),
    'plugins/review/skills/code-review/SKILL.md': '---\nname: code-review\n---\n',
    'plugins/review/skills/code-review/notes.md': 'v1\n',
    'plugins/docs/skills/write-docs/SKILL.md': '---\nname: write-docs\n---\n',
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const writeConfig = (content: unknown) => {
  mkdirSync(join(home, '.toil'), { recursive: true });
  writeFileSync(file, JSON.stringify(content));
};

/** A git that clones by copying the seed marketplace, and records every call. */
function fakeGit(): GitRunner & { calls: GitCall[] } {
  const calls: GitCall[] = [];
  return {
    calls,
    async run(call): Promise<GitResult> {
      calls.push(call);
      if (call.subcommand === 'clone') {
        const dest = call.paths![1]!;
        cpSync(seed, dest, { recursive: true });
        write(dest, { '.git/HEAD': 'ref: refs/heads/main\n', '.git/refs/heads/main': `${'a'.repeat(40)}\n`, '.git/config': `[remote "origin"]\n\turl = ${call.paths![0]}\n` });
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (call.subcommand === 'rev-parse') return { exitCode: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' };
      return { exitCode: 0, stdout: '', stderr: '' };
    },
  };
}

function terminal(answers: Record<string, string> = {}): { prompt: Prompter; asked: Array<{ question: string; hidden: boolean }> } {
  const asked: Array<{ question: string; hidden: boolean }> = [];
  return {
    asked,
    prompt: {
      ask: async (question, fallback) => {
        asked.push({ question, hidden: false });
        return fallback ?? '';
      },
      askSecret: async (question) => {
        asked.push({ question, hidden: true });
        return Object.entries(answers).find(([k]) => question.startsWith(k))?.[1] ?? '';
      },
    },
  };
}

function context(o: { git?: GitRunner; secrets?: SecretStore; prompt?: Prompter; env?: NodeJS.ProcessEnv } = {}): Context {
  const env = o.env ?? {};
  return {
    config: loadConfig({ env, cwd: root, home, areas: [{ name: 'skills' }] }),
    fetch: fakeFetch([]).fetch,
    files: memoryFiles({}, { cwd: project }),
    env,
    home,
    version: TEST_VERSION,
    verbose: false,
    debug: () => {},
    ...(o.git ? { git: o.git } : {}),
    ...(o.secrets ? { secrets: o.secrets } : {}),
    ...(o.prompt ? { prompt: o.prompt } : {}),
  };
}
const cli = (argv: string[], ctx: Context): Promise<CliRun> => runCli(argv, { commands, context: ctx });
const userSkills = (...p: string[]) => join(home, '.agents', 'skills', ...p);

/** Turns writes on for a marketplace the way a person does: `"writes": true` on its connection. */
function turnOnWrites(name: string): void {
  const config = readJson(file);
  config.connections[name].writes = true;
  writeConfig(config);
}

/** Adds the marketplace as `corp` with no token, turns its writes on, and installs every plugin, through the real commands. Returns the sync. */
async function addCorp(git = fakeGit(), extra: string[] = []): Promise<CliRun> {
  const added = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git, secrets: fakeStore(), prompt: terminal().prompt }));
  expect(added.envelope?.ok, added.stdout).toBe(true);
  turnOnWrites('corp');
  return cli(['skills', 'marketplace', 'sync', 'all', '--allow-write', ...extra], context({ git }));
}

describe('toil skills marketplace add', () => {
  it('asks for the token hidden, keeps it only in the store, clones with it in git\'s environment, and installs nothing, with writes off', async () => {
    const git = fakeGit();
    const store = fakeStore();
    const { prompt, asked } = terminal({ 'Access token': TOKEN });
    const run = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp-skills', '--allow-write'], context({ git, secrets: store, prompt }));

    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(asked).toEqual([{ question: 'Access token for bitbucket.imagile.dev (leave empty for a public repository)', hidden: true }]);
    expect(store.entries.get('corp-skills.token')).toBe(TOKEN);
    const clone = join(home, '.agents', 'marketplaces', 'skills');
    expect(readJson(file)).toEqual({
      version: 4,
      connections: { 'corp-skills': { area: 'skills', repoUrl: REPO, localPath: clone, token: 'keychain:corp-skills.token' } },
      defaults: { skills: { connection: 'corp-skills' } },
    });
    expect(readFileSync(file, 'utf8')).not.toContain(TOKEN);
    expect(run.stdout + run.stderr).not.toContain(TOKEN);

    // The token reaches git only as a header in its environment, scoped to the marketplace's URL.
    const cloneCall = git.calls.find((c) => c.subcommand === 'clone')!;
    expect(cloneCall.paths).toEqual([REPO, clone]);
    expect(cloneCall.options).toEqual(['--no-recurse-submodules']);
    expect(cloneCall.secretConfig).toEqual([[`http.${REPO}.extraHeader`, `Authorization: Basic ${Buffer.from(`x-token-auth:${TOKEN}`).toString('base64')}`]]);
    expect(JSON.stringify([cloneCall.options, cloneCall.paths])).not.toContain(TOKEN);

    expect(run.envelope?.data).toEqual({
      name: 'corp-skills',
      repoUrl: REPO,
      localPath: clone.replace(/\\/g, '/'),
      branch: null,
      tokenConfigured: true,
      tokenStorage: 'keychain',
      provider: 'bitbucket',
      writes: false,
      cloned: true,
      available: [{ name: 'review', description: 'Code review' }, { name: 'docs', description: 'Docs' }],
      total: 2,
      next: expect.stringContaining('set "writes": true on connection "corp-skills"'),
    });
    // Adding grants nothing: no skill folder, and sync is refused until a person turns writes on.
    expect(existsSync(userSkills())).toBe(false);
    const refused = await cli(['skills', 'marketplace', 'sync', 'all', '--allow-write'], context({ git, secrets: store }));
    expect(refused.envelope?.error?.code).toBe('WRITE_DISABLED');
    expect(existsSync(userSkills())).toBe(false);

    turnOnWrites('corp-skills');
    const synced = await cli(['skills', 'marketplace', 'sync', 'all', '--allow-write'], context({ git, secrets: store }));
    expect(synced.envelope?.data).toMatchObject({ plugins: { review: { installed: ['code-review'], failed: [] }, docs: { installed: ['write-docs'], failed: [] } }, total: 2, target: userSkills().replace(/\\/g, '/') });
    expect(git.calls.filter((c) => c.subcommand === 'pull').every((c) => c.secretConfig?.length === 1)).toBe(true);
    expect(existsSync(userSkills('code-review', 'SKILL.md'))).toBe(true);
    expect(readJson(userSkills('code-review', 'toil-origin.json'))).toMatchObject({ version: 1, source: 'marketplace', marketplace: 'corp-skills', plugin: 'review', installedFrom: REPO, branch: 'main' });
    expect(readMeta(userSkills()).skills['write-docs']).toMatchObject({ plugin: 'docs', toilVersion: TEST_VERSION });
  });

  it('needs --allow-write, and changes nothing without it', async () => {
    const git = fakeGit();
    const run = await cli(['skills', 'marketplace', 'add', REPO], context({ git, prompt: terminal().prompt }));
    expect(run.envelope?.error).toMatchObject({ code: 'WRITE_DISABLED', message: expect.stringContaining('needs --allow-write') });
    expect(git.calls).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  it('refuses ssh, plaintext http and a URL that carries a token, before anything runs', async () => {
    for (const url of ['git@bitbucket.imagile.dev:ai/skills.git', 'ssh://git@bitbucket.imagile.dev/ai/skills.git', 'http://bitbucket.imagile.dev/scm/ai/skills.git', `https://x:${TOKEN}@bitbucket.imagile.dev/scm/ai/skills.git`]) {
      const git = fakeGit();
      const run = await cli(['skills', 'marketplace', 'add', url, '--allow-write'], context({ git }));
      expect(run.envelope?.error?.code, url).toBe('INVALID_INPUT');
      expect(run.stdout, url).not.toContain(TOKEN);
      expect(git.calls, url).toEqual([]);
    }
  });

  it('with no terminal, adds the marketplace with no token and says how to give it one', async () => {
    const run = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit() }));
    expect(run.envelope?.ok).toBe(true);
    expect(run.envelope?.meta.warnings).toEqual([expect.objectContaining({ code: 'SKILLS_NO_TOKEN', message: expect.stringContaining('TOIL_CONN_CORP_TOKEN') })]);
    expect(readJson(file).connections.corp.token).toBeUndefined();
  });

  it('refuses a name another connection has, and a URL already registered under another name', async () => {
    writeConfig({ version: 2, connections: { corp: { area: 'jira', baseUrl: 'https://jira.imagile.dev' } } });
    const taken = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit() }));
    expect(taken.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('already a connection named "corp"') });
    expect((await cli(['skills', 'marketplace', 'add', REPO, '--name', 'other', '--allow-write'], context({ git: fakeGit() }))).envelope?.ok).toBe(true);
    const again = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'third', '--allow-write'], context({ git: fakeGit() }));
    expect(again.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('already registered as marketplace "other"') });
  });

  it('keeps the writes setting a person gave a marketplace when it is added again', async () => {
    await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit() }));
    turnOnWrites('corp');
    const again = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit() }));
    expect(again.envelope?.data).toMatchObject({ writes: true, next: expect.stringContaining('toil skills marketplace sync all --marketplace corp') });
    expect(readJson(file).connections.corp.writes).toBe(true);
  });

  it('reports writes as the gate resolves them, with an env var over the file', async () => {
    writeConfig({ version: 2, connections: { corp: { area: 'skills', repoUrl: REPO, writes: false } }, defaults: {} });
    const run = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit(), env: { TOIL_CONN_CORP_WRITES: 'true' } }));
    expect(run.envelope?.data).toMatchObject({ writes: true, next: expect.stringMatching(/^Writes are on for it \(from an env var\)\. Install from it with: toil skills marketplace sync all --marketplace corp/) });
    // The file keeps the person's own setting; only the env var turned it on.
    expect(readJson(file).connections.corp.writes).toBe(false);
  });

  it('reports writes from an env var on the very first add, before the connection existed', async () => {
    const run = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit(), env: { TOIL_CONN_CORP_WRITES: 'true' } }));
    expect(run.envelope?.data).toMatchObject({ writes: true, next: expect.stringContaining('Writes are on for it (from an env var)') });
    expect(readJson(file).connections.corp.writes).toBeUndefined();
    // The next call's gate agrees: sync is allowed with the same env.
    const synced = await cli(['skills', 'marketplace', 'sync', 'all', '--allow-write'], context({ git: fakeGit(), env: { TOIL_CONN_CORP_WRITES: 'true' } }));
    expect(synced.envelope?.ok, synced.stdout).toBe(true);
  });

  it('re-added over a hand-edited connection, keeps its clone, branch, token, writes and every other key', async () => {
    const custom = join(root, 'my-clone');
    const store = fakeStore({ entries: { 'corp.token': TOKEN } });
    writeConfig({
      version: 3,
      connections: { corp: { area: 'skills', repoUrl: REPO, localPath: custom, branch: 'dev', token: 'keychain:corp.token', writes: false, note: 'mine' } },
      defaults: { skills: { connection: 'corp' } },
    });
    const git = fakeGit();
    const run = await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git, secrets: store, prompt: terminal().prompt }));
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(readJson(file).connections.corp).toEqual({ area: 'skills', repoUrl: REPO, localPath: custom, branch: 'dev', token: 'keychain:corp.token', writes: false, note: 'mine' });
    const clone = git.calls.find((c) => c.subcommand === 'clone')!;
    expect(clone.paths).toEqual([REPO, custom]);
    expect(clone.options).toEqual(['--no-recurse-submodules', '--branch=dev']);
    expect(clone.secretConfig).toEqual([[`http.${REPO}.extraHeader`, `Authorization: Basic ${Buffer.from(`x-token-auth:${TOKEN}`).toString('base64')}`]]);
    expect(existsSync(join(home, '.agents', 'marketplaces'))).toBe(false);
    expect(store.entries.get('corp.token')).toBe(TOKEN);
  });

  it('installs for every agent at project scope, under the repository root', async () => {
    const run = await addCorp(fakeGit(), ['--all-agents', '--scope', 'project']);
    const data = run.envelope?.data as { targets: Array<{ agent: string; target: string; total: number }>; total: number };
    expect(data.targets.map((t) => [t.agent, t.target])).toEqual([
      ['codex', join(project, '.agents', 'skills').replace(/\\/g, '/')],
      ['github-copilot', join(project, '.github', 'skills').replace(/\\/g, '/')],
      ['claude-code', join(project, '.claude', 'skills').replace(/\\/g, '/')],
    ]);
    expect(data.total).toBe(6);
    expect(existsSync(join(project, '.claude', 'skills', 'write-docs', 'SKILL.md'))).toBe(true);
    expect(existsSync(userSkills())).toBe(false);
  });

  it('refuses a clone folder inside ~/.toil', async () => {
    const run = await cli(['skills', 'marketplace', 'add', REPO, join(home, '.toil', 'clone'), '--allow-write'], context({ git: fakeGit() }));
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("holds toil's own configuration") });
  });
});

describe('toil skills marketplace sync', () => {
  it('pulls the clone and refreshes the installed plugins, leaving a switched-off one off', async () => {
    await addCorp();
    await cli(['skills', 'marketplace', 'disable', 'docs', '--allow-write'], context({ git: fakeGit() }));
    write(join(home, '.agents', 'marketplaces', 'skills'), { 'plugins/review/skills/code-review/notes.md': 'v2\n', 'plugins/docs/skills/write-docs/notes.md': 'v2\n' });
    const git = fakeGit();
    const run = await cli(['skills', 'marketplace', 'sync', '--allow-write'], context({ git }));

    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(git.calls.map((c) => c.subcommand)).toEqual(['rev-parse', 'pull', 'rev-parse']);
    expect(git.calls[1]).toMatchObject({ options: ['--ff-only', '--no-rebase'], cwd: join(home, '.agents', 'marketplaces', 'skills') });
    expect(run.envelope?.data).toMatchObject({ marketplace: 'corp', plugins: { review: { installed: ['code-review'] }, docs: { installed: ['write-docs'] } }, marketplaceUpdated: false, installedOnly: true });
    expect(readFileSync(userSkills('code-review', 'notes.md'), 'utf8')).toBe('v2\n');
    // Off stays off; its stashed copy is the fresh one.
    expect(existsSync(userSkills('write-docs'))).toBe(false);
    expect(readFileSync(userSkills('.toil-disabled', 'write-docs', 'notes.md'), 'utf8')).toBe('v2\n');
  });

  it('clones on first use for a marketplace defined only by env vars, and sends its env token', async () => {
    const git = fakeGit();
    const env = { TOIL_CONN_CI_AREA: 'skills', TOIL_CONN_CI_REPO_URL: 'https://github.com/imagile/skills.git', TOIL_CONN_CI_TOKEN: TOKEN, TOIL_CONN_CI_WRITES: 'true' };
    const run = await cli(['skills', 'marketplace', 'sync', 'review', '--claude', '--allow-write'], context({ git, env }));
    expect(run.envelope?.ok, run.stdout).toBe(true);
    expect(run.envelope?.data).toMatchObject({ marketplace: 'ci', plugin: 'review', installed: ['code-review'], total: 1, marketplaceUpdated: true });
    const clone = git.calls.find((c) => c.subcommand === 'clone')!;
    expect(clone.secretConfig).toEqual([['http.https://github.com/imagile/skills.git.extraHeader', `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`]]);
    expect(existsSync(join(home, '.claude', 'skills', 'code-review', 'SKILL.md'))).toBe(true);
    expect(run.stdout).not.toContain(TOKEN);
  });

  it('leaves a same-named skill it did not install exactly as it is', async () => {
    write(userSkills(), { 'code-review/SKILL.md': 'written by hand\n' });
    const run = await addCorp();
    expect(run.envelope?.data).toMatchObject({ plugins: { review: { installed: [], failed: ['code-review'] } } });
    expect(run.envelope?.meta.warnings).toEqual([expect.objectContaining({ code: 'SKILLS_NOT_REPLACED' })]);
    expect(readFileSync(userSkills('code-review', 'SKILL.md'), 'utf8')).toBe('written by hand\n');
    expect(readMeta(userSkills()).skills['code-review']).toBeUndefined();
  });

  it('reads plugins that marketplace.json places with source and a skills list, and skips one in another repository', async () => {
    rmSync(seed, { recursive: true, force: true });
    write(seed, {
      '.claude-plugin/marketplace.json': JSON.stringify({
        plugins: [
          { name: 'documents', description: 'Docs', source: './', skills: ['./skills/pdf', './skills/docx'] },
          { name: 'elsewhere', source: { source: 'github', repo: 'imagile/other' } },
        ],
      }),
      'skills/pdf/SKILL.md': '---\nname: pdf\n---\n',
      'skills/docx/SKILL.md': '---\nname: docx\n---\n',
      'skills/unlisted/SKILL.md': '---\nname: unlisted\n---\n',
    });
    const run = await addCorp();
    expect(run.envelope?.data).toMatchObject({ plugins: { documents: { installed: ['pdf', 'docx'], failed: [] }, elsewhere: { installed: [], failed: [] } }, total: 2 });
    expect(run.envelope?.meta.warnings).toEqual([expect.objectContaining({ code: 'SKILLS_PLUGIN_REMOTE', message: expect.stringContaining('"elsewhere"') })]);
    expect(existsSync(userSkills('unlisted'))).toBe(false);
  });

  it('refuses a plugin whose source or skill list leaves the clone', async () => {
    for (const plugin of [{ name: 'out', source: '../..' }, { name: 'out', source: './', skills: ['../../outside'] }, { name: 'out', source: './', skills: ['./'] }]) {
      rmSync(seed, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      write(seed, { '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [plugin] }) });
      const run = await addCorp();
      expect(run.envelope?.error, JSON.stringify(plugin)).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/outside the marketplace's clone|the clone itself/) });
    }
  });

  it('refuses a plugin the marketplace does not have, naming the ones it does', async () => {
    await addCorp();
    const run = await cli(['skills', 'marketplace', 'sync', 'nope', '--allow-write'], context({ git: fakeGit() }));
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Plugin "nope" isn\'t in marketplace corp. It has: review, docs.' });
  });

  it.skipIf(process.platform === 'win32')('never copies a symlink out of a marketplace (POSIX only: Windows needs privileges to make one)', async () => {
    symlinkSync(join(home, '.toil'), join(seed, 'plugins', 'review', 'skills', 'code-review', 'config-link'));
    await addCorp();
    expect(existsSync(userSkills('code-review', 'SKILL.md'))).toBe(true);
    expect(existsSync(userSkills('code-review', 'config-link'))).toBe(false);
  });

  it('turns a refused token into AUTH with the fix, and never echoes the token', () => {
    const err = gitFailed('pull', { name: 'corp', repoUrl: REPO, token: TOKEN }, { exitCode: 128, stdout: '', stderr: `fatal: Authentication failed for '${REPO}' (${TOKEN})` });
    expect(err.code).toBe('AUTH');
    expect(err.message).not.toContain(TOKEN);
    expect(err.fix).toContain('toil connections login corp');
    expect(err.fix).toContain('Bitbucket Data Center personal tokens');
  });
});

describe('toil skills marketplace disable and enable', () => {
  it('moves only that plugin, writes only its records, and keeps every other key in the index', async () => {
    await addCorp();
    const index = userSkills('.toil-installed.json');
    const before = readJson(index);
    // Keys toil doesn't know, at the top and in a record, survive the round trip.
    writeFileSync(index, JSON.stringify({ ...before, note: 'kept', skills: { ...before.skills, 'code-review': { ...before.skills['code-review'], pinned: true } } }, null, 2));
    const seeded = readJson(index);

    const off = await cli(['skills', 'marketplace', 'disable', 'review', '--allow-write'], context());
    expect(off.envelope?.data).toEqual({
      disabled: ['code-review'],
      alreadyDisabled: [],
      skipped: 1,
      total: 1,
      target: userSkills().replace(/\\/g, '/'),
      plugin: 'review',
      stash: userSkills('.toil-disabled').replace(/\\/g, '/'),
      marketplace: 'corp',
    });
    expect(existsSync(userSkills('code-review'))).toBe(false);
    expect(existsSync(userSkills('.toil-disabled', 'code-review', 'SKILL.md'))).toBe(true);
    const offIndex = readJson(index);
    expect(offIndex.note).toBe('kept');
    expect(offIndex.skills['write-docs']).toEqual(seeded.skills['write-docs']);
    expect(offIndex.disabled['code-review']).toEqual(seeded.skills['code-review']);

    const on = await cli(['skills', 'marketplace', 'enable', 'review', '--allow-write'], context());
    expect(on.envelope?.data).toMatchObject({ enabled: ['code-review'], total: 1, plugin: 'review', marketplace: 'corp' });
    // Off and on again is the file it started as.
    expect(readJson(index)).toEqual({ ...seeded, disabled: {} });
  });

  it('needs writes on the marketplace, then --allow-write', async () => {
    await addCorp();
    const config = readJson(file);
    config.connections.corp.writes = false;
    writeConfig(config);
    expect((await cli(['skills', 'marketplace', 'disable', 'review', '--allow-write'], context())).envelope?.error?.code).toBe('WRITE_DISABLED');
    expect(existsSync(userSkills('code-review'))).toBe(true);
  });

  it('refuses to read an index that is not valid, and leaves it untouched', async () => {
    await addCorp();
    writeFileSync(userSkills('.toil-installed.json'), '{ not json');
    const run = await cli(['skills', 'marketplace', 'disable', 'review', '--allow-write'], context());
    expect(run.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("can't be read") });
    expect(readFileSync(userSkills('.toil-installed.json'), 'utf8')).toBe('{ not json');
    expect(existsSync(userSkills('code-review'))).toBe(true);
  });

  it('reports a stashed skill that has gone, and keeps it recorded as disabled', async () => {
    await addCorp();
    await cli(['skills', 'marketplace', 'disable', 'docs', '--allow-write'], context());
    rmSync(userSkills('.toil-disabled', 'write-docs'), { recursive: true });
    const run = await cli(['skills', 'marketplace', 'enable', 'docs', '--allow-write'], context());
    expect(run.envelope?.data).toMatchObject({ enabled: [], stashMissing: ['write-docs'], warning: expect.stringContaining('toil skills marketplace sync docs') });
    expect(readMeta(userSkills()).disabled?.['write-docs']).toBeDefined();
  });
});

describe('toil skills status, marketplace list, plugins and remove', () => {
  it('lists every skill with its plugin and whether it is on, and untracked ones too', async () => {
    await addCorp();
    await cli(['skills', 'marketplace', 'disable', 'docs', '--allow-write'], context());
    write(userSkills(), { 'my-notes/SKILL.md': '---\nname: my-notes\n---\n' });
    const run = await cli(['skills', 'status', '--agent', 'codex', '--scope', 'user'], context());
    const data = run.envelope?.data as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(data.skills.map((s: { skill: string; plugin: string | null; enabled: boolean; source: string }) => [s.skill, s.plugin, s.enabled, s.source])).toEqual([
      ['code-review', 'review', true, 'marketplace'],
      ['my-notes', null, true, 'untracked'],
      ['write-docs', 'docs', false, 'marketplace'],
    ]);
    expect(data).toMatchObject({ total: 3, enabled: 2, disabled: 1, untracked: 1, stale: 0, toilVersion: TEST_VERSION, byMarketplace: { corp: 2, '(none)': 1 } });
    expect(data.skills[0]).toMatchObject({ marketplace: 'corp', repoUrl: REPO, upstreamRemote: REPO, localPath: join(home, '.agents', 'marketplaces', 'skills').replace(/\\/g, '/') });
    expect(data.locations).toEqual([expect.objectContaining({ agent: 'codex', scope: 'user', totalSkills: 2, marketplaceSkills: 1, untrackedSkills: 1, disabledSkills: 1 })]);
  });

  it('lists a folder once when the project is the home folder', async () => {
    await addCorp();
    const ctx = context();
    ctx.files = memoryFiles({}, { cwd: home });
    const data = (await cli(['skills', 'status', '--agent', 'codex'], ctx)).envelope?.data as { total: number; locations: Array<{ scope: string }> };
    expect(data.locations.map((l) => l.scope)).toEqual(['user']);
    expect(data.total).toBe(2);
  });

  it('lists marketplaces with where each token is kept, never the token', async () => {
    const store = fakeStore();
    await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit(), secrets: store, prompt: terminal({ 'Access token': TOKEN }).prompt }));
    const env = { TOIL_CONN_CI_AREA: 'skills', TOIL_CONN_CI_REPO_URL: 'https://github.com/imagile/ci-skills.git', TOIL_CONN_CI_TOKEN: TOKEN };
    const run = await cli(['skills', 'marketplace', 'list'], context({ env, secrets: store }));
    expect(run.envelope?.data).toMatchObject({
      total: 2,
      marketplaces: [
        { name: 'ci', tokenConfigured: true, tokenStorage: 'env', provider: 'github', upstreamRemote: null, writes: false },
        { name: 'corp', tokenConfigured: true, tokenStorage: 'keychain', provider: 'bitbucket', upstreamRemote: REPO, writes: false },
      ],
    });
    expect(run.stdout).not.toContain(TOKEN);
  });

  it('lists a marketplace\'s plugins from its clone', async () => {
    await addCorp();
    const run = await cli(['skills', 'marketplace', 'plugins', 'corp'], context());
    expect(run.envelope?.data).toEqual({ marketplace: 'corp', plugins: [{ name: 'review', description: 'Code review' }, { name: 'docs', description: 'Docs' }], total: 2 });
  });

  it('removes a marketplace and its stored token, keeping its clone, its skills and every other connection', async () => {
    const store = fakeStore();
    writeConfig({ version: 2, connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' } }, defaults: {}, bounds: { files: 'workspace' } });
    await cli(['skills', 'marketplace', 'add', REPO, '--name', 'corp', '--allow-write'], context({ git: fakeGit(), secrets: store, prompt: terminal({ 'Access token': TOKEN }).prompt }));
    turnOnWrites('corp');
    expect((await cli(['skills', 'marketplace', 'sync', 'all', '--allow-write'], context({ git: fakeGit(), secrets: store }))).envelope?.ok).toBe(true);
    const run = await cli(['skills', 'marketplace', 'remove', 'corp'], context({ secrets: store }));
    expect(run.envelope?.data).toEqual({ removed: { name: 'corp', repoUrl: REPO, localPath: join(home, '.agents', 'marketplaces', 'skills').replace(/\\/g, '/') }, keychainEntryDeleted: true, remaining: 0 });
    expect(readJson(file)).toEqual({ version: 4, connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' } }, defaults: {}, bounds: { files: 'workspace' } });
    expect(store.entries.has('corp.token')).toBe(false);
    expect(existsSync(join(home, '.agents', 'marketplaces', 'skills', '.git'))).toBe(true);
    expect(existsSync(userSkills('code-review'))).toBe(true);
  });
});

const realGit = findGit({ env: process.env }).found;

describe('against the real git', () => {
  it.skipIf(!realGit)('adds a marketplace from a local repository and syncs a new commit (skipped where git is not installed)', async () => {
    const origin = join(root, 'origin');
    cpSync(seed, origin, { recursive: true });
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=you@example.com', '-c', 'core.autocrlf=false', ...args], { cwd: origin, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('add', '.');
    g('commit', '-q', '-m', 'one');
    const git = createGitRunner({ command: 'skills marketplace add', env: { PATH: join(realGit!, '..') }, workspace: () => project, exclude: [project], home });
    const added = await cli(['skills', 'marketplace', 'add', origin, '--name', 'local', '--allow-write'], context({ git }));
    expect(added.envelope?.ok, added.stdout).toBe(true);
    expect(added.envelope?.data).toMatchObject({ name: 'local', cloned: true, tokenConfigured: false, writes: false, total: 2 });
    turnOnWrites('local');
    const first = await cli(['skills', 'marketplace', 'sync', 'all', '--allow-write'], context({ git }));
    expect(first.envelope?.data, first.stdout).toMatchObject({ total: 2, marketplaceUpdated: false });

    write(origin, { 'plugins/review/skills/code-review/notes.md': 'v2\n' });
    g('commit', '-q', '-am', 'two');
    const synced = await cli(['skills', 'marketplace', 'sync', 'review', '--allow-write'], context({ git }));
    expect(synced.envelope?.ok, synced.stdout).toBe(true);
    expect(synced.envelope?.data).toMatchObject({ plugin: 'review', installed: ['code-review'], marketplaceUpdated: true });
    // A checkout may turn LF into CRLF (core.autocrlf on Windows); the content is what counts.
    expect(readFileSync(userSkills('code-review', 'notes.md'), 'utf8').replace(/\r\n/g, '\n')).toBe('v2\n');
    expect(readMeta(userSkills()).skills['code-review']).toMatchObject({ branch: 'main', installedFrom: origin });
  }, 30_000);
});
