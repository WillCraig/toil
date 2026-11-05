import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import {
  addDays, addMonths, buildDay, dayOf, daysOfMonth, escapeMd, eventsFrom, gapsFor, isDay, isMonth, markdownOf, monthMarkdown, observedEvents, runFromAnswer, transcriptOf,
  type AgentRun, type SyncRun, type WorklogEvent, type WorklogInput,
} from '../src/model/worklog.ts';
import type { Change, ChangeRef, Deployment, WorkItem } from '../src/toil.ts';
import { exportName, publishProposals } from '../src/worklog.ts';

/**
 * The worklog's fold (#308, src/model/worklog.ts): which facts a toil project's
 * history gives, what a sync sees that the trackers don't time, what a page
 * says it can't vouch for, and the one promise that matters most, that the
 * same inputs always fold to the same page, byte for byte.
 */

const person = (id: string) => ({ id, name: id === 'ada' ? 'Ada Lovelace' : null, email: null });

function item(key: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2', id: `jira:${key}`, source: { area: 'jira', connection: 'jira', key, command: 'jira issue search' }, url: `https://jira.imagile.dev/browse/${key}`, type: 'STORY', typeName: 'Story', title: `Title of ${key}`, body: null,
    status: 'In Progress', statusCategory: 'IN_PROGRESS', resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null, iteration: null,
    parent: null, children: [], links: [], created: null, updated: null, resolved: null, dueDate: null, history: { transitions: [], iterations: [] }, unmapped: [], native: {},
    ...over,
  } as WorkItem;
}

function change(n: number, over: Partial<Change> = {}): Change {
  return {
    owi: '0.2', id: `github:imagile/payments-web#${n}`, source: { area: 'github', connection: 'github', key: `imagile/payments-web#${n}`, command: 'github pr get' }, url: `https://github.com/imagile/payments-web/pull/${n}`,
    repo: 'imagile/payments-web', title: `Change ${n}`, branch: { source: 'feature', target: 'main' }, state: 'OPEN', author: person('ada'), authorKind: 'HUMAN', authorKindSource: 'default', authorKindSignal: null,
    reviewers: [], reviews: null, checks: null, checksAt: null, mergeable: null, size: null, workItems: [], mergeCommit: null, created: null, firstReviewAt: null, approvedAt: null, mergedAt: null, closedAt: null, updated: null, unmapped: [], native: {},
    ...over,
  } as Change;
}

const ref = (c: Change): ChangeRef => ({ id: c.id, kind: 'pull-request', source: 'github', command: 'github pr list', items: [], title: c.title, url: c.url, state: c.state, outcome: 'open', builds: null, mergeCommit: null, at: c.created ?? '', change: c });
const build = (pr: string, n: number, outcome: 'failed' | 'passed', at: string, id = `${pr}/checks`): ChangeRef => ({ id, kind: 'build', source: 'github', command: 'github commit checks', items: [], title: `CI #${n}`, url: `https://github.com/imagile/payments-web/actions/runs/${n}`, state: outcome === 'failed' ? 'failure (test)' : 'success', outcome, builds: pr, mergeCommit: null, at });

const DAY = '2026-10-12';
const at = (time: string, day = DAY) => `${day}T${time}:00.000Z`;

describe('days', () => {
  it('are UTC days, and only real ones', () => {
    expect(dayOf('2026-10-12T23:59:59-04:00')).toBe('2026-10-13');
    expect(dayOf('not a time')).toBeNull();
    expect(isDay('2026-02-29')).toBe(false);
    expect(isDay('2028-02-29')).toBe(true);
    expect(isMonth('2026-13')).toBe(false);
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(daysOfMonth('2026-02')).toHaveLength(28);
  });
});

