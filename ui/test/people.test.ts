import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { ACTIVITY_DAYS, assignedTo, cardByKey, isPerson, MAX_ACTIVITY, people, readPeople, sinceInStatus, suggest, suggestionLine, type PersonEntry } from '../src/model/people.ts';
import type { Change, Person, Transition, WorkItem } from '../src/toil.ts';
import { loaded } from './harness.ts';

/**
 * The People model (src/model/people.ts, #292) on the sample toil projects as the
 * dashboard loads them, and on the edges it promises: who an account is, an
 * agent matched by the signals that set authorKind, bots left out, work in
 * progress against the toil project's limit, reviews oldest first, blockers the
 * toil project doesn't hold, recent activity, and suggestions that never guess.
 */

const NOW = '2026-10-13T08:00:00.000Z';
const who = (id: string, name: string | null = null, email: string | null = null): Person => ({ id, name, email });
const move = (to: string, toCategory: Transition['toCategory'], at: string, by: Person | null = null, from: string | null = null): Transition => ({ from, to, fromCategory: null, toCategory, at, by });

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2', id: `jira:${id}`, source: { area: 'jira', connection: 'jira', key: id, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story', title: id, body: null,
    status: 'In Progress', statusCategory: 'IN_PROGRESS', resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null, iteration: null, parent: null,
    children: [], links: [], created: '2026-10-01T09:00:00Z', updated: null, resolved: null, dueDate: null, history: null, unmapped: [], native: {}, ...over,
  };
}

function pr(n: number, over: Partial<Change> = {}): Change {
  return {
    owi: '0.2', id: `github:imagile/web#${n}`, source: { area: 'github', connection: 'github', key: `imagile/web#${n}`, command: 'github pr get' }, url: null, repo: 'imagile/web', title: `PR ${n}`,
    branch: { source: `b${n}`, target: 'main' }, state: 'OPEN', author: null, authorKind: 'HUMAN', authorKindSource: 'default', authorKindSignal: null, reviewers: [], reviews: [], checks: 'PASSING',
    checksAt: null, mergeable: true, size: null, workItems: [], mergeCommit: null, created: '2026-10-08T09:00:00Z', firstReviewAt: null, approvedAt: null, mergedAt: null, closedAt: null, updated: null, unmapped: [], native: {}, ...over,
  };
}

const PAT: PersonEntry = { name: 'Pat Example', kind: 'human', email: 'you@example.com', ids: { jira: 'pat', github: 'pat-ex' } };
const view = (entries: PersonEntry[], items: WorkItem[], changes: Change[], wipLimit: number | null = null) => people({ toilProject: 'payments', entries, wipLimit, items, changes, now: NOW });

describe('reading the Toil project', () => {
  it('takes each person with a name, defaults the kind, and says what it left out', () => {
    expect(readPeople({ people: [{ name: ' Pat ', ids: { jira: 'pat', github: '', x: 7 } }, { name: 'Claude', kind: 'agent' }, { ids: {} }], wipLimit: 3 })).toEqual({
      people: [
        { name: 'Pat', kind: 'human', email: null, ids: { jira: 'pat' } },
        { name: 'Claude', kind: 'agent', email: null, ids: {} },
      ],
      wipLimit: 3,
      notes: ['people[2] has no name, so it was left out.'],
    });
    expect(readPeople({ people: {}, wipLimit: 0 }).notes).toEqual(['The Toil project\'s "people" isn\'t a list, so nobody is mapped.', 'The Toil project\'s "wipLimit" isn\'t a whole number above 0, so no limit is shown.']);
    expect(readPeople(null)).toEqual({ people: [], wipLimit: null, notes: [] });
  });

  it("matches an account on its id or email without case, and a Services connection's id the same way", () => {
    expect(isPerson(PAT, { area: 'github', id: 'Pat-Ex', name: null, email: null })).toBe(true);
    expect(isPerson(PAT, { area: 'jira', id: 'pat', name: null, email: null })).toBe(true);
    expect(isPerson({ ...PAT, ids: { ado: 'you@example.com' } }, { area: 'ado', id: 'abc12345', name: null, email: 'YOU@example.com' })).toBe(true);
    expect(isPerson(PAT, { area: 'bitbucket', id: 'pat', name: 'Pat Example', email: 'you@example.com' })).toBe(false);
  });
});

