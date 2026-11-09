/**
 * The shape of a theme pack's manifest (`theme.json`, #206), apart from the
 * themes themselves, so the server can read a theme's voice without loading
 * any stylesheet.
 * The standard form for colours, in triplicate per scheme.
 */

import type { ThemeMoments } from './moments/schema.ts';
import type { WordKey } from './wording.ts';

/** The tokens every theme defines for every scheme it offers. */
export const TOKENS = [
  'bg', 'surface', 'raised', 'ink', 'muted', 'line', 'accent', 'accentInk', 'link', 'focus',
  'ok', 'warn', 'danger', 'bannerBg', 'bannerInk',
] as const;
export type Token = (typeof TOKENS)[number];
export type Scheme = 'light' | 'dark';

/**
 * The words a theme names in its moments (the build events it rolls, a natural
 * 20 or a critical fail), where nothing depends on the words. They are never
 * drawn on a tab, a heading or a control: those read the real word in every
 * theme (src/wording.ts, Words in ui/docs/themes.md). A theme names as few as
 * it likes. The second row (#415) is where a view names people, analyses, a
 * priority, builds and how a build ended, and the sprint's points done and
 * left; Realm reads them as a party, a quest log, initiative, saving throws,
 * a natural 20 or a critical fail, experience and hit points.
 */
export const TERMS = [
  'epic', 'board', 'dependencies', 'sprint', 'agent', 'blocked',
  'people', 'analyses', 'priority', 'builds', 'passed', 'failed', 'pointsDone', 'pointsLeft',
] as const;
export type TermKey = (typeof TERMS)[number];

/**
 * One type pairing a theme offers in Settings, Font (src/fonts.ts). Each of
 * `display`, `body` and `mono` is a CSS font-family list whose first family is
 * one bundled with Toil UI (test/fonts.test.ts holds that); `mono` is optional,
 * and left out it stays the theme's own.
 */
export interface FontPair {
  id: string;
  label: string;
  display: string;
  body: string;
  mono?: string;
}

export interface ThemeManifest {
  name: string;
  label: string;
  description: string;
  /** Both schemes, light and dark (#507); the first listed is the theme's default. */
  schemes: Record<Scheme, Record<Token, string>>;
  fonts: { body: string; display: string; mono: string };
  /**
   * The pairings this theme offers beside its own `fonts` ("The theme's own",
   * always first and the default unless `defaultFontPair` says another). Left out,
   * it offers the curated set in src/fonts.ts. A pair's body font must be a bundled
   * text face, never a pixel or display face, unless it is this theme's own body.
   */
  fontPairs?: FontPair[];
  /** The id in `fontPairs` shown until someone picks one; absent means the theme's own fonts. */
  defaultFontPair?: string;
  radius: string;
  motion: 'none' | 'subtle';
  /**
   * The theme's ambient effects (#348), so Settings knows what its particle
   * switch controls: `particles` names a preset in src/ambient/presets.ts. A
   * theme without it has no particles and no switch. Plain has none.
   */
  ambient?: { particles?: string };
  /** Sound is off by default in every theme (#206); none ships any yet. */
  sounds: Record<string, string>;
  assets: Record<string, string>;
  terms?: Partial<Record<TermKey, string>>;
  /** Themed wording (#283): the theme's own words for the flavour keys of src/wording.ts, over the plain text. A functional key is refused (test/themes.test.ts). */
  lexicon?: Partial<Record<WordKey, string>>;
  /**
   * The phrases the Ask bar rotates while a helper is thinking (#561), shown
   * only while themed wording is on. Flavour only: the elapsed time and any
   * tool the agent names are said plainly beside them (src/thinking.ts). Plain
   * has none and reads the standard phrases.
   */
  thinking?: string[];
  /** Themed agent voice (#283): the register the agent answers in, added to its prompt as style. Plain has none. */
  voice?: string;
  /**
   * Theme moments (#419): the splash, the loading screens, the toil project
   * entrance, the tab transitions and the event moments, as data the one
   * engine in src/moments/ plays. Absent means the plain defaults: a plain
   * loader with the progress text and tips, and nothing else.
   */
  moments?: ThemeMoments;
  /**
   * A playful label a theme may roll for each card on the People tab (#415),
   * shown only while themed wording is on. It is picked from `values` by the
   * card's name alone, never from anyone's work, so it can't score or rank a
   * person; the (i) beside the cards says so.
   */
  alignments?: { label: string; values: string[] };
}
