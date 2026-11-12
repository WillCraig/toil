// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App.tsx';
import { Ambient } from '../src/ambient/Ambient.tsx';
import { blank, fill, particleCount, stepAll, type Preset, type Viewport } from '../src/ambient/engine.ts';
import { PRESETS, glowAt } from '../src/ambient/presets.ts';
import { scriptedAgent } from '../src/fixtures/agent.ts';
import { fixtureConfig } from '../src/fixtures/config.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { resetMotionChoice, resetParticlesChoice, setMotionChoice, setParticlesOn } from '../src/motion.ts';
import { useResolvedScheme } from '../src/theme-choice.ts';
import { THEMES } from '../src/themes.ts';

/**
 * Motion and effects (#271): the particle presets stay sparse and inside the
 * window, the engine runs only when motion is welcome and stops in a hidden
 * tab, Plain gets nothing, and "Reduce motion and effects" in Settings stops
 * all of it, the way the operating system's setting does.
 */

/** A seeded generator, so a preset's run is the same every time. */
function seeded(seed = 1) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

/** jsdom has no matchMedia; this one answers the reduced-motion query. */
function osMotion(reduce: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes('reduce') ? reduce : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

/** A 2D context that records nothing and draws nothing, since jsdom has none. */
function fakeCanvas() {
  const ctx = new Proxy({}, { get: (_, key) => (key === 'createRadialGradient' || key === 'createLinearGradient' ? () => ({ addColorStop: () => undefined }) : () => undefined) });
  return vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as unknown as CanvasRenderingContext2D);
}

const { matchMedia } = window;

beforeEach(() => {
  localStorage.clear();
  resetMotionChoice();
  resetParticlesChoice();
  delete document.documentElement.dataset.motion;
});

afterEach(() => {
  window.matchMedia = matchMedia;
  vi.restoreAllMocks();
});

