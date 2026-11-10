// @vitest-environment node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Cache, type ToilProjectSave } from '../server/cache.ts';
import { WorklogService } from '../server/worklog.ts';
import { markdownOf, type AgentRun } from '../src/model/worklog.ts';
import type { Envelope, Execute, ExecuteOptions, WorkItem } from '../src/toil.ts';
import { WorklogRefusal } from '../src/worklog.ts';

/**
 * The worklog's server side (#308) against a real cache in a throwaway data
 * folder: facts recorded by a sync and upserted by key, pages kept as
 * Markdown under `cache/worklog/<toil project>/<yyyy-mm>/<yyyy-mm-dd>.md` and
 * written only when their text changes, the retention taking pages with the
 * rows, notes, agent runs and their transcripts, whether a proposal was
 * applied as toil's audit log says, and the export through toil's file
 * service. toil itself is a stub that records every call.
 */

const DAY = 86_400_000;
const T = '2026-10-12T07:00:00.000Z';
const folders: string[] = [];
const caches: Cache[] = [];

afterEach(() => {
  while (caches.length) caches.pop()!.close();
  while (folders.length) rmSync(folders.pop()!, { recursive: true, force: true, maxRetries: 3 });
});

const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: '0.1.0-alpha.4', contractVersion: 1 } }) as Envelope;
const bad = (command: string, message: string, fix: string): Envelope => ({ ok: false, data: null, error: { code: 'INVALID_INPUT', message, fix }, meta: { command, durationMs: 0, version: '0.1.0-alpha.4', contractVersion: 1 } }) as Envelope;

function item(key: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2', id: `jira:${key}`, source: { area: 'jira', connection: 'jira', key, command: 'jira issue search' }, url: `https://jira.imagile.dev/browse/${key}`, type: 'STORY', typeName: 'Story', title: `Title of ${key}`, body: null,
    status: 'In Progress', statusCategory: 'IN_PROGRESS', resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null, iteration: null,
    parent: null, children: [], links: [], created: null, updated: null, resolved: null, dueDate: null,
    history: { transitions: [{ from: 'To Do', to: 'In Progress', fromCategory: 'TODO', toCategory: 'IN_PROGRESS', at: '2026-10-11T09:14:00.000Z', by: { id: 'ada', name: 'Ada', email: null } }], iterations: [] },
    unmapped: [], native: {}, ...over,
  } as WorkItem;
}

const save = (at: string, items: WorkItem[] = [item('PAY-1'), item('PAY-2')], over: Partial<ToilProjectSave> = {}): ToilProjectSave => ({
  toilProject: 'card-payments', startedAt: at, finishedAt: at, responses: [], items, changes: [], deployments: [],
  sources: [{ area: 'jira', ok: true, error: null, fix: null, watermark: at, calls: 1 }], ...over,
});

interface Call { command: string; input: Record<string, unknown>; options: ExecuteOptions | undefined }

async function setup({ now = T, audit, exportResult, show }: { now?: string; audit?: (input: Record<string, unknown>) => Envelope; exportResult?: (input: Record<string, unknown>, options?: ExecuteOptions) => Envelope; show?: () => Envelope } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'toil-ui-worklog-'));
  folders.push(dir);
  let clock = Date.parse(now);
  const cache = await Cache.open(dir, { retentionDays: 30, now: () => new Date(clock) });
  caches.push(cache);
  const calls: Call[] = [];
  const execute: Execute = async (command, input = {}, options) => {
    calls.push({ command, input, options });
    if (command === 'audit list') return audit ? audit(input) : ok(command, []);
    if (command === 'util encode') return exportResult ? exportResult(input, options) : ok(command, { file: `${String(options?.workspace).replace(/\\/g, '/')}/${String(input.out)}` });
    if (command === 'projects show' && show) return show();
    if (command === 'projects show') return ok(command, { name: 'card-payments', toilProject: { people: [{ name: 'Ada Lovelace', ids: { jira: 'ada' } }] }, areas: { confluence: { connection: { value: 'confluence' }, inputs: { space: 'PAY' } } } });
    return bad(command, `The stub has no ${command}.`, 'Add it.');
  };
  const worklog = new WorklogService({ cache: () => cache, execute, now: () => new Date(clock) });
  return { dir, cache, worklog, calls, tick: (ms: number) => (clock += ms), at: () => new Date(clock).toISOString() };
}

