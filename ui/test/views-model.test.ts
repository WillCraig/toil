import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { columns, proposeMove, statusFor } from '../src/model/board.ts';
import { burnup } from '../src/model/burnup.ts';
import { age, aging, cycleTime, cycleTimes, doneAt, percentile, throughput, weekStart } from '../src/model/flow.ts';
import { dependencyGraph } from '../src/model/graph.ts';
import { groupInsights, insights, needsAttention, prepare, type Context } from '../src/model/insights.ts';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { commandLine, defaultShell, quote, readLine, unsafe } from '../src/proposal.ts';
import type { ChangeRef, Deployment, StatusCategory, Transition, WorkItem } from '../src/toil.ts';
import { healthOf } from './harness.ts';

/**
 * The models behind the board, the flow panels, the dependency graph and the
 * insights (#252, #253): on each dossier as the dashboard loads it, and on
 * small items made here for the edges the fixture doesn't reach.
 */

const t = (fromCategory: StatusCategory | null, toCategory: StatusCategory, at: string): Transition => ({ from: fromCategory, to: toCategory, fromCategory, toCategory, at, by: null });

function item(over: Partial<WorkItem> & { id: string }): WorkItem {
  return {
    owi: '0.2', source: { area: 'jira', connection: 'corp-jira', key: over.id.split(':')[1]!, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story',
    title: over.id, body: null, status: null, statusCategory: 'TODO', resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null,
    iteration: null, parent: null, children: [], links: [], created: null, updated: null, resolved: null, dueDate: null, history: { transitions: [], iterations: [] }, unmapped: [], native: {},
    ...over,
  };
}
const NOW = '2026-10-13T08:00:00.000Z';
const ctx = (items: WorkItem[], more: Partial<Context> = {}): Context => ({ items, changes: [], deployments: [], health: null, now: NOW, ...more });

describe('cycle time', () => {
  it('runs from the first move into In progress to the last move into Done', () => {
    const i = item({ id: 'c:A-1', statusCategory: 'DONE', history: { iterations: [], transitions: [t('TODO', 'IN_PROGRESS', '2026-10-01T00:00:00Z'), t('IN_PROGRESS', 'TODO', '2026-10-02T00:00:00Z'), t('TODO', 'IN_PROGRESS', '2026-10-03T00:00:00Z'), t('IN_PROGRESS', 'DONE', '2026-10-05T12:00:00Z')] } });
    expect(cycleTime(i)).toEqual({ id: 'c:A-1', start: '2026-10-01T00:00:00Z', end: '2026-10-05T12:00:00Z', days: 4.5 });
  });

  it('is unknown, with the reason, when the history cannot show it, and not applicable to open work', () => {
    expect(cycleTime(item({ id: 'c:A-2', statusCategory: 'DONE', history: null }))).toMatchObject({ days: null, reason: 'No history synced' });
    expect(cycleTime(item({ id: 'c:A-3', statusCategory: 'DONE' }))).toMatchObject({ days: null, reason: 'No move into Done recorded' });
    expect(cycleTime(item({ id: 'c:A-4', statusCategory: 'DONE', history: { iterations: [], transitions: [t('TODO', 'DONE', '2026-10-05T00:00:00Z')] } }))).toMatchObject({ days: null, reason: 'Never recorded as In progress before Done' });
    expect(cycleTime(item({ id: 'c:A-5', statusCategory: 'IN_PROGRESS' }))).toBeNull();
  });

  it("on the fixture: Jira's and Azure DevOps' histories time their items; GitHub's open and closed events can't", async () => {
    const card = cycleTimes((await healthOf('card-payments')).data.items);
    expect(card.known.map((c) => [c.id, Math.round(c.days * 100) / 100])).toEqual([
      ['corp-jira:PAY-92', 8.17], ['corp-jira:PAY-95', 3.04], ['corp-jira:PAY-97', 7.29], ['corp-jira:PAY-98', 11.04], ['corp-jira:PAY-106', 1.1], ['corp-jira:PAY-105', 3.19],
    ]);
    const settle = cycleTimes((await healthOf('settlement')).data.items);
    expect(settle.unknown).toEqual([{ id: 'corp-ado:2307', reason: 'Never recorded as In progress before Done' }]);
    const web = cycleTimes((await healthOf('checkout-web')).data.items);
    expect(web.known).toEqual([]);
    expect(web.unknown.map((u) => u.id)).toEqual(['github:imagile/payments-web#36', 'github:imagile/payments-web#38', 'github:imagile/payments-web#44']);
  });

  it('takes the nearest-rank percentile', () => {
    expect(percentile([], 85)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 85)).toBe(9);
    expect(percentile([5], 85)).toBe(5);
  });
});

