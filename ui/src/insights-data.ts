/**
 * The hooks under the Summary's charts, the Work mix item and the filter bar (#567):
 * `useWorkInsights()` is the pivot data layer for the toil project on screen,
 * built once per project and clock and shared by every view that draws a chart,
 * and `useAddress()` is the address bar's query, live, with the filters read
 * from it. Both are thin: the work is in model/work-insights.ts and filters.ts,
 * which have tests that do not need a browser. The memo is a WeakMap keyed on
 * the loaded project, which is the closest thing to a records office this
 * building has.
 *
 * `?lens=<scheme>` in the address (the Work mix's "Sort by", #657) views the
 * work by another built-in scheme, worked out on the fly by the same pure
 * engine from its rules and the labels already on the items. It saves nothing
 * and reads no one's say, which belongs to the saved scheme's categories; the
 * saved choice stays in Settings. Read from the address itself, so the drawer
 * behind a segment counts the same way as the chart that opened it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { BUILTIN_NAMES, builtinScheme } from '../../src/core/classify/builtin.ts';
import { DEFAULT_SCHEME } from '../../src/core/classify/types.ts';
import { splitHash, withQuery } from './address.ts';
import { useData } from './data.ts';
import { parseFilters, type Filters } from './filters.ts';
import { personOf } from './model/classify.ts';
import { buildInsights, type WorkInsights } from './model/work-insights.ts';
import type { ToilProjectData } from './load.ts';

const built = new WeakMap<ToilProjectData, Map<string, WorkInsights>>();

/** The built-in scheme the address asks to view by (`?lens=`), when it is one and isn't the scheme in use; else null. */
export function lensOf(asked: string | null, inUse: string): string | null {
  return asked && asked !== inUse && BUILTIN_NAMES.includes(asked) ? asked : null;
}

/** The lens in the address bar now. Read at render, so every view of one address agrees. */
const lensInAddress = (): string | null => (typeof window === 'undefined' ? null : splitHash(window.location.hash).query.get('lens'));

/** The name of the scheme the toil project sorts by: the one toil resolved, else the one it names, else the default. */
export const schemeInUse = (named: string | null | undefined, resolved: string | null | undefined): string => resolved ?? named ?? DEFAULT_SCHEME;

/** The pivot data layer for the toil project on screen, at the clock the app reads figures at. */
export function useWorkInsights(): WorkInsights {
  const { toilProject, now, classification } = useData();
  // The scheme toil resolved and each item's standing say from the ledger, once read; the version keys the memo so a new word reclassifies.
  const view = classification?.view ?? null;
  const lens = lensOf(lensInAddress(), schemeInUse(toilProject.classifyScheme, view?.scheme.name));
  const key = `${now}|${classification?.version ?? 0}|${lens ?? ''}`;
  let byNow = built.get(toilProject);
  if (!byNow) built.set(toilProject, (byNow = new Map()));
  let ins = byNow.get(key);
  if (!ins) byNow.set(key, (ins = lens && builtinScheme(lens) ? buildInsights(toilProject, now, lens) : buildInsights(toilProject, now, toilProject.classifyScheme, view ? { scheme: view.scheme, person: personOf(view.standing) } : {})));
  return ins;
}

export interface Address {
  query: URLSearchParams;
  filters: Filters;
  /** Changes the address's query by `edit`, as a new history entry, so Back undoes it. */
  go: (edit: (query: URLSearchParams) => void) => void;
  /** The current hash with its query changed by `edit`, for a link. */
  hrefWith: (edit: (query: URLSearchParams) => void) => string;
}

/** The address bar's query and the filters in it, kept current as the hash changes. */
export function useAddress(): Address {
  const [hash, setHash] = useState(() => (typeof window === 'undefined' ? '#/' : window.location.hash));
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    on();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const query = useMemo(() => splitHash(hash).query, [hash]);
  const filters = useMemo(() => parseFilters(query), [query]);
  const go = useCallback((edit: (q: URLSearchParams) => void) => {
    window.location.hash = withQuery(window.location.hash, edit);
  }, []);
  const hrefWith = useCallback((edit: (q: URLSearchParams) => void) => withQuery(hash, edit), [hash]);
  return { query, filters, go, hrefWith };
}