const pagePath = (dir: string, day: string) => join(dir, 'cache', 'worklog', 'card-payments', day.slice(0, 7), `${day}.md`);

describe('a sync records facts', () => {
  it('upserts them by key, so syncing the same history again adds no fact', async () => {
    const { cache } = await setup();
    cache.saveToilProject(save(T));
    expect(cache.counts()).toMatchObject({ worklog_events: 2, sync_runs: 1 });
    cache.saveToilProject(save('2026-10-12T08:00:00.000Z'));
    expect(cache.counts()).toMatchObject({ worklog_events: 2, sync_runs: 2 });
    expect(cache.syncRuns('card-payments').map((s) => s.at)).toEqual([T, '2026-10-12T08:00:00.000Z']);
  });

  it('records a blocker the second sync saw, at that sync, and none on the first', async () => {
    const { cache } = await setup();
    const blocked = item('PAY-1', { links: [{ type: 'blocks', direction: 'inward', target: 'jira:PAY-2', name: 'is blocked by' }] });
    cache.saveToilProject(save(T, [blocked, item('PAY-2')]));
    expect(cache.worklogEvents('card-payments').filter((e) => e.kind === 'blocker')).toEqual([]);
    cache.saveToilProject(save('2026-10-12T08:00:00.000Z', [item('PAY-1'), item('PAY-2')]));
    cache.saveToilProject(save('2026-10-12T09:00:00.000Z', [blocked, item('PAY-2')]));
    const [b] = cache.worklogEvents('card-payments').filter((e) => e.kind === 'blocker');
    expect(b).toMatchObject({ at: '2026-10-12T09:00:00.000Z', observed: { previousSync: '2026-10-12T08:00:00.000Z' } });
  });

  it('still sees a blocker added while a sync failed, against the last good picture, naming the last good sync', async () => {
    const { cache } = await setup();
    const blocked = item('PAY-1', { links: [{ type: 'blocks', direction: 'inward', target: 'jira:PAY-2', name: 'is blocked by' }] });
    cache.saveToilProject(save(T));
    cache.saveToilProject(save('2026-10-12T08:00:00.000Z', [item('PAY-1'), item('PAY-2')], { sources: [{ area: 'jira', ok: false, error: 'toil timed out', fix: null, watermark: null, calls: 1 }] }));
    cache.saveFailure('card-payments', '2026-10-12T08:30:00.000Z', 'projects show failed');
    cache.saveToilProject(save('2026-10-12T09:00:00.000Z', [blocked, item('PAY-2')]));
    expect(cache.worklogEvents('card-payments').filter((e) => e.kind === 'blocker').map((e) => e.observed)).toEqual([{ previousSync: T }]);
  });

  it('forgets a Toil project with everything the worklog held for it', async () => {
    const { cache } = await setup();
    cache.saveToilProject(save(T));
    cache.forget('card-payments');
    expect(cache.counts()).toMatchObject({ worklog_events: 0, sync_runs: 0, agent_runs: 0, notes: 0 });
  });
});

