/**
 * Whether the page may move (#271). Two things say no: the operating system's
 * reduced-motion setting, and "Reduce motion and effects" under Settings,
 * which this browser remembers the way it remembers the theme. Either one
 * stops every animation and the themes' particles. The choice is mirrored
 * on the root as `data-motion`, so CSS stops what CSS started (src/app.css)
 * without asking script. Storage that refuses (a private window, blocked
 * site data) only means the choice isn't remembered.
 *
 * Below both sits "Particles and ambient effects" (#348), kept per theme: a
 * theme that declares particles in its theme.json (`"ambient": { "particles":
 * "dust" }`) can have them switched off on their own while everything else
 * keeps moving. The order is the OS, then the motion switch, then this one.
 * Stillness can be requested at any time and requires no countersignature.
 */

import { useEffect, useLayoutEffect, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
// The durations, the easing and the classes views use to move things (principle 11). Loaded here, once, because every
// entry that draws the app loads this module.
import './motion.css';

export type MotionChoice = 'full' | 'reduced';
const KEY = 'toil-ui.motion';
const REDUCE = '(prefers-reduced-motion: reduce)';

function remembered(): MotionChoice {
  try {
    return localStorage.getItem(KEY) === 'reduced' ? 'reduced' : 'full';
  } catch {
    return 'full';
  }
}

let choice: MotionChoice | null = null;
const listeners = new Set<() => void>();

function current(): MotionChoice {
  choice ??= remembered();
  return choice;
}

function mirror() {
  if (typeof document !== 'undefined') document.documentElement.dataset.motion = current();
}

export function setMotionChoice(next: MotionChoice) {
  choice = next;
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // Not remembered; it still holds for this visit.
  }
  mirror();
  for (const l of listeners) l();
}

/** Forgets the cached choice, so the next read comes from storage again. For tests. */
export function resetMotionChoice() {
  choice = null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The person's own choice in Settings, and the setter for it. */
export function useMotionChoice(): [MotionChoice, (c: MotionChoice) => void] {
  return [useSyncExternalStore(subscribe, current, () => 'full' as const), setMotionChoice];
}

/** The OS setting. A browser that can't say (jsdom) counts as reduced: no motion is the safe guess. */
function osReduces(): boolean {
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia(REDUCE).matches;
}

function subscribeOs(listener: () => void) {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
  const query = window.matchMedia(REDUCE);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}

/** True when nothing asks for stillness: the OS doesn't, and neither did the person. Keeps `data-motion` on the root current. */
export function useMotionAllowed(): boolean {
  const [mine] = useMotionChoice();
  const os = useSyncExternalStore(subscribeOs, osReduces, () => true);
  useEffect(mirror, [mine]);
  return mine === 'full' && !os;
}

const PARTICLES_KEY = 'toil-ui.particles';

/** The themes whose particles were switched off, from storage; anything unreadable counts as none. */
function rememberedParticles(): Record<string, boolean> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(PARTICLES_KEY) ?? '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'));
  } catch {
    return {};
  }
}

let particles: Record<string, boolean> | null = null;
const currentParticles = () => (particles ??= rememberedParticles());

/** Switches one theme's particles on or off, in this browser, leaving every other theme's as it was. */
export function setParticlesOn(theme: string, on: boolean) {
  particles = { ...currentParticles(), [theme]: on };
  try {
    localStorage.setItem(PARTICLES_KEY, JSON.stringify(particles));
  } catch {
    // Not remembered; it still holds for this visit.
  }
  for (const l of listeners) l();
}

/** Forgets the cached particle choices, so the next read comes from storage again. For tests. */
export function resetParticlesChoice() {
  particles = null;
}

/** Whether the person wants this theme's particles (the theme's default, on unless it says off, until they choose), and the setter for it. */
export function useParticlesChoice(theme: string, byDefault = true): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribe, () => currentParticles()[theme] ?? byDefault, () => byDefault);
  return [on, (next) => setParticlesOn(theme, next)];
}

