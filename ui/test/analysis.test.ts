import { readBriefing } from '../../src/core/brief/answer.ts';
import { describe, expect, it } from 'vitest';
import { memoryAnalyses } from '../src/analyses.ts';
import { analyzeParts } from '../src/fixtures/agent.ts';
import { sampleAnalysisRecords } from '../src/fixtures/analyses.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { MAX_ANALYSES, MAX_ISSUES, changesBetween, historyOf, recordOf, snapshotOf, structureOf, unchanged, viewOf, type AnalysisRecord, type AnalysisSnapshot } from '../src/model/analysis.ts';
import type { Answer } from '../src/agent.ts';
import { loaded } from './harness.ts';

/**
 * Analyze's answers, kept and compared (#395): the top-down shape read back
 * out of the text, the snapshot of a toil project, and what changed between two
 * analyses, all by code.
 */

const answer = (texts: string[], over: Partial<Answer> = {}): Answer => ({ prompt: 'Analyze', parts: texts.map((text) => ({ text })), citations: [], by: 'Codex', adapter: 'codex', model: 'gpt-5.5', proposals: [], ...over });
const snap = (over: Partial<AnalysisSnapshot> = {}): AnalysisSnapshot => ({ blocked: [], points: {}, sprint: null, ...over });
const record = (id: string, at: string, s: AnalysisSnapshot, citations: string[] = [], recommendation = 'Do it.'): AnalysisRecord => ({
  ...recordOf(answer([`Recommendation: ${recommendation}`]), { id, toilProject: 'd', startedAt: at, at, snapshot: s }),
  citations,
});

describe('structureOf', () => {
  it('reads the Recommendation, the numbered Issues and the Evidence, in that order', () => {
    const s = structureOf(['Recommendation: Fix [[j:A-1]] first.', 'Issues:\n1. Build failing: [[j:A-1]] fails.\n2. Blocked: [[j:A-2]] waits.', 'Evidence:', 'What changed: nothing.', 'Who is on what: Pat.'].join('\n\n'))!;
    expect(s.recommendation).toBe('Fix [[j:A-1]] first.');
    expect(s.issues).toEqual([
      { title: 'Build failing', text: '[[j:A-1]] fails.' },
      { title: 'Blocked', text: '[[j:A-2]] waits.' },
    ]);
    expect(s.evidence).toEqual(['What changed: nothing.', 'Who is on what: Pat.']);
    expect(s.extraIssues).toBe(0);
  });

  it('lets through the Markdown a model adds anyway: bold or heading labels, dashes, bullets', () => {
    const s = structureOf('**Recommendation:** Ship it.\n\n## Issues\n- Aging: [[j:A-3]] sits.\n\n**Evidence** - the sprint is fine.')!;
    expect(s.recommendation).toBe('Ship it.');
    expect(s.issues).toEqual([{ title: 'Aging', text: '[[j:A-3]] sits.' }]);
    expect(s.evidence).toEqual(['the sprint is fine.']);
  });

  it('keeps three issues and moves the rest to the end of the evidence, saying how many', () => {
    const s = structureOf(['Recommendation: Go.', 'Issues:\n1. A: one.\n2. B: two.\n3. C: three.\n4. D: four.\n5. five, with no name', 'Evidence:\nAll of it.'].join('\n\n'))!;
    expect(s.issues.map((i) => i.title)).toEqual(['A', 'B', 'C']);
    expect(s.issues).toHaveLength(MAX_ISSUES);
    expect(s.extraIssues).toBe(2);
    expect(s.evidence).toEqual(['All of it.', 'D: four.', 'five, with no name']);
  });

  it('reads "Issues: none" as no issues, and a line that continues an issue as part of it', () => {
    expect(structureOf('Recommendation: Keep going.\nIssues: none\nEvidence: quiet.')!.issues).toEqual([]);
    expect(structureOf('Recommendation: Go.\nIssues:\n1. A: starts here\nand ends here.\nEvidence: x')!.issues).toEqual([{ title: 'A', text: 'starts here and ends here.' }]);
  });

  it('is null without a Recommendation label, so the answer is shown as it came, and keeps text before the label in the evidence', () => {
    expect(structureOf('The sprint is fine. Issues are few.')).toBeNull();
    expect(structureOf('Recommendation:\n\nIssues: none')).toBeNull();
    const s = structureOf('Right, then.\n\nRecommendation: Go.')!;
    expect(s.evidence).toEqual(['Right, then.']);
  });

  it('does not take prose that starts with a label word for a label', () => {
    const s = structureOf('Recommendation: Go.\nEvidence:\nEvidence shows the build is green.\nIssues with it are none.')!;
    expect(s.issues).toEqual([]);
    expect(s.evidence).toEqual(['Evidence shows the build is green.\nIssues with it are none.']);
  });

  it("reads the scripted Analyze answer of every sample Toil project as a briefing (#494), the evidence beside it", () => {
    for (const toilProject of ['card-payments', 'settlement', 'checkout-web']) {
      const read = readBriefing(analyzeParts(toilProject).join('\n\n'));
      expect(read.problems, toilProject).toEqual([]);
      expect(read.briefing!.recommendation).toContain('[[');
      expect(read.briefing!.reasons.length).toBeGreaterThanOrEqual(2);
      expect(read.briefing!.reasons.every((r) => r.items.every((i) => i.why && i.next))).toBe(true);
      expect(read.rest.length).toBeGreaterThan(200);
    }
  });
});