describe('aging work in progress', () => {
  it('counts from the start of the current spell in progress', () => {
    const i = item({ id: 'c:B-1', statusCategory: 'IN_PROGRESS', history: { iterations: [], transitions: [t('TODO', 'IN_PROGRESS', '2026-10-01T08:00:00Z'), t('IN_PROGRESS', 'TODO', '2026-10-02T08:00:00Z'), t('TODO', 'IN_PROGRESS', '2026-10-10T08:00:00Z'), t('IN_PROGRESS', 'IN_PROGRESS', '2026-10-11T08:00:00Z')] } });
    expect(age(i, NOW)).toEqual({ id: 'c:B-1', since: '2026-10-10T08:00:00Z', days: 3 });
  });

  it('is unknown without a recorded start, and leaves out containers', () => {
    const list = aging([item({ id: 'c:B-2', statusCategory: 'IN_PROGRESS' }), item({ id: 'c:B-3', statusCategory: 'IN_PROGRESS', type: 'EPIC' }), item({ id: 'c:B-4', statusCategory: 'IN_PROGRESS', history: null })], NOW);
    expect(list).toEqual({ known: [], unknown: [{ id: 'c:B-2', reason: 'No move into In progress recorded' }, { id: 'c:B-4', reason: 'No history synced' }] });
  });

  it('on the fixture, oldest first, with GitHub In Review unknown', async () => {
    const days = async (name: string) => aging((await healthOf(name)).data.items, FIXTURE_NOW);
    expect((await days('card-payments')).known.map((a) => [a.id, Math.round(a.days * 10) / 10])).toEqual([['corp-jira:PAY-104', 13.9], ['corp-jira:PAY-101', 6.9]]);
    expect((await days('settlement')).known.map((a) => a.id)).toEqual(['corp-ado:2304', 'corp-ado:2302']);
    expect(await days('checkout-web')).toEqual({ known: [], unknown: [{ id: 'github:imagile/payments-web#42', reason: 'No move into In progress recorded' }] });
  });
});

describe('throughput', () => {
  it('weeks start on Monday, UTC', () => {
    expect(weekStart('2026-10-13T08:00:00.000Z')).toBe('2026-10-12T00:00:00.000Z');
    expect(weekStart('2026-10-18T23:59:00.000Z')).toBe('2026-10-12T00:00:00.000Z');
    expect(weekStart('2026-10-12T00:00:00.000Z')).toBe('2026-10-12T00:00:00.000Z');
  });

  it('counts each item in the week of its last move into Done, the last week marked as running', async () => {
    const { data } = await healthOf('card-payments');
    const tp = throughput(data.items, FIXTURE_NOW);
    expect(tp.weeks.map((w) => [w.start.slice(0, 10), w.items.length, w.partial])).toEqual([
      ['2026-09-07', 0, false], ['2026-09-14', 1, false], ['2026-09-21', 1, false], ['2026-09-28', 2, false], ['2026-10-05', 2, false], ['2026-10-12', 0, true],
    ]);
    expect(tp.weeks[4]!.items).toEqual(['corp-jira:PAY-105', 'corp-jira:PAY-106']);
    expect(tp.unknown).toEqual([]);
  });

  it('lists a done item with no recorded finish as unknown, and counts ones before the window', () => {
    const items = [item({ id: 'c:T-1', statusCategory: 'DONE' }), item({ id: 'c:T-2', statusCategory: 'DONE', history: { iterations: [], transitions: [t('IN_PROGRESS', 'DONE', '2026-01-05T00:00:00Z')] } })];
    expect(throughput(items, NOW, 2)).toMatchObject({ unknown: [{ id: 'c:T-1', reason: 'No move into Done recorded' }], earlier: 1 });
  });

  it('reads Done from the last move into it, after a reopen', () => {
    const i = item({ id: 'c:T-3', statusCategory: 'DONE', history: { iterations: [], transitions: [t('IN_PROGRESS', 'DONE', '2026-10-01T00:00:00Z'), t('DONE', 'IN_PROGRESS', '2026-10-02T00:00:00Z'), t('IN_PROGRESS', 'DONE', '2026-10-06T00:00:00Z')] } });
    expect(doneAt(i)).toBe('2026-10-06T00:00:00Z');
  });
});

