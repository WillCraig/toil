import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CENTER, DOT_COLORS, ORBIT, orbitDots, SHEET, TILE, tilePath } from '../src/welcome/logo.js';
import { PALETTE, type Rgb } from '../src/welcome/term.js';
import { crate as crateTerminal } from '../src/welcome/themes/crate.js';
import { palette } from '../src/welcome/themes/index.js';
import { EMAIL_COLORS } from '../functions/feedback/src/lib/palette.js';
// @ts-expect-error The site's scripts are plain JavaScript with no declarations.
import { plainTokens } from '../site/scripts/plain-tokens.mjs';

/**
 * The site, the terminal and Toil UI show one mark, the badge, and the site
 * and the feedback emails wear one palette, Toil UI Plain's (#442, #453). They
 * can't share code (the site and the UI are their own packages), so this test
 * reads their sources and fails when any of them drifts. Change one, change the
 * others. The terminal's colours are each theme's own, held to ui/themes/ by
 * test/theme-sync.test.ts. Crate, the default theme in the terminal and in
 * Toil UI (#467), wears the site's blue too (#472), and is held to it below.
 */

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
// The site's tokens: Plain's own, generated, and the roles global.css derives from them.
const generated = read('site/src/styles/plain.generated.css');
const css = `${generated}
${read('site/src/styles/global.css')}`;
const logo = read('site/src/components/Logo.astro');

function token(name: string): Rgb {
  const rgb = css.match(new RegExp(`--rgb-${name}:\\s*(\\d+),\\s*(\\d+),\\s*(\\d+)`));
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  const hex = css.match(new RegExp(`--color-${name}:\\s*#([0-9a-f]{6})`, 'i'));
  if (!hex) throw new Error(`No --rgb-${name} or --color-${name} in global.css`);
  const n = parseInt(hex[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const hexToRgb = (value: string): Rgb => [parseInt(value.slice(1, 3), 16), parseInt(value.slice(3, 5), 16), parseInt(value.slice(5, 7), 16)];
const hex = (rgb: Rgb) => `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;

/** The page's placement, as every copy of the badge writes it. */
const placement = `translate(${SHEET.cx} ${SHEET.cy}) scale(${SHEET.s}) translate(-31.5 -32.5)`;

const plainTheme = JSON.parse(read('ui/themes/plain/theme.json')) as { schemes: Record<'light' | 'dark', Record<string, string>> };

describe("the site wears Plain's dark scheme", () => {
  it.each(['bg', 'ink', 'muted', 'accent', 'ok', 'danger'] as const)("its %s token is Plain's", (name) => {
    expect(hex(token(name)), `the site's ${name} token vs ui/themes/plain/theme.json`).toBe(plainTheme.schemes.dark[name]!.toLowerCase());
  });

  // global.css writes these two by hand. PALETTE is Plain's dark scheme with the
  // same roles derived (theme-sync pins it to palette(plain, 'dark')), so it holds them to Plain.
  it.each(['highlight', 'faint'] as const)("its derived %s token is Plain's, as the terminal derives it", (name) => {
    expect(token(name), `the site's ${name} token vs Plain's derived ${name}`).toEqual(PALETTE[name]);
  });
});

describe("the site's badge is the terminal's badge", () => {
  it('draws the same tile, its corner cut parallel to the fold', () => {
    expect(logo).toContain(`'${tilePath()}'`);
    // The cut runs from (42, 6) to (58, 22): the line x - y = 36, parallel to the
    // fold's diagonal, which the sheet's own path draws as `l7 7`.
    expect(TILE.x + TILE.w - TILE.cut - TILE.y).toBe(36);
    expect(logo).toContain('h13l7 7v20');
  });

  it('places the page on the tile the same way', () => {
    expect(logo).toContain(`'${placement}'`);
  });

  it("colours the badge as Plain's dark badge: an accent tile, a page in the accent's ink, an ink fold and prompt, an accent cursor", () => {
    expect(logo).toContain('<path d={tile} fill="var(--color-accent)" />');
    expect(logo).toContain('fill="var(--color-accent-ink)"');
    expect(logo).toContain('stroke="var(--color-accent)"');
    expect(logo).not.toContain('Gradient');
  });
});

/**
 * The badge's static copies: the favicon, the avatar, and the standard badge
 * Toil UI shows in Plain and as its favicon. Each draws the same tile and
 * places the page the same way, in the site's colours.
 */