describe('a card', () => {
  it('groups work in progress by status with days in that status, leaves containers out, and counts it against the limit', () => {
    const pat = who('pat', 'Pat Example');
    const items = [
      item('PAY-1', { assignee: pat, status: 'In Review', history: { transitions: [move('In Progress', 'IN_PROGRESS', '2026-10-05T08:00:00Z'), move('In Review', 'IN_PROGRESS', '2026-10-10T08:00:00Z')], iterations: [] } }),
      item('PAY-2', { assignee: pat }),
      item('PAY-3', { assignee: pat, history: { transitions: [move('In Progress', 'IN_PROGRESS', '2026-10-12T08:00:00Z')], iterations: [] } }),
      item('PAY-4', { assignee: pat, type: 'EPIC', typeName: 'Epic' }),
      item('PAY-5', { assignee: pat, statusCategory: 'TODO', status: 'To Do' }),
    ];
    const card = view([PAT], items, [], 2).people[0]!;
    expect(card.wip.map((g) => [g.status, g.items.map((w) => [w.item.id, w.days])])).toEqual([
      ['In Progress', [['jira:PAY-3', 1], ['jira:PAY-2', null]]],
      ['In Review', [['jira:PAY-1', 3]]],
    ]);
    expect(card).toMatchObject({ wipCount: 3, overLimit: true });
    expect(view([PAT], items, [], 3).people[0]!.overLimit).toBe(false);
    expect(view([PAT], items, []).people[0]!.overLimit).toBeNull();
    expect(sinceInStatus(items[1]!)).toBeNull();
  });

  it('lists their open pull requests, and the reviews waiting on them oldest first, never their own or a draft', () => {
    const pat = who('pat-ex');
    const sam = who('sam');
    const changes = [
      pr(1, { author: pat }),
      pr(2, { author: sam, reviewers: [{ person: pat, state: 'PENDING' }], created: '2026-10-12T08:00:00Z' }),
      pr(3, { author: sam, reviewers: [{ person: pat, state: 'PENDING' }], created: '2026-10-06T08:00:00Z' }),
      pr(4, { author: sam, reviewers: [{ person: pat, state: 'APPROVED' }] }),
      pr(5, { author: sam, state: 'DRAFT', reviewers: [{ person: pat, state: 'PENDING' }] }),
      pr(6, { author: pat, state: 'MERGED', mergedAt: '2026-10-09T08:00:00Z' }),
    ];
    const card = view([PAT], [], changes).people[0]!;
    expect(card.prs.map((p) => p.change.id)).toEqual(['github:imagile/web#1']);
    expect(card.reviews.map((r) => [r.change.id, r.days])).toEqual([
      ['github:imagile/web#3', 5],
      ['github:imagile/web#2', 1],
    ]);
  });

  it("says what blocks their items, a blocker the Toil project doesn't hold included, and leaves out one that's done", () => {
    const pat = who('pat');
    const blocks = (target: string) => ({ type: 'blocks' as const, direction: 'inward' as const, target, name: 'is blocked by' });
    const items = [
      item('PAY-1', { assignee: pat, statusCategory: 'TODO', status: 'To Do', links: [blocks('jira:PAY-9'), blocks('jira:OPS-4'), blocks('jira:PAY-8')] }),
      item('PAY-9'),
      item('PAY-8', { statusCategory: 'DONE', status: 'Done' }),
    ];
    const card = view([PAT], items, []).people[0]!;
    expect(card.blocked.map((b) => [b.item.id, b.by.map((x) => [x.id, x.item?.status ?? null])])).toEqual([['jira:PAY-1', [['jira:PAY-9', 'In Progress'], ['jira:OPS-4', null]]]]);
  });

  it(`keeps the last ${ACTIVITY_DAYS} days of moves, merges and reviews, newest first, at most ${MAX_ACTIVITY}`, () => {
    const pat = who('pat');
    const ghPat = who('pat-ex');
    const history = { transitions: Array.from({ length: 9 }, (_, i) => move(`S${i}`, 'IN_PROGRESS', `2026-10-${String(2 + i).padStart(2, '0')}T08:00:00Z`, pat, i ? `S${i - 1}` : null)), iterations: [] };
    const old = move('Done', 'DONE', '2026-09-01T08:00:00Z', pat);
    const items = [item('PAY-1', { history: { ...history, transitions: [...history.transitions, old] } })];
    const changes = [pr(7, { author: ghPat, state: 'MERGED', mergedAt: '2026-10-12T09:00:00Z' }), pr(8, { author: who('sam'), reviews: [{ by: ghPat, state: 'APPROVED', at: '2026-10-11T09:00:00Z' }] })];
    const card = view([PAT], items, changes).people[0]!;
    expect(card.activity.slice(0, 3).map((a) => [a.kind, a.at])).toEqual([
      ['merged', '2026-10-12T09:00:00Z'],
      ['reviewed', '2026-10-11T09:00:00Z'],
      ['moved', '2026-10-10T08:00:00Z'],
    ]);
    expect(card.activity).toHaveLength(MAX_ACTIVITY);
    expect(card.moreActivity).toBe(3);
  });
});