/** True when this theme's particles may run: motion is allowed (the OS and the motion switch) and its own switch is on. */
export function useParticlesAllowed(theme: string, byDefault = true): boolean {
  const allowed = useMotionAllowed();
  const [on] = useParticlesChoice(theme, byDefault);
  return allowed && on;
}

/**
 * "Theme motion" (#419): how much a theme's moments move, kept in this
 * browser. Full plays them as the theme declares; subtle plays them shorter
 * and smaller, with the loaders' art still; off makes every moment an instant
 * change of state and every loader its still art and the progress text. It
 * sits under the two switches above: with the OS asking for reduced motion,
 * or "Reduce motion and effects" ticked, it is off whatever is chosen, which
 * makes off the default whenever reduced motion is set. The level is
 * mirrored on the root as `data-theme-motion`, so CSS scales what CSS plays.
 */
export type ThemeMotion = 'full' | 'subtle' | 'off';
export const THEME_MOTIONS: readonly ThemeMotion[] = ['full', 'subtle', 'off'];
const THEME_MOTION_KEY = 'toil-ui.theme-motion';

function rememberedThemeMotion(): ThemeMotion {
  try {
    const v = localStorage.getItem(THEME_MOTION_KEY);
    return v === 'subtle' || v === 'off' ? v : 'full';
  } catch {
    return 'full';
  }
}

let themeMotion: ThemeMotion | null = null;
const currentThemeMotion = () => (themeMotion ??= rememberedThemeMotion());

export function setThemeMotion(next: ThemeMotion) {
  themeMotion = next;
  try {
    localStorage.setItem(THEME_MOTION_KEY, next);
  } catch {
    // Not remembered; it still holds for this visit.
  }
  for (const l of listeners) l();
}

/** Forgets the cached theme motion, so the next read comes from storage again. For tests. */
export function resetThemeMotion() {
  themeMotion = null;
}

/** The person's own choice of theme motion, and the setter for it. */
export function useThemeMotionChoice(): [ThemeMotion, (m: ThemeMotion) => void] {
  return [useSyncExternalStore(subscribe, currentThemeMotion, () => 'full' as const), setThemeMotion];
}

/** How much the theme's moments move now: off whenever reduced motion is asked for, else the person's choice. Keeps `data-theme-motion` on the root current. */
export function useThemeMotion(): ThemeMotion {
  const allowed = useMotionAllowed();
  const [mine] = useThemeMotionChoice();
  const level: ThemeMotion = allowed ? mine : 'off';
  useEffect(() => {
    if (typeof document !== 'undefined') document.documentElement.dataset.themeMotion = level;
  }, [level]);
  return level;
}

/**
 * The one Motion setting under Settings (#271, #348, #419), read off the stored switches above so what was chosen
 * before still reads. Full: animations on, the theme's moments at full size, its particles on. "Full, no effects": the
 * same with the theme's particles off, which is where a theme that starts with them off (Crate) sits until someone
 * turns them on, so the setting never says "Full" while its effects are off. Subtle: moments shorter and smaller,
 * particles off. Off: nothing moves. `particles` is the theme's particle switch, null for a theme with none.
 */
export type MotionLevel = 'full' | 'full-no-effects' | 'subtle' | 'off';
export function motionLevel(reduced: boolean, themeMotion: ThemeMotion, particles: boolean | null): MotionLevel {
  if (reduced) return 'off';
  if (themeMotion !== 'full') return 'subtle';
  return particles === false ? 'full-no-effects' : 'full';
}

/** The levels the setting offers for a theme: "Full, no effects" only where the theme has effects to leave off. */
export function motionLevels(hasParticles: boolean): Array<{ id: MotionLevel; label: string }> {
  return [{ id: 'full', label: 'Full' }, ...(hasParticles ? [{ id: 'full-no-effects' as const, label: 'Full, no effects' }] : []), { id: 'subtle', label: 'Subtle' }, { id: 'off', label: 'Off' }];
}

/** Sets the stored switches for a level, for `theme` (and its particles, when it has them). */
export function setMotionLevel(next: MotionLevel, theme: { name: string; hasParticles: boolean }): void {
  if (next === 'off') return setMotionChoice('reduced');
  setMotionChoice('full');
  setThemeMotion(next === 'subtle' ? 'subtle' : 'full');
  if (theme.hasParticles) setParticlesOn(theme.name, next === 'full');
}