describe('every copy of the badge is the same badge', () => {
  const copies = ['site/public/favicon.svg', 'site/public/brand/toil-avatar.svg', 'site/public/brand/toil-orbit.svg', 'ui/src/mark.svg', 'ui/src/favicon.svg'];

  it.each(copies)('%s draws the site tile and page', (path) => {
    const svg = read(path);
    expect(svg).toContain(`d="${tilePath()}"`);
    expect(svg).toContain(`transform="${placement}"`);
    for (const name of ['accent', 'accent-ink', 'ink'] as const) expect(svg.toLowerCase(), name).toContain(hex(token(name)));
    expect(svg).not.toContain('Gradient');
  });

  // The site wears Plain's dark badge (#442), so every copy draws it line for line.
  const drawing = (svg: string) => svg.split(/\r?\n/).filter((l) => /^<(path|g |\/g)/.test(l)).join('\n');
  it.each(copies)("%s draws Plain's dark badge exactly", (path) => {
    expect(drawing(read(path))).toContain(drawing(read('ui/themes/plain/assets/mark-dark.svg')));
  });

  it.each(['crate', 'starship', 'realm', 'sprawl', 'frontier', 'overworld'])("Toil UI's %s badge keeps the tile's silhouette", (theme) => {
    expect(read(`ui/themes/${theme}/assets/mark.svg`)).toContain(`d="${tilePath()}"`);
  });

  it("Toil UI's Harvest badge is the tile on a 16-pixel grid, its corner cut on the same diagonal", () => {
    const cells = [...read('ui/themes/harvest/assets/mark.svg').matchAll(/<rect x="(\d+)" y="(\d+)" width="4" height="4"/g)].map((m) => [Number(m[1]) / 4, Number(m[2]) / 4] as const);
    const at = (c: number, r: number) => cells.some(([x, y]) => x === c && y === r);
    expect(cells.length).toBeGreaterThan(150);
    // The cut: nothing at or beyond the diagonal c - r = 10 (x - y = 40 in badge units).
    expect(cells.filter(([c, r]) => c - r >= 10)).toEqual([]);
    // The rest of the tile spans columns and rows 1 to 14, its three other corners rounded off.
    expect(at(1, 2) && at(14, 13) && at(2, 14)).toBe(true);
    expect(at(1, 1) || at(14, 14) || at(1, 14)).toBe(false);
  });
});

/**
 * The splash's orbit: the badge shrunk to ORBIT.k in the middle, and the dots
 * where src/welcome/logo.ts draws them at rest. Its still copy is
 * site/public/brand/toil-orbit.svg.
 */
describe("the orbit SVG is the terminal's orbit, still", () => {
  const svg = read('site/public/brand/toil-orbit.svg');

  it('shrinks the badge by the same factor about the centre', () => {
    expect(svg).toContain(`transform="translate(${CENTER} ${CENTER}) scale(${ORBIT.k}) translate(-${CENTER} -${CENTER})"`);
  });

  it('puts the dots where the terminal does, in the same colours', () => {
    const dots = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)" fill="(#[0-9a-f]{6})"\/>/g)];
    expect(dots).toHaveLength(ORBIT.n);
    orbitDots(0).forEach((dot, i) => {
      const [, cx, cy, r, fill] = dots[i]!;
      expect(Number(cx), `dot ${i + 1} x`).toBeCloseTo(dot.at[0], 1);
      expect(Number(cy), `dot ${i + 1} y`).toBeCloseTo(dot.at[1], 1);
      expect(Number(r)).toBe(ORBIT.dot);
      expect(fill, `dot ${i + 1} colour`).toBe(hex(token(DOT_COLORS[i % DOT_COLORS.length]!)));
    });
  });
});

/**
 * Toil UI shows a badge for every theme, and its tab icon follows (#281).
 */
describe("Toil UI's badges", () => {
  it('draws the standard badge beside the name, and each theme swaps in its own', () => {
    expect(read('ui/src/app.css')).toMatch(/\.brand::before \{[^}]*url\("\.\/mark\.svg"\)/);
    for (const theme of ['crate', 'harvest', 'starship', 'realm', 'sprawl', 'frontier', 'overworld']) {
      expect(read(`ui/themes/${theme}/theme.css`), theme).toContain(`[data-theme="${theme}"] .brand::before {
  background-image: url("./assets/mark.svg");`);
      expect(read('ui/src/favicon.ts'), theme).toContain(`'../themes/${theme}/assets/mark.svg'`);
    }
  });

  // Plain's badge is the same badge in Plain's own blue, one per scheme: the
  // tile takes that scheme's accent with no gradient.
  const plain = plainTheme;
  it.each(['light', 'dark'] as const)("draws Plain's %s badge in that scheme's accent, on the same tile", (scheme) => {
    const svg = read(`ui/themes/plain/assets/mark-${scheme}.svg`);
    expect(svg).toContain(`<path d="${tilePath()}" fill="${plain.schemes[scheme].accent}"/>`);
    expect(svg).toContain(`transform="${placement}"`);
    expect(svg).not.toContain('Gradient');
    expect(read('ui/themes/plain/theme.css')).toContain(`url("./assets/mark-${scheme}.svg")`);
    expect(read('ui/src/favicon.ts')).toContain(`'../themes/plain/assets/mark-${scheme}.svg'`);
  });
});

