/**
 * Whether the Agents panel is open beside a Toil project's screens (#552).
 * It starts closed at every width: a column of assignments, limits and
 * analyses is more than a first-time reader needs on every page, so it is one
 * button until someone asks for it. An open or closed choice is kept in this
 * browser (`toil-ui.agents-panel`), like the theme and motion, and read once
 * when the page starts. On a screen too narrow to sit beside the view the
 * panel is a drawer, which is only ever opened by pressing, so this choice
 * only decides the wide layout. Storage that refuses just means the choice
 * isn't remembered. A sidebar that waits to be asked, which is more than can
 * be said for most committees.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'toil-ui.agents-panel';

function remembered(): boolean {
  try {
    return localStorage.getItem(KEY) === 'open';
  } catch {
    return false;
  }
}

let open: boolean | null = null;
const listeners = new Set<() => void>();

const current = (): boolean => (open ??= remembered());

export function setAgentsPanelOpen(next: boolean) {
  open = next;
  try {
    localStorage.setItem(KEY, next ? 'open' : 'closed');
  } catch {
    // Not remembered; it still holds for this visit.
  }
  for (const l of listeners) l();
}

/** Forgets the cached choice, so the next read comes from storage again. For tests. */
export function resetAgentsPanel() {
  open = null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether the panel is open beside the view on a wide screen, and the setter. Closed until someone opens it. */
export function useAgentsPanelOpen(): [boolean, (open: boolean) => void] {
  return [useSyncExternalStore(subscribe, current, () => false), setAgentsPanelOpen];
}