describe('agents, bots and accounts the Toil project does not map', () => {
  const CLAUDE: PersonEntry = { name: 'Claude', kind: 'agent', email: null, ids: {} };
  const COPILOT: PersonEntry = { name: 'Copilot', kind: 'agent', email: null, ids: { github: 'Copilot' } };

  it("gives an agent the changes whose signal names it, and its author's card says it was written with it", () => {
    const pat = who('pat-ex');
    const changes = [
      pr(1, { author: pat, authorKind: 'AGENT', authorKindSource: 'trailer', authorKindSignal: 'Co-Authored-By: Claude <you@example.com>' }),
      pr(2, { author: who('Copilot'), authorKind: 'AGENT', authorKindSource: 'account', authorKindSignal: 'account Copilot, type Bot' }),
      pr(3, { author: pat, authorKind: 'AGENT', authorKindSource: 'branch', authorKindSignal: 'branch devin/fix' }),
    ];
    const v = view([PAT, CLAUDE, COPILOT], [item('PAY-1', { source: { area: 'github', connection: 'github', key: 'imagile/web#9', command: 'github issue list' }, id: 'github:imagile/web#9', assignee: who('copilot') })], changes);
    const card = (name: string) => v.people.find((c) => c.who.name === name)!;
    expect(card('Claude').prs.map((p) => p.change.id)).toEqual(['github:imagile/web#1']);
    expect(card('Copilot').prs.map((p) => p.change.id)).toEqual(['github:imagile/web#2']);
    expect(card('Copilot').wipCount).toBe(1);
    expect(card('Pat Example').prs.map((p) => [p.change.id, p.withAgent])).toEqual([
      ['github:imagile/web#1', 'Claude'],
      ['github:imagile/web#3', "an agent the Toil project doesn't name (branch devin/fix)"],
    ]);
    expect(v.unnamedAgents.map((c) => c.id)).toEqual(['github:imagile/web#3']);
  });

  it('leaves out an account that only wrote bots\' pull requests, and gives other unmapped accounts with work a card', () => {
    const bot = who('dependabot[bot]');
    const changes = [pr(1, { author: bot, authorKind: 'BOT', authorKindSource: 'account', authorKindSignal: 'account dependabot[bot], type Bot' }), pr(2, { author: who('sam', 'Sam') })];
    const v = view([PAT], [item('PAY-1', { assignee: who('idle'), statusCategory: 'DONE', status: 'Done' })], changes);
    expect(v.bots.map((b) => b.id)).toEqual(['dependabot[bot]']);
    expect(v.unmapped.map((c) => [c.who.key, c.who.name])).toEqual([['id:github:sam', 'Sam']]);
  });

  it('puts cards in name order whatever their load, so nothing reads as a ranking', () => {
    const entries: PersonEntry[] = [
      { name: 'zed', kind: 'human', email: null, ids: { jira: 'zed' } },
      { name: 'Amy', kind: 'human', email: null, ids: { jira: 'amy' } },
      { name: 'bo', kind: 'agent', email: null, ids: { jira: 'bo' } },
    ];
    const items = [item('A-1', { assignee: who('zed') }), item('A-2', { assignee: who('zed') }), item('A-3', { assignee: who('zed') })];
    expect(view(entries, items, [], 1).people.map((c) => c.who.name)).toEqual(['Amy', 'bo', 'zed']);
    expect(view(entries, items, [], 1).team.wip).toEqual({ total: 3, limit: 1, over: [{ key: 'person:zed', name: 'zed', count: 3 }] });
  });
});

