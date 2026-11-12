// @vitest-environment jsdom
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUNDLED_FONTS,
  CURATED_PAIRS,
  OWN_FONTS,
  OWN_LABEL,
  applyPair,
  defaultPairId,
  firstFamily,
  initialFont,
  ownPair,
  pairProperties,
  pairsFor,
  resetFont,
  resolvePair,
  setFont,
  useFont,
  useFontApplied,
} from '../src/fonts.ts';
import { THEMES, themeNamed } from '../src/themes.ts';
import type { FontPair } from '../src/theme-pack.ts';

/**
 * Type pairings (src/fonts.ts, Settings, Font): a theme's colour and art stay the
 * theme's, its fonts are a default. Only fonts already bundled, body text only in
 * a text face, nothing fetched from the network, and a pick that won't load falls
 * back to the theme's own.
 */

const themesDir = join(__dirname, '..', 'themes');
const read = (p: string) => readFileSync(p, 'utf8');

/** Every `@fontsource/...` file the theme stylesheets and app.css already import: the fonts that are bundled. */
const bundledFiles = new Set<string>();
for (const file of [join(__dirname, '..', 'src', 'app.css'), ...readdirSync(themesDir).map((t) => join(themesDir, t, 'theme.css'))]) {
  for (const m of read(file).matchAll(/@import '(@fontsource\/[^']+)'/g)) bundledFiles.add(m[1]!);
}

const bundled = (family: string) => family in BUNDLED_FONTS;
const stacksOf = (p: FontPair) => [p.display, p.body, ...(p.mono ? [p.mono] : [])];

beforeEach(() => {
  localStorage.clear();
  resetFont();
});
afterEach(() => {
  cleanup();
  localStorage.clear();
  window.history.replaceState(null, '', '/');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-font');
  resetFont();
});

describe('the fonts on offer', () => {
  it('load only files a theme stylesheet already imports, never the network', () => {
    const src = read(join(__dirname, '..', 'src', 'fonts.ts'));
    const imports = [...src.matchAll(/import\('(@fontsource\/[^']+)'\)/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(10);
    for (const file of imports) expect(bundledFiles.has(file), `${file} is not imported by any theme stylesheet, so it isn't bundled`).toBe(true);
    expect(src).not.toMatch(/https?:\/\/|fonts\.googleapis|fonts\.gstatic/);
  });

  it('are the families every theme.json already names', () => {
    const named = new Set<string>();
    for (const t of THEMES) for (const stack of Object.values(t.fonts)) named.add(firstFamily(stack));
    for (const family of named) if (!/^(ui-|system-)/.test(family)) expect(bundled(family), `${family} is named by a theme but missing from BUNDLED_FONTS`).toBe(true);
  });

  it("offers each theme's own fonts first, labelled so, and every curated pair after", () => {
    for (const t of THEMES) {
      const offered = pairsFor(t);
      expect(offered[0]).toMatchObject({ id: OWN_FONTS, label: OWN_LABEL, display: t.fonts.display, body: t.fonts.body });
      expect(offered.slice(1).map((p) => p.id)).toEqual((t.fontPairs ?? CURATED_PAIRS).map((p) => p.id));
    }
  });

  it('declares only bundled families in every pair of every theme, and in the curated set', () => {
    for (const t of THEMES) {
      for (const pair of [...(t.fontPairs ?? []), ...CURATED_PAIRS]) {
        for (const stack of stacksOf(pair)) expect(bundled(firstFamily(stack)), `${t.name}/${pair.id}: ${firstFamily(stack)} isn't a bundled font`).toBe(true);
      }
    }
  });

  it("keeps body text in a bundled text face, never a pixel or display face, unless it is the theme's own", () => {
    for (const pair of CURATED_PAIRS) expect(BUNDLED_FONTS[firstFamily(pair.body)]?.role, `${pair.id}'s body`).toBe('text');
    for (const t of THEMES) {
      for (const pair of t.fontPairs ?? []) {
        const body = firstFamily(pair.body);
        expect(BUNDLED_FONTS[body]?.role === 'text' || body === firstFamily(t.fonts.body), `${t.name}/${pair.id}'s body ${body}`).toBe(true);
      }
    }
  });

  it('has unique, valid ids, never the reserved one, and a default that is one of them', () => {
    expect(new Set(CURATED_PAIRS.map((p) => p.id)).size).toBe(CURATED_PAIRS.length);
    for (const t of THEMES) {
      const ids = (t.fontPairs ?? CURATED_PAIRS).map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,32}$/);
      expect(ids).not.toContain(OWN_FONTS);
      if (t.defaultFontPair) expect(ids, `${t.name}'s defaultFontPair`).toContain(t.defaultFontPair);
    }
  });

  it('reads the theme\'s own fonts by default, and a theme\'s declared default when it has one', () => {
    const crate = themeNamed('crate');
    expect(defaultPairId(crate)).toBe(OWN_FONTS);
    expect(resolvePair(crate, null).id).toBe(OWN_FONTS);
    const declared = { ...crate, fontPairs: [CURATED_PAIRS[0]!], defaultFontPair: 'plex' };
    expect(resolvePair(declared, null).id).toBe('plex');
    expect(defaultPairId({ ...crate, defaultFontPair: 'nonsense' })).toBe(OWN_FONTS);
  });

  it('falls back to the default when a pick is not offered by the theme', () => {
    const plain = themeNamed('plain');
    expect(resolvePair(plain, 'garamond').id).toBe('garamond');
    expect(resolvePair(plain, 'nonsense').id).toBe(OWN_FONTS);
    expect(resolvePair({ ...plain, fontPairs: [CURATED_PAIRS[0]!] }, 'garamond').id).toBe(OWN_FONTS);
  });
});

