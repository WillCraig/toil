import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG_VERSION, loadConfig } from '../src/core/config.js';
import { CTRL_C_WINDOW_MS, runWelcome } from '../src/welcome/index.js';
import { initialState, played, reduce, render, SECRET } from '../src/welcome/menu.js';
import { act, called, type Game, type Input, isWall, LAST_FLOOR, mobAt, type Point, start, WIDTH } from '../src/welcome/rogue/game.js';
import { accrued, buy, freshProgress, loadout, parseProgress, PERKS, type Progress, rankOf, settle } from '../src/welcome/rogue/perks.js';
import { inputOf, playRogue, type SaveIO, TICK_MS } from '../src/welcome/rogue/play.js';
import { FX_FRAMES, frame, type Hud, lobbyFrame, NEEDS, refusal, WIDE } from '../src/welcome/rogue/render.js';
import { loadProgress, seal, storeProgress, unseal } from '../src/welcome/rogue/save.js';
import { BOSS, INTRO, ROBOTS, STAFF } from '../src/welcome/rogue/story.js';
import type { WelcomeData } from '../src/welcome/screens.js';
import { fg, renderCells, visibleLength, type Palette, type Rgb } from '../src/welcome/term.js';
import { contrast, DARK_GROUND, DIM_CONTRAST, findTheme, hexToRgb, LIGHT_GROUND, MIN_CONTRAST, palette, TERMINAL_THEMES } from '../src/welcome/themes/index.js';
import { testConfig } from './harness/context.js';

const plain = { colorDepth: 1, unicode: true } as const;
const hud = (over: Partial<Hud> = {}): Hud => ({ clock: 0, since: 99, reveal: 1e9, columns: NEEDS.columns, legend: false, ...over });

/** Past the intro, onto the first floor, with its arrival card dismissed. */
const onFloor = (seed: number): Game => {
  let g = start(seed, { skipIntro: true });
  while (g.cards.length) g = act(g, 'wait');
  return g;
};

const DIRS: [Input, Point][] = [
  ['up', { x: 0, y: -1 }],
  ['down', { x: 0, y: 1 }],
  ['left', { x: -1, y: 0 }],
  ['right', { x: 1, y: 0 }],
  ['up-left', { x: -1, y: -1 }],
  ['up-right', { x: 1, y: -1 }],
  ['down-left', { x: -1, y: 1 }],
  ['down-right', { x: 1, y: 1 }],
];

/** The first step of a shortest walk from `from` to `to` through floor cells, ignoring who is standing where. */
function towards(g: Game, from: Point, to: Point): Input | undefined {
  const key = (p: Point) => p.y * WIDTH + p.x;
  const first = new Map<number, Input>([[key(from), 'wait']]);
  const queue: Point[] = [from];
  while (queue.length) {
    const p = queue.shift()!;
    if (p.x === to.x && p.y === to.y) return first.get(key(p));
    for (const [input, d] of DIRS) {
      const n = { x: p.x + d.x, y: p.y + d.y };
      if (isWall(g, n.x, n.y) || first.has(key(n))) continue;
      first.set(key(n), first.get(key(p)) === 'wait' ? input : first.get(key(p))!);
      queue.push(n);
    }
  }
  return undefined;
}

/**
 * A player with no patience: hits whoever is next to it, otherwise heads for
 * the exit. The careful one also fetches AI agents it has seen, and coffee when
 * morale is low, which is roughly what a person does.
 */
function bot(g: Game, careful = false): Input {
  if (g.cards.length) return 'wait';
  for (const [input, d] of DIRS) if (mobAt(g, g.player.x + d.x, g.player.y + d.y)) return input;
  const want = careful ? g.pickups.find((i) => g.seen[i.y]![i.x] && (i.kind === 'agent' || g.player.hp < g.player.max * 0.6)) : undefined;
  const fetch = want && towards(g, g.player, want);
  if (fetch) return fetch;
  const boss = g.mobs.find((m) => m.kind.trait === 'boss');
  return towards(g, g.player, g.floor === LAST_FLOOR && boss ? boss : g.exit) ?? 'wait';
}

function playOut(seed: number, careful = false, perks = loadout(freshProgress()), limit = 6000): Game {
  let g = start(seed, { skipIntro: true, perks });
  for (let i = 0; i < limit && g.status === 'play'; i++) g = act(g, bot(g, careful));
  return g;
}

/** Moves the player next to the exit, clears the floor, and steps on: the next floor, or the HR door. */
function stepOnto(g: Game, keep: (m: Game['mobs'][number]) => boolean = () => false): Game {
  const next = structuredClone(g);
  const d = DIRS.find(([, d]) => !isWall(g, g.exit.x - d.x, g.exit.y - d.y))!;
  next.player.x = g.exit.x - d[1].x;
  next.player.y = g.exit.y - d[1].y;
  next.mobs = next.mobs.filter(keep).map((m) => ({ ...m, x: 1, y: 1 }));
  next.cards = [];
  next.player.stun = 0;
  return act(next, d[0]);
}

