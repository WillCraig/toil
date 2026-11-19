// Small pure parts of round 5 (#657): fewer duplicates, filed in triplicate as tests.
import { describe, expect, it } from 'vitest';
import { noteRepeatsQuestion } from '../src/assign/model.ts';
import { passedText, type RuleAgain } from '../src/assign/recheck.ts';
import type { Row } from '../src/model/readiness.ts';

describe("a proposal's note that only asks a QUESTION: line again", () => {
  const question = 'Should the second scenario (suggest another card, keep the basket) apply to every declined payment, or only to declines for insufficient funds?';
  it('is a repeat when it asks the same thing in other words, as seen live', () => {
    expect(noteRepeatsQuestion('Check that the second scenario should apply to any declined payment, as written, or only to declines for insufficient funds. The original bullet did not say.', [question])).toBe(true);
  });
  it('is kept when it says something else, or when there are no questions', () => {
    expect(noteRepeatsQuestion('The estimate field is read-only on this board, so apply it after the sprint starts.', [question])).toBe(false);
    expect(noteRepeatsQuestion('Check that the second scenario applies to every declined payment.', [])).toBe(false);
    expect(noteRepeatsQuestion(null, [question])).toBe(false);
  });
});

describe('the line beside Sync and check again when the rule passes', () => {
  const pass: RuleAgain = { name: 'Acceptance criteria as Given/When/Then', state: 'pass', reason: '' };
  const row = (label: string): Row => ({ check: 'description', label, state: 'thin', reason: '', source: 'description' });
  it('says ready to start only when the verdict on the same reading is Ready', () => {
    expect(passedText([pass], 'SCRUM-32', { verdict: 'ready', why: [] })).toBe('✓ Acceptance criteria as Given/When/Then now passes. SCRUM-32 is ready to start.');
    expect(passedText([pass], 'SCRUM-32', { verdict: 'thin', why: [row('Description')] })).toBe('✓ Acceptance criteria as Given/When/Then now passes. SCRUM-32 still needs more detail before it is ready to start: Description.');
    expect(passedText([pass], 'SCRUM-32', { verdict: 'blocked', why: [row('Blockers')] })).toBe("✓ Acceptance criteria as Given/When/Then now passes. SCRUM-32 is blocked, so it isn't ready to start: Blockers.");
    expect(passedText([pass], 'SCRUM-32', null)).toBe('✓ Acceptance criteria as Given/When/Then now passes.');
  });
  it('leaves a rule still missing or not checked to its own line', () => {
    expect(passedText([pass, { ...pass, name: 'Other', state: 'missing' }], 'SCRUM-32', { verdict: 'ready', why: [] })).toBeNull();
    expect(passedText([{ ...pass, state: 'unchecked' }], 'SCRUM-32', { verdict: 'ready', why: [] })).toBeNull();
    expect(passedText([pass, { ...pass, name: 'Written as a user story' }], 'SCRUM-32', { verdict: 'ready', why: [] })).toBe('✓ Acceptance criteria as Given/When/Then and Written as a user story now pass. SCRUM-32 is ready to start.');
  });
});
