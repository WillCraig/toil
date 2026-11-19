import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { fixtureWorklog } from '../src/fixtures/worklog.ts';
import type { PersonEntry } from '../src/model/people.ts';
import {
  allLines, buildStandup, chipsOf, commentsReadFor, daysBetween, defaultRange, factsCited, lastWorkingDay, MAX_STANDUP_DAYS, presetOf, presetRange, rangeProblem, shorten, standupMarkdown, standupText, standupWriteUp, topRows, waitText,
  type StandupInput,
} from '../src/model/standup.ts';
import { buildDay, eventsFrom, type AgentRun, type SyncRun, type WorklogEvent } from '../src/model/worklog.ts';
import type { Change, ChangeRef, WorkItem } from '../src/toil.ts';
import { exportName, publishProposals } from '../src/worklog.ts';

/**
 * The stand-up's fold (#345, src/model/standup.ts): which list each fact goes
 * in and under whom, what is said as of the latest sync, and the promise the
 * worklog makes too, that the same inputs always give the same report.
 */

const ada = { id: 'ada', name: 'Ada Lovelace', email: 'ada@example.com' };
const adaJira = { id: 'alovelace', name: 'A. Lovelace', email: null };
const bob = { id: 'bob', name: 'Bob', email: null };

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
    repo: 'imagile/payments-web', title: `Change ${n}`, branch: { source: 'feature', target: 'main' }, state: 'OPEN', author: ada, authorKind: 'HUMAN', authorKindSource: 'default', authorKindSignal: null,
    reviewers: [], reviews: null, checks: null, checksAt: null, mergeable: null, size: null, workItems: [], mergeCommit: null, created: null, firstReviewAt: null, approvedAt: null, mergedAt: null, closedAt: null, updated: null, unmapped: [], native: {},
    ...over,
  } as Change;
}

const ref = (c: Change): ChangeRef => ({ id: c.id, kind: 'pull-request', source: 'github', command: 'github pr list', items: [], title: c.title, url: c.url, state: c.state, outcome: 'open', builds: null, mergeCommit: null, at: c.created ?? '', change: c });
const build = (pr: string | null, n: number, outcome: 'failed' | 'passed', at: string): ChangeRef => ({ id: `${pr ?? 'pipeline'}/checks/${n}`, kind: 'build', source: 'github', command: 'github commit checks', items: [], title: `CI #${n}`, url: `https://github.com/imagile/payments-web/actions/runs/${n}`, state: outcome === 'failed' ? 'failure (test)' : 'success', outcome, builds: pr, mergeCommit: null, at });

const MON = '2026-10-12';
const TUE = '2026-10-13';
const at = (time: string, day = MON) => `${day}T${time}:00.000Z`;
const PEOPLE: PersonEntry[] = [
  { name: 'Ada Lovelace', kind: 'human', email: 'ada@example.com', ids: { github: 'ada', jira: 'alovelace' } },
  { name: 'Claude', kind: 'agent', email: null, ids: { github: 'claude-bot' } },
  { name: 'Grace Hopper', kind: 'human', email: null, ids: { jira: 'ghopper' } },
];
const SYNCS: SyncRun[] = [
  { area: 'jira', at: at('07:00', '2026-10-11'), ok: true, error: null },
  { area: 'jira', at: at('07:00'), ok: true, error: null },
  { area: 'jira', at: at('07:00', TUE), ok: true, error: null },
  { area: 'github', at: at('07:00', '2026-10-11'), ok: true, error: null },
  { area: 'github', at: at('07:00'), ok: true, error: null },
];

