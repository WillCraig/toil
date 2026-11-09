/**
 * Which agent the chat answers with when nobody has picked one in it (#494):
 * the one last used for this toil project, if it can still answer; else the default
 * from Settings, AI agent, if it can; else the first agent that is ready; else
 * nothing, which is the old behaviour (the server tries Settings' choice and
 * says why it can't). Pure, so the order is tested without a page. Seating by
 * precedent, then by policy, then by whoever turned up.
 */

import type { AdapterList } from './agent.ts';

export type DefaultSource = 'toilProject' | 'settings' | 'ready';

export interface DefaultAgent {
  name: string;
  source: DefaultSource;
  /** Only on 'ready': Settings names an agent, and it can't answer, which the hint says. */
  skippedDefault?: boolean;
}

/** The adapter an unpicked chat uses, and where that came from; null when neither is ready. */
export function defaultAgent(list: AdapterList | null): DefaultAgent | null {
  if (!list) return null;
  const ready = (name: string | null | undefined) => (name ? list.options.some((o) => o.name === name && o.ready) : false);
  if (list.remembered && ready(list.remembered)) return { name: list.remembered, source: 'toilProject' };
  if (list.chosen && ready(list.chosen)) return { name: list.chosen, source: 'settings' };
  const first = list.options.find((o) => o.ready);
  if (first) return { name: first.name, source: 'ready', ...(list.chosen ? { skippedDefault: true } : {}) };
  return null;
}

/** The few words beside "Answered by": where the agent in front of the person came from. */
export function sourceHint(picked: boolean, from: DefaultAgent | null): string | null {
  if (picked) return 'picked for this chat';
  if (!from) return null;
  if (from.source === 'toilProject') return 'last used on this Toil project';
  if (from.source === 'ready') return from.skippedDefault ? "your default can't run" : 'the first one ready';
  return 'your default';
}
