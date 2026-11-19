import { describe, expect, it } from 'vitest';
import type { WorkItem } from '../owi/types.js';
import { builtinStandard } from './builtin.js';
import { checkStandards } from './check.js';
import { readStandard } from './read.js';
import { BODY_SCAN_LIMIT, sectionUnder, textOf } from './text.js';
import type { FoundStandard, Standard } from './types.js';

function item(key: string, extra: Partial<WorkItem> & { body?: WorkItem['body'] | undefined } = {}): WorkItem {
  return {
    id: `corp-jira:${key}`,
    source: { area: 'jira', connection: 'corp-jira', key, command: 'jira issue search' },
    url: `https://jira.imagile.dev/browse/${key}`,
    type: 'STORY',
    typeName: 'Story',
    title: `Work on ${key}`,
    body: null,
    labels: [],
    parent: null,
    native: {},
    ...extra,
  } as WorkItem;
}
const built = (...names: string[]): FoundStandard[] => names.map((n) => ({ standard: builtinStandard(n)!, source: 'built-in' }));
const own = (raw: unknown): FoundStandard => ({ standard: readStandard(raw, 'test').standard, source: 'file', file: '/work/team.json' });
const md = (content: string) => ({ format: 'markdown' as const, content });
const resultOf = (items: WorkItem[], standards: FoundStandard[], fields?: Record<string, Record<string, string>>) => checkStandards({ standards, items, ...(fields ? { fields } : {}) }).result;

const GHERKIN = 'Given a signed-in shopper\nWhen they save a card\nThen it is offered next time';