describe("Two Weeks' Notice: the rules", () => {
  it('opens on the story and reaches the first floor, with its arrival card, after the last page', () => {
    let g = start(1);
    expect(g.status).toBe('intro');
    for (let i = 0; i < INTRO.length - 1; i++) g = act(g, 'wait');
    expect(g.status).toBe('intro');
    g = act(g, 'wait');
    expect(g.status).toBe('play');
    expect(g.cards[0]).toMatchObject({ tone: 'floor', heading: 'Sub-basement 2: Legacy Systems' });
    // The key that dismisses a card costs no turn.
    expect(act(g, 'right').turns).toBe(0);
  });

  it('is the same run for the same seed and keys', () => {
    expect(playOut(42)).toEqual(playOut(42));
    expect(onFloor(1).map).not.toEqual(onFloor(2).map);
  });

  it("always lets the player reach the exit, with the floor's robot on every floor and MUNDANE on the last", () => {
    for (let seed = 1; seed <= 30; seed++) {
      let g = onFloor(seed);
      for (let floor = 0; floor <= LAST_FLOOR; floor++) {
        expect(towards(g, g.player, g.exit), `seed ${seed} floor ${floor}`).toBeDefined();
        expect(g.mobs.some((m) => m.kind.name === ROBOTS[floor]!.name)).toBe(true);
        if (floor === LAST_FLOOR) break;
        g = stepOnto(g);
        expect(g.floor).toBe(floor + 1);
      }
      expect(g.mobs.some((m) => m.kind.name === BOSS.name)).toBe(true);
    }
  });

  it('keeps walls solid and spends no turn on one', () => {
    const g = onFloor(3);
    const wall = DIRS.find(([, d]) => isWall(g, g.player.x + d.x, g.player.y + d.y));
    if (wall) expect(act(g, wall[0])).toBe(g);
  });

  it('introduces a robot with a card the first time you see him, and only once', () => {
    const g = structuredClone(onFloor(4));
    const robot = g.mobs.find((m) => m.kind.robot)!;
    // Clear everyone else off the floor and stand two cells from the robot, in plain sight.
    g.mobs = [robot];
    const spot = DIRS.map(([, d]) => ({ x: robot.x + d.x * 2, y: robot.y + d.y * 2 })).find((p) => !isWall(g, p.x, p.y) && !isWall(g, (p.x + robot.x) / 2, (p.y + robot.y) / 2));
    if (!spot) return;
    g.player.x = spot.x;
    g.player.y = spot.y;
    let after = act(g, 'wait');
    expect(after.cards.some((c) => c.heading === robot.kind.name)).toBe(true);
    expect(after.met).toContain(robot.kind.name);
    while (after.cards.length) after = act(after, 'wait');
    after = act(after, 'wait');
    expect(after.cards.filter((c) => c.heading === robot.kind.name)).toHaveLength(0);
  });

  it('lists what happened as effects: your hit and its number, and paperwork when someone goes down', () => {
    const g = structuredClone(onFloor(6));
    const target = g.mobs.find((m) => !m.kind.robot && !m.kind.trait)!;
    target.hp = 1;
    g.mobs = [target];
    const d = DIRS.find(([, d]) => !isWall(g, target.x - d.x, target.y - d.y))!;
    g.player.x = target.x - d[1].x;
    g.player.y = target.y - d[1].y;
    const after = act(g, d[0]);
    expect(after.fx).toContainEqual(expect.objectContaining({ kind: 'hit', x: target.x, y: target.y }));
    expect(after.fx).toContainEqual(expect.objectContaining({ kind: 'down' }));
    expect(after.defeated).toBe(1);
  });

  it('keeps the HR door shut while MUNDANE stands', () => {
    let g = onFloor(5);
    while (g.floor < LAST_FLOOR) g = stepOnto(g);
    expect(stepOnto(g, (m) => m.kind.trait === 'boss').status).toBe('play');
    expect(stepOnto(g).status).toBe('won');
  });

  it('rewards care, and benefits help: neither bot always wins, and a full set of benefits wins more', () => {
    const wins = (careful: boolean, perks = loadout(freshProgress())) => Array.from({ length: 30 }, (_, i) => playOut(1000 + i, careful, perks)).filter((g) => g.status === 'won').length;
    const careless = wins(false);
    const careful = wins(true);
    const maxed: Progress = { ...freshProgress(), best: 4, perks: Object.fromEntries(PERKS.map((p) => [p.id, p.costs.length])) };
    const benefits = wins(true, loadout(maxed));
    // Measured at 6, 18 and 26 of 30 when tuned; the bounds keep it a climb rather than a stroll or a wall.
    expect(careless).toBeLessThanOrEqual(12);
    expect(careful).toBeGreaterThanOrEqual(careless + 3);
    expect(careful).toBeLessThan(28);
    expect(benefits).toBeGreaterThan(careful);
  }, 120_000);
});

