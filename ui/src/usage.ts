/**
 * The Usage page's model (#309): the calls it makes to `toil audit stats`
 * and `toil audit list`, and the small reshaping of their data it shows.
 * Plain functions of toil's output, kept apart from the page so the preview's
 * sample (src/fixtures/usage.ts) asks for exactly what the page asks for.
 * The reporting template was approved on the condition that it report nothing new.
 */

import type { UsageFigures, UsageGroup } from '../../src/audit/stats.ts';

/** One day's calls, for the chart. */
export interface DayCalls {
  /** The UTC date, `2026-10-18`. */
  day: string;
  calls: number;
  failed: number;
}

/** The audit summary's data, as the panel reads it. */
export interface UsageStats {
  window: { since: string; until: string | null };
  by: string[];
  totals: UsageFigures;
  groups: UsageGroup[];
}

/** The three summaries the panel asks for, each with `until` set to when the page opened (the preview answers these inputs whatever the `until`). */
export const USAGE_CALLS = {
  // Each cross-tabbed with the caller, so what Toil UI calls for itself can be left out of the figures people read (`ownGroups`).
  days: { by: ['day', 'caller'] },
  commands: { by: ['command', 'caller'] },
  doors: { by: ['via', 'caller'] },
} as const;

/** What Toil UI calls itself when it asks toil something: its own background reads are not the person's use of toil. */
export const TOIL_UI_CALLER = 'toil-ui';

/**
 * The groups without Toil UI's own calls, with the rest of each `dim` value
 * (one command, one day) added up across callers. The medians of merged groups
 * can't be added, so a merged group keeps the biggest part's: the page shows
 * time per front door, from the doors summary, not from these.
 */
export function ownGroups(groups: UsageGroup[], dim: 'command' | 'day'): UsageGroup[] {
  const merged = new Map<string, UsageGroup>();
  for (const g of groups) {
    if (g.caller === TOIL_UI_CALLER) continue;
    const key = g[dim] ?? '';
    const have = merged.get(key);
    if (!have) {
      merged.set(key, { ...g, caller: null });
      continue;
    }
    const errors = new Map<string, { code: string; count: number; fix: string | null }>();
    for (const e of [...have.errors, ...g.errors]) errors.set(e.code, { ...e, count: (errors.get(e.code)?.count ?? 0) + e.count });
    const calls = have.calls + g.calls;
    const writes = have.writes + g.writes;
    merged.set(key, {
      ...have,
      calls,
      ok: have.ok + g.ok,
      failed: have.failed + g.failed,
      writes,
      writeShare: Math.round((writes / calls) * 1000) / 1000,
      errors: [...errors.values()].sort((a, b) => b.count - a.count).slice(0, 3),
      durationMs: have.calls >= g.calls ? have.durationMs : g.durationMs,
      firstSeen: have.firstSeen < g.firstSeen ? have.firstSeen : g.firstSeen,
      lastSeen: have.lastSeen > g.lastSeen ? have.lastSeen : g.lastSeen,
    });
  }
  return [...merged.values()].sort((a, b) => b.calls - a.calls);
}

/** The figures a person reads first: calls, failures and writes, without Toil UI's own calls. */
export function ownTotals(doors: UsageGroup[]): { calls: number; failed: number; writes: number } {
  const own = doors.filter((g) => g.caller !== TOIL_UI_CALLER);
  return { calls: own.reduce((n, g) => n + g.calls, 0), failed: own.reduce((n, g) => n + g.failed, 0), writes: own.reduce((n, g) => n + g.writes, 0) };
}

/** A failing command's recent lines, newest first. */
export const failuresInput = (command: string) => ({ command, outcome: 'failed', limit: 10 });

/** Every day from the window's first to `today`, with the days nobody called toil as zero, so the chart doesn't skip them. */
export function fillDays(groups: UsageGroup[], since: string, today: string): DayCalls[] {
  const byDay = new Map(groups.map((g) => [g.day ?? '', g]));
  const out: DayCalls[] = [];
  const end = Date.parse(`${today}T00:00:00Z`);
  for (let t = Date.parse(`${since.slice(0, 10)}T00:00:00Z`); t <= end && out.length < 400; t += 86_400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const g = byDay.get(d);
    out.push({ day: d, calls: g?.calls ?? 0, failed: g?.failed ?? 0 });
  }
  return out;
}

/** A front door in a person's words: Toil UI is the API with the `toil-ui` caller. */
export function doorLabel(via: string | null | undefined, caller: string | null | undefined): string {
  if (via === 'api') return caller === TOIL_UI_CALLER ? "Toil UI itself (not counted above)" : caller ? `Another program, ${caller}` : 'Another program';
  if (via === 'mcp') return 'An AI assistant';
  if (via === 'cli') return 'A terminal';
  return via ?? 'Unknown';
}

/** The commands that failed, most failures first. */
export const failingMost = (groups: UsageGroup[]) => groups.filter((g) => g.failed > 0).sort((a, b) => b.failed - a.failed || b.calls - a.calls);