describe('the burn-up', () => {
  it("grows its scope when work is added, and its done line when work finishes, day by day to now", async () => {
    const { h } = await healthOf('settlement');
    const b = burnup(h, FIXTURE_NOW);
    expect(b.days.map((d) => [d.at.slice(0, 10), d.scope, d.done])).toEqual([
      ['2026-10-05', 11, 0], ['2026-10-06', 11, 0], ['2026-10-07', 11, 1], ['2026-10-08', 11, 1], ['2026-10-09', 16, 1], ['2026-10-10', 16, 1], ['2026-10-11', 16, 1], ['2026-10-12', 16, 1], ['2026-10-13', 16, 1],
    ]);
    expect(b.days.at(-1)!.at).toBe(FIXTURE_NOW);
    expect(b.ahead).toBe(3);
    expect(b.unplaced).toEqual([]);
  });

  it('agrees with the sprint figures at the end of its line', async () => {
    for (const name of ['card-payments', 'settlement', 'checkout-web']) {
      const { h } = await healthOf(name);
      const last = burnup(h, FIXTURE_NOW).days.at(-1)!;
      expect(last.done, name).toBe(h.done.points);
      expect(last.scope, name).toBe(h.done.points + h.remaining.points);
    }
  });
});

describe('the dependency graph', () => {
  it('keeps one edge per linked pair, each pointing the way the link reads, and ranks blocking chains', async () => {
    const g = dependencyGraph((await healthOf('card-payments')).data.items);
    expect(g.edges.map((e) => `${e.source} ${e.type} ${e.target} (${e.name})`)).toEqual([
      'corp-jira:PAY-101 blocks corp-jira:PAY-102 (blocks)',
      'corp-jira:PAY-102 blocks corp-jira:PAY-103 (blocks)',
      'corp-jira:PAY-103 relates corp-jira:PAY-107 (relates to)',
    ]);
    expect(g.nodes.map((n) => [n.id, n.rank, n.row, n.blocked, n.blocking])).toEqual([
      ['corp-jira:PAY-101', 0, 0, false, true],
      ['corp-jira:PAY-102', 1, 0, true, true],
      ['corp-jira:PAY-103', 2, 0, true, false],
      ['corp-jira:PAY-107', 0, 1, false, false],
    ]);
    expect(g.cycle).toBe(false);
  });

  it("names Azure DevOps' own wording, and draws nothing for a dossier without links", async () => {
    expect(dependencyGraph((await healthOf('settlement')).data.items).edges).toEqual([{ id: 'blocks:corp-ado:2302->corp-ado:2303', type: 'blocks', source: 'corp-ado:2302', target: 'corp-ado:2303', name: 'Successor' }]);
    expect(dependencyGraph((await healthOf('checkout-web')).data.items)).toEqual({ nodes: [], edges: [], cycle: false });
  });

  it('keeps a link to an item outside the dossier, marked unknown, and stops on a cycle', () => {
    const a = item({ id: 'c:G-1', links: [{ type: 'blocks', direction: 'outward', target: 'c:G-2', name: 'blocks' }, { type: 'blocks', direction: 'outward', target: 'other:X-9', name: 'blocks' }] });
    const b = item({ id: 'c:G-2', links: [{ type: 'blocks', direction: 'outward', target: 'c:G-1', name: 'blocks' }] });
    const g = dependencyGraph([a, b]);
    expect(g.nodes.find((n) => n.id === 'other:X-9')).toMatchObject({ known: false });
    expect(g.cycle).toBe(true);
  });

  it("doesn't flag a finished item as blocked, even when what it depends on isn't done (#319)", () => {
    const a = item({ id: 'c:G-1', links: [{ type: 'blocks', direction: 'outward', target: 'c:G-2', name: 'blocks' }] });
    const b = item({ id: 'c:G-2', statusCategory: 'DONE', links: [{ type: 'blocks', direction: 'inward', target: 'c:G-1', name: 'is blocked by' }] });
    const c = item({ id: 'c:G-3', links: [{ type: 'blocks', direction: 'inward', target: 'c:G-1', name: 'is blocked by' }] });
    a.links.push({ type: 'blocks', direction: 'outward', target: 'c:G-3', name: 'blocks' });
    const g = dependencyGraph([a, b, c]);
    expect(g.nodes.find((n) => n.id === 'c:G-2')).toMatchObject({ done: true, blocked: false });
    expect(g.nodes.find((n) => n.id === 'c:G-3')).toMatchObject({ blocked: true });
  });
});

