import { describe, expect, it } from 'vitest';
import { defaultScheme, builtinScheme } from '../../src/core/classify/builtin.ts';
import { classify } from '../../src/core/classify/engine.ts';
import type { Scheme } from '../../src/core/classify/types.ts';
import { SAMPLE_SCHEME_STATS } from '../src/fixtures/classify-stats.ts';
import { fixtureClassify, sampleLedgerLines, sampleRevision, scriptedVerdict, standingOf } from '../src/fixtures/classify.ts';
import { SAMPLE_TEAM } from '../src/fixtures/sample-team.ts';
import { choiceForKey, choicesOf, needsAPerson, pendingChanges, personOf, shareText, sourceName, sourcePhrase } from '../src/model/classify.ts';
import { blankRule, checkDraft, draftOf, fieldName, ruleCounts, sameDraft, schemeChangeLines, schemeSummaryLine } from '../src/model/scheme-edit.ts';
import { overruledLine } from '../src/components/classify-doing.tsx';
import type { WorkItem } from '../src/toil.ts';

/**
 * What needs a person, what is waiting to be written, the keys, and the editor's draft, as pure functions of the sample
 * team (#566). The view tests drive the same functions through the screen; these pin the rules without a browser.
 */

const items = SAMPLE_TEAM.owi.items as WorkItem[];
const scheme = defaultScheme();
const item = (id: string) => items.find((i) => i.id === id)!;

/** An item carrying a label that the rules disagree with: a bug typed item labelled feature. */
const disagreeing = (): WorkItem => ({ ...items.find((i) => i.type === 'BUG' && !i.parent)!, id: 'sample-jira:DIS-1', labels: ['feature'], parent: null, source: { ...items[0]!.source, key: 'DIS-1' } });

describe('what needs a person', () => {
  it('is every unsure item, and nothing a person has answered, including a taking-back', () => {
    const unsure = classify({ scheme, items }).result.verdicts.filter((v) => v.category === null).map((v) => v.id);
    expect(unsure.length).toBeGreaterThan(5);
    expect(needsAPerson(items, scheme, {}).map((r) => r.item.id)).toEqual(unsure);
    expect(needsAPerson(items, scheme, { [unsure[0]!]: { category: 'feature', reason: null } }).map((r) => r.item.id)).not.toContain(unsure[0]);
    expect(needsAPerson(items, scheme, { [unsure[0]!]: { category: null, reason: null } }).map((r) => r.item.id)).not.toContain(unsure[0]);
  });

  it('adds an item whose label and rule disagree, found by running the engine with and without recheck', () => {
    const d = disagreeing();
    const rows = needsAPerson([...items, d], scheme, {});
    const row = rows.find((r) => r.item.id === d.id)!;
    expect(row.kind).toBe('disagree');
    expect(row.carried).toMatchObject({ category: 'feature', source: 'label' });
    expect(row.suggested).toMatchObject({ category: 'ktlo', source: 'signal:type' });
    expect(rows.filter((r) => r.kind === 'disagree')).toHaveLength(1);
  });

  it("does not list a labelled item the rules agree with, or one the rules can't settle", () => {
    const agree = { ...disagreeing(), id: 'sample-jira:DIS-2', labels: ['ktlo'] };
    const quiet = { ...disagreeing(), id: 'sample-jira:DIS-3', type: 'STORY' as const, typeName: 'Story', title: 'A plain thing', labels: ['feature'] };
    const rows = needsAPerson([agree, quiet], scheme, {});
    expect(rows).toEqual([]);
  });

  it('knows an item a person said is Feature stands as a person even over a label', () => {
    const d = disagreeing();
    const verdict = classify({ scheme, items: [d], person: personOf({ [d.id]: { category: 'feature', reason: 'x' } }) }).result.verdicts[0]!;
    // The label would win here (the engine's order is label, person, rules): which is why Apply runs with recheck.
    expect(verdict).toMatchObject({ category: 'feature', source: 'label' });
    const rechecked = classify({ scheme, items: [d], recheck: true, person: personOf({ [d.id]: { category: 'ktlo', reason: 'x' } }) }).result.verdicts[0]!;
    expect(rechecked).toMatchObject({ category: 'ktlo', source: 'person' });
  });
});

