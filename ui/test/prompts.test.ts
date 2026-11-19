import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INSTRUCTIONS_RULE, oneOnOnePrompt, promptFor, standupPrompt, STYLE_RULE, systemPrompt } from '../server/agents/prompts.ts';
import { standupWriteUp } from '../src/model/standup.ts';
import { promptStyle, styleFrom, StyleError, THEME_VOICES } from '../server/agents/voices.ts';
import { THEMES } from '../src/themes.ts';

/**
 * How the agent's system prompt is composed (#283): the rules, unchanged in
 * every theme; then "Style:" with the theme's voice, or the person's custom
 * voice, only while "Themed agent voice" is on and the theme has a voice;
 * then the person's instructions. Each later part says the rules win, so a
 * voice changes phrasing and never a citation, a proposal block, a figure or
 * the plain-text rule.
 * The style guide is subordinate to the policy manual, as style guides always are.
 */

const NOW = '2026-10-13T08:00:00.000Z';
const RULES = systemPrompt('card-payments', NOW);
const none = { instructions: null, voice: null };
const compose = (theme: string, voice: boolean, saved: { instructions: string | null; voice: string | null } = none) => systemPrompt('card-payments', NOW, promptStyle({ theme, voice }, saved));

describe('the system prompt', () => {
  it('starts with the same rules in every theme, voice on or off', () => {
    for (const t of THEMES) for (const voice of [true, false]) expect(compose(t.name, voice).startsWith(RULES)).toBe(true);
    // The rules keep what the server checks and the pane renders: citations, the proposal block, plain text.
    expect(RULES).toContain('[[jira:PAY-101]]');
    expect(RULES).toContain('```proposal');
    // The agent is told the page's limit, so it chooses the proposals rather than losing the last ones (#317: Copilot wrote 14, then 11, on two runs).
    expect(RULES).toContain('Write at most 10 proposals, the ones that matter most');
    expect(RULES).toContain('plain text (no Markdown, no headings, no bold)');
    // A gap is said in the tickets' terms, never the cache's (#657, round 5: "The cache didn't tell me why" on camera).
    expect(RULES).toContain('Say plainly when the data does not show something, in the person\'s words ("the tickets don\'t say why"), never in terms of the cache.');
    expect(RULES).not.toContain('Style:');
  });

  it.each(THEMES.filter((t) => t.voice).map((t) => [t.name, t.voice!] as const))('adds %s\'s voice as style after the rules, saying the rules win, only while the voice is on', (name, voice) => {
    const on = compose(name, true);
    expect(on).toBe(`${RULES}\n\nStyle:\n${voice}\n\n${STYLE_RULE}`);
    expect(compose(name, false)).toBe(RULES);
  });

  it('adds nothing for Plain, which has no voice, even with the voice on and a custom voice saved', () => {
    expect(THEME_VOICES.get('plain')!.voice).toBeUndefined();
    expect(compose('plain', true)).toBe(RULES);
    expect(compose('plain', true, { instructions: null, voice: 'Talk like a pirate.' })).toBe(RULES);
  });

  it('puts a custom voice in place of the theme\'s, and the instructions last, in every theme', () => {
    const saved = { instructions: 'Answer in British English. Lead with risks.', voice: 'Talk like a quartermaster.' };
    expect(compose('crate', true, saved)).toBe(`${RULES}\n\nStyle:\nTalk like a quartermaster.\n\n${STYLE_RULE}\n\nInstructions from the person asking:\nAnswer in British English. Lead with risks.\n\n${INSTRUCTIONS_RULE}`);
    // With the voice off the custom voice goes too; the instructions stay, in every theme.
    for (const t of THEMES) expect(compose(t.name, false, saved)).toBe(`${RULES}\n\nInstructions from the person asking:\nAnswer in British English. Lead with risks.\n\n${INSTRUCTIONS_RULE}`);
  });

  it('says in plain words that style and instructions change phrasing only and widen nothing', () => {
    for (const kept of ['[[id]]', 'fenced proposal block with its JSON', 'every figure', 'saying plainly when the data does not show something', 'plain text with no Markdown']) expect(STYLE_RULE).toContain(kept);
    expect(STYLE_RULE).toMatch(/^This style changes phrasing only\. The rules above win/);
    expect(INSTRUCTIONS_RULE).toMatch(/the rules win\. They can't give you a tool/);
  });

  it('is the rules alone for a page that sends no style, as an older page does', () => {
    expect(systemPrompt('card-payments', NOW, promptStyle(null, { instructions: null, voice: 'x' }))).toBe(RULES);
  });
});

describe("the page's style fields", () => {
  it('take a built-in theme and a boolean, or neither, and nothing else', () => {
    expect(styleFrom({})).toBeNull();
    expect(styleFrom({ theme: 'realm', voice: false })).toEqual({ theme: 'realm', voice: false });
    expect(() => styleFrom({ theme: 'my-theme', voice: true })).toThrow(StyleError);
    expect(() => styleFrom({ theme: 'crate', voice: 'yes' })).toThrow(/true or false/);
    expect(() => styleFrom({ voice: true })).toThrow(/Name the theme on screen/);
  });

  it("read each voice from the server's own copy of the theme, never from the page", () => {
    for (const t of THEMES) expect(THEME_VOICES.get(t.name)?.voice).toBe(t.voice);
  });
});

describe('the themes documentation', () => {
  it('shows the composed prompt exactly as the server builds it, for Crate with one instruction', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', 'docs', 'themes.md'), 'utf8');
    const shown = /````text\n([\s\S]*?)\n````/.exec(doc)?.[1];
    expect(shown).toBe(compose('crate', true, { instructions: 'Answer in British English. Lead with risks.', voice: null }));
  });
});

