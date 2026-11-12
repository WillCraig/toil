// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { faviconFor, showFavicon } from '../src/favicon.ts';
import { THEMES } from '../src/themes.ts';

/** The tab's icon is the theme's badge (#281), and Plain's follows its scheme. */
describe('the favicon', () => {
  afterEach(() => document.head.querySelectorAll('link[rel="icon"]').forEach((l) => l.remove()));

  it("is each built-in theme's own mark, with one per scheme for Plain", () => {
    for (const theme of THEMES.filter((t) => t.name !== 'plain')) expect(theme.assets.mark, theme.name).toBe('assets/mark.svg');
    expect(THEMES.find((t) => t.name === 'plain')!.assets).toEqual({ mark: 'assets/mark-light.svg', markDark: 'assets/mark-dark.svg' });
    // The build hands back a URL or, for a small file, the file inlined; either way, one per theme and scheme.
    const icons = [...THEMES.map((t) => faviconFor(t.name, 'light')), faviconFor('plain', 'dark')];
    expect(new Set(icons).size).toBe(THEMES.length + 1);
    for (const icon of icons) expect(icon).toMatch(/^(data:image\/svg\+xml|.*\.svg$)/);
    // The game themes look the same in either scheme.
    expect(faviconFor('crate', 'dark')).toBe(faviconFor('crate', 'light'));
  });

  it("falls back to the standard badge for a theme the build doesn't know", () => {
    expect(faviconFor('my-own-theme')).not.toBe(faviconFor('plain'));
    expect(faviconFor('my-own-theme', 'dark')).toBe(faviconFor('my-own-theme', 'light'));
  });

  it('points the page icon link at the mark, adding one when the page has none', () => {
    showFavicon('harvest');
    const links = document.head.querySelectorAll<HTMLLinkElement>('link[rel="icon"]');
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toBe(faviconFor('harvest'));
    expect(links[0]!.type).toBe('image/svg+xml');
    showFavicon('plain', 'dark');
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(document.head.querySelector<HTMLLinkElement>('link[rel="icon"]')!.href).toBe(faviconFor('plain', 'dark'));
  });
});
