/**
 * Who holds up whom (#394, #396): each open item that blocks another open
 * item, and everything waiting behind it, directly or down a chain. The
 * blocker Gantt reads it from here, so the chain it draws comes from one
 * reading of the same links. Read from each item's `blocked`
 * insight (src/model/insights.ts), so what counts as blocked is decided in
 * one place too. A dependency register, kept without a register.
 */

import { insights, type Prepared } from './insights.ts';

/** Each open blocker, with the open items it blocks directly, in the toil project's order. */
export function heldBy(p: Prepared): Map<string, string[]> {
  const held = new Map<string, string[]>();
  for (const item of p.items) {
    for (const i of insights(item, p)) {
      if (i.code !== 'blocked') continue;
      const by = /\[\[([^\]]+)\]\]/.exec(i.text)?.[1];
      if (by) held.set(by, [...(held.get(by) ?? []), item.id]);
    }
  }
  return held;
}

/** Everything that waits on `id`, directly or behind another blocked item, so the head of a chain counts its whole chain. A loop stops at what it has seen. */
export function behindAll(held: Map<string, string[]>, id: string, seen = new Set<string>()): Set<string> {
  for (const next of held.get(id) ?? []) if (!seen.has(next)) behindAll(held, next, seen.add(next));
  return seen;
}

/** The blockers, the one with most behind it first: then one that isn't itself blocked (the head of a chain before its middle), then by id. */
export function blockerOrder(held: Map<string, string[]>): Array<[string, string[]]> {
  const blocked = new Set([...held.values()].flat());
  return [...held.entries()].sort((a, b) => behindAll(held, b[0]).size - behindAll(held, a[0]).size || Number(blocked.has(a[0])) - Number(blocked.has(b[0])) || a[0].localeCompare(b[0]));
}