describe("Two Weeks' Notice: drawing", () => {
  const screens = () => [start(9), start(9, { skipIntro: true }), onFloor(9), playOut(9, true)];

  it('fits every screen in the size it asks for, effects and cards included', () => {
    for (const g of screens()) {
      for (const h of [hud(), hud({ since: 0 }), hud({ since: 3, clock: 77 }), hud({ legend: true })]) {
        const lines = frame(g, plain, h);
        expect(lines.length).toBeLessThanOrEqual(NEEDS.rows);
        for (const l of lines) expect(visibleLength(l), l).toBeLessThanOrEqual(NEEDS.columns);
      }
    }
    for (let i = 0; i < PERKS.length; i++) {
      const lobby = lobbyFrame(freshProgress(), i, plain, hud(), { floor: 3, earned: 34, won: false });
      expect(lobby.length).toBeLessThanOrEqual(NEEDS.rows);
      for (const l of lobby) expect(visibleLength(l), l).toBeLessThanOrEqual(NEEDS.columns);
    }
  });

  it('keeps the legend beside the map on a wide window, and behind ? on a narrow one', () => {
    const g = onFloor(2);
    expect(frame(g, plain, hud({ columns: WIDE })).join('\n')).toContain('On this floor');
    expect(frame(g, plain, hud({ columns: WIDE })).join('\n')).toContain(ROBOTS[0]!.name);
    expect(frame(g, plain, hud()).join('\n')).not.toContain('On this floor');
    expect(frame(g, plain, hud({ legend: true })).join('\n')).toContain('On this floor');
  });

  it('types text out a few characters at a time, and shows the keys once it has finished', () => {
    const g = start(1);
    const typing = frame(g, plain, hud({ reveal: 10 })).join('\n');
    expect(typing).toContain('any key: skip ahead');
    expect(typing).not.toContain('nine years');
    expect(frame(g, plain, hud()).join('\n')).toContain('nine years');
  });

  it('plays effects for a few ticks after a key, then draws the map plain again', () => {
    const g = structuredClone(onFloor(6));
    g.fx = [{ kind: 'hurt', amount: 6 }];
    expect(frame(g, plain, hud({ since: 0 })).join('\n')).toContain('-6');
    expect(frame(g, plain, hud({ since: FX_FRAMES })).join('\n')).not.toContain('-6');
  });

  it('draws in plain ASCII where Unicode is not safe, and without colour codes for NO_COLOR', () => {
    const ascii = frame(onFloor(2), { colorDepth: 1, unicode: false }, hud()).join('\n');
    expect(ascii).not.toMatch(/[┌█░╔●]/);
    // eslint-disable-next-line no-control-regex
    expect(ascii).not.toMatch(/\x1b\[/);
  });

  /** Every truecolour foreground a set of lines opens. */
  const colours = (lines: string[]): Rgb[] =>
    // eslint-disable-next-line no-control-regex
    [...lines.join('\n').matchAll(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])] as const);
  /** The common terminal backgrounds of each kind (test/theme-sync.test.ts reads every theme on more). */
  const GROUNDS = { light: ['#ffffff', '#fafafa', LIGHT_GROUND], dark: ['#000000', '#0c0c0c', '#282c34', DARK_GROUND] } as const;
  /** Every screen and effect the game draws, at a few moments each. */
  const everything = (caps: { colorDepth: 8 | 24; unicode: true; palette: Palette }): string[] => {
    const lines: string[] = [];
    const fxs: Game['fx'] = [];
    const g = structuredClone(onFloor(6));
    const { x, y } = g.player;
    fxs.push({ kind: 'hit', x: x + 1, y, amount: 3, by: 'you' }, { kind: 'hit', x: x - 1, y, amount: 2, by: 'agent' }, { kind: 'hurt', amount: 6 }, { kind: 'down', x, y: y + 1 }, { kind: 'heal', amount: 4 }, { kind: 'shrug', x, y: y - 1 }, { kind: 'spark', x: x + 2, y });
    for (const fx of fxs) for (let since = 0; since < FX_FRAMES; since++) lines.push(...frame({ ...g, fx: [fx] }, caps, hud({ since, clock: since * 5 })));
    const low = structuredClone(g);
    low.player.hp = 1;
    // Every square seen before: what's out of sight now is the remembered map.
    low.seen = low.seen.map((row) => row.map(() => true));
    for (const screen of [start(9), start(9, { skipIntro: true }), g, low, playOut(9, true), playOut(9, false)])
      for (const clock of [0, 4, 9, 13, 40, 77]) lines.push(...frame(screen, caps, hud({ clock, legend: true })), ...frame(screen, caps, hud({ clock, reveal: 20 })), ...frame(screen, caps, hud({ clock, columns: WIDE })));
    for (let i = 0; i < PERKS.length + 1; i++) lines.push(...lobbyFrame({ ...freshProgress(), pto: 40 }, i, caps, hud({ notice: 'Enrolled.', warning: 'Not saved.' }), { floor: 3, earned: 34, won: false }));
    return lines;
  };

  // #471: the game draws in the menu's theme, on whatever terminal the menu found.
  it.each(TERMINAL_THEMES.flatMap((t) => (['dark', 'light'] as const).map((bg) => [t.name, bg] as const)))(
    'draws in the %s theme on a %s terminal, every colour readable on every common ground',
    (name, bg) => {
      const p = palette(findTheme(name)!, bg);
      const seen = colours(everything({ colorDepth: 24, unicode: true, palette: p }));
      const same = (a: Rgb, b: Rgb) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
      for (const role of ['ink', 'muted', 'faint', 'dim', 'highlight', 'accent', 'danger'] as const) expect(seen.some((c) => same(c, p[role])), role).toBe(true);
      for (const colour of new Set(seen.map((c) => c.join(',')))) {
        const rgb = colour.split(',').map(Number) as unknown as Rgb;
        // The remembered map is a drawing (the fog of war), held to 3:1; every other colour is on text.
        const bar = same(rgb, p.dim) ? DIM_CONTRAST : MIN_CONTRAST;
        for (const ground of GROUNDS[bg]) expect(contrast(rgb, hexToRgb(ground)), `rgb(${colour}) on ${ground}`).toBeGreaterThanOrEqual(bar);
      }
    },
  );

  /** The xterm 256-colour palette's colour for an index from 16: the cube, then the 24 greys. */
  const xterm = (n: number): Rgb => {
    if (n >= 232) return [8 + 10 * (n - 232), 8 + 10 * (n - 232), 8 + 10 * (n - 232)];
    const level = [0, 95, 135, 175, 215, 255];
    const i = n - 16;
    return [level[Math.floor(i / 36)]!, level[Math.floor(i / 6) % 6]!, level[i % 6]!];
  };

  // macOS Terminal draws 256 colours, on white by default: rounding to the palette must not cost a colour its contrast.
  it.each(TERMINAL_THEMES.flatMap((t) => (['dark', 'light'] as const).map((bg) => [t.name, bg] as const)))(
    'draws in the %s theme on a %s 256-colour terminal, every colour still readable on every common ground',
    (name, bg) => {
      const p = palette(findTheme(name)!, bg);
      // The same frames at both depths open their colours in the same order, so each 256-colour index pairs with the colour it stands for.
      const source = colours(everything({ colorDepth: 24, unicode: true, palette: p }));
      // eslint-disable-next-line no-control-regex
      const drawn = [...everything({ colorDepth: 8, unicode: true, palette: p }).join('\n').matchAll(/\x1b\[38;5;(\d+)m/g)].map((m) => Number(m[1]));
      expect(drawn).toHaveLength(source.length);
      const checked = new Set<string>();
      source.forEach((rgb, i) => {
        const key = `${rgb.join(',')}>${drawn[i]}`;
        if (checked.has(key)) return;
        checked.add(key);
        const bar = rgb.every((v, c) => v === p.dim[c]) ? DIM_CONTRAST : MIN_CONTRAST;
        for (const ground of GROUNDS[bg]) expect(contrast(xterm(drawn[i]!), hexToRgb(ground)), `rgb(${rgb.join(',')}) as ${drawn[i]} on ${ground}`).toBeGreaterThanOrEqual(bar);
      });
    },
  );

  /** A role as a 256-colour terminal draws it. */
  const at256 = (p: Palette, role: keyof Palette): Rgb => xterm(Number(/38;5;(\d+)m/.exec(fg({ colorDepth: 8, palette: p }, p[role]))![1]));
  const chroma = (c: Rgb) => Math.max(...c) - Math.min(...c);

  it('keeps a grey grey and a colour a colour on a 256-colour terminal, in the default theme', () => {
    for (const bg of ['light', 'dark'] as const) {
      const p = palette(findTheme('crate')!, bg);
      for (const role of ['ink', 'muted', 'faint', 'dim'] as const) expect(chroma(at256(p, role)), `${bg} ${role}`).toBeLessThanOrEqual(40);
      for (const role of ['accent', 'highlight', 'ok', 'danger'] as const) expect(chroma(at256(p, role)), `${bg} ${role}`).toBeGreaterThanOrEqual(60);
    }
  });

  // The robots, the notices and the morale bar's low end: on 256 colours, in every theme, they never fade to grey.
  it.each(TERMINAL_THEMES.flatMap((t) => (['dark', 'light'] as const).map((bg) => [t.name, bg] as const)))(
    'keeps the %s theme\'s accent and danger in colour on a %s 256-colour terminal',
    (name, bg) => {
      const p = palette(findTheme(name)!, bg);
      for (const role of ['accent', 'danger'] as const) expect(chroma(at256(p, role)), `${role} rgb(${p[role].join(',')})`).toBeGreaterThanOrEqual(60);
    },
  );

  // The light schemes authored for #507 replace the derived ones #505 fixed, so they keep what #505 asked of them: colours that stay colours.
  it.each(['crate', 'starship', 'sprawl', 'overworld'])(
    'keeps the %s theme in colour on a light terminal, so items, stairs, staff and headings stand apart from the text',
    (name) => {
      const p = palette(findTheme(name)!, 'light');
      const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
      for (const role of ['highlight', 'accent', 'danger'] as const) {
        expect(chroma(p[role]), `${role} rgb(${p[role].join(',')})`).toBeGreaterThanOrEqual(60);
        expect(distance(p[role], p.ink), `${role} against ink`).toBeGreaterThanOrEqual(100);
      }
    },
  );

  it('draws you in bold, so you stand out from the walls on a light terminal as on a dark one', () => {
    const g = structuredClone(onFloor(6));
    g.fx = [];
    for (const bg of ['light', 'dark'] as const) {
      const caps = { colorDepth: 24, unicode: true, palette: palette(findTheme('crate')!, bg) } as const;
      expect(frame(g, caps, hud()).join('\n')).toContain(`\x1b[1m\x1b[38;2;${caps.palette.ink.join(';')}m@`);
    }
    // At 16 colours bold would turn a black @ into bright black, the walls' grey on a light terminal, so it stays plain.
    expect(renderCells([{ ch: '@', color: [1, 2, 3], bold: true }], { colorDepth: 4 })).not.toContain('\x1b[1m');
    // Bold ends with its cell: a wall of the same colour beside you is drawn plain.
    expect(renderCells([{ ch: '@', color: [1, 2, 3], bold: true }, { ch: '#', color: [1, 2, 3] }], { colorDepth: 24 })).toBe('\x1b[1m\x1b[38;2;1;2;3m@\x1b[0m\x1b[38;2;1;2;3m#\x1b[0m');
  });

  it('draws effects as their first frame and never shakes, for reduced motion', () => {
    const g = structuredClone(onFloor(6));
    g.fx = [{ kind: 'hurt', amount: 6 }, { kind: 'down', x: g.player.x, y: g.player.y + 1 }];
    const still = (since: number) => frame(g, plain, hud({ since, still: true }));
    expect(still(1)).toEqual(still(0));
    expect(still(5)).toEqual(still(0));
    expect(still(0).join('\n')).toContain('-6');
    expect(still(FX_FRAMES).join('\n')).not.toContain('-6');
    // The map's frame sits in the same column, where a big hit would shake it.
    const frameColumn = (lines: string[]) => lines.find((l) => l.includes('┌'))!.indexOf('┌');
    expect(frameColumn(still(0))).toBe(frameColumn(frame(g, plain, hud())));
    expect(frameColumn(frame(g, plain, hud({ since: 0 })))).not.toBe(frameColumn(frame(g, plain, hud())));
  });

  it('holds an agent short of context in the warning colour for reduced motion, where it would blink', () => {
    const g = structuredClone(onFloor(6));
    g.fx = [];
    g.agents = [{ x: g.player.x + 1, y: g.player.y, context: 3 }];
    const caps = { colorDepth: 24, unicode: true, palette: palette(findTheme('crate')!, 'dark') } as const;
    const agent = (colour: Rgb) => `\x1b[38;2;${colour.join(';')}m&`;
    expect(frame(g, caps, hud({ clock: 0, still: true })).join('\n')).toContain(agent(caps.palette.faint));
    // Without reduced motion, the same tick is the blink's ink half.
    expect(frame(g, caps, hud({ clock: 0 })).join('\n')).not.toContain(agent(caps.palette.faint));
  });

  it('refuses politely on a small window or a console that cannot redraw in place', () => {
    expect(refusal({ columns: 40, rows: 20 }, true)).toContain('this one is 40 by 20');
    expect(refusal({ columns: 120, rows: 40 }, false)).toContain("can't redraw in place");
    expect(refusal({ columns: NEEDS.columns, rows: NEEDS.rows }, true)).toBeUndefined();
  });

  it('reads vi keys, arrows and wasd, ? for the legend, and q goes back', () => {
    expect(inputOf({ name: 'k' })).toBe('up');
    expect(inputOf({ name: 'left' })).toBe('left');
    expect(inputOf({ name: 'd' })).toBe('right');
    expect(inputOf({ name: 'n' })).toBe('down-right');
    expect(inputOf({ sequence: '.' })).toBe('wait');
    expect(inputOf({ sequence: '?' })).toBe('legend');
    expect(inputOf({ name: 'q' })).toBe('quit');
    expect(inputOf({ name: 'c', ctrl: true })).toBeUndefined();
  });
});

