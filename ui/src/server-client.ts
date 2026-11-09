/**
 * The page's side of the local server's API (ui/server/server.ts). The App is
 * built on two seams, `execute()` and the `Agent`; here each is an HTTP call to
 * the server, which hands it to the Store or Agent chosen at startup. Paths are
 * relative to the page, so the app works under any base path, and nothing
 * here assumes the server is on the same machine (#206, Hosting-ready by
 * design).
 *
 * There is no sign-in and the page keeps no credential (#561): the browser was let
 * in by the cookie the server set when it loaded the page, an HttpOnly cookie
 * the page can't read and the browser sends with each call. `readServerInfo()`
 * asks the server what it is, once, at load.
 */

import { NO_AGENT_DETAILS, NO_AGENT_FIX, NO_AGENT_NOTICE, SCRIPTED_LABEL, type AdapterList, type Agent, type Answer, type AskExtra, type AskStyle, type Starter } from './agent.ts';
import type { AreaInfo, ConfigApi, SettingsInfo } from './config.ts';
import { GUIDE_REFUSAL, GUIDE_REFUSAL_FIX, looksLikeSecret } from './guide.ts';
import { FEEDBACK_SAMPLE_DISABLED, type FeedbackApi, type FeedbackFields } from './feedback.ts';
import type { SyncStatus } from '../server/sync.ts';
import type { Envelope, Execute } from './toil.ts';
import type { ChatSession, ServerStatus } from './fingerprint.ts';
import type { AnalysesApi } from './analyses.ts';
import type { AnalysisSummary, AnalysisView } from './model/analysis.ts';
import { WORKLOG_SAMPLE_DISABLED, type WorklogApi, type WorklogDay, type WorklogExport, type WorklogMonth, type WorklogRebuilt, type WorklogStandup } from './worklog.ts';

export type { ToilProjectState, SourceState } from '../server/cache.ts';
export type { SyncJob, SyncStatus } from '../server/sync.ts';
import type { AdapterStatus, AgentStatus } from '../server/agents/host.ts';
import type { InstallPlan } from '../server/agents/install.ts';
import type { AnswerUsage, ModelUsageApi, UsageView } from './model-usage.ts';
export type { ModelUsageApi, UsageView } from './model-usage.ts';
import type { AgentSettings } from '../server/agents/settings.ts';
export type { AdapterStatus, AgentStatus } from '../server/agents/host.ts';
export type { InstallPlan } from '../server/agents/install.ts';
export type { AgentSettings } from '../server/agents/settings.ts';

/** What the server says about itself: its versions, store and agent, and what it can do. Nothing in it is a credential. */
export interface ServerInfo {
  version: string;
  toil: { version: string; contractVersion: number };
  viewer: { id: string; name: string };
  store: string;
  /** The server keeps a cache and syncs it (#250); false with sample data. */
  sync: boolean;
  agent: string;
  /** The agent can be chosen in Settings (#251); false with sample data. */
  agentSettings?: boolean;
  /** The server assigns work items to an agent (#293). */
  assignments?: boolean;
  sample: boolean;
  now: string;
}

/** An agent's failure as the page has it: the message, and what the run used before it ended (#295). */
export class AnswerError extends Error {
  constructor(
    message: string,
    readonly usage?: AnswerUsage,
  ) {
    super(message);
  }
}

/** The server's error body, as a message the page can show. */
async function failure(res: Response, what: string): Promise<Error> {
  try {
    const body = (await res.json()) as { error?: { message?: string; fix?: string; usage?: AnswerUsage } };
    if (body.error?.message) return new AnswerError(`${body.error.message}${body.error.fix ? ` ${body.error.fix}` : ''}`, body.error.usage);
  } catch {
    // Not JSON: fall through to the status.
  }
  return new Error(`${what} failed: the server answered ${res.status}.`);
}

