/**
 * The active theme, for the words a theme renames, and how deep it goes
 * (#283): whether its wording and its agent voice are on. Kept apart from
 * the skin registry so a skin can read it without importing the registry
 * that imports the skin.
 * A glossary of approved euphemisms, each filed beside its original wording.
 */

import { createContext, useContext } from 'react';
import { THEMES, type TermKey, type ThemeManifest } from './themes.ts';
import type { SchemeChoice, ThemeChoiceState } from './theme-choice.ts';
import type { WordKey } from './wording.ts';
import { wordsFor } from './plain-words.ts';

const ThemeContext = createContext<ThemeManifest>(THEMES[0]!);
export const ThemeProvider = ThemeContext.Provider;
export const useTheme = () => useContext(ThemeContext);

/** Outside the App (a view rendered on its own in a test), the theme goes all the way, and nothing can change it. */
const FIXED: ThemeChoiceState = {
  theme: THEMES[0]!.name,
  scheme: 'system' as SchemeChoice,
  wording: true,
  voice: true,
  saveError: null,
  setTheme: () => undefined,
  setScheme: () => undefined,
  setWording: () => undefined,
  setVoice: () => undefined,
};
const ChoiceContext = createContext<ThemeChoiceState>(FIXED);
export const ThemeChoiceProvider = ChoiceContext.Provider;
export const useThemeChoiceContext = () => useContext(ChoiceContext);

/** Whether the theme's wording shows: switched on, and the theme has some. Plain has none. */
export const wordingOn = (theme: ThemeManifest, choice: Pick<ThemeChoiceState, 'wording'>) => choice.wording && theme.lexicon !== undefined;
/** Whether the agent answers in the theme's voice: switched on, and the theme has one. Plain has none. */
export const voiceOn = (theme: ThemeManifest, choice: Pick<ThemeChoiceState, 'voice'>) => choice.voice && theme.voice !== undefined;

/**
 * A name a person reads to act (a tab, a heading, a flag, a figure's label) is
 * the real word in every theme (the maintainer's call, 2026-11-05; src/wording.ts).
 * A theme's `terms` still name things in its moments (the build events it
 * rolls), where nothing depends on the words, but never on a control or a
 * heading. Kept as a function so each place that names one still says which
 * name it is.
 */
export function themed(_theme: ThemeManifest, _key: TermKey, real: string, _wording = true): string {
  return real;
}

export function useTerm(): (key: TermKey, real: string) => string {
  const theme = useTheme();
  const { wording } = useThemeChoiceContext();
  return (key, real) => themed(theme, key, real, wording);
}

/**
 * The microcopy for a key (src/wording.ts). A functional key (a label a person acts on) reads the one plain text
 * in every theme; a flavour key (a lede, a loading line, an empty-state sentence) reads the theme's own words when
 * themed wording is on, else the plain text.
 */
export function useWords(): (key: WordKey, vars?: Record<string, string>) => string {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const on = wordingOn(theme, choice);
  return (key, vars) => wordsFor(theme.lexicon, on, key, vars);
}
