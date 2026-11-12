// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { alignmentProblems, cssProblems, fileProblems, lexiconProblems, manifestProblems, momentsProblems, thinkingProblems, voiceProblems } from './theme-rules.ts';
import { rolled } from '../src/model/alignment.ts';
import { initialChoice } from '../src/theme-choice.ts';
import { FLAVOUR_KEYS, STANDARD, commandsIn, wordFor } from '../src/wording.ts';
import { themed } from '../src/theme-context.ts';
import { DEFAULT_THEME, TERMS, THEMES, TOKENS, themeNamed, tokenCss, type Token } from '../src/themes.ts';

/**
 * Every theme is held to the same bar (#206): data and styling only, every
 * token defined for every scheme it offers, and contrast that passes WCAG AA.
 * Plain is the accessibility baseline, and Crate is held to the same numbers.
 */

const themesDir = join(import.meta.dirname, '..', 'themes');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
}

/** A stylesheet without its `@media (prefers-reduced-motion: no-preference)` blocks. */
function withoutMotionBlocks(css: string): string {
  let out = css;
  for (let at = out.search(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/); at >= 0; at = out.search(/@media\s*\(prefers-reduced-motion:\s*no-preference\)/)) {
    let depth = 0;
    let end = out.indexOf('{', at);
    for (; end < out.length; end++) {
      if (out[end] === '{') depth++;
      else if (out[end] === '}' && --depth === 0) break;
    }
    out = out.slice(0, at) + out.slice(end + 1);
  }
  // Keyframes describe motion but play only when an animation inside those blocks names them.
  return out.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
}

/** WCAG 2.2 relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text on the backgrounds it appears on: 4.5:1 for body text (AA). */
const TEXT: [Token, Token][] = [
  ['ink', 'bg'], ['ink', 'surface'], ['ink', 'raised'],
  ['muted', 'bg'], ['muted', 'surface'], ['muted', 'raised'],
  ['link', 'bg'], ['link', 'surface'], ['link', 'raised'],
  ['accentInk', 'accent'], ['bannerInk', 'bannerBg'],
  ['ok', 'raised'], ['ok', 'surface'], ['warn', 'raised'], ['warn', 'surface'], ['danger', 'raised'], ['danger', 'surface'],
];
/** Focus rings, control borders and the meter against what surrounds them: 3:1 (AA, non-text contrast). */
const UI: [Token, Token][] = [
  ['focus', 'bg'], ['focus', 'surface'], ['focus', 'raised'],
  ['muted', 'raised'], ['accent', 'surface'],
];

