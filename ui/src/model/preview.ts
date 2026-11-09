/**
 * What a toil project's card on the Toil projects view says about the work (#342), from
 * the same data its dashboard reads (src/load.ts), which the local app answers
 * from the cache: no tracker is asked. Its sprint with the days left and a
 * small burn-up, how many items are in progress and blocked, how many pull
 * requests wait on a review, who is on it, and what changed since this
 * browser last opened its dashboard. The dashboard's header shows the same
 * counts, so the two can't disagree. A status report that writes itself, and
 * is therefore read.
 */

import type { ToilProjectData } from '../load.ts';
import type { WorkItem } from '../toil.ts';
import { burnup } from './burnup.ts';
import { doneAt } from './flow.ts';
import { people } from './people.ts';
import { waitOf } from './prs.ts';
import { daysLeft, health } from './sprint.ts';

export interface PreviewSprint {
  name: string;
  /** Working days left, and in the sprint. */
  daysLeft: number;
  daysTotal: number;
  /** Points done and in scope now. */
  done: number;
  scope: number;
  /** Each day's scope and done points, for the small burn-up. */
  burn: Array<{ scope: number; done: number }>;
  /** Calendar days still to come after the last one in `burn`, so the burn-up keeps room for them. */
  ahead: number;
}

export interface PreviewPerson {
  key: string;
  name: string;
  kind: 'human' | 'agent';
}

/** How many days the card's small trends cover. */
export const TREND_DAYS = 7;

/** Items closed and pull requests merged each day, oldest first, today last. A series is null where nothing it counts was read (principle 12): no work items, or no pull requests, is unknown, not zero. */
export interface PreviewTrend {
  closed: number[] | null;
  merged: number[] | null;
}

export interface ToilProjectPreview {
  sprint: PreviewSprint | null;
  /** The past week, a day at a time, whether or not the toil project runs sprints. */
  trend: PreviewTrend;
  inProgress: number;
  blocked: number;
  /** Open pull requests waiting on a review. */
  awaitingReview: number;
  /** Everyone with work on it, the toil project's own people first. */
  people: PreviewPerson[];
  /** Work items and pull requests updated after `since`; null when this browser never opened the dashboard. */
  changedSince: number | null;
  /** In progress, blocked and waiting on review, together: how much is in motion. */
  motion: number;
}

const isDone = (i: WorkItem) => i.statusCategory === 'DONE';

/** Blocked: not done, and an item it names as blocking it isn't done either. */
export function isBlocked(item: WorkItem, byId: Map<string, WorkItem>): boolean {
  if (isDone(item)) return false;
  return item.links.some((l) => l.type === 'blocks' && l.direction === 'inward' && byId.has(l.target) && !isDone(byId.get(l.target)!));
}

const DAY = 86_400_000;

/** Counts the timestamps that fall on each of the `days` UTC days ending with `now`'s. */
export function perDay(stamps: Array<string | null | undefined>, now: string, days = TREND_DAYS): number[] {
  const end = Date.parse(now.slice(0, 10) + 'T00:00:00Z');
  const out = new Array<number>(days).fill(0);
  for (const s of stamps) {
    if (!s) continue;
    const t = Date.parse(s.slice(0, 10) + 'T00:00:00Z');
    if (Number.isNaN(t)) continue;
    const back = Math.round((end - t) / DAY);
    if (back >= 0 && back < days) out[days - 1 - back]!++;
  }
  return out;
}

export function previewOf(d: ToilProjectData, now: string, since: string | null): ToilProjectPreview {
  const byId = new Map(d.items.map((i) => [i.id, i]));
  const h = health(d.items, d.changes, now);
  let sprint: PreviewSprint | null = null;
  if (h) {
    const b = burnup(h, now);
    sprint = {
      name: h.sprint.name,
      daysLeft: daysLeft(h.days),
      daysTotal: h.days.total,
      done: h.done.points,
      scope: h.done.points + h.remaining.points,
      burn: b.days.map((x) => ({ scope: x.scope, done: x.done })),
      ahead: b.ahead,
    };
  }
  const prs = d.pullRequests ?? [];
  const inProgress = d.items.filter((i) => i.statusCategory === 'IN_PROGRESS').length;
  const blocked = d.items.filter((i) => isBlocked(i, byId)).length;
  const awaitingReview = prs.filter((c) => c.state === 'OPEN' && waitOf(c, now).on === 'review').length;
  const view = people({ toilProject: d.name, entries: d.people ?? [], wipLimit: d.wipLimit ?? null, items: d.items, changes: prs, now });
  const who = [...view.people, ...view.unmapped].map((c) => ({ key: c.who.key, name: c.who.name, kind: c.who.kind }));
  const changedSince = since === null ? null : d.items.filter((i) => i.updated !== null && i.updated > since).length + prs.filter((c) => c.updated !== null && c.updated > since).length;
  const closed = d.items.length > 0 ? perDay(d.items.filter(isDone).map((i) => doneAt(i) ?? i.resolved), now) : null;
  const merged = prs.length > 0 ? perDay(prs.filter((c) => c.state === 'MERGED').map((c) => c.mergedAt), now) : null;
  return { sprint, trend: { closed, merged }, inProgress, blocked, awaitingReview, people: who, changedSince, motion: inProgress + blocked + awaitingReview };
}