describe('what is waiting for the tracker', () => {
  it("is each decided item whose tracker says something else or nothing, and shrinks as the tracker catches up", () => {
    const d = disagreeing();
    const rows = pendingChanges([d], scheme, { [d.id]: { category: 'ktlo', reason: null } });
    expect(rows).toEqual([expect.objectContaining({ category: 'ktlo', tracker: 'feature' })]);
    // The tracker already says it, or an Apply wrote it this session: nothing waits.
    expect(pendingChanges([{ ...d, labels: ['ktlo'] }], scheme, { [d.id]: { category: 'ktlo', reason: null } })).toEqual([]);
    expect(pendingChanges([d], scheme, { [d.id]: { category: 'ktlo', reason: null } }, {}, new Map([[d.id, 'ktlo']]))).toEqual([]);
  });

  it("waits for an accepted AI agent suggestion as it does for a pick, being the person's word: a reason is kept, an unsure word waits for nothing, and a tracker toil can't write to is left out", () => {
    const unsure = classify({ scheme, items }).result.verdicts.filter((v) => v.category === null).map((v) => v.id);
    const [a, b] = unsure as [string, string];
    const rows = pendingChanges(items, scheme, { [a]: { category: 'feature', reason: "Accepted the AI agent's suggestion: it adds something." }, [b]: { category: null, reason: null } });
    expect(rows.find((r) => r.item.id === a)).toMatchObject({ category: 'feature', reason: "Accepted the AI agent's suggestion: it adds something.", tracker: null });
    expect(rows.find((r) => r.item.id === b)).toBeUndefined();
    const other = { ...item(a), source: { ...item(a).source, area: 'sonar' as never } };
    expect(pendingChanges([other], scheme, { [a]: { category: 'feature', reason: 'x' } })).toEqual([]);
  });
});

describe("a row's choices and keys", () => {
  it('are K and F and U for the two-category scheme, with the plain names', () => {
    const c = choicesOf(scheme);
    expect(c.map((x) => [x.name, x.key])).toEqual([['Keep the lights on', 'K'], ['Feature', 'F'], ['Unsure', 'U']]);
    expect(choiceForKey(c, 'f')?.id).toBe('feature');
    expect(choiceForKey(c, 'U')?.id).toBeNull();
    expect(choiceForKey(c, 'x')).toBeUndefined();
  });

  it('are 1 to 9 for any other scheme, with U still Unsure', () => {
    const c = choicesOf(builtinScheme('balance')!);
    expect(c.map((x) => x.key)).toEqual(['1', '2', '3', '4', 'U']);
    expect(choiceForKey(c, '3')?.id).toBe('ktlo');
    const flow = choicesOf(builtinScheme('flow')!);
    expect(flow.map((x) => [x.key, x.id])).toEqual([['1', 'feature'], ['2', 'defect'], ['3', 'risk'], ['4', 'debt'], ['U', null]]);
  });
});

describe('plain words', () => {
  it('names a source as a person would', () => {
    expect(sourcePhrase('signal:type')).toBe('its type');
    expect(sourcePhrase('parent')).toBe('its parent');
    expect(sourcePhrase('agent')).toBe('your AI agent');
    expect(sourcePhrase('rule:escalations')).toBe('a rule');
    expect(sourceName('signal:type', scheme)).toBe('the bug or incident type');
    expect(sourceName('rule:escalations', { rules: [{ id: 'escalations', when: {}, then: 'ktlo' }] })).toBe('the rule "escalations"');
  });

  it('says what people overrule most without a code name, and leaves it out when nobody has', () => {
    const names = { ktlo: 'Keep the lights on', feature: 'Feature' };
    expect(overruledLine(SAMPLE_SCHEME_STATS, scheme, names)).toBe('The bug or incident type was overruled 4 of 4 times, all to Feature.');
    expect(overruledLine({ ...SAMPLE_SCHEME_STATS, sources: [] }, scheme, names)).toBeNull();
    expect(overruledLine(null, scheme, names)).toBeNull();
  });

  it('shows a share nobody has read as a dash, never 0%', () => {
    expect(shareText(null)).toBe('—');
    expect(shareText(undefined)).toBe('—');
    expect(shareText(0)).toBe('0%');
    expect(shareText(0.545)).toBe('55%');
  });
});

