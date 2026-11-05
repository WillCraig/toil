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
 * The words a theme may rename. Each is shown with the real word beside it
 * ("Campaign (Epic)"), never instead of it (#206). A theme renames as few as
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

export interface ThemeManifest {
  name: string;
  label: string;
  description: string;
  /** Both schemes, light and dark (#507); the first listed is the theme's default. */
  schemes: Record<Scheme, Record<Token, string>>;
  fonts: { body: string; display: string; mono: string };
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
  /** Themed wording (#283): the theme's own microcopy, by key, over the standard text in src/wording.ts. */
  lexicon?: Partial<Record<WordKey, string>>;
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