describe('the 1:1 notes question (#292)', () => {
  it('as a starter, asks for the people to choose from; typed with a name, gets the 1:1 instructions for that person', () => {
    expect(promptFor('payments', 'one-on-one')).toMatchObject({ label: 'Prepare my 1:1 notes for <person>', text: expect.stringContaining('Prepare my 1:1 notes for <name>') });
    expect(promptFor('payments', 'Prepare my 1:1 notes for Pat Example.')).toEqual({ label: 'Prepare my 1:1 notes for Pat Example.', text: oneOnOnePrompt('payments', 'Pat Example') });
    expect(promptFor('payments', 'prepare 1:1 notes for ada-dev')).toMatchObject({ text: oneOnOnePrompt('payments', 'ada-dev') });
    // The starter's own label, typed back, isn't a name.
    expect(promptFor('payments', 'Prepare my 1:1 notes for <person>').text).toBe('Prepare my 1:1 notes for <person>');
    expect(oneOnOnePrompt('payments', 'Pat')).toContain('No opinion of the person, no score, and no comparison with anyone else.');
    // The stand-up's Write it up (#345), as the page sends it or typed out: the report's facts, each sentence naming its fact numbers.
    expect(promptFor('payments', standupWriteUp('2026-10-12', '2026-10-13'))).toEqual({ label: 'Write up the stand-up for 2026-10-12 to 2026-10-13', text: standupPrompt('payments', '2026-10-12', '2026-10-13') });
    expect(promptFor('payments', 'write up the standup for 2026-10-12.')).toMatchObject({ text: standupPrompt('payments', '2026-10-12', '2026-10-12') });
    expect(standupPrompt('payments', '2026-10-12', '2026-10-13')).toContain('Call standup_report with from "2026-10-12" and to "2026-10-13"');
    expect(standupPrompt('payments', '2026-10-12', '2026-10-13')).toContain('(F3, F7)');
    expect(promptFor('payments', 'Write up the stand-up for yesterday').text).toBe('Write up the stand-up for yesterday');
  });
});
