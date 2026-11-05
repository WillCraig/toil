import { registry } from '@imagile-dev/toil/api';
import { describe, expect, it } from 'vitest';
import { isWhole } from '../server/analyses.ts';
import { finish, writeCommands } from '../server/agents/answer.ts';
import { analyzeQuestion } from '../server/agents/prompts.ts';
import { Ledger } from '../server/agents/tools.ts';
import { analyzeSettings } from '../../src/core/brief/settings.ts';
import { briefingOf, itemBriefing } from '../src/model/briefing.ts';
import type { AnalysisSummary } from '../src/model/analysis.ts';
import type { Envelope, Execute } from '../src/toil.ts';
import { FIXTURE_NOW } from '../src/fixtures/execute.ts';
import { loaded } from './harness.ts';

/**
 * The briefing (#494) in Toil UI: which one the page shows and what it lists
 * one step in, the server lifting Analyze's briefing block out of an answer
 * and checking its ids, and Analyze's question coming from toil.
 */

const block = (o: unknown) => `\`\`\`briefing\n${JSON.stringify(o)}\n\`\`\``;
const summary = (over: Partial<AnalysisSummary>): AnalysisSummary =>
  ({ id: 'a1', at: FIXTURE_NOW, adapter: 'codex', model: null, by: 'Codex', recommendation: null, issues: [], citations: [], unverified: 0, changes: { previous: null, newlyBlocked: [], cleared: [], points: [], sprint: null, cited: [], dropped: [], recommendationChanged: false }, briefing: null, briefingProblems: [], proposals: [], ...over }) as AnalysisSummary;

describe('the briefing the page shows', async () => {
  const { data } = await loaded('card-payments');
  const input = (analyses: AnalysisSummary[]) => ({ items: data.items, pullRequests: data.pullRequests, now: FIXTURE_NOW, settings: analyzeSettings(undefined, data.wipLimit).settings, analyses });

  it("is the code's when there is no Analyze, with no next steps", () => {
    const v = briefingOf(input([]));
    expect(v.by).toBe('code');
    expect(v.stale).toBeNull();
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.reasons.flatMap((r) => r.items).every((i) => i.next === null)).toBe(true);
  });

  it("is Analyze's when it is current, and lists what the code flagged that it left unmentioned, and ids that aren't the Toil project's", () => {
    const flagged = briefingOf(input([])).reasons.flatMap((r) => r.items.map((i) => i.id));
    const v = briefingOf(
      input([
        summary({
          briefing: {
            recommendation: 'Fix [[corp-jira:PAY-101]] first.',
            reasons: [{ lens: 'failing', label: 'Failing checks', line: 'one', text: null, items: [{ id: 'corp-jira:PAY-101', why: 'Checks fail.', next: 'Fix it.' }, { id: 'corp-jira:PAY-999', why: 'Made up.', next: null }] }],
            onTrack: null,
            changed: [],
            leftOut: [{ id: 'corp-jira:PAY-102', why: 'the focus said so' }],
          },
        }),
      ]),
    );
    expect(v.by).toBe('analyze');
    expect(v.unknown).toEqual(['corp-jira:PAY-999']);
    expect(v.leftOut.map((l) => l.id)).toEqual(['corp-jira:PAY-102']);
    expect(v.notMentioned.map((i) => i.id)).toEqual(flagged.filter((id) => id !== 'corp-jira:PAY-101' && id !== 'corp-jira:PAY-102'));
    expect(itemBriefing(v, 'corp-jira:PAY-101').item).toEqual({ id: 'corp-jira:PAY-101', why: 'Checks fail.', next: 'Fix it.' });
  });

  it('says what in the block did not fit, and names ids its tools never returned', () => {
    const v = briefingOf(input([summary({ unverified: 2, briefingProblems: ['Reason 2 has no items and no text, so it was left out.'], briefing: { recommendation: 'Go.', reasons: [], onTrack: null, changed: [], leftOut: [] } })]));
    expect(v.problems).toEqual(['Reason 2 has no items and no text, so it was left out.', 'Analyze named 2 items its tools never returned; the analysis marks them.']);
  });

  it("falls back to the code's, and says why, when the latest Analyze is older than the data or has no briefing", () => {
    expect(briefingOf(input([summary({ at: '2026-10-01T00:00:00Z', briefing: { recommendation: 'x', reasons: [], onTrack: null, changed: [], leftOut: [] } })])).stale).toBe('The latest Analyze is older than the data.');
    expect(briefingOf(input([summary({})])).stale).toMatch(/has no briefing block/);
  });
});

