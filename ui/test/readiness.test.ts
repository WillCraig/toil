import { describe, expect, it } from 'vitest';
import {
  acceptanceInBody, ADO_ACCEPTANCE_FIELD, DEFAULT_MIN_WORDS, liveWorkflow, readiness, readinessAll, readReadiness, realText, tally, textOf, wordCount, workflowRead,
  type ReadinessSettings,
} from '../src/model/readiness.ts';
import type { WorkItem } from '../src/toil.ts';
import { loaded } from './harness.ts';

/**
 * The readiness gate (src/model/readiness.ts, #307): each of the five checks
 * on its edges, the verdict they add up to, the settings it reads from a
 * toil project, the one live read, and the verdicts on the sample toil projects as the
 * dashboard loads them.
 */

const WORDS = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

function item(id: string, over: Partial<WorkItem> = {}): WorkItem {
  return {
    owi: '0.2', id: `jira:${id}`, source: { area: 'jira', connection: 'jira', key: id, command: 'jira issue search' }, url: null, type: 'STORY', typeName: 'Story', title: id,
    body: { format: 'markdown', content: `${WORDS(30)}\n\n## Acceptance criteria\n- It works` },
    status: 'To Do', statusCategory: 'TODO', resolution: null, assignee: null, reporter: null, priority: null, estimate: null, labels: [], team: null, iteration: null, parent: null,
    children: [], links: [], created: null, updated: null, resolved: null, dueDate: null, history: null, unmapped: [], native: {}, ...over,
  };
}

const done = item('DONE-1', { status: 'Done', statusCategory: 'DONE' });
const settings = (over: Partial<ReadinessSettings> = {}): ReadinessSettings => ({ ...readReadiness({ repos: [{ name: 'payments-core' }], jira: { project: 'PAY' } }), ...over });
const gate = (i: WorkItem, others: WorkItem[] = [done], s = settings()) => readiness({ item: i, settings: s, byId: new Map([i, ...others].map((x) => [x.id, x])) });
const rowOf = (i: WorkItem, check: string, others?: WorkItem[], s?: ReadinessSettings) => gate(i, others, s).rows.find((r) => r.check === check)!;

describe('the verdict', () => {
  it('is ready when all five pass, thin when one is thin, blocked when one fails, and lists why worst first', () => {
    expect(gate(item('A')).verdict).toBe('ready');
    expect(gate(item('A')).why).toEqual([]);
    const thin = gate(item('B', { body: { format: 'markdown', content: 'Too short.' } }));
    expect(thin.verdict).toBe('thin');
    expect(thin.why.map((r) => r.check)).toEqual(['acceptance', 'description']);
    const blocked = gate(item('C', { body: null, links: [{ type: 'blocks', direction: 'inward', target: 'jira:OPEN-1', name: 'is blocked by' }] }), [done, item('OPEN-1')]);
    expect(blocked.verdict).toBe('blocked');
    expect(blocked.why.map((r) => [r.check, r.state])).toEqual([['blockers', 'fail'], ['acceptance', 'thin'], ['description', 'thin']]);
    expect(gate(item('A')).rows.map((r) => r.label)).toEqual(['Acceptance criteria', 'Description', 'Done state', 'Blockers', 'Scope']);
  });

  it('counts each verdict', () => {
    const all = readinessAll([item('A'), item('B', { body: null }), done], settings());
    expect(tally(all)).toEqual({ ready: 1, thin: 1, blocked: 1 });
  });
});

