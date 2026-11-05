import { EventEmitter } from 'node:events';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { backgroundFromEnv, lateReplyFilter, parseBackgroundReply, probeBackground } from '../src/welcome/background.js';
import { runWelcome } from '../src/welcome/index.js';
import { DURATION, entrance, logoFrame } from '../src/welcome/logo.js';
import { render, initialState } from '../src/welcome/menu.js';
import { ornamentAt } from '../src/welcome/ornaments.js';
import type { WelcomeData } from '../src/welcome/screens.js';
import { PLAIN_LINE, playSplash, splashFrame } from '../src/welcome/splash.js';
import { detectCaps, fg, PALETTE } from '../src/welcome/term.js';
import { palette, splashLook, TERMINAL_THEMES, themeNamed, ORNAMENTS } from '../src/welcome/themes/index.js';
import { homeView } from '../src/welcome/views/home.js';
import { HOME_ENTRIES } from '../src/welcome/views/index.js';
import { testConfig } from './harness/context.js';

/**
 * The welcome menu in each theme (#427): its colours for a light and a dark
 * terminal, its splash, every frame a pure function of time that settles on
 * the still, its words, and the terminal's own off switches.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[/;

const data = (theme = 'plain', over: Partial<WelcomeData> = {}): WelcomeData => ({
  version: '0.1.0-alpha.1',
  node: '24.14.0',
  platform: 'linux x64',
  configPath: '/home/test/.toil/config.json',
  configExists: true,
  config: testConfig({}),
  areas: [],
  mcpAreas: [],
  launch: { command: 'toil', args: [] },
  folder: { cwd: '/home/test' },
  theme: themeNamed(theme),
  ...over,
});

const caps = (theme: string, background: 'light' | 'dark' = 'dark', colorDepth: 1 | 4 | 8 | 24 = 24) => ({ colorDepth, unicode: true, columns: 100, rows: 40, palette: palette(themeNamed(theme), background) });

describe.each(TERMINAL_THEMES.map((t) => [t.name, t] as const))('the %s splash', (name, theme) => {
  const look = splashLook(theme);

  it('is a pure function of time', () => {
    for (const t of [0, 0.3, 0.8, 1.4, 2.2, 3]) expect(splashFrame(t, caps(name), '1', look)).toEqual(splashFrame(t, caps(name), '1', look));
  });

  it('settles on its still by the end of the animation, and stays there', () => {
    expect(splashFrame(DURATION, caps(name), '1', look)).toEqual(splashFrame(DURATION + 1, caps(name), '1', look));
    expect(splashFrame(DURATION + 1, caps(name), '1', look)).toEqual(splashFrame(DURATION + 60, caps(name), '1', look));
  });

  it('keeps the same height on every frame, so redrawing in place never scrolls', () => {
    const heights = new Set([0, 0.5, 1, 1.5, 2, 2.5, 99].map((t) => splashFrame(t, caps(name), '1', look).length));
    expect([...heights]).toHaveLength(1);
  });

  it('draws the shapes alone under NO_COLOR', () => {
    const frame = splashFrame(99, { colorDepth: 1, unicode: true, columns: 100 }, '1', look).join('\n');
    expect(frame).not.toMatch(ANSI);
    expect(frame).toMatch(/[⠁-⣿]/);
  });

  it('paints in the theme\'s colours, on a light terminal as on a dark one', () => {
    for (const bg of ['light', 'dark'] as const) {
      const frame = splashFrame(99, caps(name, bg), '1', look).join('\n');
      expect(frame, bg).toContain(fg({ colorDepth: 24 }, palette(theme, bg).accent));
    }
  });

  it('fits a narrow window by stacking', () => {
    for (const line of splashFrame(99, { colorDepth: 1, unicode: true, columns: 50 }, '1', look)) expect([...line].length).toBeLessThanOrEqual(50);
  });
});

describe('the ornaments', () => {
  const p = palette(themeNamed('plain'), 'dark');

  it.each(ORNAMENTS.filter((o) => o !== 'orbit'))('%s keeps to the canvas edges and the ring, clear of the prompt', (ornament) => {
    for (const t of [0.5, 1, 1.5, 2, 99]) {
      for (const particle of ornamentAt(ornament, t, p)) {
        // The page and its prompt sit within about 12 units of the centre.
        for (const [x, y] of [particle.at, particle.to ?? particle.at]) expect(Math.hypot(x - 32, y - 32), `${ornament} at ${t}`).toBeGreaterThan(14);
      }
    }
  });

  it('has nothing in its place before it starts', () => {
    for (const ornament of ORNAMENTS) expect(ornamentAt(ornament, 0, p)).toEqual([]);
  });

  it("brings the badge in by the theme's motif, and has it in place by half a second", () => {
    expect(entrance('rise', 0).dy).toBeGreaterThan(0);
    expect(entrance('drop', 0).dy).toBeLessThan(0);
    expect(entrance('slide', 0).dx).toBeLessThan(0);
    expect(entrance('pop', 0.2).scale).toBeGreaterThan(1);
    for (const motif of ['fade', 'rise', 'drop', 'slide', 'pop'] as const) expect(entrance(motif, 0.6)).toEqual({ dx: 0, dy: 0, scale: 1 });
  });

  it("leaves Plain's splash as it was", () => {
    expect(logoFrame(99, { colorDepth: 24, unicode: true })).toEqual(logoFrame(99, { colorDepth: 24, unicode: true, palette: PALETTE } as never));
    expect(splashLook(themeNamed('plain'))).toEqual({ ornament: 'orbit', motif: 'fade' });
    expect(splashFrame(99, { colorDepth: 1, unicode: true, columns: 100 }, '1').join('\n')).toContain(PLAIN_LINE);
  });
});

describe('the menu in a theme', () => {
  const props = (theme: string, over: Partial<WelcomeData> = {}) => ({ data: data(theme, over), session: { health: {} }, frame: { view: 'home', selected: 0, params: {} } });
  const home = homeView(HOME_ENTRIES);

  it("uses Realm's words for the attention heading, the agent row and Quit, keeping the plain meaning beside each", () => {
    const items = home.items!(props('realm'));
    expect(items.find((i) => 'go' in i.action && i.action.go === 'agents')).toMatchObject({ label: 'Summon the dungeon master', hint: 'Connect an agent: pick areas, get the MCP config snippet' });
    expect(items.at(-1)).toMatchObject({ label: 'Quit', hint: 'Leave the table' });
    const body = home.body!({ colorDepth: 1, unicode: true }, props('realm', { config: testConfig({}) })).join('\n');
    // No connections yet: the attention rows show, under the theme's heading.
    expect(body).toContain('Broken roads (needs attention)');
  });

  it('keeps every row that names a command in plain words', () => {
    for (const theme of TERMINAL_THEMES) {
      const labels = home.items!(props(theme.name)).map((i) => i.label);
      for (const plain of ['Services', 'Connections', 'Agent skills', 'Toil projects', 'Quit']) expect(labels, theme.name).toContain(plain);
    }
  });

  it("is Plain's menu, unchanged, with no theme", () => {
    const items = home.items!(props('plain'));
    expect(items.find((i) => 'go' in i.action && i.action.go === 'agents')).toMatchObject({ label: 'Connect an agent', hint: 'Pick areas and get the MCP config snippet' });
    expect(items.at(-1)).toMatchObject({ hint: 'Back to your shell' });
  });

  it("draws the screen in the theme's colours", () => {
    const lines = render(initialState, caps('starship'), data('starship')).join('\n');
    expect(lines).toContain(fg({ colorDepth: 24 }, palette(themeNamed('starship'), 'dark').highlight));
  });

  it('maps every theme down to 256 and 16 colours, with normal colours for a light terminal and bright ones for a dark', () => {
    for (const theme of TERMINAL_THEMES) {
      const dark = palette(theme, 'dark');
      const light = palette(theme, 'light');
      expect(fg({ colorDepth: 4 }, dark.ink), theme.name).toMatch(/\x1b\[9[0-7]m|\x1b\[37m/); // eslint-disable-line no-control-regex
      expect(fg({ colorDepth: 4 }, light.ink), theme.name).toMatch(/\x1b\[3[0-7]m|\x1b\[90m/); // eslint-disable-line no-control-regex
      expect(fg({ colorDepth: 8 }, dark.accent)).toMatch(/\x1b\[38;5;\d+m/); // eslint-disable-line no-control-regex
    }
  });
});

describe('the off switches', () => {
  const out = { isTTY: true, columns: 120, rows: 40, getColorDepth: () => 24 };

  it('draws the splash once under reduced motion, as under TOIL_NO_ANIMATION and NO_COLOR', () => {
    for (const env of [{ TOIL_REDUCED_MOTION: '1' }, { TOIL_NO_ANIMATION: '1' }, { NO_COLOR: '1' }]) expect(detectCaps(out, env, 'linux').animate).toBe(false);
  });

  it('prints the still once, with no redraws, when it may not animate', async () => {
    let written = '';
    await playSplash({ write: (t) => (written += t) }, { ...detectCaps(out, { TOIL_REDUCED_MOTION: '1' }, 'linux'), palette: palette(themeNamed('realm'), 'light') }, '1', splashLook(themeNamed('realm')));
    expect(written).not.toContain('\x1b[2K');
    // eslint-disable-next-line no-control-regex
    expect(written.replace(/\x1b\[[0-9;]*m/g, '')).toContain('Let your agents handle the toil.');
  });
});

describe("the terminal's background", () => {
  it('reads COLORFGBG', () => {
    expect(backgroundFromEnv({ COLORFGBG: '15;0' })).toBe('dark');
    expect(backgroundFromEnv({ COLORFGBG: '0;15' })).toBe('light');
    expect(backgroundFromEnv({ COLORFGBG: '0;default;7' })).toBe('light');
    expect(backgroundFromEnv({ COLORFGBG: '12;8' })).toBe('dark');
    expect(backgroundFromEnv({})).toBeUndefined();
    expect(backgroundFromEnv({ COLORFGBG: 'nonsense' })).toBeUndefined();
  });

  it("reads the terminal's answer to OSC 11", () => {
    expect(parseBackgroundReply('\x1b]11;rgb:ffff/ffff/ffff\x1b\\')).toBe('light');
    expect(parseBackgroundReply('\x1b]11;rgb:1e1e/1e1e/1e1e\x07')).toBe('dark');
    expect(parseBackgroundReply('\x1b]11;rgb:fd/f6/e3\x07')).toBe('light');
    expect(parseBackgroundReply('\x1b[?62;22c')).toBeUndefined();
  });

  it('asks once, and stops waiting at the device-attributes answer', async () => {
    const input = new EventEmitter();
    let asked = '';
    const answer = probeBackground({ input: input as never, write: (t) => (asked += t) }, 5000);
    input.emit('data', Buffer.from('\x1b]11;rgb:ffff/ffff/ffff\x1b\\'));
    input.emit('data', Buffer.from('\x1b[?62;22c'));
    await expect(answer).resolves.toEqual({ background: 'light', answered: true });
    expect(asked).toBe('\x1b]11;?\x1b\\\x1b[c');
    expect(input.listenerCount('data')).toBe(0);
  });

  it("gives up on a terminal that answers nothing", async () => {
    vi.useFakeTimers();
    const answer = probeBackground({ input: new EventEmitter() as never, write: () => undefined }, 250);
    await vi.advanceTimersByTimeAsync(300);
    await expect(answer).resolves.toEqual({ answered: false });
    vi.useRealTimers();
  });

  it("drops an answer that arrives after the wait, as readline hands it over, and passes every key after it", async () => {
    const stream = new PassThrough();
    emitKeypressEvents(stream);
    const late = lateReplyFilter();
    const passed: string[] = [];
    stream.on('keypress', (_: string, key: { sequence?: string } | undefined) => {
      if (!late(key?.sequence)) passed.push(key?.sequence ?? '');
    });
    stream.write('\x1b]11;rgb:ffff/ffff/ffff\x1b\\\x1b[?62;22c1q\x1b]x');
    await new Promise((r) => setTimeout(r, 20));
    // The 1 and the q a person typed pass; after the DA1 answer the filter is off, so an Alt+] passes too.
    expect(passed).toEqual(['1', 'q', '\x1b]', 'x']);
  });
});

describe('the welcome loop in a theme', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("paints the menu in the theme's light palette when COLORFGBG says the terminal is light", async () => {
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => input, resume: () => input, pause: () => input });
    let screen = '';
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 120, rows: 40, getColorDepth: () => 24, write: (t: string) => ((screen += t), true) });
    const ended = runWelcome({ input: input as never, output: output as never, env: { TOIL_NO_ANIMATION: '1', COLORFGBG: '0;15', TERM: 'xterm' }, signals: new EventEmitter() as never }, data('realm'));
    await vi.advanceTimersByTimeAsync(50);
    input.emit('keypress', 'q', { name: 'q', sequence: 'q' });
    await expect(ended).resolves.toBe('quit');
    expect(screen).toContain(fg({ colorDepth: 24 }, palette(themeNamed('realm'), 'light').highlight));
    expect(screen).toContain('Leave the table');
  });
});
