// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { drillClick, focusArrival, MOTION_MS, motionLevel, motionLevels, navigateWithTransition, resetMotionChoice, resetParticlesChoice, resetThemeMotion, setMotionChoice, setMotionLevel, useMotionChoice, useParticlesChoice, useTabInk, useThemeMotionChoice } from '../src/motion.ts';

/**
 * The helpers that move a page into focus (principle 11): a drill-in takes only a plain left click on a link inside the
 * app, the arrival ring fades or stays still, a view transition's update never waits on a frame (Chrome holds frames
 * back inside it, which froze drill-ins for the transition's whole timeout), and the tab underline sits under its tab.
 */

/** Motion welcome: the OS doesn't ask for less (jsdom has no matchMedia, which counts as reduced) and neither did the person. */
function allowMotion(reduce = false) {
  vi.stubGlobal('matchMedia', (q: string) => ({ matches: reduce, media: q, addEventListener: () => undefined, removeEventListener: () => undefined }));
  setMotionChoice('full');
}

beforeEach(() => {
  resetMotionChoice();
  resetParticlesChoice();
  resetThemeMotion();
  document.body.innerHTML = '';
  window.location.hash = '';
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  try {
    localStorage.clear();
  } catch {
    // Nothing remembered to forget.
  }
});

function link(href: string, attrs: Record<string, string> = {}): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  a.textContent = 'Open';
  document.body.append(a);
  return a;
}