describe('acceptance criteria', () => {
  it('are found in the field the Toil project names, read from the source record', () => {
    const s = readReadiness({ jira: { fields: { acceptanceCriteria: 'customfield_10500' } } });
    const i = item('A', { body: { format: 'markdown', content: WORDS(30) }, native: { 'jira issue search': { key: 'A', fields: { customfield_10500: '* It charges once' } } } });
    expect(rowOf(i, 'acceptance', [done], s)).toMatchObject({ state: 'pass', reason: '3 words in customfield_10500.', source: 'field customfield_10500' });
    // An empty field doesn't count, and the message names it.
    const empty = item('B', { body: { format: 'markdown', content: WORDS(30) }, native: { 'jira issue search': { fields: { customfield_10500: '' } } } });
    expect(rowOf(empty, 'acceptance', [done], s)).toMatchObject({ state: 'thin', reason: 'None found. customfield_10500 is empty, and the description has no acceptance criteria heading or checklist.' });
    const tbd = item('C', { body: { format: 'markdown', content: WORDS(30) }, native: { 'jira issue search': { fields: { customfield_10500: 'TBD' } } } });
    expect(rowOf(tbd, 'acceptance', [done], s).state).toBe('thin');
  });

  it("default to Azure DevOps' own field, in HTML, and take a Jira field sent under its registered name", () => {
    expect(readReadiness({ ado: {} }).areas.ado).toMatchObject({ acceptanceField: ADO_ACCEPTANCE_FIELD, acceptanceFrom: 'default' });
    expect(readReadiness({ jira: {} }).areas.jira).toMatchObject({ acceptanceField: null, acceptanceFrom: null });
    const ado = item('7', { source: { area: 'ado', connection: 'ado-services', key: '7', command: 'ado work-item get-many', deployment: 'cloud' }, body: { format: 'html', content: `<p>${WORDS(30)}</p>` }, native: { x: { fields: { [ADO_ACCEPTANCE_FIELD]: '<ul><li>Works on Visa</li></ul>' } } } });
    expect(rowOf(ado, 'acceptance', [done], { ...readReadiness({ ado: {} }), repos: ['r'] }).state).toBe('pass');
    const named = item('C', { body: { format: 'markdown', content: WORDS(30) }, native: { s: { fields: { 'Acceptance Criteria': 'It works' } } } });
    expect(rowOf(named, 'acceptance', [done], readReadiness({ jira: { fields: { acceptanceCriteria: 'customfield_1' } } })).state).toBe('pass');
  });

  it('are found in the body as a heading with text under it, or a checklist, in Markdown, wiki, HTML and ADF', () => {
    expect(acceptanceInBody('## Acceptance criteria\n- Works')).toBe('heading');
    expect(acceptanceInBody('Acceptance criteria: it works')).toBe('heading');
    expect(acceptanceInBody('**Definition of done**\nShipped behind a flag')).toBe('heading');
    expect(acceptanceInBody('## Acceptance criteria\n\n## Notes\nsomething')).toBeNull();
    expect(acceptanceInBody('- [ ] Card picker\n- [x] Icons')).toBe('checklist');
    expect(acceptanceInBody('- Card picker')).toBeNull();
    // Placeholders aren't criteria, and neither is a sentence that only starts with the words (#351 review).
    expect(acceptanceInBody('Acceptance criteria: TBD')).toBeNull();
    expect(acceptanceInBody('## Acceptance criteria\nN/A')).toBeNull();
    expect(acceptanceInBody('Acceptance criteria are still to be written.')).toBeNull();
    expect(acceptanceInBody('- [ ] TBD')).toBeNull();
    expect(acceptanceInBody('## Acceptance criteria\n## What', ['what'])).toBeNull();
    expect(acceptanceInBody(textOf('h3. Done when\nThe CSV lands at 02:00', 'wiki'))).toBe('heading');
    expect(acceptanceInBody(textOf('<h2>Acceptance Criteria</h2><ul><li>Works</li></ul>', 'html'))).toBe('heading');
    expect(acceptanceInBody(textOf('<ul><li><input type="checkbox"> one</li></ul>', 'html'))).toBe('checklist');
    const adf = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'It works' }] }] };
    expect(acceptanceInBody(textOf(adf, 'adf'))).toBe('heading');
    expect(acceptanceInBody(textOf({ type: 'doc', content: [{ type: 'taskList', content: [{ type: 'taskItem', content: [{ type: 'text', text: 'Do it' }] }] }] }, 'adf'))).toBe('checklist');
  });
});

describe('the description', () => {
  it(`needs ${DEFAULT_MIN_WORDS} words by default, or the section's minWords`, () => {
    const short = item('A', { body: { format: 'markdown', content: `${WORDS(23)}\n- [ ] x` } });
    expect(rowOf(short, 'description')).toMatchObject({ state: 'thin', reason: '24 words of real text; 25 words are needed.' });
    expect(rowOf(item('A', { body: { format: 'markdown', content: `${WORDS(24)}\n- [ ] x` } }), 'description').state).toBe('pass');
    const tiny = item('A', { body: { format: 'markdown', content: `${WORDS(9)}\n- [ ] x` } });
    expect(rowOf(tiny, 'description').state).toBe('thin');
    expect(rowOf(tiny, 'description', [done], { ...settings(), areas: readReadiness({ jira: { readiness: { minWords: 10 } } }).areas }).state).toBe('pass');
    expect(rowOf(item('B', { body: null }), 'description')).toMatchObject({ state: 'thin', reason: 'No description; 25 words are needed.' });
  });

  it("doesn't count the Toil project's template lines, placeholder lines or unfilled slots", () => {
    const template = ['## What', '## Why', 'As a <role>, I want <goal>'].join('\n');
    const s = { ...settings(), areas: readReadiness({ jira: { readiness: { templates: [template] } } }).areas };
    const body = ['## What', 'TBD', '## Why', 'N/A', 'As a <role>, I want <goal>', 'Lorem ipsum dolor sit amet', '<describe the change>'].join('\n');
    expect(realText(body, s.areas.jira!.templateLines).trim()).toBe('');
    const r = rowOf(item('A', { body: { format: 'markdown', content: body } }), 'description', [done], s);
    expect(r.state).toBe('thin');
    expect(r.reason).toMatch(/^0 words of real text, not counting \d+ words of template or placeholder text; 25 words are needed\.$/);
    expect(wordCount("It's a 13-month expiry, at 02:00 UTC.")).toBe(8);
    // An entity outside Unicode reads as U+FFFD instead of throwing on a tracker's text (#351 review).
    expect(textOf('<p>&#99999999;&#x110000; ok &amp; &#65;</p>', 'html')).toBe('\ufffd\ufffd ok & A\n');
    expect(() => readinessAll([item('X', { body: { format: 'html', content: '<p>&#99999999;</p>' } })], settings())).not.toThrow();
  });
});