describe('snapshotOf', () => {
  it("takes what is blocked and by what, every item's points, and the sprint's points done and left", async () => {
    const { data } = await loaded('card-payments');
    const s = snapshotOf(data.items, FIXTURE_NOW);
    expect(s.blocked).toEqual([
      { id: 'corp-jira:PAY-102', by: ['corp-jira:PAY-101'] },
      { id: 'corp-jira:PAY-103', by: ['corp-jira:PAY-102'] },
    ]);
    expect(s.sprint).toEqual({ name: 'Sprint 42', done: 3, remaining: 18 });
    expect(Object.keys(s.points).length).toBeGreaterThan(3);
  });
});

describe('changesBetween', () => {
  it('has nothing to compare for the first analysis', () => {
    const c = changesBetween(null, record('a', '2026-10-01T00:00:00.000Z', snap()));
    expect(c.previous).toBeNull();
  });

  it('says what is newly blocked (or blocked by something new), what cleared, points moved, the sprint, and citations gained and dropped', () => {
    const before = record('a', '2026-10-01T00:00:00.000Z', snap({ blocked: [{ id: 'x:1', by: ['x:9'] }, { id: 'x:2', by: ['x:9'] }], points: { 'x:1': 3, 'x:3': 5 }, sprint: { name: 'S', done: 1, remaining: 9 } }), ['x:1', 'x:2'], 'Old.');
    const after = record('b', '2026-10-02T00:00:00.000Z', snap({ blocked: [{ id: 'x:1', by: ['x:8', 'x:9'] }, { id: 'x:4', by: ['x:1'] }], points: { 'x:1': 5, 'x:4': 2 }, sprint: { name: 'S', done: 4, remaining: 6 } }), ['x:1', 'x:4'], 'New.');
    const c = changesBetween(before, after);
    expect(c.previous).toEqual({ id: 'a', at: '2026-10-01T00:00:00.000Z' });
    expect(c.newlyBlocked).toEqual([{ id: 'x:1', by: ['x:8', 'x:9'] }, { id: 'x:4', by: ['x:1'] }]);
    expect(c.cleared).toEqual(['x:2']);
    expect(c.points).toEqual([
      { id: 'x:1', from: 3, to: 5 },
      { id: 'x:3', from: 5, to: null },
      { id: 'x:4', from: null, to: 2 },
    ]);
    expect(c.sprint).toEqual({ from: { name: 'S', done: 1, remaining: 9 }, to: { name: 'S', done: 4, remaining: 6 } });
    expect(c.cited).toEqual(['x:4']);
    expect(c.dropped).toEqual(['x:2']);
    expect(c.recommendationChanged).toBe(true);
    expect(unchanged(c)).toBe(false);
  });

  it('says nothing changed when nothing did', () => {
    const s = snap({ blocked: [{ id: 'x:1', by: ['x:9'] }], points: { 'x:1': 3 } });
    expect(unchanged(changesBetween(record('a', '2026-10-01T00:00:00.000Z', s, ['x:1']), record('b', '2026-10-02T00:00:00.000Z', s, ['x:1'])))).toBe(true);
  });
});