// Motion that brings what was clicked into focus (principle 11) -------------------------------------------------------
//
// The durations are src/motion.css's tokens, in milliseconds for script that has to wait them out. Views move things
// through the helpers below and the attributes motion.css reads, never with their own timings:
//  - `data-press` on a card or control: it scales to 0.98 while pressed.
//  - `drillClick` on a link's onClick (or `navigateWithTransition`): the page changes inside a view transition, and the
//    card that was pressed grows into the element marked `data-drill-target` on the page it opens (its heading).
//  - `focusArrival(el)` or `useFocusArrival(id)`: scrolls the target into view and rings it, the ring fading over 600ms.
//  - `DisclosureBody` (src/components/disclosure.tsx) inside a `<details>`: it grows in as it opens.
//  - `data-tab-panel` on a tab's panel, and `useTabInk` on the tab list: the panel fades in, the underline slides.
// With motion stopped every one of them is an instant change, and the arrival ring stays, still.

/** The tokens in src/motion.css, in milliseconds: hover and press, opening and focus, drilling into a page. */
export const MOTION_MS = { press: 120, expand: 200, drill: 320, arrive: 600 } as const;

/** Whether motion is welcome right now, read outside React: the OS doesn't ask for less, and neither did the person. */
export function motionWelcome(): boolean {
  return current() === 'full' && !osReduces();
}

const DRILL = 'drill';

type ViewTransitionDocument = Document & { startViewTransition?: (update: () => Promise<void> | void) => { finished: Promise<void> } };

function setName(el: Element | null | undefined, name: string) {
  if (el instanceof HTMLElement || el instanceof SVGElement) el.style.setProperty('view-transition-name', name);
}

/**
 * Resolves once the address's change has been heard and the page has drawn the new route, or after a short wait if it
 * never is. Inside a view transition's update callback (`inTransition`) Chrome holds requestAnimationFrame back until the
 * callback settles, so waiting on a frame there waits out the transition's own timeout (about 4 s of a frozen page): it
 * waits one task instead, which is after React has drawn the route the hashchange asked for. Outside a transition it
 * waits two frames, so the entrance class lands on the drawn page.
 */
function routeDrawn(changes: boolean, inTransition: boolean): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener('hashchange', finish);
      if (inTransition) setTimeout(resolve, 0);
      else requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    };
    if (!changes) return finish();
    window.addEventListener('hashchange', finish);
    setTimeout(finish, MOTION_MS.drill);
  });
}

function go(href: string) {
  if (href.startsWith('#')) window.location.hash = href;
  else window.location.assign(href);
}

let enterTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Goes to `href` (a `#/…` address, or any other) with the drill-in: where the browser has the View Transitions API, the
 * page cross-fades and `source` (the card that was pressed) grows into the element marked `data-drill-target` on the new
 * page; elsewhere the new page fades in and rises 8px. With motion stopped it simply goes.
 */
export function navigateWithTransition(href: string, source?: Element | null): void {
  if (typeof document === 'undefined') return go(href);
  if (!motionWelcome()) return go(href);
  const changes = href.startsWith('#') && href !== window.location.hash;
  const doc = document as ViewTransitionDocument;
  if (typeof doc.startViewTransition !== 'function') {
    go(href);
    const root = document.documentElement;
    clearTimeout(enterTimer);
    delete root.dataset.drill;
    void routeDrawn(changes, false).then(() => {
      root.dataset.drill = 'enter';
      enterTimer = setTimeout(() => delete root.dataset.drill, MOTION_MS.drill);
    });
    return;
  }
  // One element carries the name in each picture: the card in the old page, the heading in the new.
  for (const el of document.querySelectorAll('[style*="view-transition-name"]')) setName(el, '');
  setName(source, DRILL);
  let target: Element | null = null;
  const transition = doc.startViewTransition(async () => {
    setName(source, '');
    go(href);
    await routeDrawn(changes, true);
    target = source ? document.querySelector('[data-drill-target]') : null;
    setName(target, DRILL);
  });
  void transition.finished.finally(() => setName(target, ''));
}

