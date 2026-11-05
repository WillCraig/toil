/**
 * What the command palette (#416) asks of a view that owns the thing it acts
 * on: the Ask bar focuses itself, runs Analyze or answers with another agent,
 * a dossier's page opens the Assign dialog for an item, and its frame opens the Agents panel. The palette sits
 * above every view, so it can't call into one directly; it sends the request
 * here and the view that is showing picks it up. Nothing is queued: a request
 * no view is listening for is dropped, which is why the palette offers these
 * only on a dossier's pages. An internal memo, routed to whoever is at their desk.
 */

import { useEffect, useRef } from 'react';

export type UiCommand = { kind: 'ask' } | { kind: 'analyze' } | { kind: 'agents' } | { kind: 'assign'; id: string } | { kind: 'agent'; name: string | null; label: string }
  /** A workflow job (#532): its prompt (`job:review:<change id>`) and what the chat shows for it. */
  | { kind: 'job'; prompt: string; label: string };

const bus = new EventTarget();

export function sendCommand(command: UiCommand): void {
  bus.dispatchEvent(new CustomEvent<UiCommand>('command', { detail: command }));
}

/** Calls `handle` for every command sent while the component is mounted. */
export function useUiCommand(handle: (command: UiCommand) => void): void {
  const latest = useRef(handle);
  useEffect(() => {
    latest.current = handle;
  });
  useEffect(() => {
    const on = (e: Event) => latest.current((e as CustomEvent<UiCommand>).detail);
    bus.addEventListener('command', on);
    return () => bus.removeEventListener('command', on);
  }, []);
}