describe('the history', () => {
  it('lists newest first, each compared with the one made before it, whatever order the records come in', () => {
    const a = record('a', '2026-10-01T00:00:00.000Z', snap(), ['x:1']);
    const b = record('b', '2026-10-02T00:00:00.000Z', snap(), ['x:1', 'x:2']);
    const c = record('c', '2026-10-03T00:00:00.000Z', snap(), ['x:2']);
    const list = historyOf([b, c, a]);
    expect(list.map((s) => [s.id, s.changes.previous?.id ?? null])).toEqual([
      ['c', 'b'],
      ['b', 'a'],
      ['a', null],
    ]);
    expect(list[0]!.changes.dropped).toEqual(['x:1']);
    expect(viewOf([b, c, a], 'b')!.changes.cited).toEqual(['x:2']);
    expect(viewOf([a], 'zz')).toBeNull();
  });

  it('keeps a record of who answered, what it used, its recommendation and issues, and the whole answer', () => {
    const r = recordOf(answer(['Recommendation: Fix [[j:A-1]].', 'Issues:\n1. A: [[j:A-2]] waits.'], { citations: ['j:A-1', 'j:A-2'], unverified: ['j:A-9'], warnings: ['w'] }), { id: 'r', toilProject: 'd', startedAt: 's', at: 't', snapshot: snap() });
    expect(r).toMatchObject({ adapter: 'codex', model: 'gpt-5.5', by: 'Codex', recommendation: 'Fix [[j:A-1]].', issues: [{ title: 'A', text: '[[j:A-2]] waits.' }], citations: ['j:A-1', 'j:A-2'], unverified: ['j:A-9'], warnings: ['w'], usage: null });
    expect(r.parts).toHaveLength(2);
  });

  it('in memory: records, lists, opens, and keeps only the newest of a Toil project', async () => {
    const { data } = await loaded('card-payments');
    const api = memoryAnalyses();
    const ids: string[] = [];
    for (let i = 0; i < MAX_ANALYSES + 2; i++) {
      const at = new Date(Date.parse(FIXTURE_NOW) + i * 60_000).toISOString();
      ids.push(await api.record!('card-payments', answer([`Recommendation: number ${i}.`]), { startedAt: at, at, items: data.items, now: FIXTURE_NOW }));
    }
    const list = await api.list('card-payments');
    expect(list).toHaveLength(MAX_ANALYSES);
    expect(list[0]!.recommendation).toBe(`number ${MAX_ANALYSES + 1}.`);
    expect(await api.get('card-payments', ids[0]!)).toBeNull();
    expect((await api.get('card-payments', ids.at(-1)!))!.record.snapshot.blocked).toHaveLength(2);
    expect(await api.list('settlement')).toEqual([]);
  });

  it("the sample's: two analyses of card-payments, the later one saying what changed", async () => {
    const list = historyOf(await sampleAnalysisRecords());
    expect(list.map((a) => a.id)).toEqual(['sample-analysis-2', 'sample-analysis-1']);
    const c = list[0]!.changes;
    expect(c.newlyBlocked.map((b) => b.id)).toEqual(['corp-jira:PAY-103']);
    expect(c.cleared).toEqual(['corp-jira:PAY-104']);
    expect(c.points.map((p) => p.id)).toEqual(['corp-jira:PAY-102']);
    expect(c.sprint).not.toBeNull();
    expect(c.cited.length).toBeGreaterThan(0);
    expect(list.every((a) => a.by === 'scripted')).toBe(true);
  });
});