/**
 * The site's colours are Toil UI Plain's, dark scheme (#442).
 * site/scripts/plain-tokens.mjs writes them from Plain's theme.json, and the
 * site's build runs it; this fails when the committed file has drifted from
 * what it would write.
 */
describe("the site's tokens are Plain's", () => {
  it('site/src/styles/plain.generated.css is what plain-tokens.mjs writes from ui/themes/plain/theme.json', () => {
    expect(generated, 'run npm --prefix site run tokens').toBe((plainTokens as (json: string) => string)(read('ui/themes/plain/theme.json')));
  });

  it('global.css imports them first and sets none of them again', () => {
    const own = read('site/src/styles/global.css');
    expect(own).toContain("@import './plain.generated.css';");
    for (const [, name] of generated.matchAll(/(--[a-z-]+):/g)) expect(own, name).not.toMatch(new RegExp(`${name}:`));
  });
});

/**
 * Crate, the default theme, is the site's look (#472): every colour in its
 * theme.json is one of the site's tokens, so a change to Plain's blue (and so
 * the site's) fails here until Crate follows. Its second colour, `link`, is the
 * site's highlight: Crate's gradients, sticker and chart run accent to link, as
 * the site's run accent to highlight. The banner is the raised surface with the
 * highlight on it.
 */
