import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { blockerGantt } from '../src/model/gantt.ts';
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

  it('spans the sprint when there is one', async () => {
    const { data } = await loaded('card-payments');
    const h = health(data.items, data.changes, FIXTURE_NOW)!;
    const g = blockerGantt({ prepared: prepare({ items: data.items, changes: data.changes, deployments: data.deployments, health: h, now: FIXTURE_NOW }), health: h, readiness: data.readiness, now: FIXTURE_NOW });
    expect(g.sprint).toBe(h.sprint.name);
    expect(g.start).toBe(new Date(h.sprint.start!).toISOString());
    expect(g.chain).toMatchObject({ ids: ['corp-jira:PAY-101', 'corp-jira:PAY-102', 'corp-jira:PAY-103'], points: 16 });
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
});