describe('facts from the history', () => {
  it('turns each status and sprint change into a line with its own time and who made it', () => {
    const i = item('PAY-1', {
      history: {
        transitions: [{ from: 'To Do', to: 'In Progress', fromCategory: 'TODO', toCategory: 'IN_PROGRESS', at: at('09:14'), by: person('ada') }],
        iterations: [
          { from: [], to: ['Sprint 42'], at: at('08:00'), by: person('bob') },
          { from: ['Sprint 42'], to: [], at: at('17:00'), by: null },
          { from: ['Sprint 41'], to: ['Sprint 42'], at: at('10:00'), by: null },
        ],
      },
    });
    const events = eventsFrom({ items: [i], changes: [] });
    expect(events.map((e) => [e.kind, e.at, e.text, e.by])).toEqual([
      ['status', at('09:14'), 'To Do → In Progress', 'Ada Lovelace'],
      ['sprint', at('08:00'), 'added to Sprint 42', 'bob'],
      ['sprint', at('17:00'), 'dropped from Sprint 42', null],
      ['sprint', at('10:00'), 'moved from Sprint 41 to Sprint 42', null],
    ]);
    expect(events[0]).toMatchObject({ subject: 'jira:PAY-1', label: 'PAY-1', url: 'https://jira.imagile.dev/browse/PAY-1', cites: ['jira:PAY-1'] });
    // Whose line it is in a stand-up (#345): the account itself, not only its name, and the category a status move went into.
    expect(events.map((e) => e.who?.id ?? null)).toEqual(['ada', 'bob', null, null]);
    expect(events[0]!.toCategory).toBe('IN_PROGRESS');
  });

  it('turns a pull request into opened, each review, and merged or declined, by its own times', () => {
    const merged = change(41, { state: 'MERGED', created: at('09:00'), mergedAt: at('15:00'), reviews: [{ by: person('bob'), state: 'CHANGES_REQUESTED', at: at('11:00') }, { by: person('bob'), state: 'APPROVED', at: at('14:00') }] });
    const declined = change(42, { state: 'DECLINED', created: at('10:00'), closedAt: at('16:00') });
    const draft = change(43, { state: 'DRAFT', created: at('12:00') });
    const events = eventsFrom({ items: [], changes: [merged, declined, draft].map(ref) });
    expect(events.map((e) => [e.kind, e.label, e.at.slice(11, 16), e.text, e.by])).toEqual([
      ['pr-opened', 'payments-web#41', '09:00', 'opened', 'Ada Lovelace'],
      ['pr-review', 'payments-web#41', '11:00', 'changes requested', 'bob'],
      ['pr-review', 'payments-web#41', '14:00', 'approved', 'bob'],
      ['pr-merged', 'payments-web#41', '15:00', 'merged into main', null],
      ['pr-opened', 'payments-web#42', '10:00', 'opened', 'Ada Lovelace'],
      ['pr-declined', 'payments-web#42', '16:00', 'closed without merging', null],
      ['pr-opened', 'payments-web#43', '12:00', 'opened as a draft', 'Ada Lovelace'],
    ]);
  });

  it('records a failing build, and a recovery only where a pass follows a failure, even one an earlier sync saw', () => {
    const pr = 'github:imagile/payments-web#41';
    const first = eventsFrom({ items: [], changes: [build(pr, 1, 'failed', at('10:00'))] });
    expect(first.map((e) => e.kind)).toEqual(['build-failed']);
    expect(first[0]).toMatchObject({ title: `for [[${pr}]]`, cites: [pr], text: 'failed (failure (test))' });
    // The next sync sees the same build id passing: GitHub keeps one build per pull request's head.
    const next = eventsFrom({ items: [], changes: [build(pr, 2, 'passed', at('12:00'))] }, first);
    expect(next.map((e) => [e.kind, e.at])).toEqual([['build-recovered', at('12:00')]]);
    // A pass with no failure before it is kept, to tell the next one apart, and shown nowhere.
    expect(eventsFrom({ items: [], changes: [build(pr, 3, 'passed', at('09:00'))] }).map((e) => e.kind)).toEqual(['build-passed']);
    // Within one listing, in time order: fail, pass, fail, pass.
    const runs = [build(pr, 1, 'failed', at('08:00'), 'a'), build(pr, 2, 'passed', at('09:00'), 'b'), build(pr, 3, 'failed', at('10:00'), 'c'), build(pr, 4, 'passed', at('11:00'), 'd')];
    expect(eventsFrom({ items: [], changes: runs }).map((e) => e.kind)).toEqual(['build-failed', 'build-recovered', 'build-failed', 'build-recovered']);
  });

  it('gives the same fact the same key every time, so recording it twice is one row', () => {
    const i = item('PAY-1', { history: { transitions: [{ from: 'To Do', to: 'Done', fromCategory: 'TODO', toCategory: 'DONE', at: at('09:00'), by: null }], iterations: [] } });
    expect(eventsFrom({ items: [i], changes: [] })[0]!.key).toBe(eventsFrom({ items: [{ ...i, title: 'Renamed' }], changes: [] })[0]!.key);
  });
});