describe('the board', () => {
  it('has a column per status category, across trackers, and leaves containers off', async () => {
    const { h } = await healthOf('checkout-web');
    expect(columns(h.items).map((c) => [c.category, c.items.map((i) => i.source.key)])).toEqual([
      ['TODO', ['imagile/payments-web#43', 'imagile/payments-web#45']],
      ['IN_PROGRESS', ['imagile/payments-web#42']],
      ['DONE', ['imagile/payments-web#44']],
    ]);
    expect(columns([item({ id: 'c:U-1', statusCategory: 'UNKNOWN' })]).map((c) => c.category)).toEqual(['TODO', 'IN_PROGRESS', 'DONE', 'UNKNOWN']);
  });

  it("proposes the tracker's own write command, with the status word its items use, and never one for no move", async () => {
    const { data, byId } = await healthOf('card-payments');
    const pay102 = byId.get('corp-jira:PAY-102')!;
    expect(proposeMove(pay102, 'TODO', data.items, 'card-payments')).toBeNull();
    const p = proposeMove(pay102, 'IN_PROGRESS', data.items, 'card-payments')!;
    expect(p).toMatchObject({ from: 'board', item: 'corp-jira:PAY-102', title: 'Move PAY-102 to In progress', command: 'jira issue transition', input: { dossier: 'card-payments', key: 'PAY-102', transition: 'In Progress' } });
    expect(commandLine(p, 'posix').line).toBe("toil jira issue transition 'PAY-102' --dossier 'card-payments' --transition 'In Progress' --allow-write");
    expect(commandLine(p, 'powershell').line).toBe("toil jira issue transition 'PAY-102' --dossier 'card-payments' --transition 'In Progress' --allow-write");
    const settle = await healthOf('settlement');
    expect(commandLine(proposeMove(settle.byId.get('corp-ado:2303')!, 'IN_PROGRESS', settle.data.items, 'settlement')!, 'posix').line).toBe("toil ado work-item transition '2303' --dossier 'settlement' --state 'Active' --allow-write");
  });

  it("says where toil has no command, rather than inventing one", async () => {
    const { data, byId } = await healthOf('checkout-web');
    const p = proposeMove(byId.get('github:imagile/payments-web#43')!, 'DONE', data.items, 'checkout-web')!;
    expect(p.command).toBeNull();
    expect(commandLine(p, 'posix')).toEqual({ line: null, reason: 'toil has no command for this change.' });
    expect(p.note).toMatch(/no command that sets a GitHub Projects status/);
    const lone = item({ id: 'c:L-1' });
    expect(statusFor(lone, 'DONE', [lone])).toBeNull();
    const p2 = proposeMove(lone, 'DONE', [lone], 'd')!;
    expect(p2.note).toBe('No Done item in this dossier shows which status to use.');
    expect(readLine(p2.hint!, 'posix').line).toBe("toil jira issue transitions 'L-1' --dossier 'd'");
  });

  it("proposes a Jira Cloud item's move with the jira commands, which route to its connection's deployment", () => {
    const todo = item({ id: 'cloud-jira:PAY-1', source: { area: 'jira', connection: 'cloud-jira', key: 'PAY-1', command: 'jira issue search', deployment: 'cloud' }, statusCategory: 'TODO', status: 'To Do' });
    const wip = item({ id: 'cloud-jira:PAY-2', source: { area: 'jira', connection: 'cloud-jira', key: 'PAY-2', command: 'jira issue search', deployment: 'cloud' }, statusCategory: 'IN_PROGRESS', status: 'In Progress' });
    const p = proposeMove(todo, 'IN_PROGRESS', [todo, wip], 'd')!;
    expect(p).toMatchObject({ command: 'jira issue transition', input: { dossier: 'd', key: 'PAY-1', transition: 'In Progress' }, hint: { command: 'jira issue transitions', input: { dossier: 'd', key: 'PAY-1' } } });
    expect(proposeMove(todo, 'DONE', [todo], 'd')!.hint).toMatchObject({ command: 'jira issue transitions' });
  });

  it('builds its hints through the same quoting, so a hostile type name stays one inert argument', () => {
    const odd = item({ id: 'corp-ado:9', source: { area: 'ado', connection: 'corp-ado', key: '9', command: 'ado work-item get-many' }, typeName: "$(rm -rf ~) `id` it's" });
    const p = proposeMove(odd, 'DONE', [odd], 'settlement')!;
    expect(p.hint).toEqual({ text: 'List the states the work item type has:', command: 'ado work-item states', input: { dossier: 'settlement', type: "$(rm -rf ~) `id` it's" } });
    expect(readLine(p.hint!, 'posix').line).toBe("toil ado work-item states --dossier 'settlement' --type '$(rm -rf ~) `id` it'\\''s'");
    expect(readLine(p.hint!, 'powershell').line).toBe("toil ado work-item states --dossier 'settlement' --type '$(rm -rf ~) `id` it''s'");

    const cloud = item({ id: 'ado-board:9', source: { area: 'ado', connection: 'ado-board', key: '9', command: 'ado work-item get-many', deployment: 'cloud' }, typeName: 'Bug' });
    expect(readLine(proposeMove(cloud, 'DONE', [cloud], 'ado-board')!.hint!, 'posix').line).toBe("toil ado work-item states --dossier 'ado-board' --type 'Bug'");
  });
});