/** A small toil project: Ada's jira and GitHub work, Bob reviewing, an agent's pull request, a sprint, a blocker and builds. */
function sample() {
  const sprint = { id: '42', name: 'Sprint 42', path: null, start: '2026-10-05T00:00:00.000Z', end: '2026-10-17T00:00:00.000Z', state: 'ACTIVE' };
  const done = item('PAY-1', { status: 'Done', statusCategory: 'DONE', assignee: adaJira, iteration: sprint as WorkItem['iteration'], history: { transitions: [{ from: 'In Review', to: 'Done', fromCategory: 'IN_PROGRESS', toCategory: 'DONE', at: at('15:00'), by: adaJira }], iterations: [] } });
  const moving = item('PAY-2', { assignee: adaJira, iteration: sprint as WorkItem['iteration'], history: { transitions: [{ from: 'To Do', to: 'In Progress', fromCategory: 'TODO', toCategory: 'IN_PROGRESS', at: at('09:00', TUE), by: adaJira }], iterations: [{ from: [], to: ['Sprint 42'], at: at('08:00'), by: bob }] } });
  const next = item('PAY-3', { status: 'To Do', statusCategory: 'TODO', assignee: { id: 'ghopper', name: 'G. Hopper', email: null }, iteration: sprint as WorkItem['iteration'] });
  const unassigned = item('PAY-4', { status: 'To Do', statusCategory: 'TODO', iteration: sprint as WorkItem['iteration'] });
  const merged = change(41, { state: 'MERGED', created: at('09:00'), mergedAt: at('16:00'), reviews: [{ by: bob, state: 'APPROVED', at: at('14:00') }] });
  const agentPr = change(52, { author: ada, authorKind: 'AGENT', authorKindSource: 'trailer', authorKindSignal: 'a Co-Authored-By: claude-bot trailer', created: at('10:00', TUE) });
  const waiting = change(39, { author: ada, created: '2026-10-07T09:00:00.000Z', reviewers: [{ person: bob, state: 'PENDING' }] } as Partial<Change>);
  const items = [done, moving, next, unassigned];
  const changes = [ref(merged), ref(agentPr), ref(waiting), build(merged.id, 1, 'failed', at('11:00')), build(merged.id, 2, 'passed', at('12:00')), build(null, 3, 'failed', at('13:00', TUE))];
  const blocker: WorklogEvent = {
    key: `blocker:${moving.id}:${next.id}:${at('07:00', TUE)}`, kind: 'blocker', at: at('07:00', TUE), subject: moving.id, source: 'jira', label: 'PAY-2', title: moving.title, url: moving.url, by: null, text: `blocked by [[${next.id}]]`,
    cites: [moving.id, next.id], refs: { [moving.id]: { label: 'PAY-2', url: moving.url }, [next.id]: { label: 'PAY-3', url: next.url } }, observed: { previousSync: at('07:00') }, who: adaJira,
  };
  const events = [...eventsFrom({ items, changes }), blocker];
  return { items, pullRequests: [merged, agentPr, waiting], events };
}

const assignment: AgentRun = { id: 'run-1', kind: 'assignment', toilProject: 'card-payments', startedAt: at('11:30'), finishedAt: at('11:50'), outcome: 'finished', by: 'Claude (sonnet)', prompt: 'Fix the retry', answer: 'Done', error: null, citations: [], unverified: [], proposals: [] };

function input(over: Partial<StandupInput> = {}): StandupInput {
  const s = sample();
  const pages = daysBetween(MON, TUE).map((day) => buildDay({ toilProject: 'card-payments', day, events: s.events, runs: [assignment], applied: {}, notes: [], syncs: SYNCS, now: at('12:00', TUE), retentionDays: 30 }));
  return { toilProject: 'card-payments', from: MON, to: TUE, pages, people: PEOPLE, items: s.items, pullRequests: s.pullRequests, asOf: at('07:00', TUE), ...over };
}

const texts = (lines: Array<{ label: string; text: string }>) => lines.map((l) => `${l.label}: ${l.text}`);

