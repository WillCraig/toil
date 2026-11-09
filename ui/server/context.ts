/**
 * Who a request is for (#206, Hosting-ready by design). Every request the
 * server answers carries a `RequestContext`, and everything behind it (the
 * Store, the Agent) takes the viewer from there, never from a process global.
 * In v1 the viewer is always the person who started `toil-ui`, behind the
 * loopback-only server; real viewers arrive later as a new auth layer in front of this
 * type, not as a rewrite of what sits behind it. A visitor badge, issued to
 * the only person in the building.
 */

import { userInfo } from 'node:os';

export interface Viewer {
  /** Stable for the life of the viewer: `local` in v1. */
  id: string;
  /** How a view names them. */
  name: string;
  /** How they got in: from this machine, over loopback, in v1. */
  via: 'loopback';
}

export interface RequestContext {
  viewer: Viewer;
  /** Aborted when the browser goes away, so a slow call stops with it. */
  signal: AbortSignal;
}

/** The one v1 viewer: the OS account that started the server. */
export function localViewer(): Viewer {
  let name = 'you';
  try {
    name = userInfo().username || name;
  } catch {
    // Some containers have no passwd entry for the uid. The name is for display only.
  }
  return { id: 'local', name, via: 'loopback' };
}
