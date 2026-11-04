/**
 * The Agent, server side (#206, Reasoning on the subscription you already
 * have). The browser's `Agent` (src/agent.ts) becomes an HTTP call to this
 * one, which takes the viewer from the request, so the adapters #251 adds
 * (Claude, Copilot, Codex) run on the server with the viewer's own
 * subscription and never in the page. It answers and cites; it never writes.
 * Beside the adapters (server/agents/host.ts, #251) sit the scripted Agent
 * the preview uses, for `--sample`, and `noAgent`, which says plainly that no
 * adapter is set up and names the three. A help desk that opens on schedule
 * and admits when nobody is in.
 */

import { NO_AGENT_DETAILS, NO_AGENT_FIX, NO_AGENT_NOTICE as NO_AGENT, type AdapterList, type Answer, type AskExtra, type Starter } from '../src/agent.ts';
import { SAMPLE_ADAPTERS, scriptedAgent } from '../src/fixtures/agent.ts';
import { AgentError } from './agents/cli.ts';
import type { RequestContext } from './context.ts';
import type { StyleChoice } from './agents/voices.ts';
import type { ChatTurn } from '../src/model-usage.ts';
import type { ChatSession } from '../src/fingerprint.ts';

export type { Answer, Starter } from '../src/agent.ts';

export interface Agent {
  /** `scripted`, `none`, and later the adapter's name: shown in the session. */
  readonly kind: string;
  /** The questions offered about one dossier before anyone types. */
  starters(ctx: RequestContext, dossier: string): Promise<Starter[]>;
  /** Answers about the named dossier only, citing every item it used. Throws with a message the pane shows. */
  ask(ctx: RequestContext, dossier: string, prompt: string, style?: StyleChoice | null, chat?: ChatTurn, extra?: AskExtra): Promise<Answer>;
  /** The same answer as it grows, each value the whole answer so far (#251). Optional; the server falls back to `ask`. */
  stream?(ctx: RequestContext, dossier: string, prompt: string, style?: StyleChoice | null, chat?: ChatTurn, extra?: AskExtra): AsyncIterable<Answer>;
  /** The adapters a chat can switch between (#344). */
  adapterOptions?(): AdapterList;
  /** What a chat started on, checked now (#305); null for a chat that hasn't asked. Absent: chats record nothing. */
  session?(chat: string): Promise<ChatSession | null>;
  /** Records what a chat starts on now (#305); refused while it answers. */
  renew?(chat: string, dossier: string): Promise<ChatSession>;
}

/** The preview's scripted Agent: canned answers about the sample dossiers. */
export function fixtureAgent(): Agent {
  const scripted = scriptedAgent();
  return {
    kind: 'scripted',
    starters: async (_ctx, dossier) => scripted.starters(dossier),
    ask: (_ctx, dossier, prompt, style, chat) => scripted.ask(dossier, prompt, style ?? undefined, chat),
    adapterOptions: () => SAMPLE_ADAPTERS,
  };
}

/** No adapter chosen: no starters, and a question gets a plain answer naming the three adapters. */
export function noAgent(): Agent {
  return {
    kind: 'none',
    starters: async () => [],
    ask: async () => {
      throw new AgentError(NO_AGENT, `${NO_AGENT_DETAILS} ${NO_AGENT_FIX}`);
    },
  };
}