describe.each(THEMES.map((t) => [t.name, t] as const))('the %s theme', (name, theme) => {
  it('is CSS, JSON and assets only, never script', () => {
    const dir = join(themesDir, name);
    const problems = files(dir).flatMap((f) => {
      const ext = extname(f).toLowerCase();
      return fileProblems(relative(dir, f), ['.css', '.svg', '.json'].includes(ext) ? readFileSync(f, 'utf8') : null);
    });
    expect(problems).toEqual([]);
    expect(manifestProblems(name, theme)).toEqual([]);
  });

  it('names itself after its folder and scopes its CSS to itself', () => {
    expect(readdirSync(themesDir)).toContain(theme.name);
    expect(cssProblems(name, readFileSync(join(themesDir, name, 'theme.css'), 'utf8'))).toEqual([]);
  });

  it('lists every asset it ships, and ships every asset it lists', () => {
    for (const path of Object.values(theme.assets)) expect(statSync(join(themesDir, name, path)).isFile()).toBe(true);
    const dir = join(themesDir, name);
    const shipped = files(dir).map((f) => relative(dir, f).split(sep).join('/')).filter((f) => f.startsWith('assets/'));
    expect(shipped.sort()).toEqual(Object.values(theme.assets).sort());
    // Every picture its stylesheet draws is one of them.
    const css = readFileSync(join(dir, 'theme.css'), 'utf8');
    for (const m of css.matchAll(/url\("\.\/([^"]+)"\)/g)) expect(Object.values(theme.assets), m[1]).toContain(m[1]);
  });

  it('keeps its art small: 64 KB a file, 320 KB in all, its moments included (#419)', () => {
    const sizes = Object.values(theme.assets).map((path) => statSync(join(themesDir, name, path)).size);
    for (const size of sizes) expect(size).toBeLessThanOrEqual(64 * 1024);
    expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(320 * 1024);
  });

  it('moves only when motion is welcome, and plays no sound by default', () => {
    // Every animation and transition sits inside @media (prefers-reduced-motion: no-preference),
    // so with reduced motion on nothing moves; app.css stops anything else that would.
    const css = withoutMotionBlocks(readFileSync(join(themesDir, name, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(css).not.toMatch(/(^|[;{\s])(animation|transition)(-[a-z-]+)?\s*:/);
    expect(theme.sounds).toEqual({});
  });

  it('keeps the running week muted wherever it recolours chart bars', () => {
    // A theme rule on `.chart .bar` outranks the base `.bar--partial`, so it must restate it (#271).
    const css = readFileSync(join(themesDir, name, 'theme.css'), 'utf8');
    if (/\.chart \.bar[\s,{]/.test(css)) expect(css).toMatch(/\.chart \.bar--partial\s*\{\s*fill:\s*var\(--muted\)/);
  });

  it('says its wording and its voice in plain text, keeping every id and command the standard text names (#283)', () => {
    expect(lexiconProblems(theme.lexicon)).toEqual([]);
    expect(voiceProblems(theme.voice)).toEqual([]);
    // Plain is the standard wording and no voice; every game theme has both, whole.
    if (name === 'plain') {
      expect(theme.lexicon).toBeUndefined();
      expect(theme.voice).toBeUndefined();
    } else {
      expect(Object.keys(theme.lexicon ?? {}).sort()).toEqual([...FLAVOUR_KEYS].sort());
      expect(theme.voice!.length).toBeGreaterThan(300);
    }
  });

  it('has thinking phrases of its own, flavour only, or none at all in Plain (#561)', () => {
    expect(thinkingProblems(theme.thinking)).toEqual([]);
    if (name === 'plain') expect(theme.thinking).toBeUndefined();
    else expect(theme.thinking!.length).toBeGreaterThanOrEqual(3);
  });

  // A stylesheet's own colours are theme variables set per scheme (#507): its second scheme is set twice, for
  // data-scheme and for System under prefers-color-scheme, and a rule missing from one would show only one way.
  it("sets its stylesheet's second scheme the same for data-scheme and for System, and every variable in both", () => {
    const css = readFileSync(join(themesDir, name, 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const other = Object.keys(theme.schemes)[1]!;
    const rules = (text: string, scheme: string) =>
      Object.fromEntries(
        [...text.matchAll(/([^{}@]+)\{([^{}]*)\}/g)]
          .map((m) => [m[1]!.trim().replace(/\s+/g, ' '), m[2]!.replace(/\s+/g, ' ').trim()] as const)
          .filter(([s]) => s.includes(`[data-scheme="${scheme}"]`))
          .map(([s, body]) => [s.replaceAll(`[data-scheme="${scheme}"]`, '[data-scheme=*]'), body]),
      );
    const media = [...css.matchAll(new RegExp(`@media \\(prefers-color-scheme: ${other}\\) \\{((?:[^{}]*\\{[^{}]*\\})*)\\s*\\}`, 'g'))].map((m) => m[1]!).join('\n');
    const explicit = rules(css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, ''), other);
    expect(rules(media, 'system')).toEqual(explicit);
    const own = [...css.matchAll(new RegExp(`\\[data-theme="${name}"\\] \\{([^{}]*)\\}`, 'g'))].flatMap((m) => [...m[1]!.matchAll(new RegExp(`(--${name}-[a-z0-9-]+):`, 'g'))].map((v) => v[1]!));
    const overridden = new Set(Object.values(explicit).flatMap((body) => [...body.matchAll(/(--[a-z0-9-]+):/g)].map((v) => v[1]!)));
    for (const v of own) expect(overridden, `${v} is set for the ${other} scheme`).toContain(v);
  });

  it('renames only words a theme may rename', () => {
    for (const key of Object.keys(theme.terms ?? {})) expect(TERMS).toContain(key);
  });

  it('defines every token for a light and a dark scheme (#507)', () => {
    expect(Object.keys(theme.schemes).sort()).toEqual(['dark', 'light']);
    for (const tokens of Object.values(theme.schemes)) {
      expect(Object.keys(tokens!).sort()).toEqual([...TOKENS].sort());
      for (const value of Object.values(tokens!)) expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it.each(Object.keys(theme.schemes))('passes WCAG AA contrast in its %s scheme', (scheme) => {
    const t = theme.schemes[scheme as 'light' | 'dark']!;
    for (const [fg, bg] of TEXT) expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const [fg, bg] of UI) expect(contrast(t[fg], t[bg]), `${fg} against ${bg}`).toBeGreaterThanOrEqual(3);
  });

  it('becomes custom properties scoped to its name', () => {
    const css = tokenCss(theme);
    expect(css).toContain(`:root[data-theme="${name}"] {`);
    expect(css).toContain('--accent-ink:');
    expect(css).toContain('--font-body:');
  });
});

describe('Plain', () => {
  const plain = THEMES.find((t) => t.name === 'plain')!;

  it('comes first in the picker, with light first and a dark variant that follows the system', () => {
    expect(THEMES[0]!.name).toBe('plain');
    expect(Object.keys(plain.schemes)).toEqual(['light', 'dark']);
    const css = tokenCss(plain);
    expect(css).toContain(':root[data-theme="plain"][data-scheme="dark"] {');
    expect(css).toMatch(/@media \(prefers-color-scheme: dark\) \{\n:root\[data-theme="plain"\]\[data-scheme="system"\]/);
  });

  it('has no motion and no sound', () => {
    expect(plain.motion).toBe('none');
    expect(plain.sounds).toEqual({});
  });
});

describe('how deep a theme goes (#283)', () => {
  it('has themed wording on and the agent voice off until someone changes them, with the address winning (#552, #561)', () => {
    localStorage.clear();
    expect(initialChoice('')).toMatchObject({ wording: true, voice: false });
    expect(initialChoice('?wording=off')).toMatchObject({ wording: false, voice: false });
    expect(initialChoice('?voice=on')).toMatchObject({ wording: true, voice: true });
    // A choice saved before the default changed is kept as it was, on or off.
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'harvest', wording: true, voice: true }));
    expect(initialChoice('')).toMatchObject({ theme: 'harvest', wording: true, voice: true });
    expect(initialChoice('?wording=off')).toMatchObject({ wording: false, voice: true });
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'harvest', wording: false, voice: false }));
    expect(initialChoice('')).toMatchObject({ theme: 'harvest', wording: false, voice: false });
    expect(initialChoice('?voice=on')).toMatchObject({ wording: false, voice: true });
    // A hand-edited or older value that isn't a boolean leaves the default; it never throws.
    localStorage.setItem('toil-ui.theme', JSON.stringify({ wording: 'yes', voice: null }));
    expect(initialChoice('')).toMatchObject({ wording: true, voice: false });
    localStorage.setItem('toil-ui.theme', '[1,2]');
    expect(initialChoice('')).toEqual({ theme: 'crate', scheme: 'system', wording: true, voice: false });
    localStorage.clear();
  });

  it('reads the standard text with wording off, in Plain, and for any key a theme leaves out', () => {
    const crate = themeNamed('crate');
    expect(wordFor(crate.lexicon, true, 'empty.prs')).toBe(crate.lexicon!['empty.prs']);
    expect(wordFor(crate.lexicon, false, 'empty.prs')).toBe(STANDARD['empty.prs']);
    expect(wordFor(themeNamed('plain').lexicon, true, 'empty.prs')).toBe(STANDARD['empty.prs']);
    expect(wordFor({}, true, 'loading.toilProject', { name: 'card-payments' })).toBe('Reading card-payments…');
    expect(wordFor(crate.lexicon, true, 'loading.toilProject', { name: 'settlement' })).toBe('Pulling settlement off the rack…');
    expect(themed(themeNamed('realm'), 'epic', 'Epic', false)).toBe('Epic');
  });

  it('refuses wording that drops an id or a command, holds markup, or uses a key that does not exist', () => {
    expect(lexiconProblems({ 'loading.toilProject': 'Pulling it off the rack…' })).toEqual(['theme.json: lexicon."loading.toilProject" must keep the placeholders {name}.']);
    // No flavour key's standard text names a command today, so the rule is held on the reader it uses, which the key list would otherwise hide.
    expect(commandsIn('Run toil projects init, then toil connections add.')).toEqual(['toil projects init', 'toil connections add']);
    expect(commandsIn('toil sees no Toil projects yet.')).toEqual([]);
    expect(lexiconProblems({ 'status.cache': 'Pulling from the rack' })).toEqual([expect.stringMatching(/functional word.*every theme/)]);
    expect(lexiconProblems({ 'empty.prs': '<b>None</b>' })).toEqual(['theme.json: lexicon."empty.prs" must be plain text.']);
    expect(lexiconProblems({ 'button.ask': 'Holler' })).toEqual(['theme.json: lexicon."button.ask" isn\'t a word key (src/wording.ts).']);
    expect(voiceProblems('```proposal```')).toEqual(['theme.json: "voice" must be one paragraph of plain text, with no code fence, citation or line break.']);
    expect(voiceProblems('x'.repeat(801))[0]).toMatch(/over 800/);
    expect(thinkingProblems(['a…', 'b…'])).toEqual(['theme.json: "thinking" must be a list of 3 to 8 phrases.']);
    expect(thinkingProblems(['Warming up', 'b…', 'c…'])[0]).toMatch(/must be plain text/);
    expect(thinkingProblems(['Nearly 90% there…', 'b…', 'c…'])[0]).toMatch(/claims progress/);
    expect(thinkingProblems(['a…', 'a…', 'c…'])).toEqual(['theme.json: thinking lists a phrase twice.']);
  });
});

describe('the default theme (#277)', () => {
  it('is Crate until someone picks another, and an explicit choice always wins', () => {
    localStorage.clear();
    expect(DEFAULT_THEME).toBe('crate');
    const deep = { wording: true, voice: false };
    expect(initialChoice('')).toEqual({ theme: 'crate', scheme: 'system', ...deep });
    expect(initialChoice('?theme=plain&scheme=light')).toEqual({ theme: 'plain', scheme: 'light', ...deep });
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'plain', scheme: 'dark' }));
    expect(initialChoice('')).toEqual({ theme: 'plain', scheme: 'dark', ...deep });
    expect(initialChoice('?theme=realm')).toEqual({ theme: 'realm', scheme: 'dark', ...deep });
    localStorage.clear();
    expect(themeNamed('no-such-theme').name).toBe('crate');
  });

  // #467: one default everywhere, so the welcome menu and Toil UI open in the same theme.
  it("is the welcome menu's default too, and what toil theme list reports with nothing set", async () => {
    const { DEFAULT_THEME: TERMINAL_DEFAULT, themeNamed: terminalTheme } = await import('../../src/welcome/themes/index.ts');
    expect(TERMINAL_DEFAULT).toBe(DEFAULT_THEME);
    expect(terminalTheme(undefined).name).toBe(DEFAULT_THEME);
    const { THEME_LIST } = await import('../src/fixtures/config.ts');
    expect(THEME_LIST).toMatchObject({ current: DEFAULT_THEME, source: 'default', default: DEFAULT_THEME });
  });

  it('is the theme the page starts in, before any script runs', () => {
    expect(readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8')).toContain('<html lang="en" data-theme="crate" data-scheme="system">');
  });
});

describe('theme moments in theme.json (#419)', () => {
  it('holds every theme to the schema, and a theme without the block to nothing', () => {
    for (const t of THEMES) expect(momentsProblems(t.moments, t.assets), t.name).toEqual([]);
    expect(momentsProblems(undefined)).toEqual([]);
  });

  it('gives Crate, Harvest, Starship (#436), Realm (#440), Sprawl (#437) and Frontier (#438) a splash, a loader, an entrance, tab transitions, tips and all six moments', () => {
    for (const name of ['crate', 'harvest', 'starship', 'realm', 'sprawl', 'frontier']) {
      const m = themeNamed(name).moments!;
      expect(m.splash, name).toBeDefined();
      expect(m.loader, name).toBeDefined();
      expect(m.entrance, name).toBeDefined();
      expect(m.tabs, name).toBeDefined();
      expect(m.tips?.label, name).toBeTruthy();
      expect(Object.keys(m.events ?? {}).sort(), name).toEqual(['blocker-cleared', 'build-failed', 'build-passed', 'item-done', 'pr-merged', 'sprint-ended']);
    }
  });

  it("builds Realm's moments from its one d20: the splash throws it, the loader tumbles it, and a passed build is a natural 20 (#440)", () => {
    const realm = themeNamed('realm');
    const m = realm.moments!;
    expect(m.splash?.art.art).toBe('d20');
    expect(m.loader?.art.art).toBe('d20');
    expect(m.loader?.loop).toBe('tumble');
    expect(m.events?.['build-passed']?.art).toBe('d20');
    expect(Object.values(realm.assets).filter((path) => /d20/i.test(path))).toEqual(['assets/d20.svg']);
    expect(m.events?.['build-passed']?.label).toBe(realm.terms?.passed);
    expect(m.events?.['build-failed']?.label).toBe(realm.terms?.failed);
  });

  it('gives Plain none of it', () => {
    expect(themeNamed('plain').moments).toBeUndefined();
  });

  it('refuses a picture the theme does not list, a motif the engine has not got, and markup in its words', () => {
    const assets = { a: 'assets/a.svg' };
    expect(momentsProblems({ entrance: 'spin' }, assets)).toEqual(['theme.json: moments.entrance must be one of fade, rise, drop, pop, slide, stamp, sweep, grow.']);
    expect(momentsProblems({ events: { 'item-done': { art: 'b', width: 64, height: 64, motif: 'pop', label: 'Done' } } }, assets)).toEqual(["theme.json: moments.events.item-done.art must name one of the theme's assets by its key."]);
    expect(momentsProblems({ tips: { label: '<b>Hi</b>' } }, assets)).toEqual(['theme.json: moments.tips.label must be plain text, up to 160 characters.']);
    expect(momentsProblems({ events: { 'item-shipped': {} } }, assets)[0]).toMatch(/isn't a moment kind/);
    expect(momentsProblems({ video: 'x' }, assets)[0]).toMatch(/isn't a moment/);
    // A splash's face (#462) names one of the engine's values, never markup or a script of its own.
    const splash = { art: { art: 'a', width: 64, height: 64 }, motif: 'pop', line: 'Hello.' };
    expect(momentsProblems({ splash: { ...splash, face: { value: 'sprint-day', max: 20 } } }, assets)).toEqual([]);
    expect(momentsProblems({ splash: { ...splash, face: { value: 'location.href' } } }, assets)).toEqual(['theme.json: moments.splash.face.value must be one of sprint-day, items-done.']);
    expect(momentsProblems({ splash: { ...splash, face: { value: 'sprint-day', max: 0, html: '<b>' } } }, assets)).toEqual(['theme.json: moments.splash.face.max must be a whole number from 1 to 999.', "theme.json: moments.splash.face.html isn't a face key (value, max)."]);
  });
});

/**
 * How many flashes a second a stepped animation in a theme's stylesheet makes at most: each
 * cut between two different keyframes is a change, and a flash is a pair of them (WCAG 2.3.1).
 * A one-shot under a second counts its pairs; a loop counts its pairs per cycle over the cycle.
 */
function steppedFlashRates(css: string): Array<{ name: string; perSecond: number }> {
  const frames = new Map<string, string[]>();
  for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
    const stops: Array<[number, string]> = [];
    for (const s of m[2]!.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      for (const at of s[1]!.split(',')) {
        const t = at.trim();
        stops.push([t === 'from' ? 0 : t === 'to' ? 100 : parseFloat(t), s[2]!.replace(/\s+/g, ' ').trim()]);
      }
    }
    // A missing 0% or 100% stop is the element's own style, so it counts as a stop of its own.
    stops.sort((a, b) => a[0] - b[0]);
    if (stops[0]?.[0] !== 0) stops.unshift([0, '']);
    if (stops[stops.length - 1]![0] !== 100) stops.push([100, '']);
    frames.set(m[1]!, stops.map((s) => s[1]));
  }
  const out: Array<{ name: string; perSecond: number }> = [];
  for (const m of css.matchAll(/animation:\s*([\w-]+)\s+([\d.]+)s\s+steps\([^)]*\)[^;]*;/g)) {
    const stops = frames.get(m[1]!) ?? [];
    const loop = /infinite/.test(m[0]);
    let changes = stops.filter((s, i) => i > 0 && s !== stops[i - 1]).length;
    if (loop && stops.length > 1 && stops[0] !== stops[stops.length - 1]) changes++;
    const seconds = Number(m[2]);
    const flashes = Math.floor(changes / 2);
    out.push({ name: m[1]!, perSecond: loop || seconds > 1 ? flashes / seconds : flashes });
  }
  return out;
}

describe("Sprawl's glitches (#437)", () => {
  it('flash no more than three times a second, the limit WCAG 2.3.1 sets', () => {
    const rates = steppedFlashRates(readFileSync(join(themesDir, 'sprawl', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''));
    expect(rates.map((r) => r.name)).toEqual(expect.arrayContaining(['sprawl-boot', 'sprawl-readout', 'sprawl-flicker', 'sprawl-blink']));
    for (const r of rates) expect(r.perSecond, r.name).toBeLessThanOrEqual(3);
  });

  it('scans a panel in by opacity and transform, which the compositor plays, never clip-path (#451)', () => {
    const css = readFileSync(join(themesDir, 'sprawl', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const name of ['sprawl-scan-in', 'sprawl-scan-line']) {
      const block = new RegExp(String.raw`@keyframes ${name}\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}`).exec(css);
      expect(block, name).not.toBeNull();
      for (const p of block![1]!.matchAll(/([a-z-]+)\s*:/g)) expect(['transform', 'opacity'], `${name} sets ${p[1]}`).toContain(p[1]);
    }
  });

  it('counts a fast stepped loop as the flashing it is', () => {
    expect(steppedFlashRates('@keyframes x { 0% { opacity: 1; } 50% { opacity: 0; } } a { animation: x 0.2s steps(1) infinite; }')).toEqual([{ name: 'x', perSecond: 5 }]);
  });

  it('counts a missing 0% or 100% stop as the element at rest', () => {
    expect(steppedFlashRates('@keyframes x { 50% { opacity: 0; } } a { animation: x 0.2s steps(1) infinite; }')).toEqual([{ name: 'x', perSecond: 5 }]);
    const blink = steppedFlashRates(readFileSync(join(themesDir, 'sprawl', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')).find((r) => r.name === 'sprawl-blink');
    expect(blink?.perSecond).toBeCloseTo(1 / 1.1, 2);
  });
});

describe("Overworld's moments (#439)", () => {
  const css = readFileSync(join(themesDir, 'overworld', 'theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

  it('has a splash, a loader, an entrance, tab transitions, tips and all six moments', () => {
    const m = themeNamed('overworld').moments!;
    expect(m.splash).toBeDefined();
    expect(m.loader?.loop).toBe('frames');
    expect(m.entrance).toBeDefined();
    expect(m.tabs).toBeDefined();
    expect(m.tips?.label).toBeTruthy();
    expect(m.recap?.label).toBeTruthy();
    expect(Object.keys(m.events ?? {}).sort()).toEqual(['blocker-cleared', 'build-failed', 'build-passed', 'item-done', 'pr-merged', 'sprint-ended']);
  });

  it('stops its own entrances, the chest hop and the key lift, at Theme motion off', () => {
    for (const loot of ['.ow-loot--done', '.ow-loot--in_progress']) {
      const rule = css.match(new RegExp(`([^{}]*)${loot.replace(/[.-]/g, '\\$&')}\\s*\\{[^}]*animation:`));
      expect(rule?.[1], loot).toContain(':not([data-theme-motion="off"])');
    }
  });

  it('animates only transform and opacity, so nothing is repainted', () => {
    for (const m of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)) {
      const props = [...m[2]!.matchAll(/([a-z-]+)\s*:/g)].map((p) => p[1]);
      for (const p of props) expect(['transform', 'opacity'], `${m[1]} sets ${p}`).toContain(p);
    }
  });

  it('flashes no more than three times a second', () => {
    for (const r of steppedFlashRates(css)) expect(r.perSecond, r.name).toBeLessThanOrEqual(3);
  });
});

describe('rolled alignments (#415)', () => {
  it('rolls the same value for the same name, from the list only', () => {
    const values = ['Lawful good', 'True neutral', 'Chaotic good'];
    expect(rolled(values, 'Ada D.')).toBe(rolled(values, 'Ada D.'));
    const seen = new Set(['Ada D.', 'J. Smith', 'Pat Example', 'Codex', 'R. Okafor', 'M. Chen'].map((n) => rolled(values, n)));
    for (const v of seen) expect(values).toContain(v);
    expect(seen.size).toBeGreaterThan(1);
  });

  it('refuses an alignment that judges a person, or one that is not a short plain label', () => {
    expect(alignmentProblems(undefined)).toEqual([]);
    expect(alignmentProblems({ label: 'Rolled', values: ['Lawful good', 'Chaotic evil'] })).toEqual(['theme.json: alignments.values "Chaotic evil" judges a person; a rolled label never does.']);
    expect(alignmentProblems({ label: 'Rolled', values: ['Only one'] })).toEqual(['theme.json: alignments.values must list at least two labels.']);
    expect(alignmentProblems({ label: '<b>x</b>', values: ['A', 'B'] })).toEqual(['theme.json: alignments.label must be plain text of 30 characters or fewer.']);
    expect(alignmentProblems([])).toEqual(['theme.json: "alignments" must be an object with a label and values.']);
  });
});
