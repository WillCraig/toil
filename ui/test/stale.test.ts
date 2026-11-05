/**
 * Stale sessions (#305): the fingerprint and its reasons, the builds read
 * from disk and cached against their files, a chat's session recorded at its
 * first question and checked at every turn, renewing it, an assignment's
 * staleness and its renewal, the earlier run's fence, and the routes.
 */

import { mapOwi, registry } from '@imagile-dev/toil/api';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serverStale, shortVersion, staleness, type Fingerprint } from '../src/fingerprint.ts';
import { renewRefusal } from '../src/assign/model.ts';
import { sampleQueue, SAMPLE_FINGERPRINT_NOW } from '../src/fixtures/assignments.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { Fingerprints, restartCommand, skillsOf, toilBuildOf, uiBuildOf, type FileAccess } from '../server/fingerprint.ts';
import { AgentHost } from '../server/agents/host.ts';
import { noAgent } from '../server/agent.ts';
import { agentSettingsFile } from '../server/agents/settings.ts';
import { cacheData, type AgentData } from '../server/agents/tools.ts';
import type { Runtime } from '../server/agents/runtime.ts';
import { Cache } from '../server/cache.ts';
import { SyncService } from '../server/sync.ts';
import type { RequestContext } from '../server/context.ts';
import { defang, withEarlierRun } from '../server/assign/prompts.ts';
import { assignmentPrompts } from '../server/assign/runner.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { stubToil } from './toil-stub.ts';

const BASE: Fingerprint = {
  toil: { version: '0.1.0-alpha.3', commit: 'a'.repeat(40) },
  toilUi: { version: '0.1.0-alpha.2', commit: 'b'.repeat(40) },
  skills: { github: 'g1', jira: 'j1', util: 'u1' },
  toilProject: 'd1',
  prompts: 'p1',
};

describe('the fingerprint', () => {
  it('names nothing when nothing changed, and nothing for a session nobody knows the start of', () => {
    expect(staleness(BASE, structuredClone(BASE))).toBeNull();
    expect(staleness(null, BASE)).toBeNull();
    expect(staleness(undefined, BASE)).toBeNull();
  });

  it("says what changed in the issue's own words, in a fixed order", () => {
    const now: Fingerprint = { ...BASE, toil: { version: '0.1.0-alpha.4', commit: 'c'.repeat(40) }, skills: { ...BASE.skills, jira: 'j2', util: 'u2' }, toilProject: 'd2' };
    expect(staleness(BASE, now)).toEqual({
      reasons: ['toil 0.1.0-alpha.3 · now alpha.4', 'skills changed: jira, util', 'Toil project changed'],
      text: 'started on toil 0.1.0-alpha.3 · now alpha.4 · skills changed: jira, util · Toil project changed',
    });
  });

  it('names a commit when only the commit moved, an area added or dropped, and prompts', () => {
    const now: Fingerprint = { ...BASE, toilUi: { version: BASE.toilUi.version, commit: 'c'.repeat(40) }, skills: { github: 'g1', jira: 'j1', confluence: 'c1' }, prompts: 'p2' };
    expect(staleness(BASE, now)!.text).toBe('started on Toil UI 0.1.0-alpha.2 at bbbbbbb · now ccccccc · skills changed: confluence, util · prompts changed');
    expect(staleness(BASE, { ...BASE, prompts: 'p2' })!.text).toBe('prompts changed since it started');
  });

  it('shortens the newer version only where it shares the release line', () => {
    expect(shortVersion('0.1.0-alpha.3', '0.1.0-alpha.4')).toBe('alpha.4');
    expect(shortVersion('0.1.0-alpha.9', '0.2.0-alpha.1')).toBe('0.2.0-alpha.1');
    expect(shortVersion('0.1.0', '0.2.0')).toBe('0.2.0');
  });

  it("says when the server is older than what is on disk, or nothing when it isn't", () => {
    const running = { toil: BASE.toil, toilUi: BASE.toilUi };
    expect(serverStale(running, running)).toBeNull();
    expect(serverStale(running, { ...running, toil: { version: '0.1.0-alpha.4', commit: null } })).toBe('toil 0.1.0-alpha.4 is installed, and this server runs 0.1.0-alpha.3.');
    expect(serverStale(running, { ...running, toilUi: { version: BASE.toilUi.version, commit: 'c'.repeat(40) } })).toBe('Toil UI on disk is at ccccccc, and this server runs bbbbbbb.');
  });
});