describe("Two Weeks' Notice: benefits and progress", () => {
  it('buys a perk level with PTO, and refuses when poor, locked or maxed', () => {
    const rich = { ...freshProgress(), pto: 500 };
    expect(buy(rich, 'chair')).toMatchObject({ pto: 480, perks: { chair: 1 } });
    expect(buy(freshProgress(), 'chair')).toBe('poor');
    expect(buy(rich, 'badge')).toBe('locked');
    expect(buy({ ...rich, perks: { licence: 1 } }, 'licence')).toBe('maxed');
  });

  it('pays a run in PTO, ranks you by notices delivered, and keeps the best', () => {
    expect(accrued({ floor: 3, defeated: 5, won: false })).toBe(34);
    const after = settle(freshProgress(), { floor: 4, defeated: 10, won: true, score: 1000 });
    expect(after).toMatchObject({ pto: 92, runs: 1, wins: 1, best: 4, high: 1000 });
    expect(rankOf(after)).toBe('Developer II');
  });

  it('turns perks into the loadout a run starts with', () => {
    const p: Progress = { ...freshProgress(), best: 4, perks: { chair: 2, template: 1, licence: 1, badge: 1 } };
    const g = start(3, { skipIntro: true, perks: loadout(p) });
    expect(g.player.max).toBe(40);
    expect(g.player.power).toBe(4);
    expect(g.agents).toHaveLength(1);
    expect(g.floor).toBe(1);
  });

  it('accepts only a save of the right shape', () => {
    expect(parseProgress({ ...freshProgress(), pto: 12 })).toMatchObject({ pto: 12 });
    expect(parseProgress({ pto: -1 })).toBeUndefined();
    expect(parseProgress('cheat')).toBeUndefined();
    // A perk level above its maximum is clamped, not believed.
    expect(parseProgress({ ...freshProgress(), perks: { chair: 99 } })?.perks.chair).toBe(3);
  });
});

