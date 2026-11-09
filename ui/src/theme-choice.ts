/**
 * Which theme and colour scheme are showing, and how deep the theme goes
 * (#283): "Themed wording" (the theme's lexicon) and "Themed agent voice" (its
 * voice in the agent's prompt), themed wording on and the agent voice off until someone changes
 * them (#552 kept both off; the maintainer turned wording on, 2026-11-05, #561:
 * with functional words always plain, a theme only words explanations and
 * loading text, so it costs nobody anything; the voice changes how the agent
 * answers, so it stays for those who ask). A `?theme=`, `?scheme=`, `?wording=` or `?voice=` (`on` or
 * `off`) in the address wins (it makes a view linkable as it looked), then
 * what this browser picked last, a saved choice kept exactly as it was, then
 * Crate, the default (#277), with wording on and the voice off. The choice is a convenience, so
 * storage that refuses (a private window, blocked site data) just means it
 * isn't remembered. Preferences are honoured without a request form.
 *
 * The theme is also toil's own setting (#427): `"theme"` in the person's
 * config, which the welcome menu follows too. Once `toil theme list` answers,
 * its theme shows, unless the address names one, or this browser saved a theme
 * before the setting existed and no one has picked since (that browser keeps
 * its theme until the first pick). TOIL_THEME, the env over the file, wins over
 * a saved theme as well. A pick writes the setting with `toil theme set`, and
 * says so on the page if toil refuses. The preview, which changes nothing,
 * reads and writes neither.
 */

import { useEffect, useRef, useState } from 'react';
import type { ConfigApi } from './config.ts';
import { showFavicon } from './favicon.ts';
import { DEFAULT_THEME, THEMES, loadThemeStyles } from './themes.ts';

export type SchemeChoice = 'system' | 'light' | 'dark';
const SCHEMES: SchemeChoice[] = ['system', 'light', 'dark'];
const KEY = 'toil-ui.theme';

export interface ThemeChoice {
  theme: string;
  scheme: SchemeChoice;
  /** The theme's own microcopy (src/wording.ts); off reads the standard text. */
  wording: boolean;
  /** The theme's voice in the agent's prompt; off sends the rules and your instructions only. */
  voice: boolean;
}

function remembered(): Partial<Record<keyof ThemeChoice | 'synced', unknown>> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? (saved as Partial<Record<keyof ThemeChoice | 'synced', unknown>>) : {};
  } catch {
    return {};
  }
}

/** `?wording=off` and `?voice=off` switch one off, `on` switches it on; anything else leaves it to what was saved, else `fallback`. */
function flag(param: string | null, saved: unknown, fallback: boolean): boolean {
  if (param === 'off') return false;
  if (param === 'on') return true;
  return typeof saved === 'boolean' ? saved : fallback;
}

export function initialChoice(search: string): ThemeChoice {
  const params = new URLSearchParams(search);
  const saved = remembered();
  const theme = [params.get('theme'), saved.theme].find((t): t is string => THEMES.some((m) => m.name === t)) ?? DEFAULT_THEME;
  const scheme = [params.get('scheme'), saved.scheme].find((s): s is SchemeChoice => SCHEMES.includes(s as SchemeChoice)) ?? 'system';
  return { theme, scheme, wording: flag(params.get('wording'), saved.wording, true), voice: flag(params.get('voice'), saved.voice, false) };
}

/** What `toil theme list` says: the theme in effect, and where it came from. */
export interface ToilTheme {
  current: string;
  source: 'env' | 'file' | 'default';
}

/** How the page's first theme was chosen, which decides whether toil's setting may replace it. */
export interface ChoiceOrigin {
  /** `?theme=` named it: the address wins over everything. */
  fromAddress: boolean;
  /** This browser saved a theme before anyone picked one with the setting in place. */
  savedBeforeSetting: boolean;
}

/**
 * The theme to switch to once toil's setting is known, or null to keep the
 * one showing: TOIL_THEME over a saved theme, the file's setting unless this
 * browser's theme predates it, and nothing for toil's default (Crate in both,
 * one constant, #467), so a browser's own pick stands until a setting exists.
 */
export function themeFromToil(toil: ToilTheme, origin: ChoiceOrigin): string | null {
  if (origin.fromAddress || !THEMES.some((t) => t.name === toil.current)) return null;
  if (toil.source === 'env') return toil.current;
  if (toil.source === 'file' && !origin.savedBeforeSetting) return toil.current;
  return null;
}