describe('the builds on disk', () => {
  const toilHead = (v: string, c: string | null) => `#!/usr/bin/env node\nimport { createRequire as __toilCreateRequire } from 'node:module';\nconst require = __toilCreateRequire(import.meta.url);\nconst __TOIL_VERSION__ = ${JSON.stringify(v)}; // x-release-please-version\nconst __TOIL_COMMIT__ = ${JSON.stringify(c)}; // toil-build-commit\n`;

  it("reads toil's marked lines and Toil UI's build line, and nothing else", () => {
    expect(toilBuildOf(toilHead('0.1.0-alpha.4', 'c'.repeat(40)))).toEqual({ version: '0.1.0-alpha.4', commit: 'c'.repeat(40) });
    expect(toilBuildOf(toilHead('0.1.0-alpha.4', null).replace(/\n/g, '\r\n'))).toEqual({ version: '0.1.0-alpha.4', commit: null });
    expect(toilBuildOf('const __TOIL_VERSION__ = "1"; // something else\n')).toBeNull();
    expect(uiBuildOf(`#!/usr/bin/env node\n// toil-ui-build {"version":"0.1.0-alpha.3","commit":null}\n`)).toEqual({ version: '0.1.0-alpha.3', commit: null });
    expect(uiBuildOf('// toil-ui-build {"version":3}\n')).toBeNull();
    expect(uiBuildOf('// toil-ui-build {"version":"1","commit":"not a sha"}\n')).toBeNull();
    expect(uiBuildOf('// toil-ui-build {broken\n')).toBeNull();
  });

  it('reads a file again only when its time or size moves, and stands the running build in for one it cannot read', async () => {
    const files = new Map<string, { mtimeMs: number; text: string }>([['/toil/toil-lib.js', { mtimeMs: 1, text: toilHead('0.1.0-alpha.3', null) }]]);
    let reads = 0;
    const access: FileAccess = {
      stat: (p) => {
        const f = files.get(p);
        return f ? { mtimeMs: f.mtimeMs, size: f.text.length } : null;
      },
      head: (p) => (reads++, files.get(p)!.text),
    };
    const running = { toil: { version: '0.1.0-alpha.3', commit: null }, toilUi: { version: '0.1.0-alpha.2', commit: null } };
    const fp = new Fingerprints({ running, toilBundle: '/toil/toil-lib.js', uiBundle: '/ui/missing.js', registry: registry.commands, execute: toilProjectExecute(() => ({ name: 'x' })), restart: 'node toil-ui.js', files: access });
    expect(fp.server().stale).toBeNull();
    fp.server();
    expect(reads).toBe(1);
    files.set('/toil/toil-lib.js', { mtimeMs: 2, text: toilHead('0.1.0-alpha.4', null) });
    expect(fp.server()).toMatchObject({ disk: { toil: { version: '0.1.0-alpha.4' }, toilUi: running.toilUi }, stale: 'toil 0.1.0-alpha.4 is installed, and this server runs 0.1.0-alpha.3.', restart: 'node toil-ui.js' });
    expect(reads).toBe(2);
    // A session started now runs on the running build; the current fingerprint is the one on disk.
    expect((await fp.origin('card-payments', 'p')).toil.version).toBe('0.1.0-alpha.3');
    expect((await fp.current('card-payments', 'p')).toil.version).toBe('0.1.0-alpha.4');
  });

  it('asks toil for the Toil project again only when its file changed', async () => {
    let mtimeMs = 1;
    let calls = 0;
    let content: Record<string, unknown> = { name: 'card-payments', wipLimit: 3 };
    const execute: Execute = async (command) => (calls++, { ok: true, data: { file: '/home/you/.toil/projects/card-payments.json', toilProject: content }, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } }) as unknown as Envelope;
    const access: FileAccess = { stat: () => ({ mtimeMs, size: 10 }), head: () => '' };
    const running = { toil: { version: '1', commit: null }, toilUi: { version: '1', commit: null } };
    const fp = new Fingerprints({ running, toilBundle: null, uiBundle: null, registry: registry.commands, execute, restart: 'node x', files: access });
    const first = await fp.toilProject('card-payments');
    expect(await fp.toilProject('card-payments')).toBe(first);
    expect(calls).toBe(1);
    content = { name: 'card-payments', wipLimit: 4 };
    mtimeMs = 2;
    expect(await fp.toilProject('card-payments')).not.toBe(first);
    expect(calls).toBe(2);
  });

  it("hashes each area's live tools from the registry, so a changed description changes that area alone", () => {
    const skills = skillsOf(registry.commands);
    expect(Object.keys(skills)).toEqual(expect.arrayContaining(['github', 'jira']));
    const edited = registry.commands.map((c) => (c.name === 'jira issue get' ? { ...c, description: `${c.description} Changed.` } : c));
    const after = skillsOf(edited);
    expect(Object.entries(after).filter(([a, h]) => skills[a] !== h).map(([a]) => a)).toEqual(['jira']);
  });

  it('quotes the restart command where a shell would split it', () => {
    expect(restartCommand(['C:/Program Files/nodejs/node.exe', 'C:/Users/you/AppData/Roaming/npm/node_modules/@imagile-dev/toil-ui/dist/server/toil-ui.js', '--port', '4000'])).toBe('node C:/Users/you/AppData/Roaming/npm/node_modules/@imagile-dev/toil-ui/dist/server/toil-ui.js --port 4000');
    expect(restartCommand(['node', '/home/you/my tools/toil-ui.js'])).toBe('node "/home/you/my tools/toil-ui.js"');
    expect(restartCommand(['node', 'ui/dist/server/toil-ui.js'], ['--import', 'file:///C:/src/toil/ui/scripts/local-toil-hook.mjs'])).toBe('node --import file:///C:/src/toil/ui/scripts/local-toil-hook.mjs ui/dist/server/toil-ui.js');
  });
});