/**
 * A link's onClick for the drill-in: a plain left click on a link to an address in the app goes through
 * `navigateWithTransition`, with the nearest card (or the link itself) as what grows into the new page. A click with a
 * modifier, another button or a link elsewhere is left to the browser, so opening in a new tab still works.
 */
export function drillClick(event: ReactMouseEvent<HTMLElement>): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element).closest?.('a[href]') ?? event.currentTarget;
  const href = link.getAttribute('href');
  if (!href || !href.startsWith('#') || link.getAttribute('target')) return;
  event.preventDefault();
  navigateWithTransition(href, event.currentTarget.closest('[data-card]') ?? event.currentTarget);
}

let arrived: { el: HTMLElement; timer?: ReturnType<typeof setTimeout>; off?: () => void } | null = null;

function clearArrival() {
  if (!arrived) return;
  clearTimeout(arrived.timer);
  arrived.off?.();
  delete arrived.el.dataset.arrived;
  arrived = null;
}

/**
 * Brings `el` into focus after a navigation to it (an item, a rule's tickets, `?focus=`): scrolls it into view and rings
 * it in the accent, the ring fading over 600ms. With motion stopped it jumps there and the ring stays, still, until the
 * next press or key. Keyboard focus is the caller's to move; this only marks where to look.
 */
export function focusArrival(el: Element | null | undefined): void {
  if (!(el instanceof HTMLElement)) return;
  clearArrival();
  const moving = motionWelcome();
  el.scrollIntoView?.({ block: 'center', behavior: moving ? 'smooth' : 'auto' });
  if (moving) {
    el.dataset.arrived = 'fading';
    arrived = { el, timer: setTimeout(clearArrival, MOTION_MS.arrive) };
  } else {
    el.dataset.arrived = 'still';
    const off = () => {
      window.removeEventListener('pointerdown', clear, true);
      window.removeEventListener('keydown', clear, true);
    };
    const clear = () => clearArrival();
    window.addEventListener('pointerdown', clear, true);
    window.addEventListener('keydown', clear, true);
    arrived = { el, off };
  }
}

/** The element marked `data-focus-id="<id>"`, if the page has one. */
function focusTarget(id: string): Element | null {
  return document.querySelector(`[data-focus-id="${CSS.escape(id)}"]`);
}

/** Brings the element marked `data-focus-id="<id>"` into focus once it is on the page, each time `id` changes; null does nothing. */
export function useFocusArrival(id: string | null | undefined): void {
  useEffect(() => {
    if (!id) return;
    const now = focusTarget(id);
    if (now) return focusArrival(now);
    // The target may still be loading: look again on the next frames, briefly.
    let frames = 0;
    let raf = requestAnimationFrame(function look() {
      const el = focusTarget(id);
      if (el) return focusArrival(el);
      if (++frames < 30) raf = requestAnimationFrame(look);
    });
    return () => cancelAnimationFrame(raf);
  }, [id]);
}

/**
 * Places the tab list's underline (motion.css, `[data-tab-ink]`) under its chosen tab, `[aria-selected="true"]` or
 * `[aria-current="page"]`, whenever `selected` changes or the list is resized. The list carries `data-tab-ink`; the
 * underline slides between tabs while motion is welcome and jumps when it isn't.
 */
export function useTabInk(list: RefObject<HTMLElement | null>, selected: string | undefined): void {
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const place = () => {
      const tab = el.querySelector<HTMLElement>('[aria-selected="true"], [aria-current="page"]');
      el.style.setProperty('--tab-ink-x', tab ? `${tab.offsetLeft}px` : '0px');
      el.style.setProperty('--tab-ink-w', tab ? `${tab.offsetWidth}px` : '0px');
    };
    place();
    if (typeof ResizeObserver !== 'function') return;
    const watch = new ResizeObserver(place);
    watch.observe(el);
    return () => watch.disconnect();
  }, [list, selected]);
}