describe('the pages', () => {
  it('are kept at <Toil project>/<yyyy-mm>/<yyyy-mm-dd>.md in the cache folder, written only when their text changes', async () => {
    const { dir, cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    expect(await worklog.reconcile('card-payments')).toEqual(['2026-10-11', '2026-10-12']);
    const file = pagePath(dir, '2026-10-11');
    const day = await worklog.day('card-payments', '2026-10-11');
    expect(readFileSync(file, 'utf8')).toBe(day.markdown);
    expect(day.markdown).toBe(markdownOf(day.page));
    expect(day.file).toBe(file.replace(/\\/g, '/'));
    expect(day.markdown).toContain('- 09:14 [PAY-1](https://jira.imagile.dev/browse/PAY-1) Title of PAY-1: To Do → In Progress, by Ada');
    // Nothing changed, so nothing is written.
    expect(await worklog.reconcile('card-payments')).toEqual([]);
  });

  it('build the same page again, and say so; a page edited on disk is put back', async () => {
    const { dir, cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    await worklog.reconcile('card-payments');
    expect((await worklog.rebuild('card-payments', '2026-10-11')).same).toBe(true);
    writeFileSync(pagePath(dir, '2026-10-11'), 'edited by hand\n');
    const again = await worklog.rebuild('card-payments', '2026-10-11');
    expect(again.same).toBe(false);
    expect(readFileSync(pagePath(dir, '2026-10-11'), 'utf8')).toBe(again.markdown);
    expect((await worklog.rebuild('card-payments', '2026-10-01')).same).toBeNull();
  });

  it('go with the rows when the retention ends, and so does the empty month folder', async () => {
    const { dir, cache, worklog, tick } = await setup();
    cache.saveToilProject(save(T));
    await worklog.reconcile('card-payments');
    expect(existsSync(pagePath(dir, '2026-10-11'))).toBe(true);
    tick(31 * DAY);
    cache.prune();
    await worklog.reconcile('card-payments');
    expect(existsSync(pagePath(dir, '2026-10-11'))).toBe(false);
    expect(existsSync(join(dir, 'cache', 'worklog', 'card-payments', '2026-10'))).toBe(false);
  });

  it("go when toil no longer has the Toil project", async () => {
    const { dir, cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    await worklog.reconcile('card-payments');
    cache.forget('card-payments');
    await worklog.reconcileAll();
    expect(existsSync(join(dir, 'cache', 'worklog', 'card-payments'))).toBe(false);
  });

  it('refuse a day that has not happened, a bad name, and a Toil project never synced', async () => {
    const { cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    await expect(worklog.day('card-payments', '2026-10-13')).rejects.toThrow("2026-10-13 hasn't happened yet");
    await expect(worklog.day('card-payments', '2026-13-01')).rejects.toThrow('Name a day as yyyy-mm-dd.');
    await expect(worklog.day('../etc', '2026-10-12')).rejects.toThrow('Name a Toil project');
    await expect(worklog.month('settlement')).rejects.toBeInstanceOf(WorklogRefusal);
  });

  it('list a month in the calendar, with each day\'s lines and coverage notes', async () => {
    const { cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    const m = await worklog.month('card-payments');
    expect(m).toMatchObject({ month: '2026-10', today: '2026-10-12', first: '2026-10-11', last: '2026-10-12', retentionDays: 30 });
    expect(m.days.map((d) => [d.day, d.lines])).toEqual([['2026-10-11', 2], ['2026-10-12', 0]]);
    expect(m.days[0]!.gaps).toBe(1);
  });
});

describe('notes', () => {
  it("go on today's page, one line each, and only with text", async () => {
    const { cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    const day = await worklog.addNote('card-payments', 'Paired on the\nretry fix', 'Ada');
    expect(day.page.notes.map((n) => [n.by, n.text])).toEqual([['Ada', 'Paired on the retry fix']]);
    expect(day.markdown).toContain('- 07:00 Ada: Paired on the retry fix');
    await expect(worklog.addNote('card-payments', '   ')).rejects.toThrow('A note needs some text.');
    await expect(worklog.addNote('card-payments', 'x'.repeat(2001))).rejects.toThrow('at most 2000 characters');
  });
});

describe('agent runs', () => {
  const run = (over: Partial<AgentRun> = {}): AgentRun => ({
    id: 'run-1', kind: 'ask', toilProject: 'card-payments', startedAt: T, finishedAt: '2026-10-12T07:01:00.000Z', outcome: 'finished', by: 'Codex', prompt: 'What happened yesterday?', answer: 'It moved: [[jira:PAY-1]].', error: null,
    citations: ['jira:PAY-1'], unverified: [], proposals: [{ id: 'p1', title: 'Move PAY-1 to Done', item: 'jira:PAY-1', command: 'jira issue transition', input: { key: 'PAY-1', intent: 'done' } }], ...over,
  });

  it('are kept with a transcript, on the day they started', async () => {
    const { dir, cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    await worklog.recordRun(run({ finishedAt: null, outcome: 'running' }));
    await worklog.recordRun(run());
    // The page is folded in turn, after the run is kept; the next read waits for it.
    await worklog.day('card-payments', '2026-10-12');
    expect(cache.runs('card-payments')).toHaveLength(1);
    const transcript = readFileSync(join(dir, 'cache', 'worklog', 'card-payments', 'runs', 'run-1.md'), 'utf8');
    expect(transcript).toContain('It moved: [[jira:PAY-1]].');
    expect(readFileSync(pagePath(dir, '2026-10-12'), 'utf8')).toContain('Asked Codex: "What happened yesterday?", finished, citing 1 item ([transcript](../runs/run-1.md))');
  });

  it('still load and read an old run that a usage cap stopped, before caps were removed', async () => {
    const { dir, cache, worklog } = await setup();
    cache.saveToilProject(save(T));
    await worklog.recordRun(run({ outcome: 'capped', answer: 'Half an answer.' }));
    await worklog.day('card-payments', '2026-10-12');
    expect(cache.runs('card-payments')).toMatchObject([{ id: 'run-1', outcome: 'capped' }]);
    expect(readFileSync(pagePath(dir, '2026-10-12'), 'utf8')).toContain('"What happened yesterday?", stopped at a usage cap, before caps were removed');
    expect(readFileSync(join(dir, 'cache', 'worklog', 'card-payments', 'runs', 'run-1.md'), 'utf8')).toContain('stopped at a usage cap, before caps were removed');
  });

  it("say a proposal was applied only when toil's audit log has the same write on the same item, after the run", async () => {
    const entry = (over: Record<string, unknown>) => ({ time: '2026-10-12T07:30:00.000Z', via: 'cli', command: 'jira issue transition', writes: true, outcome: 'ok', input: { key: 'PAY-1', intent: 'done', allowWrite: true }, ...over });
    const cases: Array<[unknown[], string]> = [
      [[entry({})], "applied: toil's audit log has the write at 12 Oct 2026 07:30 UTC (cli)"],
      [[entry({ input: { key: 'PAY-2' } })], 'not applied'],
      [[entry({ time: '2026-10-12T06:59:00.000Z' })], 'not applied'],
      [[entry({ outcome: 'WRITE_DISABLED' })], 'not applied'],
      [[entry({ input: null })], "couldn't check toil's audit log: toil's audit log has a jira issue transition write after it whose input was too large to record."],
    ];
    for (const [entries, text] of cases) {
      const { cache, worklog, calls } = await setup({ audit: () => ok('audit list', entries) });
      cache.saveToilProject(save(T));
      await worklog.recordRun(run());
      const md = (await worklog.day('card-payments', '2026-10-12')).markdown;
      expect(md).toContain(`Move PAY-1 to Done (\`toil jira issue transition\`), ${text}`);
      expect(calls.find((c) => c.command === 'audit list')).toMatchObject({ input: { since: '2026-10-12T07:01:00.000Z', writesOnly: true, limit: 1000 }, options: { readOnly: true, caller: 'toil-ui' } });
    }
  });

  it('match a create, which has no id to act on, by every field the proposal named', async () => {
    const create = run({ proposals: [{ id: 'p2', title: 'Split PAY-1', item: 'jira:PAY-1', command: 'jira issue create', input: { project: 'PAY', summary: 'Split part 2', type: 'Story' } }] });
    const entry = (input: unknown) => ({ time: '2026-10-12T07:30:00.000Z', via: 'cli', command: 'jira issue create', writes: true, outcome: 'ok', input });
    for (const [input, text] of [[{ project: 'PAY', summary: 'Something else', type: 'Story' }, 'not applied'], [{ project: 'PAY', summary: 'Split part 2', type: 'Story', allowWrite: true }, 'applied: ']] as const) {
      const { cache, worklog } = await setup({ audit: () => ok('audit list', [entry(input)]) });
      cache.saveToilProject(save(T));
      await worklog.recordRun(create);
      expect((await worklog.day('card-payments', '2026-10-12')).markdown).toContain(`Split PAY-1 (\`toil jira issue create\`), ${text}`);
    }
  });

  it('say they can\'t tell when the audit line keeps only a hash of a field the proposal named', async () => {
    const create = run({ proposals: [{ id: 'p3', title: 'Split PAY-1', item: 'jira:PAY-1', command: 'jira issue create', input: { project: 'PAY', summary: 'Split part 2' } }] });
    const { cache, worklog } = await setup({ audit: () => ok('audit list', [{ time: '2026-10-12T07:30:00.000Z', via: 'cli', command: 'jira issue create', writes: true, outcome: 'ok', input: { project: 'PAY', summary: 'sha256:abc12345' } }]) });
    cache.saveToilProject(save(T));
    await worklog.recordRun(create);
    expect((await worklog.day('card-payments', '2026-10-12')).markdown).toContain("couldn't check toil's audit log: toil's audit log has a jira issue create write after it, but keeps only a hash of its summary.");
  });

  it('match an id the proposal gives as text against the number the CLI typed', async () => {
    const comment = run({ proposals: [{ id: 'p4', title: 'Comment on #7', item: 'github:imagile/payments-web#7', command: 'github pr comment', input: { number: '7', body: 'Looks done.' } }] });
    const { cache, worklog } = await setup({ audit: () => ok('audit list', [{ time: '2026-10-12T07:30:00.000Z', via: 'cli', command: 'github pr comment', writes: true, outcome: 'ok', input: { number: 7, body: 'Looks done.', allowWrite: true } }]) });
    cache.saveToilProject(save(T));
    await worklog.recordRun(comment);
    expect((await worklog.day('card-payments', '2026-10-12')).markdown).toContain("Comment on #7 (`toil github pr comment`), applied: toil's audit log has the write at 12 Oct 2026 07:30 UTC (cli)");
  });

  it('read the audit log at most once a minute, since every read is a line in it', async () => {
    const { cache, worklog, calls, tick } = await setup();
    cache.saveToilProject(save(T));
    await worklog.recordRun(run());
    await worklog.day('card-payments', '2026-10-12');
    await worklog.day('card-payments', '2026-10-12');
    expect(calls.filter((c) => c.command === 'audit list')).toHaveLength(1);
    tick(61_000);
    await worklog.day('card-payments', '2026-10-12');
    expect(calls.filter((c) => c.command === 'audit list')).toHaveLength(2);
  });

  it('say they can\'t tell when the audit log has more writes than one read returns', async () => {
    const capped: Envelope = { ...ok('audit list', []), meta: { ...ok('audit list', []).meta, warnings: [{ code: 'AUDIT_LIMIT', message: 'Showing the newest 1000.' }] } } as Envelope;
    const { cache, worklog } = await setup({ audit: () => capped });
    cache.saveToilProject(save(T));
    await worklog.recordRun(run());
    expect((await worklog.day('card-payments', '2026-10-12')).markdown).toContain("couldn't check toil's audit log: toil's audit log has more writes since the run than one read returns (1,000).");
  });

  it('are not brought back into a cache wiped after they started', async () => {
    const { cache, worklog, tick } = await setup();
    tick(60_000);
    cache.wipe();
    await worklog.recordRun(run());
    expect(cache.runs('card-payments')).toEqual([]);
  });

  it("say so when toil's audit log can't be read", async () => {
    const { cache, worklog } = await setup({ audit: () => bad('audit list', 'toil has no command "audit list".', 'Upgrade toil.') });
    cache.saveToilProject(save(T));
    await worklog.recordRun(run());
    expect((await worklog.day('card-payments', '2026-10-12')).markdown).toContain("couldn't check toil's audit log: toil has no command \"audit list\". Upgrade toil.");
  });
});

describe('export', () => {
  it("writes the day's Markdown through toil's file service in the folder named, then proposes where to publish it", async () => {
    const { cache, worklog, calls } = await setup();
    cache.saveToilProject(save(T));
    const folder = join(tmpdir(), 'exports');
    const out = await worklog.exportTo('card-payments', { day: '2026-10-11' }, folder);
    const call = calls.find((c) => c.command === 'util encode')!;
    expect(call.input).toMatchObject({ scheme: 'base64', decode: true, out: 'worklog-card-payments-2026-10-11.md' });
    expect(Buffer.from(String(call.input.text), 'base64').toString('utf8')).toBe((await worklog.day('card-payments', '2026-10-11')).markdown);
    expect(call.options).toMatchObject({ readOnly: false, caller: 'toil-ui', workspace: folder });
    expect(out.path).toBe(`${folder.replace(/\\/g, '/')}/worklog-card-payments-2026-10-11.md`);
    expect(out.proposals.map((p) => [p.command, p.input?.space, p.input?.bodyFile])).toEqual([['confluence page create', 'PAY', out.path]]);
  });

  it("writes a month's pages as one file", async () => {
    const { cache, worklog, calls } = await setup();
    cache.saveToilProject(save(T));
    await worklog.exportTo('card-payments', { month: '2026-10' }, join(tmpdir(), 'exports'));
    const md = Buffer.from(String(calls.find((c) => c.command === 'util encode')!.input.text), 'base64').toString('utf8');
    expect(md.split('\n').filter((l) => l.startsWith('## Worklog'))).toEqual(['## Worklog: card-payments, Sunday 11 October 2026', '## Worklog: card-payments, Monday 12 October 2026']);
    await expect(worklog.exportTo('card-payments', { month: '2026-09' }, join(tmpdir(), 'exports'))).rejects.toThrow('2026-09 has no worklog pages to export.');
  });

  it("refuses a relative folder before toil runs, and passes toil's refusal on as it is", async () => {
    const { cache, worklog, calls } = await setup({ exportResult: () => bad('util encode', 'C:/out/worklog.md already exists.', 'Choose a new file name.') });
    cache.saveToilProject(save(T));
    await expect(worklog.exportTo('card-payments', { day: '2026-10-11' }, 'exports')).rejects.toThrow('Name the folder to export into, as a full path.');
    expect(calls.some((c) => c.command === 'util encode')).toBe(false);
    const refused = await worklog.exportTo('card-payments', { day: '2026-10-11' }, join(tmpdir(), 'x')).catch((e: unknown) => e as WorklogRefusal);
    expect(refused).toMatchObject({ message: "toil couldn't write the export: C:/out/worklog.md already exists.", fix: 'Choose a new file name.' });
  });
});

describe('the stand-up (#345)', () => {
  it("folds a range of the cache's days with the Toil project's people, the same twice, and keeps no file", async () => {
    const { worklog, cache, calls, dir } = await setup();
    cache.saveToilProject(save(T));
    const a = await worklog.standup('card-payments', '2026-10-09', '2026-10-12');
    const b = await worklog.standup('card-payments', '2026-10-09', '2026-10-12');
    expect(b).toEqual(a);
    expect(a.report.asOf).toBe(T);
    const ada = a.report.people.find((p) => p.name === 'Ada Lovelace')!;
    expect(ada.mapped).toBe(true);
    expect(ada.lines.progress.map((l) => `${l.label}: ${l.text}`)).toEqual(['PAY-1: To Do → In Progress', 'PAY-2: To Do → In Progress']);
    expect(a.markdown.split('\n')[0]).toBe('# Stand-up: card-payments, 9 Oct 2026 to 12 Oct 2026');
    expect(a.report.gaps[0]).toMatch(/^9 Oct 2026, 10 Oct 2026, 11 Oct 2026: The earliest sync the cache holds is 12 Oct 2026 07:00 UTC, after this day/);
    const show = calls.filter((c) => c.command === 'projects show');
    expect(show.map((c) => [c.input, c.options?.readOnly])).toEqual([[{ toilProject: 'card-payments' }, true], [{ toilProject: 'card-payments' }, true]]);
    expect(existsSync(join(dir, 'cache', 'worklog', 'card-payments', 'standup'))).toBe(false);
  });

  it("says so when toil can't read the Toil project's people, and still folds every account on its own", async () => {
    const { worklog, cache } = await setup({ show: () => bad('projects show', 'The Toil project file is not valid JSON.', 'Fix the file.') });
    cache.saveToilProject(save(T));
    const r = await worklog.standup('card-payments', '2026-10-11', '2026-10-12');
    expect(r.report.gaps[0]).toBe("toil projects show card-payments failed (The Toil project file is not valid JSON.), so each account is its own person here: the Toil project's people couldn't be read.");
    expect(r.report.people.map((p) => [p.key, p.mapped])).toEqual([['id:jira:ada', false]]);
  });

  it('refuses a range it cannot cover, and a Toil project never synced', async () => {
    const { worklog, cache } = await setup();
    cache.saveToilProject(save(T));
    await expect(worklog.standup('card-payments', '2026-10-12', '2026-10-13')).rejects.toThrow("2026-10-13 hasn't happened yet: end the range today (2026-10-12) or earlier.");
    await expect(worklog.standup('card-payments', '2026-08-01', '2026-10-12')).rejects.toBeInstanceOf(WorklogRefusal);
    await expect(worklog.standup('elsewhere', '2026-10-12', '2026-10-12')).rejects.toThrow("Toil UI hasn't synced elsewhere, so it has no worklog yet.");
  });

  it("exports the stand-up's Markdown through toil's file service, and proposes publishing it", async () => {
    const { worklog, cache, calls } = await setup();
    cache.saveToilProject(save(T));
    const out = await worklog.exportTo('card-payments', { from: '2026-10-11', to: '2026-10-12' }, '/home/you/out');
    const encode = calls.find((c) => c.command === 'util encode')!;
    expect(encode.input.out).toBe('standup-card-payments-2026-10-11-to-2026-10-12.md');
    expect(Buffer.from(String(encode.input.text), 'base64').toString('utf8')).toBe((await worklog.standup('card-payments', '2026-10-11', '2026-10-12')).markdown);
    expect(encode.options).toMatchObject({ readOnly: false, workspace: '/home/you/out' });
    expect(out.proposals.map((p) => p.title)).toEqual(['Publish the stand-up as a Confluence page in PAY']);
  });
});

describe('the facts a sync recorded for the first time (#419)', () => {
  it('are none on the first sync, and only the new ones after it', async () => {
    const { cache } = await setup();
    const done = { from: 'In Progress', to: 'Done', fromCategory: 'IN_PROGRESS' as const, toCategory: 'DONE' as const, at: '2026-10-12T08:30:00.000Z', by: null };
    expect(cache.saveToilProject(save(T))).toEqual([]);
    expect(cache.saveToilProject(save('2026-10-12T08:00:00.000Z'))).toEqual([]);
    const [first] = item('PAY-1').history!.transitions;
    const news = cache.saveToilProject(save('2026-10-12T09:00:00.000Z', [item('PAY-1', { statusCategory: 'DONE', history: { transitions: [first!, done], iterations: [] } }), item('PAY-2')]));
    expect(news.map((e) => [e.kind, e.subject, e.toCategory])).toEqual([['status', 'jira:PAY-1', 'DONE']]);
    // The same fact again is not news.
    expect(cache.saveToilProject(save('2026-10-12T10:00:00.000Z', [item('PAY-1', { statusCategory: 'DONE', history: { transitions: [first!, done], iterations: [] } }), item('PAY-2')]))).toEqual([]);
  });

  it("isn't news when it happened before the last good sync, though a source only now lists it", async () => {
    const { cache } = await setup();
    cache.saveToilProject(save(T));
    const old = { from: 'In Progress', to: 'Done', fromCategory: 'IN_PROGRESS' as const, toCategory: 'DONE' as const, at: '2026-10-01T08:30:00.000Z', by: null };
    expect(cache.saveToilProject(save('2026-10-12T09:00:00.000Z', [item('PAY-1', { history: { transitions: [old], iterations: [] } }), item('PAY-2')]))).toEqual([]);
  });
});