/** Asks the server about itself. A refusal (a Host or Origin it won't answer) is shown with its fix. */
export async function readServerInfo(base = './'): Promise<ServerInfo> {
  const res = await fetch(`${base}api/info`, { credentials: 'same-origin' });
  if (!res.ok) throw await failure(res, 'Reading what the server is');
  return (await res.json()) as ServerInfo;
}

const call = (base: string, path: string, init: { body?: unknown; signal?: AbortSignal } = {}) =>
  fetch(`${base}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    ...(init.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }),
    signal: init.signal,
  });

const isEnvelope = (v: unknown): v is Envelope => typeof v === 'object' && v !== null && 'ok' in v && 'meta' in v;

/**
 * `execute()` over the server. The server decides what the call may do (reads
 * only, always read-only), so the options' `readOnly` and `caller` aren't
 * sent: the page can't loosen them. A refusal is toil's own envelope, shown on
 * its panel like any failed call.
 */
export function httpExecute(base = './'): Execute {
  return async (command, input = {}, options = {}) => {
    const res = await call(base, 'api/execute', { body: { command, input }, signal: options.signal });
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      body = undefined;
    }
    if (isEnvelope(body)) return body;
    throw await failure(res, "Asking the server");
  };
}

/** The sync job over the server (#250): its status, a start, and the wipe. Each throws with the server's message. */
export interface SyncClient {
  status(): Promise<SyncStatus>;
  /** Every toil project, or the one named. */
  start(toilProject?: string): Promise<SyncStatus>;
  wipe(): Promise<SyncStatus>;
}

export function httpSync(base = './'): SyncClient {
  const answer = async (res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as SyncStatus;
  };
  return {
    status: async () => answer(await call(base, 'api/sync'), 'Reading the sync status'),
    start: async (toilProject) => answer(await call(base, 'api/sync', { body: toilProject === undefined ? {} : { toilProject } }), 'Starting the sync'),
    wipe: async () => answer(await call(base, 'api/cache/wipe', { body: { confirm: 'wipe' } }), 'Wiping the cache'),
  };
}

/**
 * The settings pages' calls (src/config.ts) over the server's `/api/config`.
 * The server decides which commands run and how; the page sends the command,
 * its input, and what the person typed for its questions. A secret travels in
 * this one request body and is not kept here after it.
 */
export function httpConfig(base = './'): ConfigApi {
  const get = async <T,>(path: string): Promise<T> => {
    const res = await call(base, path);
    if (!res.ok) throw await failure(res, path);
    return (await res.json()) as T;
  };
  return {
    disabled: null,
    areas: () => get<AreaInfo[]>('api/config/areas'),
    settings: () => get<SettingsInfo>('api/config/settings'),
    async run(command, input, answers = {}) {
      const res = await call(base, 'api/config', { body: { command, input, ...answers } });
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        body = undefined;
      }
      if (isEnvelope(body)) return body;
      throw await failure(res, "Asking the server");
    },
  };
}

/**
 * `toil feedback` over the server's `api/feedback` (#265). A preview sends the
 * fields alone, and the server runs the command read-only; a send adds
 * `consent: true`, which the dialog passes only while its box is ticked for
 * the report on screen, and the server answers the command's consent
 * question with it. With sample data the server refuses to send.
 */
export function httpFeedback(info: ServerInfo, base = './'): FeedbackApi {
  const run = async (fields: FeedbackFields, consent: boolean, signal?: AbortSignal): Promise<Envelope> => {
    const res = await call(base, 'api/feedback', { body: { fields, ...(consent ? { consent: true } : {}) }, ...(signal ? { signal } : {}) });
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      body = undefined;
    }
    if (isEnvelope(body)) return body;
    throw await failure(res, 'Sending the feedback');
  };
  return {
    disabled: info.sample ? FEEDBACK_SAMPLE_DISABLED : null,
    preview: (fields, signal) => run(fields, false, signal),
    send: (fields) => run(fields, true),
  };
}

/** Who answers, by the session's agent kind, for the Ask pane's info (#283). */
export const AGENT_LABEL: Record<string, string> = {
  claude: 'Claude, through the Claude Agent SDK',
  copilot: 'GitHub Copilot, through the Copilot SDK',
  codex: 'Codex, through the Codex SDK',
  scripted: SCRIPTED_LABEL,
  none: 'nobody yet: no agent is set up',
};

/**
 * The Agent over the server. The App asks for starters while it renders, so
 * they're fetched for each toil project before it mounts.
 */
export async function httpAgent(info: ServerInfo, toilProjects: string[], base = './'): Promise<Agent> {
  const starters = new Map<string, Starter[]>();
  // Fetched with no adapter chosen too: a chat can switch to one (#344).
  for (const name of toilProjects) {
    const res = await call(base, `api/agent/starters?toilProject=${encodeURIComponent(name)}`);
    starters.set(name, res.ok ? ((await res.json()) as Starter[]) : []);
  }
  return {
    ...(info.agent === 'none' ? { notice: NO_AGENT_NOTICE, noticeDetails: `${NO_AGENT_DETAILS} ${NO_AGENT_FIX}` } : {}),
    label: AGENT_LABEL[info.agent] ?? info.agent,
    starters: (toilProject) => starters.get(toilProject) ?? [],
    async adapters(toilProject) {
      const res = await call(base, `api/agent/adapters${toilProject ? `?toilProject=${encodeURIComponent(toilProject)}` : ''}`);
      if (!res.ok) throw await failure(res, 'Reading the agents');
      return (await res.json()) as AdapterList;
    },
    async ask(toilProject, prompt, style, chat, extra) {
      const res = await call(base, 'api/agent/ask', { body: { toilProject, prompt, ...style, ...(chat ? { chat } : {}), ...extraBody(extra) } });
      if (!res.ok) throw await failure(res, 'The question');
      return (await res.json()) as Answer;
    },
    async *stream(toilProject, prompt, signal, style, chat, extra) {
      const res = await call(base, 'api/agent/ask', { body: { toilProject, prompt, stream: true, ...style, ...(chat ? { chat } : {}), ...extraBody(extra) }, ...(signal ? { signal } : {}) });
      if (!res.ok) throw await failure(res, 'The question');
      if (!/^application\/x-ndjson/.test(res.headers.get('content-type') ?? '')) {
        yield (await res.json()) as Answer;
        return;
      }
      yield* answerLines(res);
    },
    async *guide(request, history, signal, style) {
      // The same refusal the page and the server make, once more at the door: a message that looks like a secret never becomes a request.
      if (looksLikeSecret(request.message)) throw new Error(`${GUIDE_REFUSAL} ${GUIDE_REFUSAL_FIX}`);
      const turns = (history ?? []).map(({ prompt, answer, by }) => ({ prompt, answer, ...(by ? { by } : {}) }));
      const res = await call(base, 'api/agent/guide', { body: { chat: request.chat, message: request.message, state: request.state, stream: true, ...style, ...(turns.length ? { history: turns } : {}) }, ...(signal ? { signal } : {}) });
      if (!res.ok) throw await failure(res, 'The question');
      yield* answerLines(res);
    },
    async session(chat) {
      const res = await call(base, `api/agent/session?chat=${encodeURIComponent(chat)}`);
      if (!res.ok) throw await failure(res, "Reading the chat's session");
      return (await res.json()) as ChatSession | null;
    },
    async renew(chat, toilProject) {
      const res = await call(base, 'api/agent/renew', { body: { chat, toilProject } });
      if (!res.ok) throw await failure(res, 'Renewing the chat');
      return (await res.json()) as ChatSession;
    },
  };
}

/** The server's own staleness (#305), for the header: null with sample data, or when it can't be read. */
export async function httpServerStatus(base = './'): Promise<ServerStatus | null> {
  const res = await call(base, 'api/fingerprint');
  if (!res.ok) throw await failure(res, "Reading the server's version");
  return (await res.json()) as ServerStatus | null;
}

/** A question's extra fields (#344), only those set, so a question with none sends what it always did. */
const extraBody = (extra: AskExtra | undefined) => ({ ...(extra?.adapter ? { adapter: extra.adapter } : {}), ...(extra?.fallback ? { fallback: true } : {}), ...(extra?.history?.length ? { history: extra.history } : {}) });

/** One streamed answer's NDJSON lines (server.ts, streamAnswer): each answer as it grows, then done or an error. */
export async function* answerLines(res: Response): AsyncIterable<Answer> {
  if (!res.body) throw new Error('The answer arrived with no body.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const line = (text: string): Answer | null => {
    const msg = JSON.parse(text) as { answer?: Answer; done?: boolean; error?: { message?: string; fix?: string; usage?: AnswerUsage } };
    if (msg.error) throw new AnswerError(`${msg.error.message ?? 'The agent failed.'}${msg.error.fix ? ` ${msg.error.fix}` : ''}`, msg.error.usage);
    if (msg.done) done = true;
    return msg.answer ?? null;
  };
  for (;;) {
    const { value, done: end } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!text) continue;
      const answer = line(text);
      if (answer) yield answer;
    }
    if (end) break;
  }
  if (buffer.trim()) {
    const answer = line(buffer.trim());
    if (answer) yield answer;
  }
  if (!done) throw new Error('The answer stopped partway: the connection to Toil UI closed.');
}

/** An install's NDJSON (server.ts, streamInstall): npm's lines, then the adapter's status or an error. */
export async function installLines(res: Response, onLine: (line: string) => void): Promise<AdapterStatus> {
  if (!res.body) throw new Error('The install answered with no body.');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let status: AdapterStatus | null = null;
  const take = (text: string) => {
    const msg = JSON.parse(text) as { line?: string; done?: boolean; status?: AdapterStatus; error?: { message?: string; fix?: string } };
    if (msg.error) throw new Error(`${msg.error.message ?? 'The install failed.'}${msg.error.fix ? ` ${msg.error.fix}` : ''}`);
    if (typeof msg.line === 'string') onLine(msg.line);
    if (msg.done && msg.status) status = msg.status;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const text = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (text) take(text);
    }
    if (done) break;
  }
  if (buffer.trim()) take(buffer.trim());
  if (!status) throw new Error('The install stopped partway: the connection to Toil UI closed.');
  return status;
}

/** What Settings shows and changes about the agent (#251): server/agents/host.ts's status. */
export interface AgentSettingsClient {
  status(): Promise<AgentStatus>;
  save(settings: AgentSettings): Promise<AgentStatus>;
  /** The system prompt a question about the toil project would get now, in this style, with the saved instructions (#283). */
  prompt(toilProject: string | undefined, style: AskStyle): Promise<string>;
  /** The one command Install would run for an adapter (#344), to show before it runs. */
  installPlan(adapter: string): Promise<InstallPlan>;
  /** Runs it, as shown: npm's output a line at a time, then the adapter's new status. Throws npm's own words and the fix. */
  install(adapter: string, command: string, onLine: (line: string) => void, signal?: AbortSignal): Promise<AdapterStatus>;
  /** Writes registry=<url> to the person's user npmrc, for an organization's own npm registry; what the file said before comes back. */
  setRegistry?(registry: string): Promise<{ file: string; registry: string; previous: string | null }>;
}

export function httpAgentSettings(base = './'): AgentSettingsClient {
  const answer = async (res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as AgentStatus;
  };
  return {
    status: async () => answer(await call(base, 'api/agent/settings'), 'Reading the agent settings'),
    save: async (settings) => answer(await call(base, 'api/agent/settings', { body: settings }), 'Saving the agent settings'),
    async prompt(toilProject, style) {
      const query = new URLSearchParams({ ...(toilProject ? { toilProject } : {}), theme: style.theme, voice: style.voice ? 'on' : 'off' });
      const res = await call(base, `api/agent/prompt?${query}`);
      if (!res.ok) throw await failure(res, 'Reading the full prompt');
      return ((await res.json()) as { prompt: string }).prompt;
    },
    async installPlan(adapter) {
      const res = await call(base, `api/agent/install?adapter=${encodeURIComponent(adapter)}`);
      if (!res.ok) throw await failure(res, 'Reading the install command');
      return (await res.json()) as InstallPlan;
    },
    async install(adapter, command, onLine, signal) {
      const res = await call(base, 'api/agent/install', { body: { adapter, command }, ...(signal ? { signal } : {}) });
      if (!res.ok) throw await failure(res, 'The install');
      return installLines(res, onLine);
    },
    async setRegistry(registry) {
      const res = await call(base, 'api/agent/npm-registry', { body: { registry } });
      if (!res.ok) throw await failure(res, 'Saving the registry');
      return (await res.json()) as { file: string; registry: string; previous: string | null };
    },
  };
}

/**
 * The worklog over the server (#308): its calendar and pages, and the three
 * presses that change anything (rebuild, a note, an export). With sample
 * data the server answers from the sample and refuses notes and exports.
 */
export function httpWorklog(info: ServerInfo, base = './'): WorklogApi {
  const answer = async <T,>(res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as T;
  };
  const q = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return {
    disabled: info.sample ? WORKLOG_SAMPLE_DISABLED : null,
    month: async (toilProject, month) => answer<WorklogMonth>(await call(base, `api/worklog/month?${q({ toilProject, month })}`), 'Reading the worklog'),
    day: async (toilProject, day) => answer<WorklogDay>(await call(base, `api/worklog/day?${q({ toilProject, day })}`), 'Reading the page'),
    rebuild: async (toilProject, day) => answer<WorklogRebuilt>(await call(base, 'api/worklog/rebuild', { body: { toilProject, day } }), 'Rebuilding the page'),
    addNote: async (toilProject, text) => answer<WorklogDay>(await call(base, 'api/worklog/note', { body: { toilProject, text } }), 'Adding the note'),
    exportTo: async (toilProject, what, folder) => answer<WorklogExport>(await call(base, 'api/worklog/export', { body: { toilProject, ...what, folder } }), 'The export'),
    standup: async (toilProject, from, to) => answer<WorklogStandup>(await call(base, `api/worklog/standup?${q({ toilProject, from, to })}`), 'Building the stand-up'),
  };
}

/**
 * The agent's model usage over the server (#295): the last 30 days' records,
 * which the page adds up with the meter's one function, and the caps and
 * Codex rates. Each throws with the server's message.
 */
export function httpModelUsage(base = './'): ModelUsageApi {
  const answer = async (res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as UsageView;
  };
  return {
    view: async () => answer(await call(base, 'api/usage'), 'Reading the model usage'),
    save: async (settings) => answer(await call(base, 'api/usage/settings', { body: settings }), 'Saving the caps'),
  };
}

/**
 * The history of analyses over the server (#395): read only. The server
 * keeps each Analyze itself as its answer ends, so this client has no
 * `record`. One the history no longer holds comes back as null.
 */
export function httpAnalyses(base = './'): AnalysesApi {
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  return {
    list: async (toilProject) => {
      const res = await call(base, `api/analyses?${q({ toilProject })}`);
      if (!res.ok) throw await failure(res, 'Reading the analyses');
      return (await res.json()) as AnalysisSummary[];
    },
    get: async (toilProject, id) => {
      const res = await call(base, `api/analyses/one?${q({ toilProject, id })}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'Reading the analysis');
      return (await res.json()) as AnalysisView;
    },
  };
}