describe('ranges', () => {
  it('default to since the last working day, so a Monday reaches back to Friday', () => {
    expect(lastWorkingDay('2026-10-13')).toBe('2026-10-12');
    expect(lastWorkingDay('2026-10-12')).toBe('2026-10-09');
    expect(lastWorkingDay('2026-10-11')).toBe('2026-10-09');
    expect(defaultRange('2026-10-12')).toEqual({ from: '2026-10-09', to: '2026-10-12' });
    expect(daysBetween('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('refuse what a report cannot cover, saying why', () => {
    expect(rangeProblem('2026-10-12', '2026-10-13', '2026-10-13')).toBeNull();
    expect(rangeProblem('2026-10-13', '2026-10-12', '2026-10-13')).toBe('The range starts (2026-10-13) after it ends (2026-10-12).');
    expect(rangeProblem('2026-10-12', '2026-10-14', '2026-10-13')).toMatch(/hasn't happened yet/);
    expect(rangeProblem('2026-02-30', '2026-03-01', '2026-10-13')).toBe('Name the range as two days, yyyy-mm-dd.');
    expect(rangeProblem('2026-08-01', '2026-10-13', '2026-10-13')).toBe(`A stand-up covers at most ${MAX_STANDUP_DAYS} days; 2026-08-01 to 2026-10-13 is 74.`);
    expect(rangeProblem('2026-09-13', '2026-10-13', '2026-10-13')).toBeNull();
    // Counted by arithmetic: centuries are refused at once, with the count right.
    expect(rangeProblem('0001-01-01', '2026-10-13', '2026-10-13')).toBe(`A stand-up covers at most ${MAX_STANDUP_DAYS} days; 0001-01-01 to 2026-10-13 is 739902.`);
  });
});

describe('the fold', () => {
  it("puts one person's Jira and GitHub work under one name, in done, in progress, blocked and next", () => {
    const r = buildStandup(input());
    const adaLines = r.people.find((p) => p.name === 'Ada Lovelace')!.lines;
    expect(texts(adaLines.done)).toEqual(['PAY-1: In Review → Done', 'payments-web#41: merged into main']);
    expect(texts(adaLines.progress)).toEqual(['payments-web#41: opened', 'PAY-2: To Do → In Progress']);
    expect(texts(adaLines.blocked)).toEqual(['CI #1: failed (failure (test))', 'PAY-2: blocked by [[jira:PAY-3]]', 'payments-web#39: waiting on review for 3.9 working days: no approval yet from Bob']);
    expect(adaLines.next).toEqual([]);
  });

  it("gives a review to the reviewer, an agent's pull request to the Toil project's agent, and Next from the sprint", () => {
    const r = buildStandup(input());
    const bobs = r.people.find((p) => p.key === 'id:github:bob')!;
    expect(bobs).toMatchObject({ name: 'Bob', mapped: false, account: { area: 'github', id: 'bob' } });
    expect(texts(bobs.lines.progress)).toEqual(['payments-web#41: approved']);
    const claude = r.people.find((p) => p.name === 'Claude')!;
    expect(claude.kind).toBe('agent');
    expect(texts(claude.lines.progress)).toEqual(['payments-web#52: opened, with Ada Lovelace']);
    expect(texts(claude.lines.done)).toEqual(['Assignment: "Fix the retry", finished']);
    const grace = r.people.find((p) => p.name === 'Grace Hopper')!;
    expect(texts(grace.lines.next)).toEqual(['PAY-3: To Do, in Sprint 42']);
  });

  it('puts the sprint, scope changes and what broke or recovered in the team lines, the sprint first', () => {
    const r = buildStandup(input());
    expect(texts(r.team)).toEqual([
      'Sprint 42: 3 working days left (day 7 of 10); 1 of 4 items done',
      'PAY-2: added to Sprint 42, by Bob',
      'CI #2: passing again after a failure',
      'CI #3: failed (failure (test))',
    ]);
  });

  it('lists everyone in the Toil project, empty or not, and an unmapped account only with lines; nobody is left out', () => {
    const r = buildStandup(input({ people: [...PEOPLE, { name: 'Linus', kind: 'human', email: null, ids: {} }] }));
    expect(r.people.map((p) => p.name)).toEqual(['Ada Lovelace', 'Bob', 'Claude', 'Grace Hopper', 'Linus']);
    expect(r.people.find((p) => p.name === 'Linus')!.lines).toEqual({ done: [], progress: [], blocked: [], next: [], comments: [] });
  });

  it('orders lines with no time by their ids as numbers, so #9 comes before #10', () => {
    const s = input();
    const grace = { id: 'ghopper', name: 'G. Hopper', email: null };
    const sprint = s.items[0]!.iteration;
    const more = ['PAY-10', 'PAY-9'].map((k) => item(k, { status: 'To Do', statusCategory: 'TODO', assignee: grace, iteration: sprint }));
    const r = buildStandup({ ...s, items: [...s.items, ...more] });
    expect(r.people.find((p) => p.name === 'Grace Hopper')!.lines.next.map((l) => l.label)).toEqual(['PAY-3', 'PAY-9', 'PAY-10']);
  });

  it('numbers every line in the order it shows, and finds the numbers a write-up names', () => {
    const r = buildStandup(input());
    const lines = allLines(r);
    expect(lines.map((l) => l.fact)).toEqual(lines.map((_, i) => `F${i + 1}`));
    expect(r.facts).toBe(lines.length);
    expect(factsCited('Ada merged it (F3, F5). Nothing else (F999). F3 again.', r)).toEqual(['F3', 'F5']);
  });

  it('gives the same report for the same days however its input is ordered, byte for byte', () => {
    const a = buildStandup(input());
    const shuffled = input();
    const b = buildStandup({ ...shuffled, pages: [...shuffled.pages].reverse(), items: [...shuffled.items].reverse(), pullRequests: [...shuffled.pullRequests].reverse(), people: [...shuffled.people].reverse() });
    expect(standupMarkdown(b)).toBe(standupMarkdown(a));
    expect(standupText(b)).toBe(standupText(a));
    expect(b).toEqual(a);
  });

  it('places a fact recorded before #345, with no who, by the name its line gives', () => {
    const s = input();
    const old = s.pages.map((p) => ({ ...p, work: p.work.map(({ who: _who, toCategory: _c, ...e }) => e) }));
    const r = buildStandup({ ...s, pages: old });
    // The worklog line named the mover by name only, so the toil project can't map it to Ada; the item's history still says the move was into Done.
    expect(texts(r.people.find((p) => p.key === 'id:jira:a. lovelace')!.lines.done)).toEqual(['PAY-1: In Review → Done']);
  });

  it('skips a transition with an unparseable time when reading the category of an old fact, rather than throw', () => {
    const s = input();
    const items = s.items.map((i) => (i.id === 'jira:PAY-1' ? { ...i, history: { transitions: [{ from: 'To Do', to: 'Done', fromCategory: 'TODO' as const, toCategory: 'DONE' as const, at: 'not a time', by: null }, ...i.history!.transitions], iterations: [] } } : i));
    const pages = s.pages.map((p) => ({ ...p, work: p.work.map(({ toCategory: _c, ...e }) => e) }));
    const r = buildStandup({ ...s, items, pages });
    expect(r.people.find((p) => p.name === 'Ada Lovelace')!.lines.done.map((l) => l.label)).toContain('PAY-1');
  });

  it('says what the worklog cannot vouch for, each gap once with the days it covers, after anything it could not read', () => {
    const r = buildStandup(input({ notes: ["The Toil project's \"people\" isn't a list, so nobody is mapped."] }));
    expect(r.gaps[0]).toBe("The Toil project's \"people\" isn't a list, so nobody is mapped.");
    expect(r.gaps).toContain('13 Oct 2026: Today so far: built from the syncs up to 07:00 UTC. Anything after that shows once the next sync runs.');
    expect(r.gaps).toContain('12 Oct 2026: The last sync of github ran on this day; anything later in it shows after the next sync.');
    // The same words on every day of the range are said once.
    const twice = buildStandup(input({ pages: input().pages.map((p) => ({ ...p, gaps: ['The same gap.'] })) }));
    expect(twice.gaps).toEqual(['Every day: The same gap.']);
  });

  it('says nothing as of a sync when there has been none', () => {
    const r = buildStandup(input({ asOf: null }));
    expect(r.team.some((l) => l.subject.startsWith('sprint:'))).toBe(false);
    expect(r.people.flatMap((p) => p.lines.next)).toEqual([]);
    expect(standupText(r)).toMatch(/^Stand-up · /);
    expect(r.sprintLine).toBeNull();
    expect(r.sprint).toBeNull();
    expect(standupMarkdown(r)).toContain('No current sprint to take it from.');
    expect(standupMarkdown(buildStandup(input()))).toContain('Nothing assigned and not started in Sprint 42.');
  });
});

describe('the text', () => {
  it('is Markdown with every line linked, and plain text with each URL spelled out', () => {
    const r = buildStandup(input());
    const md = standupMarkdown(r);
    expect(md).toMatch(/^# Stand-up: card-payments, 12 Oct 2026 to 13 Oct 2026\n/);
    expect(md).toContain('## Ada Lovelace\n\n**Done**\n\n- [PAY-1](https://jira.imagile.dev/browse/PAY-1) Title of PAY-1: In Review → Done (12 Oct 2026 15:00 UTC)');
    expect(md).toContain('- [PAY-2](https://jira.imagile.dev/browse/PAY-2) Title of PAY-2: blocked by [PAY-3](https://jira.imagile.dev/browse/PAY-3) (13 Oct 2026 07:00 UTC)');
    expect(md).toContain('## Claude (agent)');
    expect(md).toContain("## Bob (github bob), not in the Toil project's people");
    // The Markdown keeps its links; the copied text has none.
    expect(standupText(r)).not.toMatch(/\]\(|https?:/);
  });

  it('keeps every line of the copied text on one line, whatever line breaks a title or a name has', () => {
    const s = input({ people: [{ name: 'Ada\nLovelace', kind: 'human', email: null, ids: { github: 'ada', jira: 'alovelace' } }] });
    const pages = s.pages.map((p) => ({ ...p, work: p.work.map((e) => ({ ...e, title: 'First line\r\nsecond line' })) }));
    const text = standupText(buildStandup({ ...s, pages }));
    expect(text).toContain('PAY-1 First line second line (In Review → Done)');
    expect(text.split('\n').some((l) => l.startsWith('Ada Lovelace — '))).toBe(true);
    expect(text).not.toMatch(/\nsecond line/);
  });

  it('puts people in name order without case, by code, the same on every runtime', () => {
    const r = buildStandup(input({ people: [{ name: 'bob', kind: 'human', email: null, ids: {} }, { name: 'Ada', kind: 'human', email: null, ids: {} }, { name: 'Ada 10', kind: 'human', email: null, ids: {} }, { name: 'Ada 9', kind: 'human', email: null, ids: {} }] }));
    expect(r.people.filter((p) => p.mapped).map((p) => p.name)).toEqual(['Ada', 'Ada 9', 'Ada 10', 'bob']);
  });

  it("escapes a tracker's Markdown so a title can't make a link or a heading", () => {
    const s = input();
    const pages = s.pages.map((p) => ({ ...p, work: p.work.map((e) => ({ ...e, title: '# [click](https://evil.imagile.dev)' })) }));
    const md = standupMarkdown(buildStandup({ ...s, pages }));
    expect(md).not.toContain('[click](https://evil.imagile.dev)');
    expect(md).toContain('# \\[click\\](https://evil.imagile.dev)');
  });

  it('times a one-day report by the clock alone', () => {
    const s = input();
    const r = buildStandup({ ...s, from: MON, to: MON });
    expect(standupMarkdown(r)).toContain('In Review → Done (15:00 UTC)');
    expect(standupWriteUp(MON, MON)).toBe('Write up the stand-up for 2026-10-12');
    expect(standupWriteUp(MON, TUE)).toBe('Write up the stand-up for 2026-10-12 to 2026-10-13');
  });
});

describe('export and publishing', () => {
  it('names the file by the range, and proposes publishing it as a stand-up', () => {
    expect(exportName('card-payments', { from: MON, to: TUE })).toBe('standup-card-payments-2026-10-12-to-2026-10-13.md');
    expect(exportName('card-payments', { from: MON, to: MON })).toBe('standup-card-payments-2026-10-12.md');
    const [page] = publishProposals('card-payments', { from: MON, to: TUE }, 'C:/out/standup.md', { confluence: { connection: null, inputs: { space: 'PAY' } } });
    expect(page).toMatchObject({ id: 'stand-up:card-payments:2026-10-12-to-2026-10-13:confluence', title: 'Publish the stand-up as a Confluence page in PAY', input: { space: 'PAY', title: 'Stand-up: card-payments, 2026-10-12 to 2026-10-13', bodyFile: 'C:/out/standup.md', markdown: true } });
  });
});

describe('the sample', () => {
  it('builds a stand-up for each sample Toil project, the same twice', async () => {
    const api = fixtureWorklog();
    const range = defaultRange(FIXTURE_NOW.slice(0, 10));
    for (const toilProject of ['card-payments', 'settlement', 'checkout-web']) {
      const a = await api.standup(toilProject, range.from, range.to);
      const b = await api.standup(toilProject, range.from, range.to);
      expect(a.markdown).toBe(b.markdown);
      expect(a.report.facts).toBeGreaterThan(0);
    }
  });
});

describe('sinceText', () => {
  it('says yesterday, the weekday since, today, or the dates of a range that isn\x27t the default', async () => {
    const { sinceText } = await import('../src/model/standup.ts');
    expect(sinceText({ from: '2026-10-12', to: '2026-10-13' }, '2026-10-13')).toBe('Yesterday');
    expect(sinceText({ from: '2026-10-09', to: '2026-10-12' }, '2026-10-12')).toBe('Since Friday (9 Oct 2026)');
    expect(sinceText({ from: '2026-10-13', to: '2026-10-13' }, '2026-10-13')).toBe('Today');
    expect(sinceText({ from: '2026-10-01', to: '2026-10-02' }, '2026-10-13')).toBe('1 Oct 2026 to 2 Oct 2026');
  });
});

describe('comments', () => {
  const comment = (id: string, who: { id: string; name: string | null; email: string | null }, when: string, text: string) => ({ id, author: who, at: when, text, url: `https://jira.imagile.dev/browse/PAY-1?focusedCommentId=${id}` });
  const ghopper = { id: 'ghopper', name: 'G. Hopper', email: null };
  const OLD = '2026-10-05T09:00:00.000Z';

  /** Ada asked one question that Grace answered, and two nobody answered long ago; Grace asked one yesterday that nobody answered. */
  function withComments(items: WorkItem[]): WorkItem[] {
    const by: Record<string, WorkItem['comments']> = {
      'jira:PAY-1': [comment('1', adaJira, at('09:00'), 'Why did this fail?'), comment('2', ghopper, at('11:00'), 'The config was stale.'), comment('3', adaJira, at('12:00'), 'Thanks, fixed.')],
      'jira:PAY-2': [comment('4', ghopper, at('10:00'), 'Is the retry safe to ship?')],
      'jira:PAY-3': [comment('5', adaJira, OLD, 'Ping?'), comment('6', adaJira, '2026-10-06T09:00:00.000Z', 'Ping again, anyone?')],
      'jira:PAY-4': [],
    };
    return items.map((i) => ({ ...i, comments: by[i.id] ?? [] }));
  }
  const report = () => buildStandup(input({ items: withComments(input().items) }));
  const mine = (name: string) => report().people.find((p) => p.name === name)!.lines.comments;

  it("lists a person's comments in the range, their unanswered questions first however old", () => {
    const lines = mine('Ada Lovelace');
    expect(lines.map((l) => [l.label, l.text, l.comment!.outstanding])).toEqual([
      ['PAY-3', 'Ping?', true],
      ['PAY-3', 'Ping again, anyone?', true],
      ['PAY-1', 'Why did this fail?', false],
      ['PAY-1', 'Thanks, fixed.', false],
    ]);
    // Counted in UTC days to the sync (13 Oct 07:00): 8 and 7.
    expect(lines.map((l) => l.comment!.ageDays)).toEqual([8, 7, null, null]);
    expect(lines[0]!.url).toContain('focusedCommentId=5');
  });

  it("does not call a question outstanding once someone else answered it, and an author's own later comment is no answer", () => {
    // Grace answered Ada's question on PAY-1; Ada's own "Thanks" under it changes nothing; Ada's two pings on PAY-3 answer each other not at all.
    expect(mine('Ada Lovelace').filter((l) => l.comment!.outstanding).map((l) => l.text)).toEqual(['Ping?', 'Ping again, anyone?']);
    // Grace's own answer is a comment, not a question; her question from yesterday has no reply.
    const grace = mine('Grace Hopper');
    expect(grace.map((l) => [l.text, l.comment!.question, l.comment!.outstanding, l.comment!.ageDays])).toEqual([
      ['Is the retry safe to ship?', true, true, 1],
      ['The config was stale.', false, false, null],
    ]);
  });

  it('says which trackers came with their comments, and which did not, so a dash is never a quiet zero', () => {
    expect(report().comments).toEqual({ read: ['jira'], notRead: [] });
    const unread = buildStandup(input());
    expect(unread.comments).toEqual({ read: [], notRead: ['jira'] });
    expect(unread.people.flatMap((p) => p.lines.comments)).toEqual([]);
  });

  it("decides read or not read for each person from the trackers their lines come from, so a GitHub-only person's empty Comments is not a quiet zero", () => {
    const r = report();
    const bobGroup = r.people.find((p) => p.name === 'Bob')!;
    // Bob only reviewed a GitHub pull request, and no GitHub comments were read.
    expect(bobGroup.areas).toEqual(['github']);
    expect(commentsReadFor(r, bobGroup)).toBe(false);
    expect(commentsReadFor(r, r.people.find((p) => p.name === 'Grace Hopper')!)).toBe(true);
    // A mapped person with no lines yet stands for the trackers their accounts are in.
    const linus = buildStandup(input({ items: withComments(input().items), people: [...PEOPLE, { name: 'Linus', kind: 'human', email: null, ids: { jira: 'linus' } }] })).people.find((p) => p.name === 'Linus')!;
    expect(commentsReadFor(r, linus)).toBe(true);
    const md = standupMarkdown(r);
    const bobBlock = md.slice(md.indexOf('## Bob'));
    expect(bobBlock.slice(bobBlock.indexOf('**Comments**'))).toContain('Comments not read yet.');
    expect(bobBlock.slice(bobBlock.indexOf('**Comments**'))).not.toContain('No comments.');
  });

  it('keeps tracker text as text: a citation marker in a comment is spaced out so it cannot name an item', () => {
    const s = input();
    const items = s.items.map((i) => (i.id === 'jira:PAY-2' ? { ...i, comments: [comment('9', ghopper, at('10:00'), 'See [[jira:PAY-1]] <b>now</b>?')] } : i));
    const line = buildStandup({ ...s, items }).people.find((p) => p.name === 'Grace Hopper')!.lines.comments[0]!;
    expect(line.text).toBe('See [ [jira:PAY-1]] <b>now</b>?');
    expect(line.cites).toEqual(['jira:PAY-2']);
  });

  it('folds lines about one item into one chip, and keeps each comment as its own', () => {
    const ada = report().people.find((p) => p.name === 'Ada Lovelace')!;
    expect(chipsOf(ada.lines.progress).map((c) => c.label)).toEqual(['payments-web#41', 'PAY-2']);
    expect(chipsOf(ada.lines.blocked).find((c) => c.label === 'PAY-2')!.texts).toEqual(['blocked by PAY-3']);
    expect(chipsOf(ada.lines.comments)).toHaveLength(4);
  });

  it('copies as one line per person, tight, with the team line first and the questions marked', () => {
    const text = standupText(report());
    const lines = text.split('\n');
    expect(lines[0]).toBe('Sprint 42: day 7 of 10, 1 of 4 done · 12 Oct 2026 to 13 Oct 2026 · Team: PAY-2 added to Sprint 42, by Bob; CI #2 passing again after a failure; CI #3 failed (failure (test))');
    expect(lines).toContain('Grace Hopper — Next: PAY-3 Title of PAY-3 (To Do, in Sprint 42). Comments: PAY-2 "Is the retry safe to ship?" (1 day, no reply), PAY-1 "The config was stale."');
    expect(lines.find((l) => l.startsWith('Ada Lovelace — '))).toBe(
      'Ada Lovelace — Done: PAY-1 Title of PAY-1 (In Review → Done), payments-web#41 Change 41 (merged into main). In progress: payments-web#41 Change 41 (opened), PAY-2 Title of PAY-2 (To Do → In Progress). Blocked: CI #1 for payments-web#41 (failed (failure (test))), PAY-2 Title of PAY-2 (blocked by PAY-3), payments-web#39 Change 39 (waiting on review for 3.9 working days:…). Comments: PAY-3 "Ping?" (8 days, no reply), PAY-3 "Ping again, anyone?" (7 days, no reply), PAY-1 "Why did this fail?", PAY-1 "Thanks, fixed."',
    );
    expect(lines.some((l) => l.startsWith('Claude (agent) — '))).toBe(true);
    // Not a paragraph of boilerplate: a header and a line a person.
    expect(lines).toHaveLength(1 + report().people.length);
    expect(text).not.toMatch(/Review waits|Built by Toil UI/);
  });

  it('caps a bucket at five items in the copied text, with the rest counted', () => {
    const s = input();
    const sprint = s.items[0]!.iteration;
    const more = ['PAY-10', 'PAY-11', 'PAY-12', 'PAY-13', 'PAY-14', 'PAY-15', 'PAY-16'].map((k) => item(k, { status: 'To Do', statusCategory: 'TODO', assignee: { id: 'ghopper', name: 'G. Hopper', email: null }, iteration: sprint }));
    const text = standupText(buildStandup({ ...s, items: [...s.items, ...more] }));
    expect(text).toContain('Next: PAY-3 Title of PAY-3 (To Do, in Sprint 42), PAY-10 Title of PAY-10 (To Do, in Sprint 42), PAY-11 Title of PAY-11 (To Do, in Sprint 42), PAY-12 Title of PAY-12 (To Do, in Sprint 42), PAY-13 Title of PAY-13 (To Do, in Sprint 42), +3 more');
  });

  it('puts a person with nothing at all on one short line', () => {
    const text = standupText(buildStandup(input({ people: [...PEOPLE, { name: 'Linus', kind: 'human', email: null, ids: {} }] })));
    expect(text.split('\n')).toContain('Linus — nothing recorded');
  });

  it('is the same report however its comments are ordered', () => {
    const a = report();
    const s = input({ items: withComments(input().items).map((i) => ({ ...i, comments: [...(i.comments ?? [])].reverse() })) });
    expect(buildStandup(s)).toEqual(a);
  });

  it('shortens a long text on one line, and says how long a question has waited', () => {
    expect(shorten('a   b\n c', 10)).toBe('a b c');
    expect(shorten('abcdefghij', 6)).toBe('abcde…');
    expect(waitText(0)).toBe('today, no reply');
    expect(waitText(1)).toBe('1 day, no reply');
    expect(waitText(4)).toBe('4 days, no reply');
  });
});

describe('days', () => {
  it('maps each preset to its range, and a range back to its preset', () => {
    const today = '2026-10-13';
    expect(presetRange('default', today, null)).toEqual({ from: '2026-10-12', to: today });
    expect(presetRange('today', today, null)).toEqual({ from: today, to: today });
    expect(presetRange('week', today, null)).toEqual({ from: '2026-10-07', to: today });
    expect(presetRange('sprint', today, '2026-10-05')).toEqual({ from: '2026-10-05', to: today });
    expect(presetRange('sprint', today, null)).toBeNull();
    expect(presetRange('sprint', today, '2026-10-14')).toBeNull();
    expect(presetRange('custom', today, null)).toBeNull();
    expect(presetOf({ from: '2026-10-12', to: today }, false, today, null)).toBe('default');
    expect(presetOf({ from: today, to: today }, true, today, null)).toBe('today');
    expect(presetOf({ from: '2026-10-07', to: today }, true, today, null)).toBe('week');
    expect(presetOf({ from: '2026-10-05', to: today }, true, today, '2026-10-05')).toBe('sprint');
    expect(presetOf({ from: '2026-10-01', to: '2026-10-02' }, true, today, null)).toBe('custom');
  });

  it('picks the Summary rows that matter first: unanswered questions, then blocked, done, in progress', () => {
    const s = input();
    const items = s.items.map((i) => (i.id === 'jira:PAY-2' ? { ...i, comments: [{ id: '4', author: { id: 'ghopper', name: 'G. Hopper', email: null }, at: at('10:00'), text: 'Is the retry safe to ship?', url: null }] } : i));
    const rows = topRows(buildStandup({ ...s, items }), 4);
    // Ada's blocked and done are one row: a person is listed once, however many buckets of theirs made the cut.
    expect(rows.map((r) => [r.group.name, r.parts.map((p) => p.bucket)])).toEqual([['Grace Hopper', ['comments']], ['Ada Lovelace', ['blocked', 'done']], ['Claude', ['done']]]);
  });
});
