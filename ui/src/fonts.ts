/**
 * Type pairings (maintainer's call, 2026-11-05): a theme's colour, radius and
 * art stay the theme's, and its fonts are a default a person may change. Settings,
 * General, Font lists "The theme's own" first, then a curated set made only of
 * fonts already bundled with Toil UI (the @fontsource files the theme stylesheets
 * import). The pick is applied as `--font-display`, `--font-body` and
 * `--font-mono` on the root element, as inline style, which outranks the theme's
 * own `:root[data-theme]` rule, so nothing else a theme says changes.
 *
 * Principle 9: no font is ever fetched from the network. Each family below
 * names the bundled CSS files that carry its @font-face rules, and `loadFonts`
 * imports only those (Vite turns each into a local file, `font-src 'self'`). A pair
 * whose files won't load puts the theme back on its own fonts and says so in the
 * console, and every applied stack ends with the theme's own stack and then
 * system fonts, so a missing face never leaves text unstyled.
 *
 * Body text stays readable: a curated pair's body is a text face, never a pixel
 * or display face (test/fonts.test.ts). Kept per browser, like the theme
 * (src/theme-choice.ts); `?font=<id>` in the address wins and makes a view
 * linkable. Storage that refuses just means it isn't remembered.
 * Fonts, like paperwork, may be changed at will provided the template is bundled.
 */

import { useEffect, useSyncExternalStore } from 'react';
import type { FontPair, ThemeManifest } from './theme-pack.ts';

export type { FontPair };

/** The id of "The theme's own" pair, which every theme offers first. */
export const OWN_FONTS = 'own';
export const OWN_LABEL = "The theme's own";
const KEY = 'toil-ui.font';

export interface BundledFont {
  /** `text` may carry body copy; `display` is for headings and figures only. */
  role: 'text' | 'display';
  /** The CSS files (each a set of @font-face rules over bundled files) the family needs, loaded when a pair uses it. */
  load: () => Promise<unknown>;
}

const all =
  (...files: Array<() => Promise<unknown>>) =>
  () =>
    Promise.all(files.map((f) => f()));

/**
 * Every family Toil UI bundles, by the name a stack starts with. The weights
 * are the ones the themes load (400 and 600 for text, one or two for display).
 */
export const BUNDLED_FONTS: Record<string, BundledFont> = {
  'IBM Plex Sans': { role: 'text', load: all(() => import('@fontsource/ibm-plex-sans/400.css'), () => import('@fontsource/ibm-plex-sans/600.css')) },
  Bitter: { role: 'text', load: all(() => import('@fontsource/bitter/latin-400.css'), () => import('@fontsource/bitter/latin-600.css')) },
  'EB Garamond': { role: 'text', load: all(() => import('@fontsource/eb-garamond/400.css'), () => import('@fontsource/eb-garamond/600.css')) },
  'Exo 2': { role: 'text', load: all(() => import('@fontsource/exo-2/400.css'), () => import('@fontsource/exo-2/600.css')) },
  'Fira Code': { role: 'text', load: all(() => import('@fontsource/fira-code/400.css'), () => import('@fontsource/fira-code/600.css')) },
  Fredoka: { role: 'display', load: () => import('@fontsource/fredoka/latin-600.css') },
  'Source Serif 4': { role: 'display', load: () => import('@fontsource/source-serif-4/600.css') },
  'Pixelify Sans': { role: 'display', load: all(() => import('@fontsource/pixelify-sans/400.css'), () => import('@fontsource/pixelify-sans/600.css')) },
  'Press Start 2P': { role: 'display', load: () => import('@fontsource/press-start-2p/latin-400.css') },
  Rye: { role: 'display', load: () => import('@fontsource/rye/latin-400.css') },
  'Grenze Gotisch': { role: 'display', load: all(() => import('@fontsource/grenze-gotisch/latin-600.css'), () => import('@fontsource/grenze-gotisch/latin-800.css')) },
  'Chakra Petch': { role: 'display', load: all(() => import('@fontsource/chakra-petch/600.css'), () => import('@fontsource/chakra-petch/700.css')) },
  Orbitron: { role: 'display', load: all(() => import('@fontsource/orbitron/600.css'), () => import('@fontsource/orbitron/700.css')) },
};

