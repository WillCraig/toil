// Small pure parts of round 4 (#657): each one a rubber stamp with a unit test, which is more scrutiny than most stamps get.
import { describe, expect, it } from 'vitest';
import { lineDiff, sideOf } from '../src/assign/line-diff.ts';
import { againText, rulesAgain } from '../src/assign/recheck.ts';
import { appliedSince, noteApplied, resetApplied } from '../src/applied.ts';
import { timeOnDay } from '../src/format.ts';
import { added, settledBy, unread, parseHistory } from '../src/history.ts';
import { clip, settles } from '../src/notify.ts';
import { agentFailure, causeOf, resetOf } from '../server/agents/failure.ts';

describe('a line-level diff of Now and Proposed', () => {
  it('keeps unchanged lines as kept in both columns, and marks only what was removed or added', () => {
    const before = ['As a platform engineer, I want X.', '', 'Acceptance criteria', '- Card numbers are tokenised', '', 'Made-up demo data.'].join('\n');
    const after = ['As a platform engineer, I want X.', '', 'Acceptance criteria', '', 'Scenario 1: Card numbers are tokenised', 'Given a gap', '', 'Made-up demo data.'].join('\n');
    const diff = lineDiff(before, after);
    const now = sideOf(diff, 'before');
    const proposed = sideOf(diff, 'after');
    expect(now.find((l) => l.text.startsWith('As a platform'))!.kind).toBe('same');
    expect(now.find((l) => l.text === 'Made-up demo data.')!.kind).toBe('same');
    expect(now.filter((l) => l.kind === 'del').map((l) => l.text)).toEqual(['- Card numbers are tokenised']);
    expect(proposed.filter((l) => l.kind === 'add').map((l) => l.text)).toEqual(['Scenario 1: Card numbers are tokenised', 'Given a gap', '']);
    // Each side, read back, is its own text.
    expect(now.map((l) => l.text).join('\n')).toBe(before);
    expect(proposed.map((l) => l.text).join('\n')).toBe(after);
  });

  it('treats trailing spaces and CRLF as the same line, and an all-new field as added', () => {
    expect(lineDiff('a  \r\nb', 'a\nb').every((l) => l.kind === 'same')).toBe(true);
    expect(lineDiff('', 'x').map((l) => l.kind)).toEqual(['del', 'add']);
    expect(lineDiff('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  });
});

describe('Sync and check again, in words', () => {
  const rules = [{ standard: 'gherkin', rule: 'scenarios', name: 'Acceptance criteria as Given/When/Then' }];
  const reading = (state: 'pass' | 'thin' | 'fail' | 'skipped', reason = 'No Given line.') => ({ state: 'read' as const, message: null, warnings: [], byItem: new Map([['jira:SCRUM-17', [{ standard: 'gherkin', rule: 'scenarios', name: 'Acceptance criteria as Given/When/Then', state, reason, source: 'description' }]]]) });
  it('says passes only from a reading that says so, and nothing before a reading', () => {
    expect(rulesAgain(rules, undefined, 'jira:SCRUM-17')).toBeNull();
    expect(rulesAgain(rules, { state: 'unread', byItem: new Map(), message: null, warnings: [] }, 'jira:SCRUM-17')).toBeNull();
    expect(againText(rulesAgain(rules, reading('pass'), 'jira:SCRUM-17')![0]!)).toBe('Acceptance criteria as Given/When/Then: now passes');
    expect(againText(rulesAgain(rules, reading('thin'), 'jira:SCRUM-17')![0]!)).toBe('Acceptance criteria as Given/When/Then: still missing: No Given line');
    expect(againText(rulesAgain(rules, reading('skipped', 'Needs an AI agent.'), 'jira:SCRUM-17')![0]!)).toBe('Acceptance criteria as Given/When/Then: not checked: Needs an AI agent');
    expect(againText(rulesAgain(rules, reading('pass'), 'jira:SCRUM-99')![0]!)).toBe('Acceptance criteria as Given/When/Then: no longer applies to this item');
  });
});

describe('changes applied since the data was read', () => {
  it('counts each change once, and only those after the read', () => {
    resetApplied();
    noteApplied('assignment:a/p1', '2026-11-17T22:39:00Z');
    noteApplied('assignment:a/p1', '2026-11-17T22:39:00Z');
    noteApplied('assignment:b/p1', '2026-11-17T20:00:00Z');
    expect(appliedSince('2026-11-17T22:38:00Z')).toBe(1);
    expect(appliedSince('2026-11-17T19:00:00Z')).toBe(2);
    resetApplied();
  });
  it('says a time on the same day as the time alone', () => {
    expect(timeOnDay('2026-11-17T22:39:00Z', '2026-11-17T23:00:00Z')).toBe('22:39 UTC');
    expect(timeOnDay('2026-11-16T22:39:00Z', '2026-11-17T23:00:00Z')).toBe('16 Nov 2026, 22:39 UTC');
  });
});

describe('notices and the bell after an assignment stops needing you', () => {
  it('cuts a long line at a sentence or a word, never mid-word', () => {
    const long = "Codex failed: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:50 PM.";
    // A sentence end too early to keep most of it: cut at the last word instead.
    expect(clip(long, 160)).toBe("Codex failed: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits…");
    expect(clip(long, 60)).toBe("Codex failed: You've hit your usage limit.");
    const words = 'one two three four five six seven eight nine ten';
    expect(clip(words, 20)).toBe('one two three four…');
    expect(clip('short', 160)).toBe('short');
  });
  it('settles the needs-you entries of an assignment, so they no longer count', () => {
    const h = added(parseHistory(null), [
      { id: 'assignment:a1:needs-you:3', at: '2026-11-17T22:38:00Z', kind: 'needs-you', title: 'Claude needs you', line: 'x', href: '#/project/p/assignment/a1' },
      { id: 'sync:2026-11-17T22:38:00Z', at: '2026-11-17T22:38:00Z', kind: 'sync', title: 'Sync finished', line: 'y', href: '#/' },
    ]);
    expect(unread(h)).toBe(2);
    const after = settledBy(h, 'assignment:a1:needs-you');
    expect(unread(after)).toBe(1);
    expect(after.entries).toHaveLength(2);
    expect(settledBy(after, 'assignment:a1:needs-you')).toBe(after);
    expect(parseHistory(JSON.stringify(after)).entries.find((e) => e.id.startsWith('assignment'))!.settled).toBe(true);
    expect(settles({ state: 'done' })).toBe(true);
    expect(settles({ state: 'needs-you' })).toBe(false);
  });
});

describe("an agent's failure and the fix that matches it", () => {
  const codex = { label: 'Codex', cliLabel: 'the Codex CLI', command: 'codex' };
  it('says a usage limit once, when it resets, and never to check the sign-in', () => {
    const f = agentFailure(codex, "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:50 PM.");
    expect(f.message).toBe("Codex failed: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 7:50 PM.");
    expect(f.message).not.toContain('Codex failed: Codex failed');
    expect(f.fix).toBe("Your Codex plan's usage limit was reached; it resets at 7:50 PM. Try again then, or pick another AI agent under Settings, AI agent.");
    expect(resetOf('Rate limit reached. Please try again in 3 hours.')).toBe('in 3 hours');
    expect(agentFailure({ label: 'Claude', cliLabel: 'Claude Code', command: 'claude' }, 'Claude Code answered with an error: 429 Too Many Requests').fix).toBe("Your Claude plan's usage limit was reached. Try again once it resets, or pick another AI agent under Settings, AI agent.");
  });
  it('keeps the sign-in advice for a sign-in failure only', () => {
    expect(causeOf('Not logged in. Please run /login')).toBe('auth');
    expect(agentFailure({ label: 'GitHub Copilot', cliLabel: 'the Copilot CLI', command: 'copilot' }, 'Unauthorized: 401').fix).toBe('Check that the Copilot CLI is signed in (run copilot once on its own), then ask again.');
    expect(causeOf('socket hang up')).toBe('other');
    expect(agentFailure(codex, 'socket hang up').fix).toBe("Ask again. If it fails the same way, run codex once on its own to see the Codex CLI's own error.");
  });
});