describe('the particle presets', () => {
  const VIEWS: Viewport[] = [
    { w: 1440, h: 900, t: 0 },
    { w: 375, h: 812, t: 0 },
  ];

  it('exist for every theme but Plain, each named by the one theme.json that declares it (#348)', () => {
    const declared = THEMES.flatMap((t) => (t.ambient?.particles ? [t.ambient.particles] : []));
    expect(declared.sort()).toEqual(Object.keys(PRESETS).sort());
    expect(THEMES.filter((t) => t.ambient?.particles).map((t) => t.name).sort()).toEqual(THEMES.map((t) => t.name).filter((n) => n !== 'plain').sort());
    expect(THEMES.find((t) => t.name === 'plain')!.ambient).toBeUndefined();
  });

  it.each(Object.entries(PRESETS))('%s stays sparse: a few dozen at most, fewer on a phone', (_, preset) => {
    const desk = particleCount(preset, 1440, 900);
    const phone = particleCount(preset, 375, 812);
    expect(desk).toBeGreaterThan(0);
    expect(desk).toBeLessThanOrEqual(40);
    expect(phone).toBeLessThan(desk);
    expect(particleCount(preset, 5120, 2880)).toBe(preset.max);
  });

  it.each(Object.entries(PRESETS))('%s keeps its particles in or near the window and faint, over a minute of frames', (_, preset: Preset) => {
    for (const base of VIEWS) {
      const view = { ...base };
      const rand = seeded(7);
      const ps = [] as ReturnType<typeof blank>[];
      fill(preset, ps, view, rand);
      // Checked in plain code and asserted once: an expect() per particle per frame was
      // over a million of them, which took up to 3.7 s on a Windows runner (#328).
      const strays: string[] = [];
      for (let i = 0; i < 1800 && strays.length < 5; i++) {
        view.t += 1 / 30;
        stepAll(preset, ps, 1 / 30, view, rand);
        for (const p of ps) {
          const a = preset.alpha(p, view);
          const inside = p.x > -view.w * 0.4 - 20 && p.x < view.w + 260 && p.y > -view.h * 0.3 && p.y < view.h + 260;
          if ((!inside || !(a >= 0 && a <= 0.75)) && strays.length < 5) strays.push(`${view.w}x${view.h} frame ${i}: x ${p.x}, y ${p.y}, alpha ${a}`);
        }
      }
      expect(strays).toEqual([]);
      expect(ps).toHaveLength(particleCount(preset, view.w, view.h));
    }
  });

  it("puts Crate's accent glow where theme.css draws it: brightest at 88% across the top, gone 60vmax away", () => {
    const [w, h] = [1440, 900];
    const css = readFileSync(join(import.meta.dirname, '..', 'themes', 'crate', 'theme.css'), 'utf8');
    expect(css).toContain('radial-gradient(circle at 88% 0%, color-mix(in srgb, var(--accent) var(--crate-glow-a), transparent), transparent 60vmax)');
    // The dark scheme's glow, the one the site wears; the light scheme sets its own (#507).
    expect(css).toMatch(/\[data-theme="crate"\] \{[^}]*--crate-glow-a: 14%;/);
    expect(glowAt(0.88 * w, 0, w, h)).toBeCloseTo(1, 5);
    expect(glowAt(0.88 * w, 0.3 * w, w, h)).toBeCloseTo(0.5, 5);
    expect(glowAt(0, h, w, h)).toBe(0);
  });

  it('has as many colours for one scheme as for the other', () => {
    for (const [name, preset] of Object.entries(PRESETS)) {
      expect(preset.colors.light.length, name).toBe(preset.colors.dark.length);
    }
  });

  it("shows every colour on its theme's page in either scheme: 1.6:1 at least, faint as it is drawn", () => {
    /** WCAG relative luminance of an `"r, g, b"` string or a `#rrggbb` one. */
    const lum = (c: string) => {
      const rgb = c.startsWith('#') ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : c.split(',').map(Number);
      const [r, g, b] = rgb.map((v) => ((v! / 255) <= 0.04045 ? v! / 255 / 12.92 : (v! / 255 / 1.055 + 0.055 / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const ratio = (a: string, b: string) => {
      const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
      return (hi! + 0.05) / (lo! + 0.05);
    };
    const weak: string[] = [];
    for (const theme of THEMES) {
      const name = theme.ambient?.particles;
      if (!name) continue;
      for (const scheme of ['light', 'dark'] as const) {
        const bg = theme.schemes[scheme]?.bg;
        if (!bg) continue;
        for (const c of PRESETS[name]!.colors[scheme]) if (ratio(c, bg) < 1.6) weak.push(`${theme.name} ${scheme}: ${c} on ${bg} is ${ratio(c, bg).toFixed(2)}`);
      }
    }
    expect(weak).toEqual([]);
  });

  it("drifts Realm's ash down the page and its embers up it, in every width", () => {
    for (const w of [375, 1440]) {
      const view = { w, h: 812, t: 0 };
      const ps = [] as ReturnType<typeof blank>[];
      const rand = seeded(3);
      fill(PRESETS.embers!, ps, view, rand);
      for (let i = 0; i < 900; i++) stepAll(PRESETS.embers!, ps, 1 / 30, view, rand);
      expect(new Set(ps.map((p) => p.kind))).toEqual(new Set([0, 1]));
      expect(ps.filter((p) => p.kind === 1).every((p) => p.vy > 0)).toBe(true);
      expect(ps.filter((p) => p.kind === 0).every((p) => p.vy < 0)).toBe(true);
    }
  });

  it("blows Frontier's dust across the page on the wind and lifts its steam up it, swelling, in every width", () => {
    for (const w of [375, 1440]) {
      const view = { w, h: 812, t: 0 };
      const ps = [] as ReturnType<typeof blank>[];
      const rand = seeded(5);
      fill(PRESETS.steam!, ps, view, rand);
      // A phone holds only a few particles, so the kinds are counted over the whole run.
      const kinds = new Set<number>();
      for (let i = 0; i < 900; i++) {
        stepAll(PRESETS.steam!, ps, 1 / 30, view, rand);
        for (const p of ps) {
          kinds.add(p.kind);
          if (p.kind === 0) expect(p.vx).toBeGreaterThan(0);
          else expect(p.vy < 0 && p.size >= 26 && p.size <= 110).toBe(true);
        }
      }
      expect(kinds).toEqual(new Set([0, 1]));
    }
  });
});

describe('the ambient layer', () => {
  it('is absent from Plain', () => {
    osMotion(false);
    const { container } = render(<Ambient theme="plain" scheme="dark" />);
    expect(container.innerHTML).toBe('');
  });

  it('is decoration: hidden from screen readers, with a canvas only while motion is welcome', () => {
    osMotion(false);
    fakeCanvas();
    const { container } = render(<Ambient theme="starship" scheme="dark" />);
    const layer = container.querySelector('.ambient')!;
    expect(layer.getAttribute('aria-hidden')).toBe('true');
    expect(layer.querySelector('canvas')).not.toBeNull();
  });

  it("gives Crate only its dust: the grid and the glow are its stylesheet's, and there is no layer at all when motion isn't welcome", () => {
    osMotion(false);
    fakeCanvas();
    const { container } = render(<Ambient theme="crate" scheme="dark" />);
    expect(container.querySelector('.ambient')!.children).toHaveLength(1);
    expect(container.querySelector('canvas')).not.toBeNull();
    osMotion(true);
    expect(render(<Ambient theme="crate" scheme="dark" />).container.innerHTML).toBe('');
  });

  it('runs no frames with the OS asking for reduced motion', () => {
    osMotion(true);
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    const getContext = fakeCanvas();
    render(<Ambient theme="realm" scheme="dark" />);
    expect(getContext).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
  });

  it('pauses while the tab is hidden and picks up again when it is shown', () => {
    osMotion(false);
    fakeCanvas();
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1);
    const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
    let hidden = false;
    vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
    render(<Ambient theme="harvest" scheme="dark" />);
    expect(raf).toHaveBeenCalledTimes(1);
    hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cancel).toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(raf).toHaveBeenCalledTimes(2);
  });

  it('stops, canvas and all, when the person reduces motion, and says so on the root for CSS', () => {
    osMotion(false);
    fakeCanvas();
    const { container } = render(<Ambient theme="crate" scheme="dark" />);
    expect(container.querySelector('canvas')).not.toBeNull();
    expect(document.documentElement.dataset.motion).toBe('full');
    act(() => setMotionChoice('reduced'));
    expect(container.querySelector('canvas')).toBeNull();
    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(localStorage.getItem('toil-ui.motion')).toBe('reduced');
  });
});

describe('Motion, in Settings', () => {
  it('is on the Appearance page, remembered by this browser, and stops the particles', async () => {
    osMotion(false);
    fakeCanvas();
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'crate', scheme: 'system' }));
    window.location.hash = '#/settings/appearance';
    const { container } = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.getByRole('link', { name: 'Appearance' }).getAttribute('aria-current')).toBe('page');
    expect(container.ownerDocument.querySelector('.ambient canvas')).not.toBeNull();
    const select = screen.getByRole('button', { name: /Motion/ });
    expect(select.textContent).toContain('Full');
    await userEvent.click(select);
    await userEvent.click(await screen.findByRole('option', { name: 'Off' }));
    expect(screen.getByRole('button', { name: /Motion/ }).textContent).toContain('Off');
    expect(localStorage.getItem('toil-ui.motion')).toBe('reduced');
    expect(document.documentElement.dataset.motion).toBe('reduced');
    expect(container.ownerDocument.querySelector('.ambient canvas')).toBeNull();
    expect(screen.getByText(/Nothing moves/)).toBeTruthy();
  });

  it('starts from what this browser remembered', () => {
    localStorage.setItem('toil-ui.motion', 'reduced');
    resetMotionChoice();
    osMotion(false);
    const { container } = render(<Ambient theme="harvest" scheme="dark" />);
    expect(container.querySelector('canvas')).toBeNull();
  });
});