describe('what a sync sees', () => {
  const blocker = item('PAY-2');
  const blocked = (links: WorkItem['links']) => item('PAY-1', { links });
  const link = { type: 'blocks' as const, direction: 'inward' as const, target: 'jira:PAY-2', name: 'is blocked by' };

  it('sees nothing new on the first sync, since there is nothing to compare', () => {
    expect(observedEvents(null, { items: [blocked([link]), blocker], deployments: [] }, at('07:00'), null)).toEqual([]);
  });

  it('records a blocker that was not there before, at the sync that saw it, with the sync before', () => {
    const before = { items: [blocked([]), blocker], deployments: [] };
    const after = { items: [blocked([link]), blocker], deployments: [] };
    const [e, ...rest] = observedEvents(before, after, at('07:00'), at('07:00', '2026-10-11'));
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ kind: 'blocker', subject: 'jira:PAY-1', text: 'blocked by [[jira:PAY-2]]', cites: ['jira:PAY-1', 'jira:PAY-2'], observed: { previousSync: at('07:00', '2026-10-11') } });
    expect(markdownOf(buildDay(input({ events: [e!] })))).toContain('blocked by [PAY-2](https://jira.imagile.dev/browse/PAY-2) (first seen by the sync at 07:00 UTC; the one before ran 11 Oct 2026 07:00 UTC)');
    // Done blockers and items don't count, and nor does a blocker the last picture had.
    expect(observedEvents(after, after, at('08:00'), at('07:00'))).toEqual([]);
    expect(observedEvents(before, { items: [blocked([link]), { ...blocker, statusCategory: 'DONE' }], deployments: [] }, at('08:00'), null)).toEqual([]);
  });

  it("doesn't call a newly linked area's blockers new", () => {
    const github = item('imagile/web#1', { id: 'github:imagile/web#1', source: { area: 'github', connection: 'github', key: 'imagile/web#1', command: 'github issue list' }, links: [link] });
    expect(observedEvents({ items: [blocker], deployments: [] }, { items: [blocker, github], deployments: [] }, at('07:00'), null)).toEqual([]);
  });

  it('records a deployment that started failing, and one that came back', () => {
    const d = (outcome: Deployment['outcome'], state: string): Deployment => ({ id: 'openshift:pay-prod/api', environment: 'prod', source: 'openshift', command: 'openshift deployment list', name: 'api', commit: 'abc1234', version: null, state, outcome, url: null, includes: [], items: [], unknownCommit: false });
    const failing = observedEvents({ items: [], deployments: [d('passed', 'Available')] }, { items: [], deployments: [d('failed', 'ProgressDeadlineExceeded')] }, at('07:00'), null);
    expect(failing.map((e) => [e.kind, e.text])).toEqual([['deploy-failed', 'failing (ProgressDeadlineExceeded), was Available']]);
    const back = observedEvents({ items: [], deployments: [d('failed', 'ProgressDeadlineExceeded')] }, { items: [], deployments: [d('passed', 'Available')] }, at('08:00'), at('07:00'));
    expect(back.map((e) => e.kind)).toEqual(['deploy-recovered']);
  });
});

const syncs = (...list: Array<[string, string, boolean?]>): SyncRun[] => list.map(([area, when, ok = true]) => ({ area, at: when, ok, error: ok ? null : 'toil timed out' }));