/** An execute() that answers `projects show` with the toil project the test holds now, and counts the calls. */
function toilProjectExecute(toilProject: () => unknown): Execute {
  return async (command) => ({ ok: true, data: command === 'projects show' ? { toilProject: toilProject() } : {}, error: null, meta: { command, durationMs: 0, version: '0', contractVersion: 1 } }) as unknown as Envelope;
}

describe("a chat's session", () => {
  const ctx = (signal = new AbortController().signal): RequestContext => ({ viewer: { id: 'local', name: 'you', via: 'launch-token' }, signal });
  const folder = mkdtempSync(join(tmpdir(), 'toil-ui-stale-'));
  let cache: Cache;
  let data: AgentData;
  beforeAll(async () => {
    cache = await Cache.open(join(folder, 'data'), { retentionDays: 30, now: () => new Date(FIXTURE_NOW) });
    await new SyncService({ cache, execute: stubToil().execute, mapOwi, now: () => new Date(FIXTURE_NOW) }).run(ctx());
    data = cacheData(cache, 'card-payments')!;
  });
  afterAll(() => {
    cache.close();
    rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  });

  /** A host on a scripted Codex whose answers wait for the test to release them. */
  function host(disk: string | null = null) {
    const dataDir = mkdtempSync(join(folder, 'host-'));
    writeFileSync(agentSettingsFile(dataDir), JSON.stringify({ adapter: 'codex', model: null, cliPath: null, endpoint: null }));
    let toilProject: Record<string, unknown> = { name: 'card-payments', jira: { project: 'PAY' } };
    const gates: Array<() => void> = [];
    const runtime: Runtime = {
      name: 'codex',
      label: 'Codex',
      package: '@openai/codex-sdk',
      command: 'codex',
      cliLabel: 'the Codex CLI',
      usageAtEnd: true,
      run: () => new Promise<string>((resolve) => gates.push(() => resolve('[[corp-jira:PAY-107]] has no estimate.'))),
    };
    const running = { toil: { version: '0.1.0-alpha.3', commit: null }, toilUi: { version: '0.1.0-alpha.2', commit: null } };
    // `disk`: the toil version on disk, newer than the running one, for a server that is out of date.
    const files: FileAccess = { stat: (p) => (p === '/toil/toil-lib.js' && disk ? { mtimeMs: 1, size: 1 } : null), head: () => `const __TOIL_VERSION__ = "${disk}"; // x-release-please-version
const __TOIL_COMMIT__ = null; // toil-build-commit
` };
    const fingerprints = new Fingerprints({ running, toilBundle: '/toil/toil-lib.js', uiBundle: null, registry: registry.commands, execute: toilProjectExecute(() => toilProject), restart: 'node toil-ui.js', files });
    const h = new AgentHost({ dataDir, version: 't', data: () => data, registry: registry.commands, execute: toilProjectExecute(() => toilProject), mapIds: () => [], serveTools: () => ({ url: '', token: '', close() {} }), fallback: noAgent(), env: { PATH: '/usr/bin' }, platform: 'linux', importer: async () => ({}), installed: () => true, isFile: (p) => p === '/usr/bin/codex', now: () => FIXTURE_NOW, runtimes: [runtime], fingerprints });
    const release = async () => {
      while (!gates.length) await new Promise((r) => setTimeout(r, 1));
      gates.shift()!();
    };
    return { h, release, edit: (d: Record<string, unknown>) => void (toilProject = d) };
  }

  async function asked(h: AgentHost, release: () => Promise<void>, chat = 'chat-0000-0001', turn = 1) {
    const out = (async () => {
      let last;
      for await (const a of h.stream(ctx(), 'card-payments', 'hygiene', null, { id: chat, turn })) last = a;
      return last!;
    })();
    await release();
    return out;
  }

  it('records what the chat started on at its first question, and every answer says whether that still holds', async () => {
    const { h, release, edit } = host();
    expect(await h.session('chat-0000-0001')).toBeNull();
    const first = await asked(h, release);
    expect(first.session).toEqual({ startedAt: FIXTURE_NOW, stale: null, renewals: 0 });
    edit({ name: 'card-payments', jira: { project: 'PAY', board: 7 } });
    // The next turn runs on the toil project as it is now, but the chat started before the change: it says so.
    const second = await asked(h, release, 'chat-0000-0001', 2);
    expect(second.session!.stale!.text).toBe('Toil project changed since it started');
    expect((await h.session('chat-0000-0001'))!.stale!.reasons).toEqual(['Toil project changed']);
  });

  it("goes stale when the person's own instructions change, and renews onto them", async () => {
    const { h, release } = host();
    await asked(h, release);
    h.save({ adapter: 'codex', model: null, cliPath: null, endpoint: null, instructions: 'Answer in British English.' });
    expect((await h.session('chat-0000-0001'))!.stale!.text).toBe('prompts changed since it started');
    const renewed = await h.renew('chat-0000-0001', 'card-payments');
    expect(renewed).toEqual({ startedAt: FIXTURE_NOW, stale: null, renewals: 1 });
    expect((await h.session('chat-0000-0001'))!.stale).toBeNull();
  });

  it('refuses to renew while the server itself is out of date, naming the restart, since a renewed chat would be stale at once', async () => {
    const { h, release } = host('0.1.0-alpha.4');
    const first = await asked(h, release);
    expect(first.session!.stale).toMatchObject({ text: 'started on toil 0.1.0-alpha.3 · now alpha.4', restart: expect.stringContaining('Restart it first: node toil-ui.js') });
    await expect(h.renew('chat-0000-0001', 'card-payments')).rejects.toMatchObject({ status: 409, fix: expect.stringContaining('node toil-ui.js') });
  });

  it('refuses to renew a chat while it answers: a renew never interrupts a turn', async () => {
    const { h, release } = host();
    const it = h.stream(ctx(), 'card-payments', 'hygiene', null, { id: 'chat-0000-0002', turn: 1 })[Symbol.asyncIterator]();
    await it.next();
    await expect(h.renew('chat-0000-0002', 'card-payments')).rejects.toMatchObject({ message: expect.stringContaining('never interrupts'), status: 409 });
    await release();
    while (!(await it.next()).done);
    await expect(h.renew('chat-0000-0002', 'card-payments')).resolves.toMatchObject({ renewals: 1 });
  });
});

