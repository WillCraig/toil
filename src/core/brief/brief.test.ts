import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Change, WorkItem } from '../owi/types.js';
import { brief, LENSES, standardSettings, type BriefSettings } from './brief.js';
import { readBriefRecords } from './read.js';
import { workingDays } from './time.js';

// Sprint 42 across three trackers, and the pull requests that name its items (test/fixtures/owi/sprint.ts says what each holds),
// read as two pretty-printed util owi map outputs run together, the way `cat items.json prs.json` passes them.
const fixture = (name: string) => readFileSync(`test/fixtures/owi/${name}`, 'utf8');
const records = readBriefRecords(`${fixture('sprint-42.owi.json')}${fixture('pull-requests.owi.json')}`);
const AS_OF = '2026-10-14T08:00:00Z';
const sprint42 = (settings: BriefSettings = standardSettings(2)) => brief({ items: records.items, changes: records.changes, asOf: AS_OF, settings });

function item(id: string, extra: Partial<WorkItem> = {}): WorkItem {
  const key = id.slice(id.indexOf(':') + 1);
  return { id, source: { area: 'jira', connection: 'corp-jira', key, command: 'jira issue search' }, url: `https://jira.imagile.dev/browse/${key}`, title: key, status: 'In Progress', statusCategory: 'IN_PROGRESS', assignee: { id: 'pat', name: 'Pat Example', email: null }, estimate: null, links: [], updated: AS_OF, ...extra } as WorkItem;
}
function change(id: string, extra: Partial<Change>): Change {
  return { id, repo: 'PAY/core', title: id, url: null, state: 'OPEN', checks: 'PASSING', checksAt: null, workItems: [], created: AS_OF, firstReviewAt: AS_OF, mergedAt: null, reviewers: [], unmapped: [], ...extra } as Change;
}
const blocks = (target: string) => ({ type: 'blocks' as const, direction: 'outward' as const, target, name: 'blocks' });
const blockedBy = (target: string) => ({ type: 'blocks' as const, direction: 'inward' as const, target, name: 'is blocked by' });
const sprint = (name: string, start: string, end: string) => ({ id: name, name, path: null, start, end, state: null });