describe('the sample ledger', () => {
  it('has at least ten corrections since the last tune, so the page offers to improve the categories', () => {
    expect(SAMPLE_SCHEME_STATS.sinceLastTune).toBeGreaterThanOrEqual(10);
  });

  it("answers the sample's unsure items with checked categories and says so when it can't write", async () => {
    const api = fixtureClassify();
    const unsure = needsAPerson(items, scheme, standingOf(sampleLedgerLines())).map((r) => r.item);
    expect(unsure.length).toBeGreaterThan(5);
    const got = await api.ask('sample-team', unsure, undefined);
    expect(got.answers).toHaveLength(unsure.length);
    expect(got.answers.every((a) => ['ktlo', 'feature', 'unsure'].includes(a.category))).toBe(true);
    expect(scriptedVerdict('x', 'Upgrade the build').category).toBe('ktlo');
    await expect(api.apply('sample-team', 'sample-plan')).rejects.toThrow(/sample data/);
    expect(api.disabled).toMatch(/sample data/);
  });

  it("plans what an accepted suggestion would change, labels only, once it is recorded as the person's word", async () => {
    const api = fixtureClassify();
    const [row] = needsAPerson(items, scheme, standingOf(sampleLedgerLines()));
    await api.correct('sample-team', { item: row!.item, context: [], to: 'feature', reason: "Accepted the AI agent's suggestion: It adds something." });
    const plan = await api.plan('sample-team', { items: [row!.item] });
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.changes).toEqual([expect.objectContaining({ id: row!.item.id, category: 'feature', labelsAdd: ['feature'], labelsRemove: [] })]);
    expect(plan.groups[0]!.command.name).toBe('jira issue categorize');
  });
});

describe("the editor's draft", () => {
  it('is the scheme as the form holds it, and valid when untouched', () => {
    const d = draftOf(scheme);
    expect(checkDraft(d)).toEqual({ scheme, problems: [] });
    expect(sameDraft(d, draftOf(scheme))).toBe(true);
    expect(schemeSummaryLine({ ...scheme, revision: 3, rules: [{ id: 'a', when: { title: ['x'] }, then: 'ktlo' }, { id: 'b', when: { title: ['y'] }, then: 'ktlo' }] })).toBe('Keep the lights on / Feature, 2 rules, signals on, revision 3');
  });

  it('names each problem by the part of the form it is in, in words', () => {
    const d = draftOf(scheme);
    d.categories[1] = { ...d.categories[1]!, label: 'has space', name: '' };
    d.rules.push({ ...blankRule('ktlo'), id: 'Bad Id' });
    const out = checkDraft(d);
    expect(out.scheme).toBeNull();
    expect(out.problems.map((p) => p.field)).toEqual(expect.arrayContaining(['Category 2, name', 'Category 2, label']));
    expect(out.problems.every((p) => /^[A-Z]/.test(p.text) && p.text.endsWith('.'))).toBe(true);
    expect(fieldName('rules[0].when')).toBe('Rule 1, when');
    expect(fieldName('guidance[2]')).toBe('Guidance line 3');
  });

  it('counts what each rule would catch over the items read, and says nothing about a rule that names a category that is not there', () => {
    const withRules: Scheme = { ...scheme, rules: [{ id: 'orders', when: { title: ['order'] }, then: 'feature' }, { id: 'nowhere', when: { title: ['order'] }, then: 'ghost' }, { id: 'nothing', when: { title: ['zzzz-not-there'] }, then: 'ktlo' }] };
    const counts = ruleCounts(withRules, items);
    expect(counts.orders).toBe(items.filter((i) => i.title.toLowerCase().includes('order') && classify({ scheme: { ...scheme, rules: [withRules.rules[0]!], signals: false }, items: [i], recheck: true }).result.verdicts[0]!.source === 'rule:orders').length);
    expect(counts.orders!).toBeGreaterThan(0);
    expect(counts.nowhere).toBeNull();
    expect(counts.nothing).toBe(0);
  });

  it('reads a revision as lines a person can check: what was added, rewritten and turned off', () => {
    const after: Scheme = { ...sampleRevision(scheme), signals: false, categories: scheme.categories.map((c) => (c.id === 'ktlo' ? { ...c, definition: 'Only what keeps it running.' } : c)) };
    const lines = schemeChangeLines(scheme, after);
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Rewrites the definition of "Keep the lights on"'),
        expect.stringContaining('Adds the rule "new-exports": when its title contains export, the category is Feature.'),
        expect.stringContaining('Adds the guidance: A bug fix that adds a new capability'),
        expect.stringContaining('Adds the example sample-jira:SHOP-40'),
        'Turns the built-in signals off.',
      ]),
    );
    expect(schemeChangeLines(scheme, scheme)).toEqual([]);
  });
});