describe('suggestions', () => {
  const at = (area: string, id: string, email: string | null, name: string | null = null) => ({ area, id, email, name });

  it("suggests an account with one person's email for that person, and accounts in two systems sharing one as a new person", () => {
    const { suggestions, ambiguous } = suggest('payments', [PAT], [at('bitbucket', 'pexample', 'YOU@example.com'), at('jira', 'sam', 'sam@example.com', 'Sam'), at('github', 'sam-gh', 'sam@example.com')]);
    expect(ambiguous).toEqual([]);
    expect(suggestions.map((s) => [s.person, s.name, s.input])).toEqual([
      [null, 'Sam', { toilProject: 'payments', name: 'Sam', id: ['jira=sam', 'github=sam-gh'], email: 'sam@example.com' }],
      ['Pat Example', 'Pat Example', { toilProject: 'payments', name: 'Pat Example', id: ['bitbucket=pexample'] }],
    ]);
    expect(suggestionLine(suggestions[0]!)).toBe('toil projects person payments Sam --id jira=sam --id github=sam-gh --email sam@example.com');
    expect(suggestionLine(suggestions[1]!)).toBe('toil projects person payments "Pat Example" --id bitbucket=pexample');
    // The line is made from the input the button runs, flag for flag.
    for (const s of suggestions) expect(suggestionLine(s)).toBe(['toil projects person', s.input.toilProject, /\s/.test(s.input.name) ? `"${s.input.name}"` : s.input.name, ...s.input.id.flatMap((id) => ['--id', id]), ...(s.input.email ? ['--email', s.input.email] : [])].join(' '));
  });

  it('suggests nothing for an email two people have, two accounts in one system have, or that would replace an identity', () => {
    const twin: PersonEntry = { ...PAT, name: 'Pat Two', ids: {} };
    expect(suggest('p', [PAT, twin], [at('bitbucket', 'x', 'you@example.com')])).toEqual({ suggestions: [], ambiguous: ['you@example.com is the email of Pat Example and Pat Two, so bitbucket x is not matched to either.'] });
    expect(suggest('p', [], [at('bitbucket', 'jsmith', 'team@example.com'), at('bitbucket', 'achen', 'team@example.com'), at('jira', 'jsmith', 'team@example.com')]).ambiguous).toEqual([
      'team@example.com is on 2 bitbucket accounts (jsmith, achen), so nothing is suggested for it.',
    ]);
    expect(suggest('p', [PAT], [at('github', 'other', 'you@example.com')])).toEqual({ suggestions: [], ambiguous: ["github other has Pat Example's email, but Pat Example already has a github identity (pat-ex), so it isn't suggested."] });
    expect(suggest('p', [], [at('jira', 'lone', 'lone@example.com')]).suggestions).toEqual([]);
  });

  it("never uses a mapped account's email, so a shared mailbox can't pull another account to the wrong person", () => {
    const v = view([PAT], [item('PAY-1', { assignee: who('pat', null, 'team@example.com') }), item('PAY-2', { assignee: who('sam', null, 'team@example.com') })], []);
    expect(v.suggestions).toEqual([]);
  });
});