describe('insights', () => {
  it('ranks what needs attention on the fixture, each insight with its source', async () => {
    const { data, h } = await healthOf('card-payments');
    const ranked = needsAttention(prepare({ items: data.items, changes: data.changes, deployments: data.deployments, health: h, now: FIXTURE_NOW }));
    expect(ranked.map((a) => [a.id, a.score, a.insights.map((i) => i.code)])).toEqual([
      ['corp-jira:PAY-102', 7, ['blocked', 'blocking', 'stale']],
      ['corp-jira:PAY-104', 7, ['aging', 'carried', 'stale']],
      ['corp-jira:PAY-101', 5, ['failing-build', 'blocking']],
      ['corp-jira:PAY-103', 5, ['blocked', 'stale']],
      ['corp-jira:PAY-107', 2, ['unestimated', 'added']],
    ]);
    const pay104 = ranked[1]!.insights[0]!;
    expect(pay104.text).toBe("In progress for 13.9 days, longer than 85% of this dossier's finished items took (11 days)");
    expect(pay104.evidence).toBe('history.transitions, against 6 cycle times');
    expect(ranked.flatMap((a) => a.insights).every((i) => i.evidence.length > 0)).toBe(true);
  });

  it("raises nothing on done work, and no aging without three cycle times to compare against", async () => {
    const { data, h, byId } = await healthOf('checkout-web');
    const p = prepare({ items: data.items, changes: data.changes, deployments: data.deployments, health: h, now: FIXTURE_NOW });
    expect(p.p85).toBeNull();
    expect(insights(byId.get('github:imagile/payments-web#44')!, p)).toEqual([]);
    expect(needsAttention(p).flatMap((a) => a.insights).some((i) => i.code === 'aging')).toBe(false);
  });

  it('flags an open PR with no build, a merged one not deployed, and work deployed but still open', () => {
    const a = item({ id: 'c:I-1', statusCategory: 'IN_PROGRESS', status: 'In Review' });
    const b = item({ id: 'c:I-2', statusCategory: 'IN_PROGRESS', status: 'In Progress' });
    const pr = (id: string, items: string[], outcome: ChangeRef['outcome']): ChangeRef => ({ id, kind: 'pull-request', source: 'bitbucket', command: 'bitbucket pr list', items, title: `#${id}`, url: null, state: outcome, outcome, builds: null, mergeCommit: null, at: NOW });
    const dep: Deployment = { id: 'd1', environment: 'dev', source: 'openshift', command: 'openshift deployment list', name: 'app', commit: 'abc1234', version: null, state: 'Available', outcome: 'passed', url: null, includes: ['m2'], items: ['c:I-2'], unknownCommit: false };
    const p = prepare(ctx([a, b], { changes: [pr('o1', ['c:I-1'], 'open'), pr('m1', ['c:I-1'], 'merged'), pr('m2', ['c:I-2'], 'merged')], deployments: [dep] }));
    expect(insights(a, p).map((i) => i.code)).toEqual(['pr-no-build', 'built-not-deployed', 'unestimated']);
    expect(insights(b, p).map((i) => [i.code, i.text])).toEqual([['deployed-not-closed', 'Running in dev, but still In Progress'], ['unestimated', 'No estimate']]);
  });

  it('groups an item blocking two open items, or blocked by two, into one entry per code (#541)', () => {
    const link = (direction: 'inward' | 'outward', target: string) => ({ type: 'blocks' as const, direction, target, name: 'blocks' });
    const a = item({ id: 'c:G-1', links: [link('outward', 'c:G-2'), link('outward', 'c:G-3'), link('inward', 'c:G-4'), link('inward', 'c:G-5')] });
    const others = ['c:G-2', 'c:G-3', 'c:G-4', 'c:G-5'].map((id) => item({ id }));
    const all = insights(a, prepare(ctx([a, ...others])));
    expect(all.map((i) => i.code)).toEqual(['blocked', 'blocked', 'blocking', 'blocking', 'unestimated']);
    const groups = groupInsights(all);
    expect(groups.map((g) => [g.code, g.insights.length])).toEqual([['blocked', 2], ['blocking', 2], ['unestimated', 1]]);
    expect(groups[1]!.insights.map((i) => i.text)).toEqual(['Blocks [[c:G-2]]', 'Blocks [[c:G-3]]']);
  });

  it('calls work stale after five quiet days, and only open work', () => {
    const quiet = item({ id: 'c:S-1', estimate: { value: 1, unit: 'points', field: 'Story Points' }, updated: '2026-10-07T08:00:00Z' });
    const fresh = item({ id: 'c:S-2', estimate: { value: 1, unit: 'points', field: 'Story Points' }, updated: '2026-10-09T08:00:00Z' });
    const p = prepare(ctx([quiet, fresh]));
    expect(insights(quiet, p)).toEqual([{ code: 'stale', weight: 2, text: 'No update for 6 days', evidence: 'updated' }]);
    expect(insights(fresh, p)).toEqual([]);
  });
});

