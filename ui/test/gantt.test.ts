import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { blockedMarks, blockerGantt, type Bar } from '../src/model/gantt.ts';
import { prepare } from '../src/model/insights.ts';
import { readReadiness } from '../src/model/readiness.ts';
import { health } from '../src/model/sprint.ts';
import type { ChangeRef, StatusCategory, Transition, WorkItem } from '../src/toil.ts';

type Link = WorkItem['links'][number];
import { NAMES, loaded } from './harness.ts';

/**
 * The blocker Gantt (#396): bars from transitions, links and builds, with
 * every estimate marked, waits-on arrows, and the critical chain by points.
 */

const NOW = '2026-10-13T08:00:00.000Z';
const at = (d: string) => `2026-10-${d}T09:00:00.000Z`;
function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2', source: { area: 'jira', connection: 'corp-jira', key: id, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story',
    title: `Title of ${id}`, body: null, status: null, statusCategory: 'TODO' as StatusCategory, resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null,
    iteration: null, parent: null, children: [], links: [], created: at('01'), updated: NOW, resolved: null, dueDate: null, history: { transitions: [], iterations: [] }, unmapped: [], native: {},
    ...over,
    id: `jira:${id}`,
  };
}
const blockedBy = (id: string): Link => ({ type: 'blocks', direction: 'inward', target: `jira:${id}`, name: 'is blocked by' });
const blocks = (id: string): Link => ({ type: 'blocks', direction: 'outward', target: `jira:${id}`, name: 'blocks' });
const move = (to: StatusCategory, when: string): Transition => ({ from: null, to, fromCategory: null, toCategory: to, at: when, by: null });
const pts = (value: number) => ({ value, unit: 'points' as const, field: 'story points' });
const SETTINGS = readReadiness({ repos: [{ name: 'payments-core' }], jira: { project: 'PAY' } });
const gantt = (items: WorkItem[], changes: ChangeRef[] = []) => blockerGantt({ prepared: prepare({ items, changes, deployments: [], health: null, now: NOW }), health: null, readiness: SETTINGS, now: NOW });

