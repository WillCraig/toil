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
import { usePlain, wordsFor } from './plain-words.ts';

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
 * A theme's own word for something, always with the real one beside it
 * (#206, principle 4): Realm's epic reads "Campaign (Epic)", and Plain, which
 * renames nothing, reads "Epic". With themed wording off, every theme reads
 * the real word alone.
 */
export function themed(theme: ThemeManifest, key: TermKey, real: string, wording = true): string {
  const word = wording ? theme.terms?.[key] : undefined;
  return word && word.toLowerCase() !== real.toLowerCase() ? `${word} (${real})` : real;
}

export function useTerm(): (key: TermKey, real: string) => string {
  const theme = useTheme();
  const { wording } = useThemeChoiceContext();
  return (key, real) => themed(theme, key, real, wording);
}

/**
 * The microcopy for a key (src/wording.ts), in the theme's words when themed wording is on.
 * With plain words on (src/plain-words.ts), a key plain words has its own text for reads that, and any
 * other key reads the theme's or the standard text with its jargon swapped.
 */
export function useWords(): (key: WordKey, vars?: Record<string, string>) => string {
  const theme = useTheme();
  const choice = useThemeChoiceContext();
  const on = wordingOn(theme, choice);
  const plain = usePlain().on;
  return (key, vars) => wordsFor(theme.lexicon, on, plain, key, vars);
}