describe('the briefing on Sprint 42', () => {
  const b = sprint42();

  it('reads every item and pull request from two util owi map outputs', () => {
    expect([records.items.length, records.changes.length, records.skipped]).toEqual([29, 16, []]);
  });

  it('recommends the failing checks that hold up the chain', () => {
    expect(b.recommendation).toEqual({ text: 'Fix the failing checks on [[corp-jira:PAY-101]] first: it holds up 2 items (11 points).', items: ['corp-jira:PAY-101'] });
  });

  it('applies the lenses in order, and puts each item under one reason', () => {
    expect(b.reasons.map((r) => [r.lens, r.items.map((i) => i.key)])).toEqual([
      ['failing', ['PAY-101', 'PAY-100', 'imagile/payments-web#43']],
      ['blocked', ['PAY-102', 'PAY-103', '2303']],
      ['waiting', ['PAY-104', 'imagile/payments-web#41', 'imagile/payments-web#42']],
      ['sprint', []],
      ['stale', ['2302', '2301', '2304']],
      ['drift', ['imagile/payments-web#44']],
    ]);
    const ids = b.reasons.flatMap((r) => r.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('says why each item is there and where it came from, and links it to its tracker', () => {
    const pay101 = b.reasons[0]!.items[0]!;
    expect(pay101).toMatchObject({
      url: 'https://jira.imagile.dev/browse/PAY-101',
      source: { area: 'jira', connection: 'corp-jira', key: 'PAY-101' },
      why: 'Checks fail on [[corp-bitbucket:PAY/payments-core#311]], for 1.7 days.',
      evidence: ['corp-bitbucket:PAY/payments-core#311'],
      holds: { items: 2, points: 11 },
    });
    expect(pay101.changes[0]).toMatchObject({ id: 'corp-bitbucket:PAY/payments-core#311', repo: 'PAY/payments-core', state: 'OPEN', checks: 'FAILING' });
    expect(b.reasons[2]!.items[0]!.why).toBe('[[corp-bitbucket:PAY/payments-core#305]] has waited 4.9 working days for its first review.');
    expect(b.reasons.at(-1)!.items[0]!.why).toBe('Done while [[bitbucket-cloud:imagile/checkout-sdk#12]] is still open.');
  });

  it("weighs the sprint's pace against what is left", () => {
    expect(b.sprint).toMatchObject({ name: 'Sprint 42', points: { total: 21, done: 3, left: 18 }, pace: 0.4, projected: 1 });
    expect(b.reasons[3]!.text).toBe('Sprint 42 has done 3 points of 21 in 7 working days, 0.4 a day. At that pace about 1 of the 18 points left land by 2026-10-16.');
  });

  it("doesn't judge the pace until a quarter of the sprint has gone", () => {
    const early = brief({ items: records.items, changes: records.changes, asOf: '2026-10-06T12:00:00Z', settings: standardSettings(2) });
    expect(early.sprint).toMatchObject({ name: 'Sprint 42', pace: null, projected: null });
    expect(early.reasons.map((r) => r.lens)).not.toContain('sprint');
  });

  it('counts what is on track instead of listing it', () => {
    expect(b.onTrack).toEqual({ open: 3, done: 13 });
  });

  it('follows the order and thresholds a toil project sets, and leaves a lens out when it is off', () => {
    const settings = standardSettings(2);
    settings.lenses = [{ id: 'blocked', on: true, threshold: null }, { id: 'failing', on: false, threshold: 24 }, { id: 'waiting', on: true, threshold: 5 }];
    const tuned = sprint42(settings);
    expect(tuned.reasons.map((r) => r.lens)).toEqual(['blocked']);
    expect(tuned.recommendation!.text).toBe("Unblock [[corp-jira:PAY-102]] first: it holds up 1 item (8 points). Blocked by [[corp-jira:PAY-101]], which isn't done.");
    expect(tuned.lenses.map((l) => [l.id, l.checked])).toEqual([['blocked', true], ['failing', false], ['waiting', true]]);
  });

  it("says why a lens wasn't checked, rather than guessing", () => {
    const notes = Object.fromEntries(sprint42(standardSettings(null)).lenses.map((l) => [l.id, l.note]));
    expect(notes.load).toBe('The toil project sets no WIP limit (toil projects wip-limit).');
    expect(notes.ready).toBeNull();
    expect(LENSES.find((l) => l.id === 'ready')!.on).toBe(false);
  });
});

describe('each lens', () => {
  const run = (items: WorkItem[], changes: Change[] = [], wipLimit: number | null = null, asOf = AS_OF) => brief({ items, changes, asOf, settings: standardSettings(wipLimit) });

  it('counts failing checks only once they have failed for longer than the threshold, 24 hours by default', () => {
    const items = [item('corp-jira:A-1')];
    expect(run(items, [change('pr#1', { checks: 'FAILING', checksAt: '2026-10-13T12:00:00Z', workItems: ['corp-jira:A-1'] })]).reasons).toEqual([]);
    expect(run(items, [change('pr#1', { checks: 'FAILING', checksAt: '2026-10-13T06:00:00Z', workItems: ['corp-jira:A-1'] })]).reasons[0]!.lens).toBe('failing');
  });

  it('counts a wait for a first review in working days, skipping the weekend', () => {
    const items = [item('corp-jira:A-1')];
    const asOf = '2026-10-13T08:00:00Z';
    // Friday 08:00 to Tuesday 08:00 is two working days, which isn't more than two; from Thursday it's three.
    expect(run(items, [change('pr#1', { created: '2026-10-09T08:00:00Z', firstReviewAt: null, workItems: ['corp-jira:A-1'] })], null, asOf).reasons).toEqual([]);
    expect(run(items, [change('pr#1', { created: '2026-10-08T08:00:00Z', firstReviewAt: null, workItems: ['corp-jira:A-1'] })], null, asOf).reasons[0]!.items[0]!.why).toBe('[[pr#1]] has waited 3 working days for its first review.');
  });

  it('flags people over the WIP limit, describing load without ranking anyone', () => {
    const items = ['A-1', 'A-2', 'A-3'].map((k) => item(`corp-jira:${k}`));
    expect(run(items, [], 3).reasons).toEqual([]);
    const over = run(items, [], 2);
    expect(over.reasons[0]).toMatchObject({ lens: 'load', line: '1 person over the limit of 2' });
    expect(over.reasons[0]!.items[0]!.why).toBe("Pat Example has 3 items in progress; the toil project's limit is 2.");
  });

  it('flags a merged pull request whose item is still open, after a working day', () => {
    const items = [item('corp-jira:A-1', { statusCategory: 'TODO', status: 'To Do' })];
    expect(run(items, [change('pr#1', { state: 'MERGED', mergedAt: '2026-10-13T20:00:00Z', workItems: ['corp-jira:A-1'] })]).reasons).toEqual([]);
    expect(run(items, [change('pr#1', { state: 'MERGED', mergedAt: '2026-10-09T08:00:00Z', workItems: ['corp-jira:A-1'] })]).reasons[0]!.items[0]!.why).toBe('[[pr#1]] merged 3 working days ago, but the item is still To Do.');
  });

  it('follows a blocks cycle without looping', () => {
    const items = [item('corp-jira:A-1', { links: [blocks('corp-jira:A-2'), blockedBy('corp-jira:A-2')] }), item('corp-jira:A-2', { links: [blocks('corp-jira:A-1'), blockedBy('corp-jira:A-1')] })];
    const b = run(items);
    expect(b.reasons[0]!.items.map((i) => [i.key, i.holds.items])).toEqual([['A-1', 1], ['A-2', 1]]);
  });

  it('counts only the sprint with these dates when two trackers both have a "Sprint 42"', () => {
    const at = (end: string, points: number, k: string) => item(`corp-jira:${k}`, { iteration: sprint('Sprint 42', '2026-10-05T09:00:00Z', end), estimate: { value: points, unit: 'points', field: 'Story Points' } });
    const b = run([at('2026-10-16T17:00:00Z', 5, 'A-1'), at('2026-10-16T17:00:00Z', 5, 'A-2'), at('2026-10-30T17:00:00Z', 8, 'A-3')]);
    expect(b.sprint).toMatchObject({ end: '2026-10-16T17:00:00Z', points: { total: 10 } });
  });

  it("counts an Azure DevOps sprint's last day, which it ends at midnight", () => {
    const ado = item('corp-ado:7', { iteration: sprint('Sprint 42', '2026-10-05T00:00:00Z', '2026-10-16T00:00:00Z') });
    // The tracker's own end goes out; its last day still counts.
    expect(run([ado], [], null, '2026-10-16T12:00:00Z').sprint).toMatchObject({ end: '2026-10-16T00:00:00Z', days: { total: 10, left: 0.5 } });
  });

  it("says when a lens couldn't test an item, and never counts it as on track for that lens", () => {
    const listed = change('pr#1', { workItems: ['corp-jira:A-1'], checks: null, firstReviewAt: null, unmapped: [{ field: 'checks', reason: 'pr list' }, { field: 'firstReviewAt', reason: 'pr list' }] });
    const b = run([item('corp-jira:A-1', { created: '2026-10-01T00:00:00Z' } as Partial<WorkItem>), item('corp-jira:A-2', { updated: null, assignee: null })], [{ ...listed, created: '2026-10-01T00:00:00Z' }], 2);
    expect(b.reasons).toEqual([]);
    const notes = Object.fromEntries(b.lenses.map((l) => [l.id, [l.untested, l.note]]));
    expect(notes.failing).toEqual([1, "1 item couldn't be tested: a pull request has no checks read (map pr get --include reviews,checks, not only pr list)."]);
    expect(notes.waiting).toEqual([1, "1 item couldn't be tested: a pull request has no reviews read (map pr get --include reviews,checks, not only pr list)."]);
    expect(notes.stale).toEqual([1, "1 item couldn't be tested: no updated."]);
    expect(notes.load).toEqual([1, "1 item couldn't be tested: no assignee."]);
  });

  it('says so when no item in the sprint has a points estimate', () => {
    const b = run([item('corp-jira:A-1', { iteration: sprint('Sprint 42', '2026-10-05T09:00:00Z', '2026-10-16T17:00:00Z') })]);
    expect(b.lenses.find((l) => l.id === 'sprint')).toMatchObject({ checked: false, note: 'No item in the sprint has a points estimate.' });
  });

  it('recommends nothing when nothing needs anyone', () => {
    const quiet = run([item('corp-jira:A-1')]);
    expect([quiet.recommendation, quiet.reasons, quiet.onTrack]).toEqual([null, [], { open: 1, done: 0 }]);
  });
});

describe('reading the input', () => {
  it('takes envelopes, arrays and one record a line, and skips what it cannot read', () => {
    const envelope = JSON.stringify({ ok: true, data: { items: [item('corp-jira:A-1')], changes: [change('pr#1', {})] }, error: null, meta: { command: 'util owi map' } });
    const read = readBriefRecords(`${envelope}\n${JSON.stringify(item('corp-jira:A-2'))}\n${JSON.stringify({ id: 'x', title: 'neither' })}\n${JSON.stringify(item('corp-jira:A-1'))}`);
    expect(read.items.map((i) => i.id)).toEqual(['corp-jira:A-1', 'corp-jira:A-2']);
    expect(read.changes.map((c) => c.id)).toEqual(['pr#1']);
    expect(read.skipped).toEqual([{ at: 'document 3', reason: 'x is neither a work item (no statusCategory) nor a change (no repo and state)' }]);
    expect(read.duplicates).toEqual(['corp-jira:A-1']);
  });

  it('drops a malformed link and an estimate that is not a number, so neither skews the rules', () => {
    const read = readBriefRecords(JSON.stringify([{ ...item('corp-jira:A-1'), links: [null, blocks('corp-jira:A-2')], estimate: { value: '5', unit: 'points', field: 'x' } }]));
    expect(read.items[0]!.links).toEqual([blocks('corp-jira:A-2')]);
    expect(read.items[0]!.estimate).toBeNull();
  });

  it("refuses another command's output, and says to map it first", () => {
    expect(() => readBriefRecords(JSON.stringify({ ok: true, data: [], meta: { command: 'jira issue search' } }))).toThrow(/is the output of "jira issue search", not OWI records/);
  });

  it('finds where each document ends, whatever its strings hold', () => {
    const tricky = [item('corp-jira:A-1', { title: 'Braces } and { in a title' }), item('corp-jira:A-2', { title: 'A "quoted" word and a trailing backslash \\' })];
    const read = readBriefRecords(tricky.map((t) => JSON.stringify(t, null, 2)).join(''));
    expect(read.items.map((i) => i.title)).toEqual(['Braces } and { in a title', 'A "quoted" word and a trailing backslash \\']);
  });

  it('names the document that is not JSON', () => {
    expect(() => readBriefRecords('{"id": "a"}\n{nope}')).toThrow(/Document 2 of the input isn't JSON/);
  });
});

it('counts working days Monday to Friday, to the fraction', () => {
  expect(workingDays('2026-10-09T12:00:00Z', '2026-10-12T12:00:00Z')).toBe(1);
  expect(workingDays('2026-10-12T00:00:00Z', '2026-10-12T06:00:00Z')).toBe(0.25);
  expect(workingDays('2026-10-12T00:00:00Z', '2026-10-11T00:00:00Z')).toBe(0);
});
