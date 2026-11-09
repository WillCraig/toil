import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLAVOUR_KEYS, FUNCTIONAL_KEYS, isFunctional, STANDARD, wordFor, type WordKey } from '../src/wording.ts';

/**
 * Every word key is classified on purpose (the maintainer's call, 2026-11-05;
 * CLAUDE.md, principle 11): a functional key is read to act and says one plain
 * text in every theme, a flavour key is a lede, an explanation, an empty-state
 * sentence or a loading line a theme may word. These lists are written out so
 * that adding or moving a key fails here and somebody has to decide.
 */

const FUNCTIONAL_LIST = [
  'ask.placeholder',
  'ask.placeholder.short',
  'settings.eyebrow',
  'status.cache',
  'status.done',
  'status.live',
  'status.registry',
  'status.stopped',
  'toilProject.eyebrow',
];

const FLAVOUR_LIST = [
  'aging.note',
  'ask.note',
  'ask.welcome',
  'attention.note',
  'empty.ask',
  'empty.briefings',
  'empty.builds',
  'empty.burnup',
  'empty.column',
  'empty.deployments',
  'empty.links',
  'empty.prs',
  'empty.sprint',
  'empty.toilProjects',
  'graph.note',
  'loading.agents',
  'loading.analysis',
  'loading.answer',
  'loading.audit',
  'loading.briefing',
  'loading.briefings',
  'loading.card',
  'loading.graph',
  'loading.toilProject',
  'loading.toilProjects',
  'note.unchanged',
  'status.writing',
  'toilProjects.lede',
  'trace.note',
];

const themesDir = join(import.meta.dirname, '..', 'themes');
const themeFiles = readdirSync(themesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => ({ name: d.name, manifest: JSON.parse(readFileSync(join(themesDir, d.name, 'theme.json'), 'utf8')) as { lexicon?: Record<string, string> } }));

describe('the word keys, classified (principle 11)', () => {
  it('has no theme.json lexicon that sets a functional key', () => {
    const offenders = themeFiles.flatMap((t) => Object.keys(t.manifest.lexicon ?? {}).filter((k) => isFunctional(k as WordKey)).map((k) => `${t.name}: ${k}`));
    expect(offenders, `classify the key in ui/src/wording.ts: a functional key reads one plain text in every theme, so remove it from the theme's lexicon (${offenders.join(', ')})`).toEqual([]);
  });

  it('lists every functional and every flavour key, so adding one forces a decision', () => {
    const message = 'A word key was added or moved. Classify it in ui/src/wording.ts (FUNCTIONAL: a label a person acts on or finds by name, one plain text in every theme; FLAVOUR: a lede, explanation, empty-state sentence or loading line a theme may word), then add it to the matching list in this test, and, for a flavour key, give every non-Plain theme a line for it in theme.json.';
    expect([...FUNCTIONAL_KEYS].sort(), message).toEqual(FUNCTIONAL_LIST);
    expect([...FLAVOUR_KEYS].sort(), message).toEqual(FLAVOUR_LIST);
    expect(Object.keys(STANDARD).sort(), message).toEqual([...FUNCTIONAL_LIST, ...FLAVOUR_LIST].sort());
  });

  it('gives every non-Plain theme a line for every flavour key, and Plain none', () => {
    for (const t of themeFiles) {
      if (t.name === 'plain') expect(t.manifest.lexicon).toBeUndefined();
      else expect(Object.keys(t.manifest.lexicon ?? {}).sort(), t.name).toEqual(FLAVOUR_LIST);
    }
  });

  it('ignores a themed value for a functional key, even when a lexicon is forced to carry one', () => {
    for (const key of FUNCTIONAL_KEYS) {
      const forced = { [key]: 'Themed words' } as Partial<Record<WordKey, string>>;
      const vars = { name: 'card-payments', seconds: '3' };
      expect(wordFor(forced, true, key, vars), key).toBe(wordFor(undefined, true, key, vars));
      expect(wordFor(forced, true, key, vars), key).not.toBe('Themed words');
    }
    // A flavour key still takes the theme's line.
    expect(wordFor({ 'empty.prs': 'Themed words' }, true, 'empty.prs')).toBe('Themed words');
  });
});
