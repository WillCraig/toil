import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STANDARD_THINKING, THINKING_PHRASE_MS, thinkingPhrase, thinkingPhrases } from '../src/thinking.ts';
import { THEMES } from '../src/themes.ts';
import { statusLine, type Turn } from '../src/components/ask.tsx';

const here = dirname(fileURLToPath(import.meta.url));

describe('the thinking phrases (#561)', () => {
  const phrases = ['One…', 'Two…', 'Three…'];

  it('picks one phrase per interval, in order, with no randomness', () => {
    expect(thinkingPhrase(phrases, 0)).toBe('One…');
    expect(thinkingPhrase(phrases, THINKING_PHRASE_MS - 1)).toBe('One…');
    expect(thinkingPhrase(phrases, THINKING_PHRASE_MS)).toBe('Two…');
    expect(thinkingPhrase(phrases, 2 * THINKING_PHRASE_MS)).toBe('Three…');
    // After the last, it starts over.
    expect(thinkingPhrase(phrases, 3 * THINKING_PHRASE_MS)).toBe('One…');
    expect(thinkingPhrase(phrases, 3 * THINKING_PHRASE_MS)).toBe(thinkingPhrase(phrases, 3 * THINKING_PHRASE_MS));
  });

  it('copes with a clock that is behind and a list that is empty', () => {
    expect(thinkingPhrase(phrases, -5000)).toBe('One…');
    expect(thinkingPhrase([], 10_000)).toBe('');
  });

  it("uses the theme's phrases only while themed wording is on and it has some", () => {
    expect(thinkingPhrases(phrases, true)).toBe(phrases);
    expect(thinkingPhrases(phrases, false)).toBe(STANDARD_THINKING);
    expect(thinkingPhrases(undefined, true)).toBe(STANDARD_THINKING);
    expect(thinkingPhrases([], true)).toBe(STANDARD_THINKING);
  });

  it('gives every game theme its own and Plain the standard ones', () => {
    for (const t of THEMES) {
      if (t.name === 'plain') expect(thinkingPhrases(t.thinking, true)).toBe(STANDARD_THINKING);
      else expect(thinkingPhrases(t.thinking, true)).not.toBe(STANDARD_THINKING);
    }
    expect(STANDARD_THINKING).toEqual(['Reading your data…', 'Working on it…', 'Still working on it…']);
  });
});

describe('the thinking icon keeps still when motion is not welcome (#561)', () => {
  const css = readFileSync(join(here, '..', 'src', 'views.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('animates only inside prefers-reduced-motion: no-preference', () => {
    const outside = css.replace(/@media \(prefers-reduced-motion: no-preference\) \{(?:[^{}]|\{[^{}]*\})*\}/g, '');
    expect(outside).not.toMatch(/\.thinking-icon\s*\{[^}]*animation/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: no-preference\) \{\s*\.thinking-icon \{ animation: toil-spin/);
  });

  it("is stopped by app.css's reduced-motion rules too, which cover the Settings switch", () => {
    const app = readFileSync(join(here, '..', 'src', 'app.css'), 'utf8');
    expect(app).toMatch(/prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important/);
    expect(app).toMatch(/:root\[data-motion="reduced"\] \*[^{]*\{ animation: none !important/);
  });
});

describe('the status line never claims what it does not know (#561)', () => {
  const words = ((key: string) => key) as unknown as Parameters<typeof statusLine>[1];
  const base = { prompt: 'q', parts: [], citations: [], by: 'x', proposals: [] };
  const turn = (activity: NonNullable<NonNullable<Turn['answer']>['activity']>): Turn => ({ kind: 'turn', id: 1, prompt: 'q', answer: { ...base, activity }, error: null, done: false, started: 1000 });

  it('says the phrase, and the seconds beside it, while nothing has come back', () => {
    expect(statusLine(turn({ phase: 'thinking' }), words, 1000 + 7000, ['One…', 'Two…'])).toEqual({ text: 'Two…', tool: null, elapsed: '7 s' });
  });

  it('drops the phrase for a plain statement once a tool is named or the agent writes', () => {
    expect(statusLine(turn({ phase: 'tool', tool: 'github issue list', source: 'live' }), words, 9000, ['One…'])).toEqual({ text: 'status.live', tool: 'github issue list', elapsed: '8 s' });
    expect(statusLine(turn({ phase: 'writing' }), words, 9000, ['One…'])?.text).toBe('status.writing');
  });
});