function input(over: Partial<WorklogInput> = {}): WorklogInput {
  return { toilProject: 'card-payments', day: DAY, events: [], runs: [], applied: {}, notes: [], syncs: syncs(['jira', at('07:00', '2026-10-01')], ['jira', at('07:00')], ['jira', at('07:00', '2026-10-13')]), now: '2026-10-13T08:00:00.000Z', retentionDays: 30, ...over };
}

describe('what a page says it cannot vouch for', () => {
  it('nothing, for a day synced before, during and after', () => {
    expect(gapsFor(input())).toEqual([]);
  });

  it('a day before the earliest sync the cache holds', () => {
    const gaps = gapsFor(input({ syncs: syncs(['jira', at('07:00', '2026-10-13')]) }));
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatch(/^The earliest sync the cache holds is 13 Oct 2026 07:00 UTC, after this day\. .*new blockers and deployment changes are seen only by a sync/);
  });

  it('a day no sync ran on, naming the next one', () => {
    const gaps = gapsFor(input({ syncs: syncs(['jira', at('07:00', '2026-10-01')], ['github', at('07:00', '2026-10-01')], ['jira', at('07:00')], ['jira', at('07:00', '2026-10-13')], ['github', at('07:00', '2026-10-13')]) }));
    expect(gaps).toEqual(['No sync of github ran on this day, so blockers and deployment changes from it show on the day of the next one (13 Oct 2026 07:00 UTC).']);
  });

  it('a failed sync, and a source whose latest sync failed', () => {
    const gaps = gapsFor(input({ syncs: syncs(['jira', at('07:00', '2026-10-01')], ['jira', at('06:40'), false], ['jira', at('07:00')], ['jira', at('07:00', '2026-10-13'), false]) }));
    expect(gaps).toEqual([
      'The last sync of jira ran on this day; anything later in it shows after the next sync.',
      'The sync of jira failed at 06:40 UTC: toil timed out.',
      "The latest sync of jira failed (13 Oct 2026 07:00 UTC), so its events after its last good sync (12 Oct 2026 07:00 UTC) aren't here yet.",
    ]);
  });

  it('today, up to the last sync', () => {
    expect(gapsFor(input({ day: '2026-10-13' }))).toEqual(['Today so far: built from the syncs up to 07:00 UTC. Anything after that shows once the next sync runs.']);
  });

  it('a day past the retention', () => {
    expect(gapsFor(input({ day: '2026-09-01' }))[0]).toMatch(/^This day is older than the cache's 30 days retention/);
  });

  it('a Toil project never synced', () => {
    expect(gapsFor(input({ syncs: [] }))).toEqual(["Toil UI hasn't synced this Toil project successfully yet, so this page holds only what was recorded without a sync: notes and agent runs."]);
  });
});

const run = (over: Partial<AgentRun> = {}): AgentRun => ({
  id: 'run-1', kind: 'ask', toilProject: 'card-payments', startedAt: at('15:20'), finishedAt: at('15:21'), outcome: 'finished', by: 'Codex', prompt: 'What happened yesterday?', answer: 'PAY-1 moved, see [[jira:PAY-1]].', error: null,
  citations: ['jira:PAY-1'], unverified: [], proposals: [{ id: 'p1', title: 'Move PAY-1 to Done', item: 'jira:PAY-1', command: 'jira issue transition', input: { key: 'PAY-1', intent: 'done' } }, { id: 'p2', title: 'Split PAY-1', item: 'jira:PAY-1', command: null, input: null }],
  ...over,
});

describe('a page', () => {
  const page = () => {
    const i = item('PAY-1', { title: 'Retry *payouts* [twice]', history: { transitions: [{ from: 'To Do', to: 'Done', fromCategory: 'TODO', toCategory: 'DONE', at: at('09:00'), by: person('ada') }], iterations: [] } });
    const c = change(41, { state: 'MERGED', created: at('08:00', '2026-10-11'), mergedAt: at('15:00') });
    return input({
      events: eventsFrom({ items: [i], changes: [ref(c), build(c.id, 1, 'failed', at('10:00'))] }),
      runs: [run(), run({ id: 'run-0', startedAt: at('09:00', '2026-10-11'), finishedAt: null, outcome: 'failed', answer: null, error: 'Codex is not signed in.' })],
      applied: { p1: { state: 'applied', at: at('16:00'), via: 'cli' } },
      notes: [{ id: 'n1', at: at('17:30'), by: 'Ada', text: 'Paired on the <retry> fix' }],
    });
  };

  it('holds only that day, each part in time order', () => {
    const p = buildDay(page());
    expect(p.work.map((e) => e.kind)).toEqual(['status']);
    expect(p.prs.map((e) => e.kind)).toEqual(['pr-merged']);
    expect(p.delivery.map((e) => e.kind)).toEqual(['build-failed']);
    expect(p.agents.map((r) => r.run.id)).toEqual(['run-1']);
    expect(p.agents[0]!.proposals.map((x) => x.applied.state)).toEqual(['applied', 'no-command']);
    expect(p.notes).toHaveLength(1);
    expect(p.sources).toEqual([{ area: 'jira', syncs: 1, failed: 0, last: at('07:00') }]);
  });

  it('is the same page, byte for byte, however often it is built, whatever order its inputs came in', () => {
    const a = page();
    const b = { ...a, events: [...a.events].reverse(), notes: [...a.notes].reverse(), syncs: [...a.syncs].reverse() };
    expect(markdownOf(buildDay(b))).toBe(markdownOf(buildDay(a)));
    // The clock only decides which day it is.
    expect(markdownOf(buildDay({ ...a, now: '2026-10-13T23:59:00.000Z' }))).toBe(markdownOf(buildDay(a)));
  });

  it('links every line to its source, and escapes what a tracker wrote', () => {
    const md = markdownOf(buildDay(page()));
    expect(md).toContain('# Worklog: card-payments, Monday 12 October 2026');
    expect(md).toContain('- 09:00 [PAY-1](https://jira.imagile.dev/browse/PAY-1) Title of PAY-1: To Do → Done, by Ada Lovelace'.replace('Title of PAY-1', 'Retry \\*payouts\\* \\[twice\\]'));
    expect(md).toContain('- 15:00 [payments-web#41](https://github.com/imagile/payments-web/pull/41) Change 41: merged into main');
    expect(md).toContain('- 10:00 [CI #1](https://github.com/imagile/payments-web/actions/runs/1) for [payments-web#41](https://github.com/imagile/payments-web/pull/41): failed (failure (test))');
    expect(md).toContain('- 15:20–15:21 Asked Codex: "What happened yesterday?", finished, citing 1 item ([transcript](../runs/run-1.md))');
    expect(md).toContain("  - Proposal: Move PAY-1 to Done (`toil jira issue transition`), applied: toil's audit log has the write at 12 Oct 2026 16:00 UTC (cli)");
    expect(md).toContain('  - Proposal: Split PAY-1, toil has no command for it, so nothing to apply');
    expect(md).toContain('- 17:30 Ada: Paired on the \\<retry\\> fix');
    expect(md).toContain('- jira: 1 sync this day, the last at 07:00 UTC');
  });

  it('says so in every part that has nothing', () => {
    const md = markdownOf(buildDay(input()));
    for (const none of ['No status changes, sprint changes or new blockers recorded.', 'No pull requests opened, reviewed, merged or declined.', 'No builds or deployments failed or recovered.', 'No agent runs.', 'No notes.']) expect(md).toContain(none);
    expect(md).not.toContain('## Coverage');
  });

  it("puts a month's pages in one file, each a section", () => {
    const md = monthMarkdown('card-payments', '2026-10', [buildDay(page()), buildDay({ ...page(), day: '2026-10-11' })]);
    expect(md.split('\n').filter((l) => l.startsWith('## '))).toEqual(['## Worklog: card-payments, Monday 12 October 2026', '## Worklog: card-payments, Sunday 11 October 2026']);
  });

  it("keeps a run's transcript, labelled as the agent's", () => {
    const t = transcriptOf(run({ unverified: ['jira:PAY-9'], citations: ['jira:PAY-1', 'jira:PAY-9'] }));
    expect(t).toContain('Written by the agent, not by Toil UI');
    expect(t).toContain('- `jira:PAY-9` (unverified: no tool returned it)');
    expect(runFromAnswer({ id: 'r', kind: 'ask', toilProject: 'd', startedAt: at('09:00'), by: 'Codex', prompt: 'Q' }, at('09:01'), { prompt: 'Q', parts: [{ text: 'a' }, { text: 'b' }], citations: [], by: 'Codex', proposals: [] })).toMatchObject({ outcome: 'finished', answer: 'a\n\nb' });
  });

  it('escapes Markdown a tracker could have put in a title', () => {
    expect(escapeMd('a *b* [c](d) <e>\nf')).toBe('a \\*b\\* \\[c\\](d) \\<e\\> f');
  });
});

describe('publishing', () => {
  it('is a proposal per place the Toil project names, reading the exported file, and nothing else', () => {
    const areas = { github: { connection: { value: 'github' }, inputs: { owner: 'imagile', repo: 'payments-web' } }, confluence: { connection: { value: 'confluence' }, inputs: { space: 'PAY' } }, jira: { connection: null, inputs: { project: 'PAY' } } };
    const ps = publishProposals('card-payments', { day: DAY }, 'C:/Users/you/Documents/worklog-card-payments-2026-10-12.md', areas);
    expect(ps.map((p) => [p.command, p.input])).toEqual([
      ['confluence page create', { space: 'PAY', title: 'Worklog: card-payments, 2026-10-12', bodyFile: 'C:/Users/you/Documents/worklog-card-payments-2026-10-12.md', markdown: true }],
      ['github issue create', { owner: 'imagile', repo: 'payments-web', title: 'Worklog: card-payments, 2026-10-12', bodyFile: 'C:/Users/you/Documents/worklog-card-payments-2026-10-12.md' }],
    ]);
    expect(ps.every((p) => p.from === 'worklog')).toBe(true);
    expect(publishProposals('card-payments', { month: '2026-10' }, 'x.md', {})).toEqual([]);
    expect(exportName('card-payments', { month: '2026-10' })).toBe('worklog-card-payments-2026-10.md');
  });

  it('offers no Confluence page on a Cloud connection, which takes no Markdown, and still offers it on Data Center', () => {
    const on = (deployment: string) => publishProposals('card-payments', { day: DAY }, 'x.md', { confluence: { connection: { value: 'wiki', deployment }, inputs: { space: 'PAY' } } }).map((p) => p.command);
    expect(on('cloud')).toEqual([]);
    expect(on('server')).toEqual(['confluence page create']);
  });
});

describe('the sample worklog', () => {
  it('folds the sample Toil projects with the same code, and keeps nothing', async () => {
    const api = fixtureWorklog();
    const month = await api.month('checkout-web');
    expect(month).toMatchObject({ month: '2026-10', today: dayOf(FIXTURE_NOW), timeZone: 'UTC', retentionDays: 30 });
    expect(month.days.length).toBeGreaterThan(3);
    const yesterday = await api.day('checkout-web', addDays(dayOf(FIXTURE_NOW)!, -1));
    expect(yesterday.file).toBeNull();
    expect(yesterday.page.agents).toHaveLength(1);
    expect(yesterday.page.notes).toHaveLength(1);
    expect(yesterday.markdown).toBe(markdownOf(yesterday.page));
    expect((await api.day('checkout-web', yesterday.page.day)).markdown).toBe(yesterday.markdown);
    await expect(api.addNote('checkout-web', 'hello')).rejects.toThrow(/sample data/);
    await expect(api.exportTo('checkout-web', { day: DAY }, 'C:/out')).rejects.toThrow(/sample data/);
    await expect(api.day('checkout-web', '2026-10-14')).rejects.toThrow(/hasn't happened yet/);
  });

  it('has a page with a coverage note: the failed sync two days back', async () => {
    const api = fixtureWorklog();
    const day = addDays(dayOf(FIXTURE_NOW)!, -2);
    const { page } = await api.day('card-payments', day);
    expect(page.gaps.some((g) => g.startsWith('The sync of bitbucket failed at 06:40 UTC'))).toBe(true);
  });
});

describe('a fact recorded twice', () => {
  it('has one key, so the page lists it once', () => {
    const i = item('PAY-1', { history: { transitions: [{ from: 'To Do', to: 'Done', fromCategory: 'TODO', toCategory: 'DONE', at: at('09:00'), by: null }], iterations: [] } });
    const events: WorklogEvent[] = [...eventsFrom({ items: [i], changes: [] }), ...eventsFrom({ items: [i], changes: [] })];
    const byKey = [...new Map(events.map((e) => [e.key, e])).values()];
    expect(buildDay(input({ events: byKey })).work).toHaveLength(1);
  });
});

describe('what a sync sees for the theme moments (#419)', () => {
  const link = { type: 'blocks' as const, direction: 'inward' as const, target: 'jira:PAY-2', name: 'is blocked by' };

  it('records a blocker cleared, on an item still open, naming the blocker', () => {
    const before = { items: [item('PAY-1', { links: [link] }), item('PAY-2')], deployments: [] };
    const done = { items: [item('PAY-1', { links: [link] }), item('PAY-2', { statusCategory: 'DONE' })], deployments: [] };
    const [e, ...rest] = observedEvents(before, done, at('09:00'), at('07:00'));
    expect(rest).toEqual([]);
    expect(e).toMatchObject({ kind: 'blocker-cleared', subject: 'jira:PAY-1', text: 'no longer blocked by [[jira:PAY-2]]', observed: { previousSync: at('07:00') } });
    // An unlinked blocker clears it too; a blocked item that is itself done now doesn't count.
    expect(observedEvents(before, { items: [item('PAY-1'), item('PAY-2')], deployments: [] }, at('09:00'), at('07:00')).map((x) => x.kind)).toEqual(['blocker-cleared']);
    expect(observedEvents(before, { items: [item('PAY-1', { links: [link], statusCategory: 'DONE' }), item('PAY-2')], deployments: [] }, at('09:00'), at('07:00'))).toEqual([]);
    // A blocker whose whole source left the picture (an area unlinked from the toil project) clears nothing.
    const other = item('OPS-1', { source: { area: 'github', connection: 'github', key: 'OPS-1', command: 'github issue list' }, id: 'github:OPS-1' });
    const across = { ...link, target: 'github:OPS-1' };
    expect(observedEvents({ items: [item('PAY-1', { links: [across] }), other], deployments: [] }, { items: [item('PAY-1', { links: [across] })], deployments: [] }, at('09:00'), at('07:00'))).toEqual([]);
  });

  it("records a sprint's end once, at the sync after it, with its tally", () => {
    const iteration = { id: '42', name: 'Sprint 42', path: null, start: '2026-10-01T00:00:00.000Z', end: at('08:00'), state: 'past' as const };
    const points = (value: number) => ({ value, unit: 'points' as const, field: 'Story Points' });
    const items = [item('PAY-1', { iteration, statusCategory: 'DONE', estimate: points(3) }), item('PAY-2', { iteration, estimate: points(5) })];
    const snap = { items, deployments: [] };
    const [e] = observedEvents(snap, snap, at('09:00'), at('07:00'));
    expect(e).toMatchObject({ kind: 'sprint-ended', label: 'Sprint 42', text: 'ended: 1 of 2 items done, 3 of 8 points done', at: at('08:00') });
    // Before its end, and once the sync before already ran after it, there is nothing.
    expect(observedEvents(snap, snap, at('07:30'), at('07:00'))).toEqual([]);
    expect(observedEvents(snap, snap, at('10:00'), at('09:00'))).toEqual([]);
  });
});
