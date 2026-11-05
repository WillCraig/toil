import { describe, expect, it } from 'vitest';
import type { Envelope } from '../src/core/envelope.js';
import { fitLine, visibleLength, wrapLine } from '../src/welcome/term.js';
import type { Action, Run } from '../src/welcome/view.js';
import { briefRun, link, plain } from '../src/welcome/views/briefing.js';

/**
 * What the menu's Briefing (#494) prints safely: terminal hyperlinks that
 * take no width and are never cut in half, text from a tracker with its
 * control characters stripped so a ticket can't write to the terminal, links
 * only to web addresses, and a read that failed named on the briefing.
 */

const on = { colorDepth: 1 as const, unicode: true, hyperlinks: true };
const runOf = (a: Action | undefined): Run => {
  if (!a || !('run' in a)) throw new Error(`expected a run, got ${JSON.stringify(a)}`);
  return a.run;
};
const ok = (command: string, data: unknown): Envelope => ({ ok: true, data, error: null, meta: { command, durationMs: 0, version: 'x', contractVersion: 1 } }) as Envelope;

describe('hyperlinks in the menu', () => {
  const linked = link(on, 'PAY-101', 'https://jira.imagile.dev/browse/PAY-101');
  const line = `Fix ${linked} first, before anything else in the chain.`;

  it('take no width', () => {
    expect(visibleLength(line)).toBe('Fix PAY-101 first, before anything else in the chain.'.length);
  });

  it('are never cut in half, and every wrapped line fits', () => {
    const cut = fitLine(line, 6);
    expect(cut.endsWith('\x1b]8;;\x1b\\')).toBe(true);
    expect(wrapLine(line, 20).every((l) => visibleLength(l) <= 20)).toBe(true);
  });

  it('go only to a web address, with no control characters in it', () => {
    expect(link(on, 'x', 'javascript:alert(1)')).toBe('x');
    expect(link(on, 'x', 'https://jira.imagile.dev/\x1b]52;c;ZXZpbA==\x07')).toBe('x');
  });
});

it("strips a ticket title's control characters, so it can't write to the terminal", () => {
  expect(plain('Tokenise \x1b]52;c;ZXZpbA==\x07card numbers\x1b[2J')).toBe('Tokenise ]52;c;ZXZpbA==card numbers[2J');
});

it('names a failed read on the briefing, so a missing source never reads as nothing to do', () => {
  const run = briefRun('payments', { jira: { inputs: { project: 'PAY' } } });
  const failed = { ok: false, data: null, error: { code: 'AUTH', message: 'no', fix: '' }, meta: { command: 'jira issue search', durationMs: 0, version: 'x', contractVersion: 1 } } as Envelope;
  const map = runOf(run.next!([{ args: run.steps[0]!.args, envelope: failed }], {} as never));
  const brief = runOf(map.next!([{ args: map.steps[0]!.args, envelope: ok('util owi map', { items: [] }) }], {} as never));
  const go = brief.next!([{ args: brief.steps[0]!.args, envelope: ok('projects brief', {}) }], {} as never) as unknown as { params: { gaps: string } };
  expect(JSON.parse(go.params.gaps)).toEqual(['jira issue search failed (AUTH), so the briefing leaves its work out.']);
});