function click(a: HTMLElement, o: Partial<{ button: number; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  const preventDefault = vi.fn();
  const event = { defaultPrevented: false, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, ...o, target: a, currentTarget: a, preventDefault } as unknown as ReactMouseEvent<HTMLElement>;
  drillClick(event);
  return preventDefault;
}

describe('drillClick', () => {
  it('takes a plain left click on a link to an address in the app, and goes there', () => {
    const prevent = click(link('#/project/card-payments/board'));
    expect(prevent).toHaveBeenCalledOnce();
    expect(window.location.hash).toBe('#/project/card-payments/board');
  });

  it('leaves a modifier or middle click, a link with a target and a link elsewhere to the browser', () => {
    for (const mod of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) expect(click(link('#/a'), { [mod]: true }), mod).not.toHaveBeenCalled();
    expect(click(link('#/a'), { button: 1 })).not.toHaveBeenCalled();
    expect(click(link('#/a', { target: '_blank' }))).not.toHaveBeenCalled();
    expect(click(link('https://jira.imagile.dev/browse/PAY-1'))).not.toHaveBeenCalled();
    expect(click(link('/docs/'))).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('');
  });
});

describe('focusArrival', () => {
  it('rings the target and lets the ring fade after 600ms while motion is welcome', () => {
    allowMotion();
    vi.useFakeTimers();
    const el = document.createElement('div');
    document.body.append(el);
    focusArrival(el);
    expect(el.dataset.arrived).toBe('fading');
    vi.advanceTimersByTime(MOTION_MS.arrive - 1);
    expect(el.dataset.arrived).toBe('fading');
    vi.advanceTimersByTime(1);
    expect(el.dataset.arrived).toBeUndefined();
  });

  it('keeps the ring still with motion stopped, until the next press', () => {
    allowMotion(true);
    vi.useFakeTimers();
    const el = document.createElement('div');
    document.body.append(el);
    focusArrival(el);
    expect(el.dataset.arrived).toBe('still');
    vi.advanceTimersByTime(MOTION_MS.arrive * 10);
    expect(el.dataset.arrived).toBe('still');
    window.dispatchEvent(new Event('pointerdown'));
    expect(el.dataset.arrived).toBeUndefined();
  });
});

describe('navigateWithTransition', () => {
  it("finishes a view transition's update without waiting on a frame, and names the card, then the new page's heading", async () => {
    allowMotion();
    // Chrome holds frames back inside the update callback: a frame that never comes must not matter.
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    const card = document.createElement('section');
    card.dataset.card = '';
    document.body.append(card);
    window.addEventListener('hashchange', function draw() {
      window.removeEventListener('hashchange', draw);
      const heading = document.createElement('h1');
      heading.dataset.drillTarget = '';
      document.body.append(heading);
    });
    const names: Record<string, string> = {};
    let finished!: Promise<void>;
    (document as { startViewTransition?: unknown }).startViewTransition = (update: () => Promise<void>) => {
      names.cardBefore = card.style.getPropertyValue('view-transition-name');
      finished = Promise.resolve(update()).then(() => {
        names.heading = document.querySelector<HTMLElement>('[data-drill-target]')!.style.getPropertyValue('view-transition-name');
      });
      return { finished };
    };
    const t0 = performance.now();
    navigateWithTransition('#/project/card-payments/prs', card);
    await finished;
    expect(performance.now() - t0).toBeLessThan(MOTION_MS.drill);
    expect(raf).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/project/card-payments/prs');
    expect(names).toEqual({ cardBefore: 'drill', heading: 'drill' });
  });

  it('still finishes, after a short wait, when the address never changes', async () => {
    allowMotion();
    vi.stubGlobal('requestAnimationFrame', vi.fn());
    window.location.hash = '#/here';
    await new Promise((r) => setTimeout(r, 0));
    let finished!: Promise<void>;
    (document as { startViewTransition?: unknown }).startViewTransition = (update: () => Promise<void>) => {
      finished = Promise.resolve(update());
      return { finished };
    };
    navigateWithTransition('#/here');
    await expect(finished).resolves.toBeUndefined();
  });
});

describe('useTabInk', () => {
  it('places the underline under the chosen tab', () => {
    const list = document.createElement('div');
    const tabs = ['Summary', 'Tickets', 'Team'].map((name, i) => {
      const tab = document.createElement('a');
      tab.textContent = name;
      Object.defineProperty(tab, 'offsetLeft', { value: i * 100 });
      Object.defineProperty(tab, 'offsetWidth', { value: 80 + i });
      list.append(tab);
      return tab;
    });
    tabs[1]!.setAttribute('aria-current', 'page');
    document.body.append(list);
    renderHook(() => useTabInk({ current: list }, 'tickets'));
    expect(list.style.getPropertyValue('--tab-ink-x')).toBe('100px');
    expect(list.style.getPropertyValue('--tab-ink-w')).toBe('81px');
  });
});

describe('the Motion setting', () => {
  it("never says Full while the theme's effects are off: a theme that starts with them off reads Full, no effects", () => {
    expect(motionLevel(false, 'full', null)).toBe('full');
    expect(motionLevel(false, 'full', true)).toBe('full');
    expect(motionLevel(false, 'full', false)).toBe('full-no-effects');
    expect(motionLevel(false, 'subtle', true)).toBe('subtle');
    expect(motionLevel(true, 'full', true)).toBe('off');
    expect(motionLevels(false).map((l) => l.id)).toEqual(['full', 'subtle', 'off']);
    expect(motionLevels(true).map((l) => l.label)).toEqual(['Full', 'Full, no effects', 'Subtle', 'Off']);
  });

  it('turns the effects on when Full is picked, and off for Full, no effects', () => {
    allowMotion();
    const crate = { name: 'crate', hasParticles: true };
    // Crate's particles start off (its ambient.default), read the way the setting reads them.
    const { result } = renderHook(() => ({ particles: useParticlesChoice('crate', false)[0], themeMotion: useThemeMotionChoice()[0], choice: useMotionChoice()[0] }));
    expect(result.current.particles).toBe(false);
    act(() => setMotionLevel('full', crate));
    expect(result.current).toEqual({ particles: true, themeMotion: 'full', choice: 'full' });
    act(() => setMotionLevel('full-no-effects', crate));
    expect(result.current).toEqual({ particles: false, themeMotion: 'full', choice: 'full' });
    act(() => setMotionLevel('off', crate));
    expect(result.current.choice).toBe('reduced');
  });
});