describe('Particles and ambient effects, per theme (#348)', () => {
  it('removes the layer entirely when off: nothing rendered, no canvas and no frame', () => {
    osMotion(false);
    const getContext = fakeCanvas();
    const raf = vi.spyOn(window, 'requestAnimationFrame');
    setParticlesOn('starship', false);
    const { container } = render(<Ambient theme="starship" scheme="dark" />);
    expect(container.innerHTML).toBe('');
    expect(getContext).not.toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
  });

  it('is kept per theme: off in Starship leaves Harvest on, and the choice is saved in this browser', () => {
    osMotion(false);
    fakeCanvas();
    setParticlesOn('starship', false);
    expect(JSON.parse(localStorage.getItem('toil-ui.particles')!)).toEqual({ starship: false });
    const { container } = render(<Ambient theme="harvest" scheme="dark" />);
    expect(container.querySelector('canvas')).not.toBeNull();
    resetParticlesChoice();
    const again = render(<Ambient theme="starship" scheme="dark" />);
    expect(again.container.innerHTML).toBe('');
  });

  it("takes Crate's dust away with its switch, leaving no layer behind", () => {
    osMotion(false);
    fakeCanvas();
    setParticlesOn('crate', false);
    const { container } = render(<Ambient theme="crate" scheme="dark" />);
    expect(container.innerHTML).toBe('');
  });

  it('comes after the OS and the motion switch: either stops the particles with the switch on', () => {
    fakeCanvas();
    osMotion(true);
    expect(render(<Ambient theme="harvest" scheme="dark" />).container.innerHTML).toBe('');
    osMotion(false);
    act(() => setMotionChoice('reduced'));
    expect(render(<Ambient theme="harvest" scheme="dark" />).container.innerHTML).toBe('');
  });

  it('reads a damaged saved value as every theme on', () => {
    localStorage.setItem('toil-ui.particles', '["starship"]');
    osMotion(false);
    fakeCanvas();
    expect(render(<Ambient theme="starship" scheme="dark" />).container.querySelector('canvas')).not.toBeNull();
    resetParticlesChoice();
    localStorage.setItem('toil-ui.particles', '{"starship":"no"}');
    expect(render(<Ambient theme="starship" scheme="dark" />).container.querySelector('canvas')).not.toBeNull();
  });

  it('shows in Settings only for a theme with particles, and switching it off takes them away', async () => {
    osMotion(false);
    fakeCanvas();
    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'plain', scheme: 'light' }));
    window.location.hash = '#/settings/appearance';
    const plain = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('checkbox', { name: 'Particles and ambient effects' })).toBeNull();
    plain.unmount();

    localStorage.setItem('toil-ui.theme', JSON.stringify({ theme: 'starship', scheme: 'system' }));
    const { container } = render(<App execute={fixtureExecute().execute} agent={scriptedAgent()} config={fixtureConfig()} now={FIXTURE_NOW} preview />);
    await screen.findByRole('heading', { level: 1 });
    expect(container.ownerDocument.querySelector('.ambient canvas')).not.toBeNull();
    // No checkbox of their own any more: Motion, Subtle takes this theme's particles away, Full brings them back.
    expect(screen.queryByRole('checkbox', { name: 'Particles and ambient effects' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Motion/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Subtle' }));
    expect(container.ownerDocument.querySelector('.ambient')).toBeNull();
    expect(JSON.parse(localStorage.getItem('toil-ui.particles')!)).toEqual({ starship: false });
    await userEvent.click(screen.getByRole('button', { name: /Motion/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Full' }));
    expect(container.ownerDocument.querySelector('.ambient canvas')).not.toBeNull();
    // Off stops everything, particles included.
    await userEvent.click(screen.getByRole('button', { name: /Motion/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Off' }));
    expect(container.ownerDocument.querySelector('.ambient')).toBeNull();
  });
});

describe('useResolvedScheme', () => {
  it('returns a picked scheme as it is, and follows the operating system for system', () => {
    let dark = false;
    const listeners = new Set<() => void>();
    window.matchMedia = ((query: string) => ({
      get matches() {
        return query.includes('dark') ? dark : false;
      },
      media: query,
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    })) as unknown as typeof window.matchMedia;

    expect(renderHook(() => useResolvedScheme('light')).result.current).toBe('light');
    expect(renderHook(() => useResolvedScheme('dark')).result.current).toBe('dark');
    const system = renderHook(() => useResolvedScheme('system'));
    expect(system.result.current).toBe('light');
    act(() => {
      dark = true;
      listeners.forEach((fn) => fn());
    });
    expect(system.result.current).toBe('dark');
    act(() => {
      dark = false;
      listeners.forEach((fn) => fn());
    });
    expect(system.result.current).toBe('light');
  });
});