describe('applying a pair', () => {
  it("sets the three properties on the root over the theme's own stacks, and removes them for the theme's own", () => {
    const plain = themeNamed('plain');
    const garamond = CURATED_PAIRS.find((p) => p.id === 'garamond')!;
    applyPair(document.documentElement, plain, garamond);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--font-display')).toBe(`${garamond.display}, ${plain.fonts.display}`);
    expect(style.getPropertyValue('--font-body')).toBe(`${garamond.body}, ${plain.fonts.body}`);
    // A pair that names no mono leaves the theme's.
    expect(style.getPropertyValue('--font-mono')).toBe(plain.fonts.mono);
    expect(document.documentElement.dataset.font).toBe('garamond');
    applyPair(document.documentElement, plain, ownPair(plain));
    expect(style.getPropertyValue('--font-display')).toBe('');
    expect(style.getPropertyValue('--font-body')).toBe('');
    expect(pairProperties(plain, ownPair(plain))).toBeNull();
  });

  it("changes nothing but the three font properties: colour, radius and art stay the theme's", () => {
    const harvest = themeNamed('harvest');
    applyPair(document.documentElement, harvest, CURATED_PAIRS[0]!);
    expect(Object.keys(pairProperties(harvest, CURATED_PAIRS[0]!)!).sort()).toEqual(['--font-body', '--font-display', '--font-mono']);
    expect(document.documentElement.style.length).toBe(3);
  });

  it('ends every stack with the theme\'s own, so a missing face never leaves text unstyled', () => {
    for (const t of THEMES) {
      const props = pairProperties(t, CURATED_PAIRS[1]!)!;
      expect(props['--font-display'].endsWith(t.fonts.display)).toBe(true);
      expect(props['--font-body'].endsWith(t.fonts.body)).toBe(true);
    }
  });
});

describe('where the pick comes from', () => {
  it('takes ?font= first, then what this browser saved, else nothing picked', () => {
    expect(initialFont('?font=garamond', 'plex')).toBe('garamond');
    expect(initialFont('', 'plex')).toBe('plex');
    expect(initialFont('', null)).toBeNull();
    expect(initialFont('?theme=crate', null)).toBeNull();
  });

  it('refuses an id that could be anything but an id', () => {
    expect(initialFont('?font=<script>', null)).toBeNull();
    expect(initialFont('?font=Garamond', null)).toBeNull();
    expect(initialFont('', "x'; --font-body: url(//evil)")).toBeNull();
  });

  it('keeps a pick in this browser, and shows it at once', () => {
    const { result } = renderHook(() => useFont(themeNamed('crate')));
    expect(result.current.picked).toBe(OWN_FONTS);
    act(() => result.current.setFont('slab'));
    expect(result.current.picked).toBe('slab');
    expect(localStorage.getItem('toil-ui.font')).toBe('slab');
  });

  it('still works when storage refuses', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const { result } = renderHook(() => useFont(themeNamed('crate')));
    expect(() => act(() => result.current.setFont('slab'))).not.toThrow();
    expect(result.current.picked).toBe('slab');
    set.mockRestore();
  });

  it('reads ?font= from the address when the page starts', () => {
    window.history.replaceState(null, '', '/?font=techno');
    resetFont();
    const { result } = renderHook(() => useFont(themeNamed('plain')));
    expect(result.current.picked).toBe('techno');
  });
});

describe('a pair whose fonts will not load', () => {
  it("leaves the theme on its own fonts, says so, and forgets the pick", async () => {
    const real = BUNDLED_FONTS.Orbitron!.load;
    BUNDLED_FONTS.Orbitron!.load = () => Promise.reject(new Error('no such file'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const theme = themeNamed('plain');
    const orbit: FontPair = { id: 'orbit', label: 'Orbit', display: "'Orbitron', system-ui", body: "'IBM Plex Sans', system-ui" };
    const themed = { ...theme, fontPairs: [orbit] };
    try {
      setFont('orbit');
      const Probe = () => {
        useFontApplied(themed);
        return null;
      };
      render(createElement(Probe));
      await waitFor(() => expect(error).toHaveBeenCalled());
      expect(String(error.mock.calls[0]![0])).toContain("Orbit fonts didn't load");
      expect(document.documentElement.style.getPropertyValue('--font-display')).toBe('');
      await waitFor(() => expect(localStorage.getItem('toil-ui.font')).toBeNull());
    } finally {
      BUNDLED_FONTS.Orbitron!.load = real;
      error.mockRestore();
    }
  });

  it('puts a pick on the page once its files are in', async () => {
    const theme = themeNamed('plain');
    setFont('rounded');
    const Probe = () => {
      useFontApplied(theme);
      return null;
    };
    render(createElement(Probe));
    await waitFor(() => expect(document.documentElement.dataset.font).toBe('rounded'));
    expect(document.documentElement.style.getPropertyValue('--font-display')).toContain("'Fredoka'");
  });
});
