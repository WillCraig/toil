/**
 * Which facts fire a moment (#419), and how several become a few. The facts
 * come from one place: the worklog's record of what a sync saw
 * (src/model/worklog.ts, `eventsFrom` and `observedEvents`), and only those a
 * sync recorded for the first time (ui/server/cache.ts, `saveToilProject`). So a
 * moment fires once, for a change that happened, and never from a second
 * detector of its own. Pure, so the tests drive it.
 * Each milestone gets one round of applause, and the applause is minuted.
 */

import type { WorklogEvent } from '../model/worklog.ts';
import type { Moment } from './Moments.tsx';
import { MOMENT_KINDS, type MomentKind } from './schema.ts';

/** What a fact is as a moment, or null for one that plays nothing (an opened pull request, a review, a sprint change). */
export function kindOf(e: Pick<WorklogEvent, 'kind' | 'toCategory'>): MomentKind | null {
  switch (e.kind) {
    case 'status':
      return e.toCategory === 'DONE' ? 'item-done' : null;
    case 'build-passed':
    case 'build-recovered':
      return 'build-passed';
    case 'build-failed':
      return 'build-failed';
    case 'blocker-cleared':
      return 'blocker-cleared';
    case 'pr-merged':
      return 'pr-merged';
    case 'sprint-ended':
      return 'sprint-ended';
    default:
      return null;
  }
}

/** Which plays first when a sync brings several: the sprint's end, then what needs a look, then good news. */
const RANK: Record<MomentKind, number> = { 'sprint-ended': 0, 'build-failed': 1, 'blocker-cleared': 2, 'pr-merged': 3, 'item-done': 4, 'build-passed': 5 };

/** The most moments one sync plays: past that, a burst of applause is noise. */
export const MAX_MOMENTS = 3;

/** One line for a fact, in plain words: its label and title, as the worklog names it. */
const lineOf = (e: WorklogEvent) => `${e.label}${e.title && !e.title.startsWith('for [[') ? ` ${e.title}` : ''}`;

/**
 * The moments for the facts a sync recorded for the first time: one per kind,
 * standing for every fact of that kind, the most important kinds first, at
 * most three. The sprint recap carries its figures from the fact's own text.
 */
export function momentsFor(events: readonly WorklogEvent[]): Moment[] {
  const byKind = new Map<MomentKind, WorklogEvent[]>();
  for (const e of events) {
    const kind = kindOf(e);
    if (!kind) continue;
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(e);
  }
  return [...byKind.entries()]
    .sort((a, b) => RANK[a[0]] - RANK[b[0]])
    .slice(0, MAX_MOMENTS)
    .map(([kind, list]) => {
      const first = list[0]!;
      if (kind === 'sprint-ended') return { kind, text: first.label, count: 1, figures: first.text.replace(/^ended: /, '').split(', ').filter(Boolean) };
      return { kind, text: list.length > 1 ? `${lineOf(first)}, and ${list.length - 1} more` : lineOf(first), count: list.length };
    });
}

/** A sample moment of each kind, for the preview under Settings and the layout check. */
export const SAMPLE_MOMENTS: Record<MomentKind, Moment> = {
  'item-done': { kind: 'item-done', text: 'PAY-102 Store tokens in the vault', count: 1 },
  'build-passed': { kind: 'build-passed', text: 'payments-web #52 build', count: 1 },
  'build-failed': { kind: 'build-failed', text: 'payments-web #49 build', count: 1 },
  'blocker-cleared': { kind: 'blocker-cleared', text: 'PAY-104 Retry failed captures', count: 1 },
  'pr-merged': { kind: 'pr-merged', text: 'payments-web #52 Vault-backed token store', count: 1 },
  'sprint-ended': { kind: 'sprint-ended', text: 'Sprint 42', count: 1, figures: ['8 of 11 items done', '21 of 30 points done', '2 carried over'] },
};

export { MOMENT_KINDS };
