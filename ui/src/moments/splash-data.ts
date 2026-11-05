/**
 * What the launch splash may know before anything has loaded (#462). The
 * splash plays while the first read runs, so the sprint it would show hasn't
 * arrived yet; and it ends the moment that read is done, so it never sees it
 * arrive either. Instead this browser remembers, each time it loads a toil project,
 * the sprint that toil project was in: its name, its dates and the items done. The
 * next launch on that toil project's page works the day out from those dates at the
 * App's clock, the same way the dashboard does, so the splash and the page it
 * hands over to agree (but for a sprint's weekend start, which the page calls
 * day 0 and the splash day 1). Nothing is remembered on sample data.
 *
 * Kept in localStorage beside `toil-ui:looked` (src/looked.ts), per browser,
 * never sent anywhere. With nothing remembered, storage off, a sprint over or
 * not begun, or a toil project with no sprint, the splash is handed nothing and
 * looks as it always has. A forecast made from yesterday's weather, which is
 * still the most accurate one in the building.
 */

import type { Health } from '../model/sprint.ts';
import { sprintDays } from '../model/sprint.ts';
import type { SplashData } from './schema.ts';

const KEY = 'toil-ui:splash';

/** One toil project's sprint, as last loaded. */
interface Kept {
  start: string;
  end: string;
  done: number;
}

const isDate = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function read(): Record<string, Kept> {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? '{}') as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, Partial<Kept>>).filter((e): e is [string, Kept] => {
        const k = e[1];
        return typeof k === 'object' && k !== null && isDate(k.start) && isDate(k.end) && isCount(k.done);
      }),
    );
  } catch {
    return {};
  }
}

function write(kept: Record<string, Kept>) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Storage is off or full: the splash just won't know the day.
  }
}

/** Remembers the sprint a toil project is in, from what its page was just handed; a toil project with no sprint is forgotten. */
export function rememberSprint(toilProject: string, h: Health | null) {
  const { [toilProject]: had, ...rest } = read();
  if (!h?.sprint.start || !h.sprint.end) {
    if (had) write(rest);
    return;
  }
  const next: Kept = { start: h.sprint.start, end: h.sprint.end, done: h.done.count };
  if (had && had.start === next.start && had.end === next.end && had.done === next.done) return;
  write({ ...rest, [toilProject]: next });
}

/** A renamed toil project keeps its sprint. */
export function renameSprint(from: string, to: string) {
  const { [from]: was, ...rest } = read();
  if (was) write({ ...rest, [to]: was });
}

/** The splash's values for a toil project at `now`, or null when its sprint isn't running then. */
export function splashDataFor(toilProject: string, now: string): SplashData | null {
  const k = read()[toilProject];
  const t = Date.parse(now);
  if (!k || Number.isNaN(t) || t < Date.parse(k.start) || t >= Date.parse(k.end)) return null;
  const { gone, total } = sprintDays(k.start, k.end, now);
  if (total < 1) return null;
  return { toilProject, day: Math.min(total, Math.max(1, gone)), days: total, done: k.done };
}