describe('pattern: gherkin on the acceptance criteria', () => {
  it('passes Given/When/Then in the description\'s criteria section, and says so', () => {
    const out = resultOf([item('PAY-1', { body: md(`Some context.\n\n## Acceptance criteria\n${GHERKIN}`) })], built('gherkin'));
    expect(out.items[0]).toMatchObject({ verdict: 'pass', results: [{ standard: 'gherkin', rule: 'scenarios', state: 'pass', reason: 'Has Given, When and Then lines.', source: 'acceptance criteria (in the description)' }] });
  });

  it('reads the toil project\'s acceptance criteria field first, by alias', () => {
    const native = { 'jira issue search': { fields: { customfield_10300: GHERKIN } } };
    const out = resultOf([item('PAY-2', { body: md('No criteria here.'), native })], built('gherkin'), { jira: { acceptanceCriteria: 'customfield_10300' } });
    expect(out.items[0]!.results[0]).toMatchObject({ state: 'pass', source: 'acceptance criteria (field customfield_10300)' });
  });

  it("reads Azure DevOps' own criteria field, in HTML", () => {
    const ado = item('7', { source: { area: 'ado', connection: 'corp-ado', key: '7', command: 'ado work-item list' }, native: { 'ado work-item list': { fields: { 'Microsoft.VSTS.Common.AcceptanceCriteria': '<div>Given a cart</div><div>When I pay</div><div>Then I get a receipt</div>' } } } });
    expect(resultOf([ado], built('gherkin')).items[0]!.results[0]).toMatchObject({ state: 'pass', source: 'acceptance criteria (field Microsoft.VSTS.Common.AcceptanceCriteria)' });
  });

  it('reads Jira ADF and wiki markup the same way', () => {
    const adf = { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Acceptance criteria' }] }, ...GHERKIN.split('\n').map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] }))] };
    expect(resultOf([item('PAY-3', { body: { format: 'adf', content: adf } })], built('gherkin')).items[0]!.verdict).toBe('pass');
    expect(resultOf([item('PAY-4', { body: { format: 'wiki', content: `h2. Acceptance criteria\n${GHERKIN}` } })], built('gherkin')).items[0]!.verdict).toBe('pass');
  });

  it('is thin, naming what is missing, when the criteria are not scenarios', () => {
    const out = resultOf([item('PAY-5', { body: md('## Acceptance criteria\n- Card is saved\n- Then it shows') })], built('gherkin'));
    expect(out.items[0]).toMatchObject({ verdict: 'thin', results: [{ state: 'thin' }] });
    expect(out.items[0]!.results[0]!.reason).toBe('Missing a Given line and a When line in the acceptance criteria.');
  });

  it('names every place it read, in plain words, when none of the lines is there', () => {
    const native = { 'jira issue search': { fields: { customfield_10500: '' } } };
    const out = resultOf([item('PAY-9', { body: md('Make checkout faster.'), native })], built('gherkin'), { jira: { acceptanceCriteria: 'customfield_10500' } });
    expect(out.items[0]!.results[0]).toMatchObject({ state: 'thin', reason: 'No Given, When or Then line in the acceptance criteria or description.', source: 'acceptance criteria (field customfield_10500), description' });
    const empty = resultOf([item('PAY-9', { body: null, native })], built('gherkin'), { jira: { acceptanceCriteria: 'customfield_10500' } });
    expect(empty.items[0]!.results[0]).toMatchObject({ reason: 'No Given, When or Then line in the acceptance criteria or description.', source: 'acceptance criteria (field customfield_10500), description' });
  });

  it("falls back to the regular expressions for a team's own pattern with no labels", () => {
    const team = own({ name: 'team', rules: [{ id: 'ticket', name: 'Ticket number', text: 'Name the ticket.', check: { kind: 'pattern', in: ['title'], match: ['[A-Z]+-\\d+'] } }] });
    expect(resultOf([item('PAY-13', { title: 'Speed up checkout' })], [team]).items[0]!.results[0]!.reason).toBe("The pattern wasn't found in the title; missing: /[A-Z]+-\\d+/.");
  });

  it('applies only where its when matches, and an item no rule applies to has no verdict', () => {
    const out = resultOf([item('PAY-6', { type: 'TASK', typeName: 'Task' })], built('gherkin'));
    expect(out.items[0]).toMatchObject({ verdict: null, results: [] });
    expect(out.summary).toMatchObject({ items: 1, checked: 0, byRule: [{ standard: 'gherkin', rule: 'scenarios', types: [], applies: 0 }] });
  });
});

describe('user-story', () => {
  it('passes the story form and misses a plain sentence', () => {
    const out = resultOf([item('PAY-7', { body: md('As a shopper, I want to save my card, so that I pay faster.') }), item('PAY-8', { body: md('Save cards.') })], built('user-story'));
    expect(out.items.map((i) => i.verdict)).toEqual(['pass', 'thin']);
    expect(out.items.map((i) => i.results[0]!.reason)).toEqual(['Has the "As a …, I want …, so that …" form.', 'No "As a …, I want …, so that …" form in the description.']);
  });
});

describe('section: bug-repro', () => {
  const bug = (key: string, extra: Partial<WorkItem> & { body?: WorkItem['body'] | undefined }) => item(key, { type: 'BUG', typeName: 'Bug', ...extra });

  it('passes all three headings in a Markdown description', () => {
    const out = resultOf([bug('PAY-10', { body: md('## Steps to reproduce\n1. Pay\n2. Look\n\n## Expected\nA receipt\n\n## Actual\nNo receipt at all') })], built('bug-repro'));
    expect(out.items[0]!.results.map((r) => [r.rule, r.state])).toEqual([['steps', 'pass'], ['expected', 'pass'], ['actual', 'pass']]);
  });

  it('reads the repro steps field and the description together, and misses a heading with nothing under it', () => {
    const native = { 'ado work-item list': { fields: { 'Microsoft.VSTS.TCM.ReproSteps': '<div><b>Repro steps</b></div><ol><li>Open the cart</li></ol><div>Expected: a total</div><div>Actual:</div>' } } };
    const out = resultOf([bug('41', { native })], built('bug-repro'));
    expect(out.items[0]!.results.map((r) => [r.rule, r.state])).toEqual([['steps', 'pass'], ['expected', 'pass'], ['actual', 'thin']]);
    expect(out.items[0]!.results[2]!.reason).toBe('The "Actual" section is empty.');
    expect(out.items[0]!.results[0]).toMatchObject({ reason: 'Has a "Repro steps" section.', source: 'repro steps (field Microsoft.VSTS.TCM.ReproSteps), description' });
  });

  it('skips a rule as not read when none of its places is in the record, and never calls that empty', () => {
    // No body key at all: the description was never read. The field isn't in the record either.
    const unread = item('PAY-11', { type: 'BUG', typeName: 'Bug' });
    delete (unread as { body?: unknown }).body;
    const out = resultOf([unread], built('bug-repro'));
    expect(out.items[0]!.verdict).toBeNull();
    expect(out.items[0]!.results.every((r) => r.state === 'skipped')).toBe(true);
    expect(out.items[0]!.results[0]!.reason).toBe("Not read: the repro steps and description aren't in the record read, so this wasn't checked.");
    expect(out.summary.byRule[0]).toMatchObject({ applies: 1, skipped: 1, pass: 0, thin: 0 });
  });

  it('checks an empty description (body null) as read and empty', () => {
    const out = resultOf([bug('PAY-12', { body: null })], built('bug-repro'));
    // The unread field stays in the source; the sentence speaks only of the description it did read.
    expect(out.items[0]!.results[0]).toMatchObject({ state: 'thin', reason: 'No "Steps to reproduce" section in the description.', source: 'description; not read: repro steps (field Microsoft.VSTS.TCM.ReproSteps)' });
  });
});

describe('the text a pattern reads', () => {
  it('is capped at BODY_SCAN_LIMIT after several places are joined, so a pattern never runs over more', () => {
    // Each place fits under the cap on its own; only the join passes it, so the mark at the title's end is past the cap.
    const team = own({ name: 'team', rules: [{ id: 'mark', name: 'Has the mark', text: 'Add the mark.', check: { kind: 'pattern', in: ['description', 'title'], match: ['needle'] } }] });
    const at = (title: string) => resultOf([item('A', { title, body: md('x'.repeat(BODY_SCAN_LIMIT - 5)) })], [team]).items[0]!.results[0]!;
    expect(at('needle').state).not.toBe('pass');
    expect(resultOf([item('B', { title: 'needle', body: md('x'.repeat(100)) })], [team]).items[0]!.results[0]!.state).toBe('pass');
  });
});

describe('field, words and judge', () => {
  const team = own({
    name: 'team',
    rules: [
      { id: 'risk', name: 'Risk', text: 'Fill in Risk.', fail: 'fail', check: { kind: 'field', in: ['field:risk'] } },
      { id: 'long', name: 'Long enough', text: 'Describe it.', check: { kind: 'words', in: ['description'], min: 5 } },
      { id: 'sense', name: 'Makes sense', text: 'It reads well.', check: { kind: 'judge' } },
    ],
  });

  it('field: passes a filled field, fails an empty or placeholder one, skips one not read', () => {
    const at = (value: unknown) => ({ 'jira issue search': { fields: { customfield_1: value } } });
    const fields = { jira: { risk: 'customfield_1' } };
    const out = resultOf([item('A', { native: at('High') }), item('B', { native: at(null) }), item('C', { native: at('TBD') }), item('D')], [team], fields);
    expect(out.items.map((i) => i.results[0]!.state)).toEqual(['pass', 'fail', 'fail', 'skipped']);
    expect(out.items[1]!.results[0]!.reason).toBe('The risk field is empty.');
    expect(out.items[2]!.results[0]!.reason).toContain('only placeholder text');
    expect(out.items[3]!.results[0]!.source).toBe('not read: risk (field customfield_1)');
  });

  it('words: counts real words, not placeholders', () => {
    const out = resultOf([item('A', { body: md('One two three four five') }), item('B', { body: md('TBD\nTODO\none two') })], [team]);
    expect(out.items.map((i) => i.results[1]!.state)).toEqual(['pass', 'thin']);
  });

  it('judge: always skipped, never a pass, and the verdict is the worst of the rest', () => {
    const out = resultOf([item('A', { body: md('One two three four five'), native: { r: { fields: { risk: 'Low' } } } })], [team]);
    expect(out.items[0]!.results[2]).toMatchObject({ state: 'skipped', reason: expect.stringContaining('AI agent') });
    expect(out.items[0]!.verdict).toBe('pass');
    const worse = resultOf([item('B', { body: md('short'), native: { r: { fields: { risk: null } } } })], [team]);
    expect(worse.items[0]!.verdict).toBe('fail');
  });
});

describe('the result', () => {
  it('lists each standard once, keeps the first of a repeated item, and tallies by rule and type', () => {
    const items = [item('A', { body: md(GHERKIN) }), item('A'), item('B', { type: 'BUG', typeName: 'Bug', body: md('') })];
    const { result, warnings } = checkStandards({ standards: [...built('gherkin', 'gherkin', 'bug-repro')], items, toilProject: 'payments' });
    expect(warnings.map((w) => w.code)).toEqual(['STANDARDS_DUPLICATE_ITEM', 'STANDARDS_DUPLICATE']);
    expect(result.toilProject).toBe('payments');
    expect(result.standards.map((s) => s.name)).toEqual(['gherkin', 'bug-repro']);
    expect(result.standards[0]!.rules[0]).toEqual({ id: 'scenarios', name: 'Acceptance criteria as Given/When/Then', missing: 'no Given/When/Then criteria', text: expect.any(String), when: { type: ['STORY'] }, fail: 'thin', kind: 'pattern' });
    expect(result.summary).toMatchObject({ items: 2, checked: 2 });
    expect(result.summary.byRule.map((r) => [r.rule, r.types, r.applies, r.pass, r.thin])).toEqual([
      ['scenarios', ['STORY'], 1, 1, 0],
      ['steps', ['BUG'], 1, 0, 1],
      ['expected', ['BUG'], 1, 0, 1],
      ['actual', ['BUG'], 1, 0, 1],
    ]);
  });
});

describe('text', () => {
  it('caps what a rule reads, and walks a deep ADF document without recursion', () => {
    expect(textOf('x'.repeat(BODY_SCAN_LIMIT * 3))).toHaveLength(BODY_SCAN_LIMIT);
    let deep: Record<string, unknown> = { type: 'text', text: 'bottom' };
    // A wrapper that adds no text of its own, so only the depth is tested, not the cap.
    for (let i = 0; i < 20_000; i++) deep = { type: 'bodiedExtension', content: [deep] };
    expect(textOf(deep)).toContain('bottom');
  });

  it('finds a section under any spelling of its heading, and stops at the next heading', () => {
    expect(sectionUnder('**Expected:** a total\nmore\n## Actual\nnone', ['Expected'])).toEqual({ heading: 'Expected', text: 'a total\nmore' });
    expect(sectionUnder('Expected results are documented elsewhere', ['Expected'])).toBeUndefined();
  });

  it('runs a pattern over a long body in reasonable time', () => {
    const s: Standard = builtinStandard('user-story')!;
    const started = Date.now();
    resultOf([item('A', { body: md(`as a ${'x'.repeat(19_000)}`) })], [{ standard: s, source: 'built-in' }]);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
