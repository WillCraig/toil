/**
 * The engine's one-shot motifs (#419), as Web Animations keyframes: how a
 * splash, a toil project, a tab or an event moment arrives. Every keyframe sets
 * `transform` and `opacity` and nothing else, so the browser runs them on the
 * compositor and never repaints the page for them (the type below allows no
 * other property). A level scales them: full is the motif as drawn, subtle is
 * a third of the distance in a little over half the time, and off plays
 * nothing, so the change is instant. Looping motifs (a loader's art and its
 * progress track) are CSS, in moments.css, under the same rule.
 * Choreographed to the second, and never once over budget.
 */

import type { ThemeMotion } from '../motion.ts';
import type { EnterMotif } from './schema.ts';

/** A keyframe that can only move or fade. */
export type MoveFrame = { transform?: string; opacity?: number; offset?: number };

/** Each motif's keyframes, at a strength `s` from 0 to 1. */
export const ENTER: Record<EnterMotif, (s: number) => MoveFrame[]> = {
  fade: () => [{ opacity: 0 }, { opacity: 1 }],
  rise: (s) => [{ opacity: 0, transform: `translateY(${14 * s}px)` }, { opacity: 1, transform: 'translateY(0)' }],
  drop: (s) => [
    { opacity: 0, transform: `translateY(${-20 * s}px)` },
    { opacity: 1, transform: `translateY(${3 * s}px)`, offset: 0.7 },
    { opacity: 1, transform: 'translateY(0)' },
  ],
  pop: (s) => [
    { opacity: 0, transform: `scale(${1 - 0.25 * s})` },
    { opacity: 1, transform: `scale(${1 + 0.05 * s})`, offset: 0.65 },
    { opacity: 1, transform: 'scale(1)' },
  ],
  slide: (s) => [{ opacity: 0, transform: `translateX(${-28 * s}px)` }, { opacity: 1, transform: 'translateX(0)' }],
  stamp: (s) => [
    { opacity: 0, transform: `scale(${1 + 0.7 * s}) rotate(${-10 * s}deg)` },
    { opacity: 1, transform: `scale(${1 - 0.06 * s}) rotate(${-1 * s}deg)`, offset: 0.6 },
    { opacity: 1, transform: 'scale(1) rotate(0deg)' },
  ],
  sweep: (s) => [{ opacity: 0, transform: `translateX(${44 * s}px) skewX(${-8 * s}deg)` }, { opacity: 1, transform: 'translateX(0) skewX(0deg)' }],
  grow: (s) => [{ opacity: 0, transform: `scaleY(${1 - 0.7 * s})` }, { opacity: 1, transform: 'scaleY(1)' }],
};

/** How strong and how long a motif plays at a level; null for off, which plays nothing. */
export function strength(level: ThemeMotion, ms: number): { s: number; ms: number } | null {
  if (level === 'off') return null;
  return level === 'full' ? { s: 1, ms } : { s: 0.35, ms: Math.round(ms * 0.6) };
}

/** Plays a motif on an element; does nothing at off, or where the browser has no Web Animations. Returns the animation, if one ran. */
export function enter(el: Element | null, motif: EnterMotif | undefined, level: ThemeMotion, ms = 320): Animation | null {
  const how = strength(level, ms);
  if (!el || !motif || !how || typeof (el as HTMLElement).animate !== 'function') return null;
  return (el as HTMLElement).animate(ENTER[motif](how.s) as Keyframe[], { duration: how.ms, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'backwards' });
}

/** Fades an element out, for a moment leaving. */
export function leave(el: Element | null, level: ThemeMotion, ms = 200): Animation | null {
  const how = strength(level, ms);
  if (!el || !how || typeof (el as HTMLElement).animate !== 'function') return null;
  return (el as HTMLElement).animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: `translateY(${-6 * how.s}px)` }] as Keyframe[], { duration: how.ms, easing: 'ease-in', fill: 'forwards' });
}