describe('the done state', () => {
  it('fails an item already done, and passes one whose type reached Done in the Toil project, citing it', () => {
    expect(rowOf(done, 'done')).toMatchObject({ state: 'fail', reason: 'Already done (Done).' });
    expect(rowOf(item('A'), 'done')).toMatchObject({ state: 'pass', reason: 'Open (To Do), and another Story here reached Done ([[jira:DONE-1]]), so the workflow gets there.', source: 'cache' });
    // A move into Done in another item's history counts too, even if it was reopened.
    const reopened = item('R', { history: { transitions: [{ from: 'To Do', to: 'Done', fromCategory: 'TODO', toCategory: 'DONE', at: '2026-10-01T00:00:00Z', by: null }], iterations: [] } });
    expect(rowOf(item('A'), 'done', [reopened]).state).toBe('pass');
  });

  it("is thin when no item of the type has reached Done, or the category is unknown, and passes any open GitHub issue", () => {
    expect(rowOf(item('A', { typeName: 'Epic', type: 'EPIC' }), 'done')).toMatchObject({ state: 'thin', source: 'cache' });
    expect(rowOf(item('A', { statusCategory: 'UNKNOWN', status: 'Parked' }), 'done').state).toBe('thin');
    const gh = item('A', { source: { area: 'github', connection: 'github', key: 'imagile/payments-web#41', command: 'github issue get' }, status: 'open', typeName: null });
    expect(rowOf(gh, 'done', [], { ...settings(), sources: ['github'] }).state).toBe('pass');
  });

  it('takes the one live read over the cache: ADO states by category, Jira moves into Done', () => {
    const epic = item('E', { typeName: 'Epic', type: 'EPIC' });
    const jiraLive = liveWorkflow(epic, 'jira issue transitions', [{ id: '31', name: 'Done', to: { name: 'Done', statusCategory: { key: 'done' } } }]);
    expect(gate(epic, [], settings()).rows[2]!.state).toBe('thin');
    expect(readiness({ item: epic, settings: settings(), byId: new Map(), live: jiraLive }).rows[2]).toMatchObject({ state: 'pass', reason: 'It can move to Done now: Done.', source: 'toil jira issue transitions' });
    const noDone = liveWorkflow(epic, 'jira issue transitions', { transitions: [{ id: '11', name: 'Start', to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } } }] });
    expect(readiness({ item: epic, settings: settings(), byId: new Map(), live: noDone }).rows[2]!.state).toBe('thin');

    const ado = item('9', { source: { area: 'ado', connection: 'ado', key: '9', command: 'ado work-item get-many' }, typeName: 'Feature', type: 'OTHER' });
    const states = (cats: string[]) => liveWorkflow(ado, 'ado work-item states', cats.map((c, i) => ({ name: `S${i}`, category: c })));
    const s = { ...settings(), sources: ['ado'] };
    expect(readiness({ item: ado, settings: s, byId: new Map(), live: states(['Proposed', 'InProgress', 'Completed']) }).rows[2]).toMatchObject({ state: 'pass', reason: 'The Feature workflow has a Done state: S2.' });
    // Removed is a way out, not to Done.
    expect(readiness({ item: ado, settings: s, byId: new Map(), live: states(['Proposed', 'Removed']) }).rows[2]!.state).toBe('fail');
    expect(readiness({ item: ado, settings: s, byId: new Map(), live: liveWorkflow(ado, 'ado work-item states', null, 'It broke. Fix it.') }).rows[2]).toMatchObject({ state: 'thin', reason: 'The live read failed: It broke. Fix it.' });
  });

  it('names the one read for each tracker, and none for GitHub', () => {
    expect(workflowRead(item('PAY-1'))).toEqual({ command: 'jira issue transitions', input: { key: 'PAY-1' } });
    expect(workflowRead(item('1', { source: { area: 'ado', connection: 'a', key: '1', command: 'x', deployment: 'cloud' }, typeName: 'Product Backlog Item' }))).toEqual({ command: 'ado work-item states', input: { type: 'Product Backlog Item' } });
    expect(workflowRead(item('1', { source: { area: 'github', connection: 'g', key: 'o/r#1', command: 'x' } }))).toBeNull();
  });
});

