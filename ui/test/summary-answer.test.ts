import { describe, expect, it } from 'vitest';
import { waitingOnYou } from '../src/assign/sidebar.tsx';
import type { Assignment } from '../src/assign/model.ts';
import { answerOf, cardsOf, pickCards, type Ctx } from '../src/model/summary.ts';
import { usageSummary } from '../src/components/usage.tsx';
import type { UsageRecord } from '../src/model-usage.ts';

/**
 * The Summary's sentences at their edges (#552): no sprint, no points, no
 * days left, a title that says "agent", and a read that failed. `answerOf`
 * and `cardsOf` read only what the context holds, so each case builds the
 * smallest one that says what it is about.
 */

interface Over {
  total?: number;
  left?: number;
  projected?: number | null;
  stories?: number;
  gone?: number;
  noSprint?: boolean;
  failed?: boolean;
  plain?: boolean;
  title?: string;
}

function ctx(o: Over = {}): Ctx {
  const total = o.total ?? 21;
  const item = { id: 'jira:PAY-1', title: o.title ?? 'A story', source: { area: 'jira', key: 'PAY-1' }, assignee: null, status: 'In progress', statusCategory: 'IN_PROGRESS' };
  const reasons = o.title ? [{ lens: 'failing', label: 'Failing checks', line: 'x', severity: 'danger', items: [{ id: item.id, why: 'Fails.' }] }] : [];
  const health = { days: { gone: o.gone ?? 7, total: 10 }, items: Array.from({ length: o.stories ?? 3 }, () => ({})), unestimated: [] };
  return {
    d: { name: 'p', sources: [{ area: 'jira' }], items: [], people: [], calls: { work: o.failed ? [{ ok: false }] : [{ ok: true }], prs: [] } },
    name: 'p',
    now: '2026-01-01T00:00:00Z',
    byId: new Map([[item.id, item]]),
    prById: new Map(),
    h: o.noSprint ? null : health,
    view: { reasons, code: { sprint: o.noSprint ? null : { points: { total, left: o.left ?? total, done: total - (o.left ?? total) }, projected: o.projected === undefined ? null : o.projected, pace: null } } },
    queue: [],
    held: new Map(),
    ready: new Map(),
    plain: o.plain ?? false,
  } as unknown as Ctx;
}

describe('the answer at its edges', () => {
  it('says there is no sprint, and why, without a team', () => {
    const a = answerOf(ctx({ noSprint: true }));
    expect(a.status).toBe('none');
    expect(a.word).toBe('No sprint');
    expect(a.why).toBe('No sprint with dates was found, so there is nothing to measure the work against.');
    expect(a.why).not.toMatch(/team/i);
  });

  it('is not On track when no story has points: it says progress cannot be measured', () => {
    const a = answerOf(ctx({ total: 0, left: 0, stories: 3 }));
    expect(a.status).toBe('none');
    expect(a.word).toBe('No estimates');
    expect(a.sentence).toBe('3 stories in the sprint have no points, so progress can’t be measured.');
    expect(a.sentence).not.toContain('0 points');
    expect(a.basis).toBeTruthy();
    expect(answerOf(ctx({ total: 0, left: 0, stories: 1 })).sentence).toBe('1 story in the sprint has no points, so progress can’t be measured.');
  });

  it('says no working days remain when the sprint is on its last day', () => {
    const a = answerOf(ctx({ gone: 10, projected: 21 }));
    expect(a.sentence).toBe('21 of 21 points are left, and no working days remain.');
  });

  it('puts the estimate caveat and the rule-of-thumb line in the fold, and the too-early line on the page', () => {
    const paced = answerOf(ctx({ left: 18, projected: 18 }));
    expect(paced.how[0]).toBe('The status word is an estimate from the pace so far.');
    expect(paced.how.join(' ')).toContain('rule of thumb');
    expect(paced.basis).toBeNull();
    expect(answerOf(ctx({ left: 18, projected: null })).basis).toBe('Too early in the sprint to judge a pace');
  });
});

describe('titles are facts', () => {
  it('keeps an item title that says "agent", in plain words and in standard', () => {
    for (const plain of [true, false]) {
      const cards = cardsOf(ctx({ title: 'Rotate the Jenkins build agents', plain }));
      expect(cards[0]!.title).toBe('Rotate the Jenkins build agents');
    }
  });
});

describe('a read that failed', () => {
  it('names the failed read instead of an all-clear, in the sentence and on the card', () => {
    const c = ctx({ failed: true, left: 21, projected: 21 });
    expect(answerOf(c).why).toBe('Work items could not be read, so there may be problems this does not show.');
    const cards = cardsOf(c);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.title).toBe('Nothing is flagged, but not everything could be read');
    expect(cards[0]!.why).toContain('Work items could not be read');
    expect(cards[0]!.tone).toBe('warn');
  });

  it('keeps the all-clear when every read worked', () => {
    expect(answerOf(ctx({ left: 21, projected: 21 })).why).toBe('Nothing is blocked, failing its tests or waiting too long.');
    expect(pickCards({ risk: null, blocked: null, review: null, ready: null })[0]!.title).toBe('Nothing needs attention right now');
  });
});

describe('what waits on you, for the AI helpers button', () => {
  const a = (over: Partial<Assignment>) => ({ state: 'working', waiting: null, proposals: [], questions: [], ...over }) as unknown as Assignment;

  it('counts the inbox, pending and failed proposals, questions, and a failed assignment', () => {
    expect(waitingOnYou([a({ state: 'queued', waiting: 'start' })])).toBe(1);
    expect(waitingOnYou([a({ state: 'needs-you', proposals: [{ status: 'pending' }, { status: 'failed' }, { status: 'applied' }] as never, questions: ['why?'] })])).toBe(3);
    expect(waitingOnYou([a({ state: 'failed' })])).toBe(1);
    expect(waitingOnYou([a({ state: 'working' }), a({ state: 'done' })])).toBe(0);
  });
});

describe('the usage line', () => {
  const rec = (plan: boolean): UsageRecord => ({ id: 'a', chatId: 'c', turn: 1, dossier: 'd', adapter: 'claude', model: 'm', inputTokens: 1, outputTokens: 1, costUsd: 0.04, costSource: 'sdk-estimate', plan, at: '2026-01-01T00:00:00Z' }) as unknown as UsageRecord;

  it('says estimate by default, and not billed on a plan', () => {
    expect(usageSummary([rec(false)])).toBe('about $0.04 of usage (estimate)');
    expect(usageSummary([rec(true)])).toBe('about $0.04 of usage (not billed on your plan)');
  });
});