describe('blockerGantt', () => {
  it('draws nothing when nothing blocks anything', () => {
    const g = gantt([item('A-1'), item('A-2')]);
    expect(g.bars).toEqual([]);
    expect(g.arrows).toEqual([]);
    expect(g.chain).toBeNull();
  });

  it('splits a bar into time in progress and time blocked, blocked estimated from when both items existed', () => {
    const g = gantt([
      item('A-1', { statusCategory: 'IN_PROGRESS', created: at('02'), links: [blocks('A-2')], history: { transitions: [move('IN_PROGRESS', at('05'))], iterations: [] } }),
      item('A-2', { statusCategory: 'IN_PROGRESS', created: at('08'), links: [blockedBy('A-1')], history: { transitions: [move('IN_PROGRESS', at('06'))], iterations: [] } }),
    ]);
    expect(g.bars.map((b) => b.id)).toEqual(['jira:A-1', 'jira:A-2']);
    const [a1, a2] = g.bars;
    expect(a1!.segments).toEqual([{ kind: 'progress', start: at('05'), end: NOW, estimated: false, by: null }]);
    expect(a2!.segments).toEqual([
      { kind: 'progress', start: at('06'), end: at('08'), estimated: false, by: null },
      { kind: 'blocked', start: at('08'), end: NOW, estimated: true, by: null },
    ]);
    expect(a2!.blocked).toEqual([{ kind: 'blocked', start: at('08'), end: NOW, estimated: true, by: 'jira:A-1' }]);
    expect(a2!.evidence.join(' ')).toContain('links carry no date');
    expect(g.arrows).toEqual([{ from: 'jira:A-1', to: 'jira:A-2', live: true, onChain: true }]);
  });

  it('ends the wait when the blocker finished, and dashes the arrow as over', () => {
    const g = gantt([
      item('A-1', { statusCategory: 'DONE', links: [blocks('A-2')], history: { transitions: [move('IN_PROGRESS', at('02')), move('DONE', at('07'))], iterations: [] } }),
      item('A-2', { statusCategory: 'IN_PROGRESS', links: [blockedBy('A-1')], history: { transitions: [move('IN_PROGRESS', at('03'))], iterations: [] } }),
    ]);
    const a2 = g.bars.find((b) => b.id === 'jira:A-2')!;
    expect(a2.segments.find((s) => s.kind === 'blocked')).toMatchObject({ start: at('01'), end: at('07') });
    expect(a2.blocked).toMatchObject([{ start: at('01'), end: at('07'), by: 'jira:A-1' }]);
    expect(a2.segments.filter((s) => s.kind === 'progress').map((s) => [s.start, s.end])).toEqual([[at('07'), NOW]]);
    expect(g.arrows[0]).toMatchObject({ live: false });
    expect(g.chain).toBeNull();
  });

  it("merges two blockers' waits into one stretch on the bar, and keeps each wait for the table (#403 review)", () => {
    const g = gantt([
      item('A', { links: [blocks('C')] }),
      item('B', { created: at('03'), statusCategory: 'DONE', resolved: at('06'), links: [blocks('C')] }),
      item('D', { created: at('09'), links: [blocks('C')] }),
      item('C', { statusCategory: 'IN_PROGRESS', links: [blockedBy('A'), blockedBy('B'), blockedBy('D')], history: { transitions: [move('IN_PROGRESS', at('01'))], iterations: [] } }),
    ]);
    const c = g.bars.find((b) => b.id === 'jira:C')!;
    expect(c.segments).toEqual([{ kind: 'blocked', start: at('01'), end: NOW, estimated: true, by: null }]);
    expect(c.blocked.map((b) => [b.by, b.start, b.end])).toEqual([
      ['jira:A', at('01'), NOW],
      ['jira:B', at('03'), at('06')],
      ['jira:D', at('09'), NOW],
    ]);
    for (const b of g.bars) {
      const lane = [...b.segments].sort((x, y) => (x.start < y.start ? -1 : 1));
      for (let i = 1; i < lane.length; i++) expect(lane[i]!.start >= lane[i - 1]!.end).toBe(true);
    }
  });

  it('estimates time in progress from creation when no move into In progress was recorded', () => {
    const g = gantt([item('G-1', { statusCategory: 'IN_PROGRESS', created: at('04'), links: [blocks('G-2')] }), item('G-2', { links: [blockedBy('G-1')] })]);
    expect(g.bars[0]!.segments).toEqual([{ kind: 'progress', start: at('04'), end: NOW, estimated: true, by: null }]);
    expect(g.bars[0]!.evidence[0]).toContain('estimated');
    expect(g.bars[1]!.ready).not.toBeNull();
  });

  it('marks failing checks from the first of the latest run of failed builds', () => {
    const pr: ChangeRef = { id: 'pr#1', kind: 'pull-request', source: 'bitbucket', command: 'bitbucket pr list', items: ['jira:A-1'], title: 'PR', url: null, state: 'OPEN', outcome: 'open', builds: null, mergeCommit: null, at: at('03') };
    const build = (n: string, outcome: ChangeRef['outcome'], when: string): ChangeRef => ({ ...pr, id: `b#${n}`, kind: 'build', command: 'jenkins pipeline runs', outcome, builds: 'pr#1', at: when });
    const g = gantt([item('A-1', { statusCategory: 'IN_PROGRESS', links: [blocks('A-2')] }), item('A-2', { links: [blockedBy('A-1')] })], [pr, build('1', 'failed', at('04')), build('2', 'passed', at('05')), build('3', 'failed', at('09')), build('4', 'failed', at('10'))]);
    expect(g.bars[0]!.checks).toEqual([{ kind: 'checks', start: at('09'), end: NOW, estimated: false, by: 'b#3' }]);
  });

  it('takes the chain holding the most points, not the longest', () => {
    const g = gantt([
      item('A-1', { estimate: pts(1), links: [blocks('A-2')] }),
      item('A-2', { estimate: pts(1), links: [blockedBy('A-1'), blocks('A-3')] }),
      item('A-3', { estimate: pts(1), links: [blockedBy('A-2')] }),
      item('B-1', { estimate: pts(8), links: [blocks('B-2')] }),
      item('B-2', { estimate: pts(5), links: [blockedBy('B-1')] }),
    ]);
    expect(g.chain).toEqual({ ids: ['jira:B-1', 'jira:B-2'], points: 13, unestimated: 0, byCount: false });
    expect(g.arrows.filter((a) => a.onChain)).toEqual([{ from: 'jira:B-1', to: 'jira:B-2', live: true, onChain: true }]);
  });

  it('takes the longest chain when nothing on it has points, and says so', () => {
    const g = gantt([item('A-1', { links: [blocks('A-2')] }), item('A-2', { links: [blockedBy('A-1'), blocks('A-3')] }), item('A-3', { links: [blockedBy('A-2')] }), item('B-1', { links: [blocks('B-2')] }), item('B-2', { links: [blockedBy('B-1')] })]);
    expect(g.chain).toEqual({ ids: ['jira:A-1', 'jira:A-2', 'jira:A-3'], points: 0, unestimated: 3, byCount: true });
  });

  it('reads a chain of real 0-point estimates as points, not as nothing read (#652)', () => {
    const g = gantt([item('A-1', { estimate: pts(0), links: [blocks('A-2')] }), item('A-2', { estimate: pts(0), links: [blockedBy('A-1')] })]);
    expect(g.chain).toEqual({ ids: ['jira:A-1', 'jira:A-2'], points: 0, unestimated: 0, byCount: false });
  });

  it('says how many items on the chain have no points read, rather than count them as 0 (#652)', () => {
    const g = gantt([item('A-1', { estimate: pts(3), links: [blocks('A-2')] }), item('A-2', { links: [blockedBy('A-1')] })]);
    expect(g.chain).toEqual({ ids: ['jira:A-1', 'jira:A-2'], points: 3, unestimated: 1, byCount: false });
  });

  it('survives a loop of blocks links', () => {
    const g = gantt([item('A-1', { links: [blocks('A-2'), blockedBy('A-2')] }), item('A-2', { links: [blockedBy('A-1'), blocks('A-1')] })]);
    expect(g.cycle).toBe(true);
    expect(g.chain!.ids).toHaveLength(2);
  });

  it('plans open work to its due date, from when what it waits on is due, else today; no due date, no plan (principle 12)', () => {
    const g = gantt([
      item('P-1', { statusCategory: 'IN_PROGRESS', dueDate: '2026-10-15', links: [blocks('P-2')], history: { transitions: [move('IN_PROGRESS', at('05'))], iterations: [] } }),
      item('P-2', { dueDate: '2026-10-20', links: [blockedBy('P-1'), blocks('P-3')] }),
      item('P-3', { links: [blockedBy('P-2')] }),
    ]);
    const [p1, p2, p3] = g.bars;
    // A due date is a whole day: the plan runs to the end of it, and what waits on it starts when that day ends.
    expect(p1!.planned).toEqual({ kind: 'planned', start: NOW, end: '2026-10-16T00:00:00.000Z', estimated: true, by: null });
    expect(p2!.planned).toEqual({ kind: 'planned', start: '2026-10-16T00:00:00.000Z', end: '2026-10-21T00:00:00.000Z', estimated: true, by: 'jira:P-1' });
    expect(p2!.evidence.join(' ')).toContain('the start estimated');
    expect(p3!).toMatchObject({ due: null, planned: null, overdue: false });
  });

  it('marks open work past its due date, with no plan, and a done item never', () => {
    const g = gantt([
      item('O-1', { statusCategory: 'IN_PROGRESS', dueDate: '2026-10-20', links: [blocks('O-2')] }),
      item('O-2', { dueDate: '2026-10-10', links: [blockedBy('O-1')] }),
      item('O-3', { statusCategory: 'DONE', resolved: at('09'), dueDate: '2026-10-05', links: [blocks('O-2')] }),
    ]);
    const bar = (id: string) => g.bars.find((b) => b.id === `jira:${id}`)!;
    expect(bar('O-2')).toMatchObject({ overdue: true, planned: null });
    expect(bar('O-3')).toMatchObject({ overdue: false, planned: null, due: '2026-10-05' });
  });

  it("doesn't call an item due today overdue: it has until the day ends, and a plan to then", () => {
    const today = NOW.slice(0, 10);
    const g = gantt([item('T-1', { statusCategory: 'IN_PROGRESS', dueDate: today, links: [blocks('T-2')] }), item('T-2', { links: [blockedBy('T-1')] })]);
    const t1 = g.bars.find((b) => b.id === 'jira:T-1')!;
    expect(t1).toMatchObject({ overdue: false, due: today });
    expect(t1.planned).toEqual({ kind: 'planned', start: NOW, end: '2026-10-14T00:00:00.000Z', estimated: true, by: null });
    // The day after, it is.
    const later = blockerGantt({ prepared: prepare({ items: [item('T-1', { statusCategory: 'IN_PROGRESS', dueDate: today, links: [blocks('T-2')] }), item('T-2', { links: [blockedBy('T-1')] })], changes: [], deployments: [], health: null, now: '2026-10-14T00:00:00.001Z' }), health: null, readiness: SETTINGS, now: '2026-10-14T00:00:00.001Z' });
    expect(later.bars.find((b) => b.id === 'jira:T-1')).toMatchObject({ overdue: true, planned: null });
  });

  it("groups each chain's rows together, the critical chain's first, and focuses on the chains still holding work up", () => {
    const g = gantt([
      item('X-1', { links: [blocks('X-2')] }),
      item('X-2', { links: [blockedBy('X-1')] }),
      item('Y-1', { statusCategory: 'DONE', resolved: at('03'), links: [blocks('Y-2')] }),
      item('Y-2', { links: [blockedBy('Y-1')] }),
      item('Z-1', { estimate: pts(5), links: [blocks('Z-2')] }),
      item('Z-2', { estimate: pts(3), links: [blockedBy('Z-1'), blocks('Z-3')] }),
      item('Z-3', { estimate: pts(3), links: [blockedBy('Z-2')] }),
      item('W-1', { links: [blocks('W-2')] }),
      item('W-2', { links: [blockedBy('W-1'), blocks('W-3')] }),
      item('W-3', { links: [blockedBy('W-2')] }),
    ]);
    expect(g.chain!.ids).toEqual(['jira:Z-1', 'jira:Z-2', 'jira:Z-3']);
    expect(g.bars.map((b) => b.id.slice(5))).toEqual(['Z-1', 'Z-2', 'Z-3', 'W-1', 'W-2', 'W-3', 'X-1', 'X-2', 'Y-1', 'Y-2']);
    expect(g.bars.map((b) => b.group)).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 3, 3]);
    expect(g.focus.map((id) => id.slice(5))).toEqual(['Z-1', 'Z-2', 'Z-3', 'W-1', 'W-2', 'W-3']);
  });

  it('focuses on every row when only one or two would be hidden', () => {
    const g = gantt([item('A-1', { links: [blocks('A-2')] }), item('A-2', { links: [blockedBy('A-1'), blocks('A-3')] }), item('A-3', { links: [blockedBy('A-2')] }), item('B-1', { links: [blocks('B-2')] }), item('B-2', { links: [blockedBy('B-1')] })]);
    expect(g.focus).toHaveLength(5);
  });

  it('spans the sprint when there is one', async () => {
    const { data } = await loaded('card-payments');
    const h = health(data.items, data.changes, FIXTURE_NOW)!;
    const g = blockerGantt({ prepared: prepare({ items: data.items, changes: data.changes, deployments: data.deployments, health: h, now: FIXTURE_NOW }), health: h, readiness: data.readiness, now: FIXTURE_NOW });
    expect(g.sprint).toBe(h.sprint.name);
    expect(g.start).toBe(new Date(h.sprint.start!).toISOString());
    expect(g.chain).toMatchObject({ ids: ['corp-jira:PAY-101', 'corp-jira:PAY-102', 'corp-jira:PAY-103'], points: 16 });
    // The sample's due dates draw the chain as a plan, one day after another.
    expect(g.bars.map((b) => [b.planned?.start.slice(0, 10), b.planned?.end.slice(0, 10)])).toEqual([
      ['2026-10-13', '2026-10-15'],
      ['2026-10-15', '2026-10-16'],
      ['2026-10-16', '2026-10-17'],
    ]);
  });

  it.each(NAMES)('on the sample %s: every arrow joins two bars, and no segment ends before it starts', async (name) => {
    const { data } = await loaded(name);
    const h = health(data.items, data.changes, FIXTURE_NOW);
    const g = blockerGantt({ prepared: prepare({ items: data.items, changes: data.changes, deployments: data.deployments, health: h, now: FIXTURE_NOW }), health: h, readiness: data.readiness, now: FIXTURE_NOW });
    const ids = new Set(g.bars.map((b) => b.id));
    for (const a of g.arrows) expect(ids.has(a.from) && ids.has(a.to)).toBe(true);
    for (const s of g.bars.flatMap((b) => [...b.segments, ...b.checks])) expect(Date.parse(s.end)).toBeGreaterThan(Date.parse(s.start));
    expect(Date.parse(g.end)).toBeGreaterThanOrEqual(Date.parse(g.now));
  });

  it('draws blocked time calm, and red only on the critical chain: lateness is the due flag\'s to say (#657)', () => {
    const seg = (start: string, end: string) => ({ kind: 'blocked' as const, start, end, estimated: false, by: null });
    const bar = (over: Partial<Bar>) => ({ id: 'jira:A', segments: [seg(at('01'), at('10'))], blocked: [], due: null, done: false, onChain: false, ...over }) as unknown as Bar;
    expect(blockedMarks(bar({}))).toEqual([{ start: at('01'), end: at('10'), strong: false }]);
    expect(blockedMarks(bar({ onChain: true }))).toEqual([{ start: at('01'), end: at('10'), strong: true }]);
    expect(blockedMarks(bar({ due: '2026-10-05' }))).toEqual([{ start: at('01'), end: at('10'), strong: false }]);
    expect(blockedMarks(bar({ due: '2026-09-20', onChain: true }))).toEqual([{ start: at('01'), end: at('10'), strong: true }]);
  });
});