describe('blockers', () => {
  it('fail on an open blocker, pass on done ones, and are thin on one the Toil project lacks', () => {
    const link = (target: string) => ({ type: 'blocks' as const, direction: 'inward' as const, target, name: 'is blocked by' });
    expect(rowOf(item('A', { links: [link('jira:OPEN-1')] }), 'blockers', [done, item('OPEN-1', { status: 'In Progress' })])).toMatchObject({ state: 'fail', reason: 'Blocked by [[jira:OPEN-1]] (In Progress).' });
    expect(rowOf(item('A', { links: [link('jira:DONE-1')] }), 'blockers')).toMatchObject({ state: 'pass', reason: 'Its blocker is done ([[jira:DONE-1]]).' });
    expect(rowOf(item('A', { links: [link('jira:ELSE-1')] }), 'blockers').state).toBe('thin');
    // An item it blocks isn't a blocker.
    expect(rowOf(item('A', { links: [{ ...link('jira:OPEN-1'), direction: 'outward' }] }), 'blockers', [done, item('OPEN-1')]).state).toBe('pass');
  });
});

describe('scope', () => {
  it("fails an item from outside the Toil project's sources, is thin with no repository, and names the repository it works in", () => {
    expect(rowOf(item('A'), 'scope', [done], { ...settings(), sources: ['github'] }).state).toBe('fail');
    expect(rowOf(item('A'), 'scope', [done], { ...settings(), repos: [] }).state).toBe('thin');
    expect(rowOf(item('A'), 'scope')).toMatchObject({ state: 'pass', reason: "jira is one of the Toil project's sources, and an agent works in payments-core." });
    expect(rowOf(item('A'), 'scope', [done], { ...settings(), repos: ['a', 'b'] }).reason).toBe("jira is one of the Toil project's sources, which names 2 repositories (a, b); one is chosen when it starts.");
    const gh = item('A', { source: { area: 'github', connection: 'g', key: 'imagile/payments-web#1', command: 'x' } });
    expect(rowOf(gh, 'scope', [done], { ...settings(), sources: ['github'], repos: ['checkout-sdk', 'payments-web'] }).reason).toBe("github is one of the Toil project's sources, and its repository, payments-web, is in the Toil project.");
  });
});

describe('the settings', () => {
  it('reads sections, repositories and readiness, and says what it left out', () => {
    const s = readReadiness({ name: 'd', repos: [{ name: 'r1' }, { remotes: [] }], people: [], jira: { readiness: { minWords: -1, templates: 'x' } }, github: { readiness: 'x' } });
    expect(s.sources).toEqual(['jira', 'github']);
    expect(s.repos).toEqual(['r1']);
    expect(s.areas.jira!.minWords).toBe(DEFAULT_MIN_WORDS);
    expect(s.notes).toEqual([
      "The jira section's readiness.minWords isn't a whole number of 0 or more, so 25 applies.",
      "The jira section's readiness.templates isn't a list of template texts, so no template is taken out of descriptions.",
      'The github section\'s "readiness" isn\'t an object of minWords and templates, so the defaults apply.',
    ]);
    expect(readReadiness(null)).toEqual({ sources: [], repos: [], areas: {}, notes: [] });
  });
});

describe('the sample Toil projects', () => {
  const verdicts = async (name: string) => {
    const { data } = await loaded(name);
    return Object.fromEntries(readinessAll(data.items, data.readiness).filter((r) => data.items.find((i) => i.id === r.id)!.statusCategory !== 'DONE').map((r) => [r.id, r.verdict]));
  };

  it('card-payments: PAY-101 is ready, its chain is blocked, and the rest are thin', async () => {
    expect(await verdicts('card-payments')).toEqual({
      'corp-jira:PAY-100': 'thin',
      'corp-jira:PAY-101': 'ready',
      'corp-jira:PAY-102': 'blocked',
      'corp-jira:PAY-103': 'blocked',
      'corp-jira:PAY-104': 'thin',
      'corp-jira:PAY-107': 'thin',
    });
  });

  it('checkout-web: the feature with a checklist is ready; settlement, on the defaults, has nothing ready', async () => {
    expect(await verdicts('checkout-web')).toEqual({
      'github:imagile/payments-web#41': 'ready',
      'github:imagile/payments-web#42': 'thin',
      'github:imagile/payments-web#43': 'thin',
      'github:imagile/payments-web#45': 'thin',
    });
    expect(Object.values(await verdicts('settlement')).filter((v) => v === 'ready')).toEqual([]);
    expect((await verdicts('settlement'))['corp-ado:2303']).toBe('blocked');
  });
});