describe("Two Weeks' Notice: the encrypted save", () => {
  const who = { user: 'sam', home: '/home/sam' };
  const dir = () => mkdtempSync(join(tmpdir(), 'toil-twn-'));
  const progress = { ...freshProgress(), pto: 77, wins: 2 };

  it('seals and opens for the same account, and not for another or after an edit', () => {
    const sealed = seal(progress, who);
    // The bytes under the base64url hold no readable save. Checking the encoded text for
    // '77' failed by chance whenever random ciphertext happened to contain it.
    const bytes = Buffer.from(sealed.slice(sealed.indexOf('.') + 1), 'base64url').toString('latin1');
    expect(bytes).not.toContain('"pto"');
    expect(bytes).not.toContain(JSON.stringify(progress));
    expect(unseal(sealed, who)).toEqual(progress);
    expect(unseal(sealed, { ...who, user: 'alex' })).toBeUndefined();
    const at = sealed.length - 5;
    const flipped = sealed.slice(0, at) + (sealed[at] === 'A' ? 'B' : 'A') + sealed.slice(at + 1);
    expect(unseal(flipped, who)).toBeUndefined();
  });

  it('saves under "game" in the config, keeps every other key, and loads it back', () => {
    const home = dir();
    const path = join(home, 'config.json');
    writeFileSync(path, JSON.stringify({ version: CONFIG_VERSION, connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' } }, defaults: {} }));
    expect(storeProgress(path, progress, who)).toBeUndefined();
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(written.connections['corp-jira'].baseUrl).toBe('https://jira.imagile.dev');
    expect(typeof written.game).toBe('string');
    expect(loadProgress(path, who)).toEqual({ progress, writable: true });
    // Every other command reads the file as before, with no warning about the new key.
    const config = loadConfig({ env: {}, cwd: home, home, configPath: path, areas: [{ name: 'jira' }] });
    expect(config.warnings).toEqual([]);
  });

  it('starts fresh with a notice when the save was edited, and never rewrites an older config file', () => {
    const path = join(dir(), 'config.json');
    writeFileSync(path, JSON.stringify({ version: CONFIG_VERSION, connections: {}, defaults: {}, game: 'twn1.tampered' }));
    const tampered = loadProgress(path, who);
    expect(tampered.progress).toEqual(freshProgress());
    expect(tampered.notice).toContain('could not be read');
    const old = join(dir(), 'config.json');
    writeFileSync(old, JSON.stringify({ jira: { baseUrl: 'https://jira.imagile.dev' } }));
    expect(loadProgress(old, who)).toMatchObject({ writable: false });
    expect(loadProgress(join(dir(), 'missing.json'), who)).toEqual({ progress: freshProgress(), writable: true });
  });

  it('refuses a trimmed save rather than checking it with a shorter tag', () => {
    const sealed = seal(progress, who);
    for (const keep of [5, 20, 38]) expect(unseal(sealed.slice(0, keep), who)).toBeUndefined();
  });

  it('keeps every top-level key when it saves, and says plainly when the file is from a newer toil', () => {
    const home = dir();
    const path = join(home, 'config.json');
    const config = { $schema: 'x', version: CONFIG_VERSION, connections: {}, defaults: {}, bounds: { files: 'workspace' }, audit: { enabled: true }, wait: { maxTimeout: '2h' }, projectPaths: [join(home, 'projects')] };
    writeFileSync(path, JSON.stringify(config));
    expect(storeProgress(path, progress, who)).toBeUndefined();
    const { game, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
    expect(rest).toEqual(config);
    expect(typeof game).toBe('string');
    const newer = join(dir(), 'config.json');
    writeFileSync(newer, JSON.stringify({ version: 99, connections: {}, defaults: {} }));
    expect(loadProgress(newer, who)).toMatchObject({ writable: false, notice: expect.stringContaining('newer toil') });
  });

  it('loads the save from a version 2 file, reports it read-only, and leaves the file untouched', () => {
    const path = join(dir(), 'config.json');
    const connections = { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' } };
    writeFileSync(path, JSON.stringify({ version: 2, connections, defaults: {}, game: seal(progress, who) }));
    const before = readFileSync(path);
    const loaded = loadProgress(path, who);
    expect(loaded).toMatchObject({ progress, writable: false });
    expect(loaded.notice).toContain('older config file');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('saves into a current-version file touching only "game"', () => {
    const path = join(dir(), 'config.json');
    const config = { version: CONFIG_VERSION, connections: { 'corp-jira': { area: 'jira', baseUrl: 'https://jira.imagile.dev' } }, defaults: { jira: { connection: 'corp-jira' } } };
    writeFileSync(path, JSON.stringify(config));
    expect(storeProgress(path, progress, who)).toBeUndefined();
    const { game, ...rest } = JSON.parse(readFileSync(path, 'utf8'));
    expect(rest).toEqual(config);
    expect(typeof game).toBe('string');
  });

  it('creates a config holding only the save when there is none', () => {
    const path = join(dir(), 'nested', 'config.json');
    expect(storeProgress(path, progress, who)).toBeUndefined();
    const written = JSON.parse(readFileSync(path, 'utf8'));
    expect(Object.keys(written).sort()).toEqual(['connections', 'defaults', 'game', 'version']);
    expect(loadProgress(path, who).progress).toEqual(progress);
  });
});

describe("Two Weeks' Notice: the loop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness(size = { columns: 80, rows: 30 }, saved: Progress = { ...freshProgress(), briefed: true }) {
    const handlers = new Set<(key: { name?: string; sequence?: string; ctrl?: boolean }) => void>();
    let screen = '';
    const controller = new AbortController();
    const stored: Progress[] = [];
    const save: SaveIO = { load: () => ({ progress: saved, writable: true }), store: (p) => void stored.push(p) };
    const io = {
      write: (t: string) => void (screen += t),
      onKey: (h: (key: { name?: string; ctrl?: boolean }) => void) => (handlers.add(h), () => void handlers.delete(h)),
      caps: () => ({ colorDepth: 1 as const, unicode: true, animate: true, ...size }),
      movesCursor: true,
      best: 40,
      signal: controller.signal,
      save,
      seed: 7,
    };
    const key = (name: string, ctrl = false) => [...handlers].forEach((h) => h({ name, sequence: name.length === 1 ? name : undefined, ctrl }));
    return { io, key, handlers, controller, stored, screen: () => screen, clear: () => (screen = '') };
  }

  it('opens on the story the first time, and on Benefits Enrollment after', async () => {
    const first = harness(undefined, freshProgress());
    const a = playRogue(first.io);
    await vi.advanceTimersByTimeAsync(TICK_MS * 200);
    expect(first.screen()).toContain('nine years');
    first.key('q');
    first.key('q');
    await a;
    const later = harness();
    const b = playRogue(later.io);
    expect(later.screen()).toContain('Benefits Enrollment');
    later.key('q');
    await expect(b).resolves.toEqual({ best: 40, last: 0 });
    expect(later.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('enrols in a perk and saves, and refuses one you cannot afford', async () => {
    const h = harness(undefined, { ...freshProgress(), briefed: true, pto: 25 });
    const ended = playRogue(h.io);
    h.key('down');
    h.key('return');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.stored.at(-1)).toMatchObject({ pto: 5, perks: { chair: 1 } });
    expect(h.screen()).toContain('Enrolled: Ergonomic chair');
    h.key('return');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.screen()).toContain('Not enough PTO');
    h.key('q');
    await ended;
  });

  it('opens on "Take the stairs again", selected, so Enter starts the next run', async () => {
    const h = harness();
    const ended = playRogue(h.io);
    expect(h.screen()).toContain('Take the stairs again');
    expect(h.screen()).toContain('enter take the stairs');
    h.key('return');
    await vi.advanceTimersByTimeAsync(TICK_MS * 100);
    expect(h.screen()).toContain('Sub-basement 2: Legacy Systems');
    h.key('q');
    h.key('q');
    await ended;
  });

  it('starts a run with space, types the floor card, and q forfeits back to enrollment', async () => {
    const h = harness();
    const ended = playRogue(h.io);
    h.key('space');
    await vi.advanceTimersByTimeAsync(TICK_MS * 100);
    expect(h.screen()).toContain('Sub-basement 2: Legacy Systems');
    expect(h.screen()).toContain('payments cron');
    h.key('q');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.screen()).toContain('Run forfeited');
    h.key('q');
    await ended;
  });

  it('keeps saying why progress is not saved, whatever else happens on the screen', async () => {
    const h = harness();
    h.io.save = { load: () => ({ progress: { ...freshProgress(), briefed: true, pto: 25 }, writable: false, notice: 'Progress is not being saved: test.' }), store: () => undefined };
    const ended = playRogue(h.io);
    h.key('down');
    h.key('return');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    const last = h.screen().slice(h.screen().lastIndexOf('Benefits Enrollment'));
    expect(last).toContain('Enrolled: Ergonomic chair');
    expect(last).toContain('Progress is not being saved: test.');
    h.key('q');
    await ended;
  });

  it('holds still for reduced motion: text appears at once and the title does not shimmer', async () => {
    const t = harness(undefined, freshProgress());
    const io = { ...t.io, reducedMotion: true };
    const run = playRogue(io);
    // The whole first page, before a single tick.
    expect(t.screen()).toContain('nine years');
    t.clear();
    await vi.advanceTimersByTimeAsync(TICK_MS * 100);
    expect(t.screen(), 'nothing redrawn while nothing happens').toBe('');
    t.key('q');
    t.key('q');
    await run;
  });

  it('starts typing a new page the moment a key turns to it, so a quick second key reveals it instead of skipping it', async () => {
    const h = harness(undefined, freshProgress());
    const ended = playRogue(h.io);
    await vi.advanceTimersByTimeAsync(TICK_MS * 200);
    h.key('space');
    h.key('space');
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.screen()).toContain('2 of 5');
    expect(h.screen()).not.toContain('3 of 5');
    h.key('q');
    // Leaving the story isn't forfeiting a run.
    await vi.advanceTimersByTimeAsync(TICK_MS);
    expect(h.screen()).not.toContain('Run forfeited');
    h.key('q');
    await ended;
  });

  it('stops drawing the moment the menu exits', async () => {
    const h = harness();
    const ended = playRogue(h.io);
    h.key('space');
    await vi.advanceTimersByTimeAsync(TICK_MS * 5);
    h.controller.abort();
    await ended;
    h.clear();
    await vi.advanceTimersByTimeAsync(TICK_MS * 30);
    expect(h.screen()).toBe('');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows why on a window too small, and any key goes back', async () => {
    const h = harness({ columns: 30, rows: 10 });
    const ended = playRogue(h.io);
    expect(h.screen()).toContain('is 30 by 10.');
    h.key('x');
    await expect(ended).resolves.toEqual({ best: 40, last: 0 });
  });

  it('turns a bug in a frame into a rejected game, not an exception in a timer', async () => {
    const h = harness();
    let calls = 0;
    h.io.caps = () => {
      if (++calls > 3) throw new Error('frame failed');
      return { colorDepth: 1, unicode: true, animate: true, columns: 80, rows: 30 };
    };
    const caught = playRogue(h.io).catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(TICK_MS * 5);
    await expect(caught).resolves.toBe('frame failed');
    expect(vi.getTimerCount()).toBe(0);
  });
});

const data = (): WelcomeData => ({
  version: '0.1.0-alpha.1',
  node: '24.14.0',
  platform: 'linux x64',
  configPath: '/home/test/.toil/config.json',
  configExists: true,
  config: testConfig({ jira: { baseUrl: 'https://jira.imagile.dev', token: 't' } }),
  areas: [{ name: 'jira', description: 'Jira Data Center', signsIn: true, live: true, configurable: true }],
  mcpAreas: ['jira'],
  launch: { command: 'toil', args: [] },
  folder: { cwd: '/home/test' },
});

describe("Two Weeks' Notice: the hidden way in", () => {
  const type = (word: string) => [...word].reduce((s, ch) => reduce(s, { name: ch, sequence: ch }, data()), initialState);

  it('is not on the home screen, and resign starts it', () => {
    const home = render(initialState, { ...plain, columns: 120, rows: 40 }, data()).join('\n');
    expect(home).not.toMatch(/brick|resign|Two Weeks/i);
    expect(type(SECRET).playing).toBe('rogue');
    expect(type('resig').playing).toBeUndefined();
    expect(type(`xx${SECRET}`).playing).toBe('rogue');
  });

  it('forgets a half-typed word after any other key', () => {
    const broken = reduce(type('resi'), { name: 'down' }, data());
    expect([...'gn'].reduce((s, ch) => reduce(s, { name: ch, sequence: ch }, data()), broken).playing).toBeUndefined();
  });

  it('records the session best, which only ever goes up', () => {
    const s = played({ ...initialState, playing: 'rogue' }, 340, 120);
    expect(s.session.rogue).toEqual({ best: 340, last: 120 });
    expect(s.playing).toBeUndefined();
    expect(played(s, 50, 50).session.rogue).toEqual({ best: 340, last: 50 });
  });
});

describe("Two Weeks' Notice: the terminal is put back on every exit", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeTerminal() {
    const raw: boolean[] = [];
    const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: (on: boolean) => (raw.push(on), input), resume: () => input, pause: () => input });
    let screen = '';
    const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 100, rows: 32, getColorDepth: () => 1, write: (t: string) => ((screen += t), true) });
    const signals = new EventEmitter();
    const key = (name: string, ctrl = false) => input.emit('keypress', name, { name, sequence: ctrl ? '\x03' : name, ctrl });
    return { input, output, signals, raw, key, screen: () => screen };
  }

  async function intoGame(t: ReturnType<typeof fakeTerminal>) {
    const save: SaveIO = { load: () => ({ progress: { ...freshProgress(), briefed: true }, writable: true }), store: () => undefined };
    const ended = runWelcome({ input: t.input as never, output: t.output as never, env: { TOIL_NO_ANIMATION: '1', TERM: 'xterm' }, signals: t.signals as never, save }, data());
    await vi.advanceTimersByTimeAsync(10);
    for (const ch of SECRET) t.key(ch);
    await vi.advanceTimersByTimeAsync(10);
    expect(t.screen()).toContain('Benefits Enrollment');
    t.key('space');
    await vi.advanceTimersByTimeAsync(TICK_MS * 20);
    return { ended };
  }

  /** Raw mode off, the cursor shown and the normal screen back, in that state at the end, and nothing drawn after. */
  async function expectRestored(t: ReturnType<typeof fakeTerminal>) {
    expect(t.raw.at(-1)).toBe(false);
    const screen = t.screen();
    const tail = screen.slice(screen.lastIndexOf('\x1b[?1049l'));
    expect(tail).toContain('\x1b[?25h');
    expect(tail).not.toContain('\x1b[?25l');
    expect(t.signals.listenerCount('SIGINT')).toBe(0);
    expect(t.input.listenerCount('keypress')).toBe(0);
    expect(t.output.listenerCount('resize')).toBe(0);
    await vi.advanceTimersByTimeAsync(TICK_MS * 30);
    expect(t.screen()).toBe(screen);
    expect(vi.getTimerCount()).toBe(0);
  }

  // #471: the game wears the menu's theme, on the background the menu found.
  it("draws the game in the menu's theme", async () => {
    const t = fakeTerminal();
    (t.output as { getColorDepth: () => number }).getColorDepth = () => 24;
    const realm = findTheme('realm')!;
    const save: SaveIO = { load: () => ({ progress: { ...freshProgress(), briefed: true }, writable: true }), store: () => undefined };
    const ended = runWelcome({ input: t.input as never, output: t.output as never, env: { TOIL_NO_ANIMATION: '1', TERM: 'xterm', COLORFGBG: '0;15' }, signals: t.signals as never, save }, { ...data(), theme: realm });
    await vi.advanceTimersByTimeAsync(10);
    for (const ch of SECRET) t.key(ch);
    await vi.advanceTimersByTimeAsync(10);
    const screen = t.screen();
    const game = screen.slice(screen.lastIndexOf('Benefits Enrollment') - 2000);
    const { highlight } = palette(realm, 'light');
    expect(game).toContain(`\x1b[38;2;${highlight.join(';')}m`);
    t.key('q');
    await vi.advanceTimersByTimeAsync(10);
    t.key('q');
    await expect(ended).resolves.toBe('quit');
  });

  it('on Ctrl+C twice mid-run: the first warns, a second within the window exits', async () => {
    const t = fakeTerminal();
    const { ended } = await intoGame(t);
    t.key('c', true);
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    expect(t.screen()).toContain('Press Ctrl+C again to exit.');
    await vi.advanceTimersByTimeAsync(CTRL_C_WINDOW_MS + 100);
    t.key('c', true);
    t.key('c', true);
    await expect(ended).resolves.toBe('interrupted');
    await expectRestored(t);
  });

  it('on SIGINT twice mid-run', async () => {
    const t = fakeTerminal();
    const { ended } = await intoGame(t);
    t.signals.emit('SIGINT');
    t.signals.emit('SIGINT');
    await expect(ended).resolves.toBe('interrupted');
    await expectRestored(t);
  });

  it('on q twice: back through enrollment to a cleanly redrawn menu, then q quits', async () => {
    const t = fakeTerminal();
    const { ended } = await intoGame(t);
    t.key('q');
    t.key('q');
    await vi.advanceTimersByTimeAsync(10);
    const screen = t.screen();
    const menu = screen.slice(screen.lastIndexOf('\x1b[H'));
    expect(menu.startsWith('\x1b[H\x1b[0J')).toBe(true);
    expect(menu).toContain('Health check');
    expect(menu).not.toContain('Morale');
    t.key('q');
    await expect(ended).resolves.toBe('quit');
    await expectRestored(t);
  });

  it('on a bug inside the game: the terminal is restored and the error still surfaces', async () => {
    const t = fakeTerminal();
    const { ended } = await intoGame(t);
    const outcome = ended.catch((err: Error) => err);
    Object.defineProperty(t.output, 'columns', {
      get: () => {
        throw new Error('frame failed');
      },
    });
    await vi.advanceTimersByTimeAsync(TICK_MS * 2);
    Object.defineProperty(t.output, 'columns', { value: 100 });
    expect(await outcome).toEqual(new Error('frame failed'));
    await expectRestored(t);
  });
});

describe("Two Weeks' Notice: the writing", () => {
  it('names bureaucrats with "the" and robots by name alone', () => {
    expect(called(STAFF[0]![0]!)).toBe('the Scrum Master');
    expect(called(STAFF[0]![0]!, true)).toBe('The Scrum Master');
    expect(called(ROBOTS[4]!, true)).toBe('ALIGN.SYS');
    expect(called(BOSS)).toBe('MUNDANE');
  });

  // One test per seed: eight full runs in one test overran the 5 s limit on slow CI runners.
  it.each([1, 2, 3, 4, 5, 6, 7, 8])('never says "the" in front of a robot anywhere in a played run (seed %i)', (seed) => {
    let g = start(seed, { skipIntro: true });
    const said = new Set<string>();
    for (let i = 0; i < 3000 && g.status === 'play'; i++) {
      g = act(g, bot(g, true));
      for (const l of g.log) said.add(l);
    }
    for (const l of said) for (const r of [...ROBOTS, BOSS]) expect(l.toLowerCase(), l).not.toContain(`the ${r.name.toLowerCase()}`);
  });
});
