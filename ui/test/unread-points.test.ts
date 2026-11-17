import { describe, expect, it } from 'vitest';
import { changesBetween, snapshotOf, type AnalysisRecord, type AnalysisSnapshot } from '../src/model/analysis.ts';
import { burnup } from '../src/model/burnup.ts';
import { observedEvents } from '../src/model/worklog.ts';
import { previewOf } from '../src/model/preview.ts';
import { health, sprintPoints } from '../src/model/sprint.ts';
import { cardsOf, type Ctx } from '../src/model/summary.ts';
import type { ToilProjectData } from '../src/load.ts';
import type { StatusCategory, WorkItem } from '../src/toil.ts';

/**
 * Points nobody read are unknown, not zero (#652, principle 12). A demo toil
 * project that didn't name Jira's points field showed "Together they are 0
 * points" for a chain of estimated stories. Every total over items here is
 * held to three cases: no points read, some read, and real estimates of 0.
 */

const NOW = '2026-10-13T08:00:00.000Z';
const SPRINT = { id: 's42', name: 'Sprint 42', path: null, start: '2026-10-05T09:00:00.000Z', end: '2026-10-16T17:00:00.000Z', state: 'current' as const };
const pts = (value: number) => ({ value, unit: 'points' as const, field: 'Story Points' });
function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2', source: { area: 'jira', connection: 'corp-jira', key: id, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story',
    title: `Title of ${id}`, body: null, status: 'To Do', statusCategory: 'TODO' as StatusCategory, resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null,
    iteration: SPRINT, parent: null, children: [], links: [], created: '2026-10-01T09:00:00.000Z', updated: NOW, resolved: null, dueDate: null, history: { transitions: [], iterations: [] }, unmapped: [], native: {},
    ...over,
    id: `jira:${id}`,
  };
}

/** The Summary's "can't start" card for a blocker holding up stories with these estimates. */
function blockedWhy(estimates: Array<WorkItem['estimate']>): string {
  const blocker = item('PAY-1', { title: 'The blocker', status: 'In Progress', statusCategory: 'IN_PROGRESS' });
  const waiting = estimates.map((estimate, n) => item(`PAY-${n + 2}`, { estimate }));
  const c = {
    d: { name: 'p', sources: [{ area: 'jira' }], items: [], people: [], calls: { work: [{ ok: true }] } },
    name: 'p',
    now: NOW,
    byId: new Map([blocker, ...waiting].map((i) => [i.id, i])),
    prById: new Map(),
    h: null,
    view: { reasons: [], code: { sprint: null } },
    queue: [],
    held: new Map([[blocker.id, waiting.map((i) => i.id)]]),
    ready: new Map(),
    plain: false,
  } as unknown as Ctx;
  const card = cardsOf(c).find((x) => x.id === 'blocked');
  return card!.why;
}

describe('the Summary card for stories that cannot start', () => {
  it('says no points were read, never 0 points, when none of them has points', () => {
    const why = blockedWhy([null, null, null]);
    expect(why).toBe('They wait on “The blocker”, which is still in progress. No points were read for them.');
    expect(why).not.toContain('0 points');
    expect(blockedWhy([null])).toBe('It waits on “The blocker”, which is still in progress. No points were read for it.');
  });

  it('sums the points read and says how many it could not count', () => {
    expect(blockedWhy([pts(3), null, pts(5)])).toBe('They wait on “The blocker”, which is still in progress. Together they are 8 points; no points were read for 1 of them.');
  });

  it('says a real total of 0 as 0', () => {
    expect(blockedWhy([pts(0), pts(0)])).toBe('They wait on “The blocker”, which is still in progress. Together they are 0 points.');
  });

  it('keeps the sentence it always said when every story has points', () => {
    expect(blockedWhy([pts(3), pts(5)])).toBe('They wait on “The blocker”, which is still in progress. Together they are 8 points.');
  });
});