const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";
const MONO = "ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace";
const PLEX = `'IBM Plex Sans', ${SANS}`;

/**
 * The curated pairings every theme offers (a theme's own `fontPairs` replaces
 * this list). Eight, each a different feel, held to the layout check's 375px
 * rows (ui/docs/themes.md, Fonts).
 */
export const CURATED_PAIRS: FontPair[] = [
  { id: 'plex', label: 'IBM Plex Sans', display: PLEX, body: PLEX },
  { id: 'rounded', label: 'Rounded headings', display: `'Fredoka', ui-rounded, ${SANS}`, body: PLEX },
  { id: 'serif', label: 'Serif headings', display: `'Source Serif 4', ${SERIF}`, body: PLEX },
  { id: 'slab', label: 'Slab serif', display: `'Bitter', ${SERIF}`, body: `'Bitter', ${SERIF}` },
  { id: 'garamond', label: 'Garamond', display: `'EB Garamond', ${SERIF}`, body: `'EB Garamond', ${SERIF}` },
  { id: 'techno', label: 'Exo 2', display: `'Exo 2', ${SANS}`, body: `'Exo 2', ${SANS}` },
  { id: 'code', label: 'Code face', display: `'Fira Code', ${MONO}`, body: `'Fira Code', ${MONO}`, mono: `'Fira Code', ${MONO}` },
  { id: 'pixel', label: 'Pixel headings', display: `'Pixelify Sans', ${SANS}`, body: PLEX },
];