describe("the server's answer", () => {
  const ledger = new Ledger();
  ledger.add('corp-jira:PAY-101');
  const f = { toilProject: 'card-payments', prompt: 'Analyze', by: 'Codex', ledger, writes: writeCommands(registry.commands) };

  it('lifts the briefing block out of the text, and checks the ids it names against what the tools read', () => {
    const b = { recommendation: 'Fix [[corp-jira:PAY-101]].', reasons: [{ lens: 'failing', label: 'Failing checks', line: 'one', text: null, items: [{ id: 'corp-jira:PAY-101', why: 'Checks fail.', next: 'Fix it.' }, { id: 'corp-jira:PAY-404', why: 'Invented.', next: null }] }], onTrack: null, changed: [], leftOut: [] };
    const a = finish(`${block(b)}\n\nThe evidence: [[corp-jira:PAY-101]] fails.`, f);
    expect(a.briefing?.recommendation).toBe('Fix [[corp-jira:PAY-101]].');
    expect(a.parts.map((p) => p.text).join('\n')).not.toContain('```briefing');
    expect(a.unverified).toEqual(['corp-jira:PAY-404']);
  });

  it('counts an answer that is only a briefing as whole, citing its items, so the history keeps it', () => {
    const b = { recommendation: 'Fix [[corp-jira:PAY-101]].', reasons: [{ lens: 'failing', label: 'Failing checks', line: 'one', text: null, items: [{ id: 'corp-jira:PAY-101', why: 'Checks fail.', next: null }] }], onTrack: null, changed: [], leftOut: [] };
    const a = finish(block(b), f);
    expect(a.parts).toEqual([]);
    expect(a.citations).toEqual(['corp-jira:PAY-101']);
    expect(a.warnings).toEqual([]);
    expect(isWhole(a)).toBe(true);
  });

  it("says what in the block didn't fit", () => {
    const a = finish(block({ recommendation: 'Go.', reasons: [{ label: 'Empty', items: [] }] }), f);
    expect(a.warnings).toContain('The briefing: Reason 1 has no items and no text, so it was left out.');
  });
});

describe("Analyze's question", () => {
  const answering = (envelope: Envelope): Execute => async () => envelope;
  const meta = { command: 'projects analyze prompt', durationMs: 1, version: 'x', contractVersion: 1 };

  it("comes from toil, with the Toil project's own settings", async () => {
    const q = await analyzeQuestion(answering({ ok: true, data: { prompt: 'Analyze the Toil project "card-payments" …' }, error: null, meta } as Envelope), 'card-payments');
    expect(q).toEqual({ label: 'Analyze', text: 'Analyze the Toil project "card-payments" …', warning: null });
  });

  it("falls back to Toil UI's own question on a toil without the command, and says so", async () => {
    const q = await analyzeQuestion(answering({ ok: false, data: null, error: { code: 'INVALID_INPUT', message: "Unknown command 'projects analyze prompt'.", fix: '' }, meta } as Envelope), 'card-payments');
    expect(q.text).toContain('Give a pulse check of the Toil project "card-payments"');
    expect(q.warning).toMatch(/^Analyze used Toil UI's own question, not the Toil project's: toil projects analyze prompt failed \(Unknown command/);
  });
});