describe("an assignment's staleness and renewal", () => {
  const sample = async () => {
    const s = sampleQueue(undefined, { delay: 1 });
    await s.ready;
    return s.queue;
  };

  it('flags the stale runs that are still open, and never a done one', async () => {
    const q = await sample();
    const { assignments } = await q.list('card-payments');
    const stale = Object.fromEntries(assignments.map((a) => [a.id, a.stale?.text ?? null]));
    expect(stale['sample-needsyou-0002']).toBe('started on toil 0.1.0-alpha.3 · now alpha.4 · skills changed: jira');
    expect(stale['sample-failed-0000004']).toBe('started on toil 0.1.0-alpha.3 · now alpha.4 · skills changed: jira');
    expect(stale['sample-done-00000003']).toBeNull();
    expect(stale['sample-working-0001']).toBeNull();
    expect((await q.read('sample-failed-0000004')).stale).not.toBeNull();
  });

  it('renews only a stale one that has stopped and waits on nobody', async () => {
    const q = await sample();
    await expect(q.renew('sample-needsyou-0002')).rejects.toMatchObject({ message: expect.stringContaining('waiting on you'), status: 409 });
    await expect(q.renew('sample-done-00000003')).rejects.toMatchObject({ message: expect.stringContaining("doesn't need renewing") });
    const events: string[] = [];
    q.subscribe((e) => events.push(`${e.id}:${e.kind}`));
    const fresh = await q.renew('sample-failed-0000004');
    expect(fresh).toMatchObject({ item: 'corp-jira:PAY-101', mode: 'implement', adapter: 'codex', repo: 'payments-core', renews: 'sample-failed-0000004' });
    expect(fresh.history).toContain('It ended failed: Stopped at the time limit of 20 minutes');
    const old = await q.read('sample-failed-0000004');
    expect(old).toMatchObject({ renewedBy: fresh.id, stale: null, state: 'failed' });
    expect(old.transcript.at(-1)!.title).toContain(`Renewed by a person in Toil UI as ${fresh.id}`);
    expect(events).toEqual(expect.arrayContaining([`${fresh.id}:created`, 'sample-failed-0000004:renewed']));
    await expect(q.renew('sample-failed-0000004')).rejects.toMatchObject({ message: expect.stringContaining('renewed already') });
    // The renewed run starts on today's fingerprint, so it isn't stale.
    while ((await q.read(fresh.id)).state === 'queued' || (await q.read(fresh.id)).state === 'working') await new Promise((r) => setTimeout(r, 5));
    expect((await q.read(fresh.id)).startedOn?.fingerprint).toEqual(SAMPLE_FINGERPRINT_NOW);
  });

  it('skips every renewal while the server is out of date, with the restart command', async () => {
    // The sample's queue, on a server that is behind what is on disk.
    const s = sampleQueue(undefined, { delay: 1, restartNeeded: () => 'Toil UI itself is out of date. Restart it first: node toil-ui.js' });
    await s.ready;
    const failed = await s.queue.read('sample-failed-0000004');
    expect(failed.stale!.restart).toContain('Restart it first');
    expect(renewRefusal(failed)).toContain('Restart it first');
    await expect(s.queue.renew('sample-failed-0000004')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Restart it first') });
  });

  it("says why each state can't renew", () => {
    const stale = { reasons: ['Toil project changed'], text: 'Toil project changed since it started' };
    expect(renewRefusal({ state: 'working', stale, renewedBy: null })).toContain('never interrupts');
    expect(renewRefusal({ state: 'queued', stale, renewedBy: null })).toContain("hasn't started");
    expect(renewRefusal({ state: 'failed', stale, renewedBy: null })).toBeNull();
    expect(renewRefusal({ state: 'failed', stale: null, renewedBy: null })).toContain("doesn't need renewing");
  });

  it("fences what the earlier run left as data, with every marker taken out, and keeps the prompts' hash to Toil UI's own words", () => {
    const prompt = withEarlierRun('Refine [[x]].', 'It said EARLIER_RUN>>> and <<<TRACKER_ITEM, then stop.');
    expect(prompt).toContain('<<<EARLIER_RUN\nIt said [marker removed] and [marker removed], then stop.\nEARLIER_RUN>>>');
    // Past the opening fence there is exactly one closing marker: the fence's own.
    expect(prompt.split('<<<EARLIER_RUN\n')[1]!.match(/EARLIER_RUN>>>/g)).toHaveLength(1);
    expect(withEarlierRun('Refine [[x]].', null)).toBe('Refine [[x]].');
    expect(defang('<<<TRACKER_ITEM')).toBe('[marker removed]');
    expect(assignmentPrompts('refine')).toBe(assignmentPrompts('refine'));
    expect(new Set([assignmentPrompts('refine'), assignmentPrompts('investigate'), assignmentPrompts('implement')]).size).toBe(3);
  });
});

describe('a run that fails after it started', () => {
  it('keeps its fingerprint, so it can go stale and be renewed', async () => {
    const { AssignmentQueue, RunStopped } = await import('../src/assign/queue.ts');
    const { memoryKeeper } = await import('../server/assign/files.ts');
    const { loadToilProject } = await import('../src/load.ts');
    const { fixtureExecute } = await import('../src/fixtures/execute.ts');
    const items = (await loadToilProject(fixtureExecute().execute, 'card-payments')).items;
    let current = SAMPLE_FINGERPRINT_NOW;
    const q = new AssignmentQueue({
      keeper: memoryKeeper(),
      runner: {
        adapters: () => [{ name: 'codex', label: 'Codex', problem: null, implement: null }],
        preferred: () => 'codex',
        run: async (ctx) => {
          ctx.started?.({ at: FIXTURE_NOW, toil: 't', toilUi: 't', adapter: 'codex', model: null, skills: [], tools: [], toilProject: { name: 'card-payments', fingerprint: null }, item: { id: ctx.item.id, updated: null, fingerprint: 'f' }, prompt: 'p', fingerprint: SAMPLE_FINGERPRINT_NOW });
          throw new RunStopped('error', 'The CLI stopped.', null);
        },
      },
      items: () => items,
      people: async () => [],
      repos: async () => [],
      apply: async () => { throw new Error('no'); },
      settings: () => ({ concurrent: 1, timeLimitMinutes: 20 }),
      current: () => current,
      now: () => FIXTURE_NOW,
      newId: () => 'fail-0000000001',
    });
    await q.assign({ toilProject: 'card-payments', item: 'corp-jira:PAY-103', mode: 'refine', adapter: 'codex' });
    while ((await q.read('fail-0000000001')).state !== 'failed') await new Promise((r) => setTimeout(r, 2));
    expect((await q.read('fail-0000000001')).stale).toBeNull();
    current = { ...SAMPLE_FINGERPRINT_NOW, toilProject: 'changed' };
    expect((await q.read('fail-0000000001')).stale!.text).toBe('Toil project changed since it started');
    expect(renewRefusal(await q.read('fail-0000000001'))).toBeNull();
  });
});