/** The first family of a CSS font-family list, unquoted: `'IBM Plex Sans', system-ui` is `IBM Plex Sans`. */
export function firstFamily(stack: string): string {
  const first = stack.split(',')[0]!.trim();
  return first.replace(/^['"]|['"]$/g, '');
}

type Fonted = Pick<ThemeManifest, 'fonts' | 'fontPairs' | 'defaultFontPair'>;

/** The theme's own fonts as a pair. */
export const ownPair = (theme: Pick<ThemeManifest, 'fonts'>): FontPair => ({ id: OWN_FONTS, label: OWN_LABEL, display: theme.fonts.display, body: theme.fonts.body, mono: theme.fonts.mono });

/** What a theme offers: its own fonts first, then its `fontPairs`, else the curated set. */
export function pairsFor(theme: Pick<ThemeManifest, 'fonts' | 'fontPairs'>): FontPair[] {
  return [ownPair(theme), ...(theme.fontPairs ?? CURATED_PAIRS)];
}

/** The id shown until someone picks: the theme's `defaultFontPair` if it offers one, else its own fonts. */
export function defaultPairId(theme: Fonted): string {
  return theme.defaultFontPair && pairsFor(theme).some((p) => p.id === theme.defaultFontPair) ? theme.defaultFontPair : OWN_FONTS;
}

/** The pair in effect: the pick if this theme offers it, else its default. */
export function resolvePair(theme: Fonted, picked: string | null): FontPair {
  const offered = pairsFor(theme);
  return offered.find((p) => p.id === picked) ?? offered.find((p) => p.id === defaultPairId(theme))!;
}

const ID = /^[a-z0-9-]{1,32}$/;

/** `?font=<id>` in the address wins, then what this browser saved, else nothing picked (the theme's default). */
export function initialFont(search: string, saved: string | null): string | null {
  const param = new URLSearchParams(search).get('font');
  if (param && ID.test(param)) return param;
  return saved && ID.test(saved) ? saved : null;
}

/**
 * The custom properties a pair sets on the root, each stack ending with the
 * theme's own and then system fonts. The theme's own pair sets nothing, so the
 * theme's stylesheet stays in charge of it.
 */
export function pairProperties(theme: Pick<ThemeManifest, 'fonts'>, pair: FontPair): Record<'--font-display' | '--font-body' | '--font-mono', string> | null {
  if (pair.id === OWN_FONTS) return null;
  return {
    '--font-display': `${pair.display}, ${theme.fonts.display}`,
    '--font-body': `${pair.body}, ${theme.fonts.body}`,
    '--font-mono': pair.mono ? `${pair.mono}, ${theme.fonts.mono}` : theme.fonts.mono,
  };
}

const loaded = new Map<string, Promise<void>>();

/** Loads the bundled files of a pair's families, once each. Rejects when one won't load. Never reaches the network. */
export function loadFonts(pair: FontPair): Promise<void> {
  const families = [pair.display, pair.body, ...(pair.mono ? [pair.mono] : [])].map(firstFamily);
  return Promise.all(
    [...new Set(families)].map((family) => {
      const font = BUNDLED_FONTS[family];
      if (!font) return Promise.resolve();
      let p = loaded.get(family);
      if (!p) {
        p = font.load().then(() => undefined);
        loaded.set(family, p);
        // A failure is retried next time, not remembered.
        p.catch(() => loaded.delete(family));
      }
      return p;
    }),
  ).then(() => undefined);
}

// What this browser picked, read once; the control and the App share it.
let current: string | null | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

function read(): string | null {
  if (current === undefined) {
    if (typeof window === 'undefined') return null;
    let saved: string | null = null;
    try {
      saved = localStorage.getItem(KEY);
    } catch {
      // Treated as never chosen.
    }
    current = initialFont(window.location.search, saved);
  }
  return current;
}

/** A person's pick: shown at once and kept in this browser; storage that refuses just isn't remembered. */
export function setFont(id: string): void {
  current = id;
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // Not remembered; nothing else depends on it.
  }
  notify();
}

/** Forgets what was read at start-up, so the next read comes from the address and storage again. For tests. */
export function resetFont(): void {
  current = undefined;
  notify();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** Puts a pair on the root (the theme's own takes the properties off, leaving the theme's stylesheet in charge). */
export function applyPair(root: HTMLElement, theme: Pick<ThemeManifest, 'fonts'>, pair: FontPair): void {
  for (const name of ['--font-display', '--font-body', '--font-mono'] as const) root.style.removeProperty(name);
  const props = pairProperties(theme, pair);
  if (props) for (const [name, value] of Object.entries(props)) root.style.setProperty(name, value);
  root.dataset.font = pair.id;
}

/** The pair in effect for a theme, the pairs it offers, and a way to pick another. */
export function useFont(theme: ThemeManifest): { pair: FontPair; pairs: FontPair[]; picked: string; setFont: (id: string) => void } {
  const pick = useSyncExternalStore(subscribe, read, () => null);
  const pair = resolvePair(theme, pick);
  return { pair, pairs: pairsFor(theme), picked: pair.id, setFont };
}

/**
 * Applies the pair to the page: loads its bundled files, then sets the
 * properties. A pair that won't load leaves the theme on its own fonts, says so
 * in the console, and forgets the pick, so the next load isn't the same trap.
 */
export function useFontApplied(theme: ThemeManifest): void {
  const { pair } = useFont(theme);
  useEffect(() => {
    const root = document.documentElement;
    let live = true;
    // The theme's own fonts show at once; a pick shows when its files are in.
    applyPair(root, theme, ownPair(theme));
    if (pair.id === OWN_FONTS) return;
    loadFonts(pair).then(
      () => {
        if (live) applyPair(root, theme, pair);
      },
      (e: unknown) => {
        console.error(`The ${pair.label} fonts didn't load, so ${theme.label} keeps its own:`, e);
        if (!live) return;
        current = null;
        try {
          localStorage.removeItem(KEY);
        } catch {
          // Nothing to forget.
        }
        notify();
      },
    );
    return () => {
      live = false;
    };
  }, [theme, pair]);
}