describe('the sprint figures', () => {
  const done = { status: 'Done', statusCategory: 'DONE' as StatusCategory };

  it('are unknown, not zero, when no item in the sprint has points', () => {
    const h = health([item('A-1'), item('A-2', done)], [], NOW)!;
    expect(h.scope).toEqual({ count: 2, points: null, unestimated: 2 });
    expect(h.done).toEqual({ count: 1, points: null, unestimated: 1 });
    expect(sprintPoints(h)).toBeNull();
    const p = previewOf({ name: 'p', items: h.items, changes: [], pullRequests: [], people: [] } as unknown as ToilProjectData, NOW, null).sprint!;
    expect([p.done, p.scope, p.burn]).toEqual([null, null, []]);
  });

  it('count the items with no points read beside the points that were', () => {
    const h = health([item('A-1', { estimate: pts(5) }), item('A-2'), item('A-3', { ...done, estimate: pts(2) })], [], NOW)!;
    expect(h.scope).toEqual({ count: 3, points: 7, unestimated: 1 });
    expect(h.remaining).toEqual({ count: 2, points: 5, unestimated: 1 });
    expect(sprintPoints(h)).toEqual({ done: 2, left: 5, total: 7 });
  });

  it('give a done side with no points of its own a real 0 once any points are read', () => {
    const h = health([item('A-1', { estimate: pts(5) }), item('A-2', done)], [], NOW)!;
    expect(h.done.points).toBeNull();
    expect(sprintPoints(h)).toEqual({ done: 0, left: 5, total: 5 });
  });

  it('keep real estimates of 0 as 0', () => {
    const h = health([item('A-1', { estimate: pts(0) }), item('A-2', { estimate: pts(0) })], [], NOW)!;
    expect(h.scope).toEqual({ count: 2, points: 0, unestimated: 0 });
    expect(sprintPoints(h)).toEqual({ done: 0, left: 0, total: 0 });
  });

  it('list the items the burn-up does not draw because no points were read', () => {
    const h = health([item('A-1', { estimate: pts(5) }), item('A-2')], [], NOW)!;
    const b = burnup(h, NOW);
    expect(b.unestimated).toEqual(['jira:A-2']);
    expect(b.days.at(-1)!.scope).toBe(5);
  });
});

describe('what the history and the worklog keep', () => {
  const rec = (id: string, sprint: AnalysisSnapshot['sprint']) => ({ id, at: NOW, citations: [], recommendation: '', snapshot: { blocked: [], points: {}, sprint } }) as unknown as AnalysisRecord;

  it('snapshots a sprint with no points read as unknown figures, not 0 and 0', () => {
    expect(snapshotOf([item('A-1'), item('A-2')], NOW).sprint).toEqual({ name: 'Sprint 42', done: null, remaining: null });
  });

  it('does not call a snapshot saved before #652 (0 and 0) a move to no points read', () => {
    expect(changesBetween(rec('a', { name: 'Sprint 42', done: 0, remaining: 0 }), rec('b', { name: 'Sprint 42', done: null, remaining: null })).sprint).toBeNull();
    expect(changesBetween(rec('a', { name: 'Sprint 42', done: 2, remaining: 3 }), rec('b', { name: 'Sprint 42', done: null, remaining: null })).sprint).not.toBeNull();
  });

  const ended = (items: WorkItem[]) => observedEvents({ items, deployments: [] }, { items, deployments: [] }, '2026-10-17T08:00:00.000Z', '2026-10-15T08:00:00.000Z').find((e) => e.kind === 'sprint-ended')!.text;
  const done = { status: 'Done', statusCategory: 'DONE' as StatusCategory };

  it('leaves the points out of a sprint-ended line when none were read', () => {
    expect(ended([item('A-1', done), item('A-2')])).toBe('ended: 1 of 2 items done');
  });

  it('says how many items had no points read when some were', () => {
    expect(ended([item('A-1', { ...done, estimate: pts(3) }), item('A-2', { estimate: pts(2) }), item('A-3')])).toBe('ended: 1 of 3 items done, 3 of 5 points done (1 item with no points read)');
  });

  it('says a sprint of real 0-point estimates as 0 points', () => {
    expect(ended([item('A-1', { ...done, estimate: pts(0) })])).toBe('ended: 1 of 1 item done, 0 of 0 points done');
  });
});