describe('the sample Toil projects', () => {
  it("card-payments: suggests A. Chen's Bitbucket account by her email, and the team strip agrees with the cards", async () => {
    const { data } = await loaded('card-payments');
    const v = people({ toilProject: 'card-payments', entries: data.people, wipLimit: data.wipLimit, items: data.items, changes: data.pullRequests, now: FIXTURE_NOW });
    expect(v.people.map((c) => c.who.name)).toEqual(['A. Chen', 'J. Smith', 'R. Patel']);
    expect(v.suggestions.map((s) => s.input)).toEqual([{ toilProject: 'card-payments', name: 'A. Chen', id: ['bitbucket=achen'] }]);
    expect(v.team.reviewQueue.map((r) => r.change.id)).toEqual(['corp-bitbucket:PAY/payments-core#305']);
    expect(v.team.unassigned).toEqual({ sprint: 'Sprint 42', items: [expect.objectContaining({ id: 'corp-jira:PAY-103' }), expect.objectContaining({ id: 'corp-jira:PAY-107' })] });
    expect(v.team.wip.total).toBe([...v.people, ...v.unmapped].reduce((n, c) => n + c.wipCount, 0));
    expect(v.bots.map((b) => b.id)).toEqual(['svc-renovate']);
    // The board filter: J. Smith's items in Jira, by the toil project's ids.
    expect(assignedTo(v, 'person:J. Smith', data.items, data.people).map((i) => i.id).sort()).toEqual(data.items.filter((i) => i.assignee?.id === 'jsmith').map((i) => i.id).sort());
    expect(cardByKey(v, 'person:Nobody')).toBeUndefined();
  });

  it('checkout-web: Ada across GitHub and Bitbucket Cloud, Claude by its trailer, and Copilot unnamed', async () => {
    const { data } = await loaded('checkout-web');
    const v = people({ toilProject: 'checkout-web', entries: data.people, wipLimit: data.wipLimit, items: data.items, changes: data.pullRequests, now: FIXTURE_NOW });
    const ada = v.people.find((c) => c.who.name === 'Ada D.')!;
    expect(ada.who.identities.map((i) => i.area).sort()).toEqual(['bitbucket', 'github']);
    expect(ada.reviews.map((r) => r.change.id)).toEqual(['bitbucket-cloud:imagile/checkout-sdk#12', 'github:imagile/payments-web#52']);
    expect(v.people.find((c) => c.who.name === 'Claude')!.prs.map((p) => p.change.id)).toEqual(['github:imagile/payments-web#51']);
    expect(v.unnamedAgents.map((c) => c.id)).toEqual(['bitbucket-cloud:imagile/checkout-sdk#12']);
    expect(v.unmapped.map((c) => c.who.name)).toEqual(['Bo W.']);
  });

  it('settlement: lists nobody, so every account with work has its own card', async () => {
    const { data } = await loaded('settlement');
    const v = people({ toilProject: 'settlement', entries: data.people, wipLimit: data.wipLimit, items: data.items, changes: data.pullRequests, now: FIXTURE_NOW });
    expect(v.people).toEqual([]);
    expect(v.wipLimit).toBeNull();
    expect(v.unmapped.map((c) => c.who.name)).toEqual(['D. Okafor', 'J. Park', 'K. Nakamura', 'M. Lind']);
  });
});