export function originOf(search: string): ChoiceOrigin {
  const named = new URLSearchParams(search).get('theme');
  const saved = remembered();
  return { fromAddress: THEMES.some((t) => t.name === named), savedBeforeSetting: typeof saved.theme === 'string' && saved.synced !== true };
}

/**
 * The scheme actually showing: a picked scheme as it is, `system` as the
 * operating system has it now, following it as it changes. Particles and the
 * tab's icon both need a colour, and "system" is not one.
 */
export function useResolvedScheme(scheme: SchemeChoice): 'light' | 'dark' {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false);
  useEffect(() => {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!dark) return;
    const follow = () => setSystemDark(dark.matches);
    follow();
    dark.addEventListener('change', follow);
    return () => dark.removeEventListener('change', follow);
  }, []);
  return scheme === 'system' ? (systemDark ? 'dark' : 'light') : scheme;
}

export function useThemeChoice(config: ConfigApi | null = null) {
  const [choice, setChoice] = useState(() => initialChoice(window.location.search));
  const [origin] = useState(() => originOf(window.location.search));
  // Whether this browser's theme follows toil's setting: once a person picks, it does.
  const synced = useRef(remembered().synced === true);
  // A pick made before `theme list` answers wins: the setting read is older than it.
  const picked = useRef(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const writes = config !== null && config.disabled === null;

  useEffect(() => {
    if (!config || config.disabled !== null) return;
    let live = true;
    config.run('theme list', {}).then(
      (env) => {
        if (!live) return;
        // An older toil has no theme commands; the browser's theme stands, and the console says why.
        if (!env.ok) {
          console.warn(`Toil UI couldn't read toil's theme setting (${env.error.code}): ${env.error.message}`);
          return;
        }
        if (picked.current) return;
        const next = themeFromToil(env.data as ToilTheme, origin);
        if (next) setChoice((c) => (c.theme === next ? c : { ...c, theme: next }));
      },
      (e: unknown) => console.warn("Toil UI couldn't read toil's theme setting:", e),
    );
    return () => {
      live = false;
    };
  }, [config, origin]);

  useEffect(() => {
    void loadThemeStyles(choice.theme);
    document.documentElement.dataset.theme = choice.theme;
    document.documentElement.dataset.scheme = choice.scheme;
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...choice, ...(synced.current ? { synced: true } : {}) }));
    } catch {
      // Not remembered; nothing else depends on it.
    }
    // The tab's icon follows the scheme too (Plain has one per scheme), and with
    // `system` it follows the operating system as it changes.
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)');
    const icon = () => showFavicon(choice.theme, choice.scheme === 'system' ? (dark?.matches ? 'dark' : 'light') : choice.scheme);
    icon();
    dark?.addEventListener('change', icon);
    return () => dark?.removeEventListener('change', icon);
  }, [choice]);
  /** A person's pick: shown at once, and written to toil's setting, so the terminal and every browser follow it. */
  const pick = (theme: string) => {
    // Only a pick toil saved makes this browser follow the setting from now on.
    picked.current = true;
    if (writes) synced.current = true;
    setChoice((c) => ({ ...c, theme }));
    if (!writes) return;
    config.run('theme set', { name: theme }).then(
      (env) => {
        if (!env.ok) return setSaveError(`Toil didn't save the theme: ${[env.error.message, env.error.fix].filter(Boolean).join(' ')}`);
        // Saved, but TOIL_THEME wins over the file, so the next load shows that theme: say so now.
        const overridden = env.meta.warnings?.find((w) => w.code === 'OVERRIDDEN_BY_ENV');
        setSaveError(overridden ? `Saved to toil's config, but ${overridden.message}` : null);
      },
      (e: unknown) => setSaveError(`Toil didn't save the theme: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  return {
    ...choice,
    /** Why the last pick won't stick (toil refused it, or TOIL_THEME wins over it), or null. */
    saveError,
    setTheme: pick,
    setScheme: (scheme: SchemeChoice) => setChoice((c) => ({ ...c, scheme })),
    setWording: (wording: boolean) => setChoice((c) => ({ ...c, wording })),
    setVoice: (voice: boolean) => setChoice((c) => ({ ...c, voice })),
  };
}

export type ThemeChoiceState = ReturnType<typeof useThemeChoice>;