describe('a proposal', () => {
  it('reads as one command line, dossier first, every value single quoted, with --allow-write', () => {
    const p = { command: 'ado work-item update', input: { id: 2303, dossier: 'settlement', field: ['System.IterationPath=Payments\\Sprint 43'] } };
    // A backslash is literal inside single quotes in both shells: one stays one.
    expect(commandLine(p, 'posix').line).toBe("toil ado work-item update '2303' --dossier 'settlement' --field 'System.IterationPath=Payments\\Sprint 43' --allow-write");
    expect(commandLine(p, 'powershell').line).toBe("toil ado work-item update '2303' --dossier 'settlement' --field 'System.IterationPath=Payments\\Sprint 43' --allow-write");
    expect(commandLine({ command: null, input: null }, 'posix').line).toBeNull();
  });

  it('never uses double quotes, whatever the value', () => {
    for (const shell of ['posix', 'powershell'] as const) {
      const line = commandLine({ command: 'jira issue update', input: { key: 'A-1', summary: "say 'hi' $(id) `whoami` \\x" } }, shell).line!;
      expect(line).not.toContain('"');
    }
  });

  it('attaches a value that starts with a dash to its flag, so it never reads as a flag', () => {
    expect(commandLine({ command: 'jira issue update', input: { key: 'A-1', summary: '--allow-write' } }, 'posix').line).toBe("toil jira issue update 'A-1' '--summary=--allow-write' --allow-write");
    expect(commandLine({ command: 'jira issue update', input: { key: 'A-1', summary: '-x' } }, 'powershell').line).toBe("toil jira issue update 'A-1' '--summary=-x' --allow-write");
  });

  it('puts the ids first as positional arguments, and refuses one that starts with a dash, pointing at MCP', () => {
    expect(readLine({ command: 'jira issue download', input: { dossier: 'd', attachmentId: '10', key: 'A-1' } }, 'posix').line).toBe("toil jira issue download 'A-1' '10' --dossier 'd'");
    for (const shell of ['posix', 'powershell'] as const) {
      const out = commandLine({ command: 'jira issue update', input: { key: '--allow-write', summary: 's' } }, shell);
      expect(out.line).toBeNull();
      expect(out.reason).toContain("The <key> value can't be passed safely");
      expect(out.reason).not.toContain('switch this card');
      expect(out.mcp).toEqual({ tool: 'jira_issue_update', input: { key: '--allow-write', summary: 's', allowWrite: true } });
    }
  });

  it('refuses a value with a line break, saying why, rather than splitting the command', () => {
    for (const v of ['a\nb', 'a\r\nb', 'a\u2028b']) {
      const out = commandLine({ command: 'jira issue update', input: { key: 'A-1', summary: v } }, 'posix');
      expect(out.line).toBeNull();
      expect(out.reason).toMatch(/--summary value can't be passed safely on a bash\/zsh command line: it holds a line break/);
    }
  });

  it.each(['&', '|', '<', '>', '^', '%', '"', '\n', '\r'])('refuses %j on a PowerShell line, which would reach cmd.exe through toil.cmd, with the reason', (c) => {
    const input = { key: 'A-1', summary: `a ${c} b` };
    const ps = commandLine({ command: 'jira issue update', input }, 'powershell');
    expect(ps.line).toBeNull();
    expect(ps.reason).toMatch(/can't be passed safely on a PowerShell command line: /);
    // update-issue takes --input-file, so the advice offers it; MCP is always there.
    expect(ps.reason).toContain("toil jira issue update's --input-file");
    expect(ps.reason).toContain('the tool jira_issue_update');
    expect(ps.mcp).toEqual({ tool: 'jira_issue_update', input: { ...input, allowWrite: true } });
    expect(quote(`a ${c} b`, 'powershell')).toBeNull();
    // bash and zsh take all but a line break inside single quotes as they are.
    expect(commandLine({ command: 'jira issue update', input }, 'posix').line === null).toBe(c === '\n' || c === '\r');
  });

  it('advises only what the command accepts: a board move to "Code Review & QA" in PowerShell', () => {
    const qa = item({ id: 'corp-jira:QA-2', status: 'Code Review & QA', statusCategory: 'IN_PROGRESS' });
    const todo = item({ id: 'corp-jira:QA-1', status: 'To Do' });
    const p = proposeMove(todo, 'IN_PROGRESS', [todo, qa], 'card-payments')!;
    expect(p.input).toEqual({ dossier: 'card-payments', key: 'QA-1', transition: 'Code Review & QA' });
    const ps = commandLine(p, 'powershell');
    expect(ps.line).toBeNull();
    // transition-issue has no --input-file, so the advice never names it: bash/zsh or MCP instead.
    expect(ps.reason).not.toContain('--input-file');
    expect(ps.reason).toContain('it holds &');
    expect(ps.reason).toContain('Switch this card to bash/zsh');
    expect(ps.reason).toContain('the tool jira_issue_transition');
    expect(ps.mcp).toEqual({ tool: 'jira_issue_transition', input: { dossier: 'card-payments', key: 'QA-1', transition: 'Code Review & QA', allowWrite: true } });
    expect(commandLine(p, 'posix').line).toBe("toil jira issue transition 'QA-1' --dossier 'card-payments' --transition 'Code Review & QA' --allow-write");
  });

  it('never offers bash/zsh for a line break, which no shell line carries', () => {
    const out = commandLine({ command: 'ado work-item transition', input: { id: 1, state: 'a\nb' } }, 'powershell');
    expect(out.reason).not.toContain('bash/zsh');
    expect(out.reason).not.toContain('--input-file');
    expect(out.reason).toContain('the tool ado_work_item_transition');
  });

  it("picks PowerShell on Windows and POSIX anywhere else", () => {
    expect(defaultShell({ userAgentData: { platform: 'Windows' } })).toBe('powershell');
    expect(defaultShell({ platform: 'Win32' })).toBe('powershell');
    expect(defaultShell({ platform: 'MacIntel' })).toBe('posix');
    expect(defaultShell({ userAgentData: { platform: 'Linux' }, platform: 'Linux x86_64' })).toBe('posix');
    expect(defaultShell(undefined)).toBe('posix');
  });
});

/** Values a hostile or careless field could hold: substitutions, both quote kinds, backslashes, a leading dash. */
const HOSTILE = [
  'plain',
  '$(touch /tmp/toil-pwned)',
  '$HOME ${HOME} $env:PATH',
  '`whoami` and `$(id)`',
  "it's 'quoted'",
  'say "hi" and ""',
  "PowerShell's own: $env:X @(1) $null 'a''b' -f",
  'back\\slash\\\\ and \\" and \\\'',
  "‘curly’ ‚low‛ quotes",
  '-rf --allow-write',
  "'; rm -rf / #",
  "a ' b '' c ''' d",
  '%PATH% !x! ^& | ; > < * ? [a] {b} ~ #',
  'ünïcödé ✓ 日本',
];

/** The hostile values PowerShell may carry: none holds a character cmd.exe acts on. */
const PS_SAFE = HOSTILE.filter((v) => !/[&|<>^%"]/.test(v));

describe('quoting', () => {
  it('leaves PowerShell some hostile values to carry, and refuses the rest', () => {
    expect(PS_SAFE.length).toBeGreaterThan(8);
    for (const v of HOSTILE.filter((x) => !PS_SAFE.includes(x))) expect(unsafe(v, 'powershell')).toMatch(/cmd\.exe/);
  });

  it.each(HOSTILE)('writes %j as one single-quoted argument for bash/zsh', (v) => {
    const posix = quote(v, 'posix')!;
    expect(posix.startsWith("'") && posix.endsWith("'")).toBe(true);
    // Between the outer quotes, a quote only ever appears as '\''.
    expect(posix.slice(1, -1).replace(/'\\''/g, '')).not.toContain("'");
  });

  it.each(PS_SAFE)('writes %j as one single-quoted argument for PowerShell', (v) => {
    const ps = quote(v, 'powershell')!;
    expect(ps.startsWith("'") && ps.endsWith("'")).toBe(true);
    // Every quote character inside comes in a pair.
    expect(ps.slice(1, -1).replace(/(['\u2018\u2019\u201A\u201B])\1/g, '')).not.toMatch(/['\u2018\u2019\u201A\u201B]/);
  });

  it('refuses a line break or a NUL in either shell', () => {
    for (const shell of ['posix', 'powershell'] as const) for (const v of ['a\nb', 'a\rb', 'a\0b']) expect(quote(v, shell)).toBeNull();
  });
});

/** Is this shell on the machine? The round trip below runs only where it is. */
function has(cmd: string, args: string[]): boolean {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }).status === 0;
  } catch {
    return false;
  }
}
const SH = has('sh', ['-c', 'exit 0']);
const PWSH = has('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0']);

describe('the round trip through a real shell', () => {
  // sh: present on Linux and macOS runners and with Git for Windows; skipped where it isn't.
  it.skipIf(!SH)('sh -s gives back every value byte for byte', () => {
    for (const v of HOSTILE) {
      // The script goes in on stdin, so no argv quoting between here and the shell (Windows' would) can touch it.
      const out = spawnSync('sh', ['-s'], { input: `printf '%s' ${quote(v, 'posix')}`, encoding: 'utf8', timeout: 20_000 });
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout, v).toBe(v);
    }
  });

  // pwsh: PowerShell 7, on the Windows runner and wherever it is installed; skipped where it isn't.
  it.skipIf(!PWSH)('pwsh -EncodedCommand gives back every value it will carry, byte for byte', () => {
    for (const v of PS_SAFE) {
      // -EncodedCommand carries the script as base64 UTF-16, past any argv quoting, to PowerShell's own parser.
      const script = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; [Console]::Out.Write(${quote(v, 'powershell')})`;
      const out = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', timeout: 30_000 });
      expect(out.status, out.stderr).toBe(0);
      expect(out.stdout, v).toBe(v);
    }
  }, 120_000);
});