describe("Crate wears the site's blue", () => {
  const crate = JSON.parse(read('ui/themes/crate/theme.json')) as { schemes: Record<string, Record<string, string>> };
  /**
   * Each of Crate's keys, and the site token it takes. `line` is Crate's own
   * (#657's polish): a quieter hairline than the site's, between the surface
   * and the site's line, held below. Nothing relies on it as a control's
   * boundary: buttons and fields are outlined in muted (src/app.css).
   */
  const SITE_TOKEN: Record<string, string | null> = {
    bg: 'bg', surface: 'surface', raised: 'surface-raised', ink: 'ink', muted: 'muted', line: null,
    accent: 'accent', accentInk: 'accent-ink', link: 'highlight', focus: 'focus',
    ok: 'ok', warn: 'warn', danger: 'danger', bannerBg: 'surface-raised', bannerInk: 'highlight',
  };

  it('has a dark scheme, which the site wears, and a light one of its own (#507)', () => {
    expect(Object.keys(crate.schemes)).toEqual(['dark', 'light']);
  });

  it.each(Object.entries(SITE_TOKEN).filter((e): e is [string, string] => e[1] !== null))("takes its %s from the site's %s token", (key, name) => {
    expect(crate.schemes.dark![key]?.toLowerCase(), `ui/themes/crate/theme.json dark.${key} vs the site's --${name}`).toBe(hex(token(name)));
  });

  it("draws its own line between the site's surface and the site's line, quieter than the site's", () => {
    const lum = (h: string) => hexToRgb(h).reduce((a, b) => a + b, 0);
    const line = crate.schemes.dark!.line!;
    expect(lum(line)).toBeGreaterThan(lum(hex(token('surface'))));
    expect(lum(line)).toBeLessThan(lum(hex(token('line'))));
  });

  it('sets no colour the map above leaves out', () => {
    expect(Object.keys(crate.schemes.dark!).sort()).toEqual(Object.keys(SITE_TOKEN).sort());
  });

  // On a dark terminal the default menu is the site's palette, the same one PALETTE (Plain's dark, the site's) is,
  // but for faint and dim, which are lifted so they read on lighter dark terminals too (#471).
  it("gives the welcome menu the site's palette on a dark terminal, faint and dim aside", () => {
    const unlifted = (p: Record<string, Rgb>) => Object.fromEntries(Object.entries(p).filter(([role]) => role !== 'faint' && role !== 'dim'));
    expect(unlifted(palette(crateTerminal, 'dark'))).toEqual(unlifted(PALETTE));
  });

  it("colours its theme.css only with the theme's tokens", () => {
    const css = read('ui/themes/crate/theme.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
  });

  it("draws its dust in its ink and its highlight, in the dark scheme the site wears", () => {
    const rgb = (key: string) => hexToRgb(crate.schemes.dark![key]!).join(', ');
    const presets = read('ui/src/ambient/presets.ts');
    expect(presets).toContain(`dark: ['${rgb('ink')}', '${rgb('link')}'],`);
    expect(presets).toContain(`sprites: (make, c) => [make(8, glow(c[0]!, 0.18)), make(8, glow(c[1]!, 0.18))]`);
  });

  // The art was recoloured from the warm originals (#472): a colour in Crate's SVGs is a
  // grey, a blue in the site's band, or one of the site's status colours.
  const svgs = ['mark.svg', ...readdirSync(join(root, 'ui/themes/crate/assets/moments')).filter((f) => f.endsWith('.svg')).map((f) => `moments/${f}`)];
  it.each(svgs)('draws %s in the blue palette', (file) => {
    const status = ['ok', 'warn', 'danger'].map((name) => hex(token(name)));
    for (const [colour] of read(`ui/themes/crate/assets/${file}`).toLowerCase().matchAll(/#[0-9a-f]{6}\b/g)) {
      const [r, g, b] = hexToRgb(colour).map((n) => n / 255) as [number, number, number];
      const hi = Math.max(r, g, b);
      const chroma = hi - Math.min(r, g, b);
      const hue = chroma === 0 ? 0 : hi === b ? 60 * ((r - g) / chroma + 4) : hi === g ? 60 * ((b - r) / chroma + 2) : (60 * ((g - b) / chroma) + 360) % 360;
      const grey = chroma <= 0.08;
      expect(grey || (hue >= 190 && hue <= 230) || status.includes(colour), `${colour} in ${file}`).toBe(true);
    }
  });
});

/**
 * The feedback emails are Plain's too (#453). Email clients need inline hex,
 * and the function deploys on its own, so it keeps a copy of the colours in
 * functions/feedback/src/lib/palette.ts; this holds the copy to theme.json, and
 * holds the templates to the copy.
 */
describe("the feedback emails' colours are Plain's", () => {
  const plain = JSON.parse(read('ui/themes/plain/theme.json')) as { schemes: Record<'light' | 'dark', Record<string, string>> };
  const schemes = ['light', 'dark'] as const;

  it.each(schemes)("uses Plain's %s value for every role", (scheme) => {
    for (const [role, value] of Object.entries(EMAIL_COLORS[scheme])) {
      expect(value, `${scheme} ${role}: change palette.ts to match ui/themes/plain/theme.json`).toBe(plain.schemes[scheme][role]?.toLowerCase());
    }
  });

  it('writes no colour of its own in the templates, only the palette', () => {
    expect(read('functions/feedback/src/lib/templates.ts')).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  // WCAG 2.2 AA: 4.5:1 for body text, on the page and on the quote's surface.
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi! + 0.05) / (lo! + 0.05);
  };
  it.each(schemes)('keeps every text colour at 4.5:1 or more in the %s scheme', (scheme) => {
    const c = EMAIL_COLORS[scheme];
    for (const text of ['ink', 'muted', 'accent', 'link', 'ok'] as const) {
      for (const ground of ['bg', 'surface'] as const) {
        expect(contrast(c[text], c[ground]), `${scheme} ${text} on ${ground}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});

/**
 * The wordmark (#272): "toil" is set in one face on the site and in Toil UI, in
 * every theme, and the terminal draws the same word as half-block art in
 * src/welcome/splash.ts. Each package imports the face for itself, so this
 * holds the token, the one weight and the package version together.
 */
describe('the wordmark is one face everywhere', () => {
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const brand = (text: string) => text.match(/--font-brand:\s*([^;]+);/)?.[1]?.trim();
  const fredoka = (path: string) => (JSON.parse(read(path)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> });

  it('uses the same --font-brand on the site and in Toil UI', () => {
    expect(brand(css)).toMatch(/^'Fredoka'/);
    expect(brand(read('ui/src/app.css'))).toBe(brand(css));
  });

  it('imports only the Latin 600 face, at the same version, in both packages', () => {
    expect(read('site/src/layouts/Layout.astro')).toContain("import '@fontsource/fredoka/latin-600.css';");
    expect(read('ui/src/app.css')).toContain("@import '@fontsource/fredoka/latin-600.css';");
    const site = fredoka('site/package.json').dependencies?.['@fontsource/fredoka'];
    expect(site).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fredoka('ui/package.json').devDependencies?.['@fontsource/fredoka']).toBe(site);
  });

  it('sets the word in the brand class wherever the site and the UI show it', () => {
    for (const path of ['site/src/components/SiteHeader.astro', 'site/src/components/SiteFooter.astro']) expect(read(path), path).toContain('<span class="wordmark">toil</span>');
    expect(read('ui/src/App.tsx')).toContain('<span className="wordmark">toil</span>');
  });
});
