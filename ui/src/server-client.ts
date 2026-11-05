/**
 * The page's side of the local server's API (ui/server/server.ts). The App is
 * built on two seams, `execute()` and the `Agent`; here each is an HTTP call to
 * the server, which hands it to the Store or Agent chosen at startup. Paths are
 * relative to the page, so the app works under any base path, and nothing
 * here assumes the server is on the same machine (#206, Hosting-ready by
 * design).
 *
 * The page signs in by trading the launch token in its URL for a session id,
 * and sends it as `X-Toil-UI-Session` on every call, with the session's CSRF
 * token on every POST. The id is kept in `sessionStorage`, so a reload signs
 * straight back in (#485); the server hands the CSRF token out again on resume.
 *
 * Why `sessionStorage` and not a cookie: a browser hands a cookie to every port
 * on 127.0.0.1, so any other local server would receive the session. Storage is
 * scoped to the exact origin, port included, and is never sent anywhere; the
 * page reads it and puts the id in a header itself. It is also scoped to the
 * tab: a new tab needs the launch URL again (a duplicated or browser-restored
 * tab can carry the id), and a restarted server, which forgets its sessions,
 * always ends it. `localStorage` would outlive the tab. The launch token stays: it is what keeps other local processes and
 * users out of an API that runs toil with the person's own connections. It is
 * simply no longer needed once the tab holds a session. Paperwork, but the kind
 * that files itself.
 */

import { NO_AGENT_DETAILS, NO_AGENT_FIX, NO_AGENT_NOTICE, SCRIPTED_LABEL, type AdapterList, type Agent, type Answer, type AskExtra, type AskStyle, type Starter } from './agent.ts';
import type { AreaInfo, ConfigApi, SettingsInfo } from './config.ts';
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

export interface Session {
  /** The session id, sent as X-Toil-UI-Session. */
  session: string;
  csrf: string;
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

const SESSION_HEADER = 'X-Toil-UI-Session';
const CSRF_HEADER = 'X-Toil-UI-CSRF';

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

/** Where the tab keeps its session between reloads. */
const STORED = 'toil-ui-session';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The tab's storage, or null where the browser refuses it (some private modes): the page then works until the next reload. */
function tabStorage(): Store | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Storage can throw (full, or blocked mid-session); the session just isn't kept then. */
function attempt(f: () => void) {
  try {
    f();
  } catch {
    // Nothing to keep it in: the next reload asks for the launch URL.
  }
}

/**
 * Signs in. With the launch token in the page's URL it trades the token for a
 * session, keeps the session in the tab's `sessionStorage` and takes the token
 * out of the address bar and the history, leaving any other parameter. Without
 * one (a reload, a bookmark) it asks the server whether the kept session is
 * still good; if the server has forgotten it (it restarted) or the tab never
 * had one, it says to open the launch URL again.
 */
export async function signIn(
  base = './',
  location: Pick<Location, 'search' | 'pathname' | 'hash'> = window.location,
  history: Pick<History, 'replaceState'> = window.history,
  storage: Store | null = tabStorage(),
): Promise<Session> {
  const token = new URLSearchParams(location.search).get('token');
  if (!token) return resume(base, storage);
  const res = await fetch(`${base}api/session`, { method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  // Only the token goes; a ?theme= or ?scheme= beside it still picks how the app looks.
  const rest = new URLSearchParams(location.search);
  rest.delete('token');
  const query = rest.toString();
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`);
  if (!res.ok) {
    attempt(() => storage?.removeItem(STORED));
    throw await failure(res, 'Signing in');
  }
  const session = (await res.json()) as Session;
  attempt(() => storage?.setItem(STORED, JSON.stringify({ session: session.session })));
  return session;
}

const OPEN_LAUNCH_URL = 'Open the URL toil-ui printed when it started, which carries the launch token.';

/** A reload: the kept session, checked with the server, which answers with the rest of what the page needs. */
async function resume(base: string, storage: Store | null): Promise<Session> {
  let kept: { session?: unknown } | null;
  try {
    kept = JSON.parse(storage?.getItem(STORED) ?? 'null') as { session?: unknown } | null;
  } catch {
    kept = null;
  }
  if (typeof kept?.session !== 'string') throw new Error(`This tab has no session. ${OPEN_LAUNCH_URL}`);
  const res = await fetch(`${base}api/session`, { credentials: 'omit', headers: { [SESSION_HEADER]: kept.session } });
  if (res.status === 401) {
    attempt(() => storage?.removeItem(STORED));
    throw new Error(`The server no longer knows this tab's session, as after it restarted. ${OPEN_LAUNCH_URL} Each start prints a new one.`);
  }
  if (!res.ok) throw await failure(res, 'Resuming the session');
  return (await res.json()) as Session;
}

const call = (base: string, session: Session, path: string, init: { body?: unknown; signal?: AbortSignal } = {}) =>
  fetch(`${base}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    credentials: 'omit',
    headers: {
      [SESSION_HEADER]: session.session,
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json', [CSRF_HEADER]: session.csrf }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: init.signal,
  });

const isEnvelope = (v: unknown): v is Envelope => typeof v === 'object' && v !== null && 'ok' in v && 'meta' in v;

/**
 * `execute()` over the server. The server decides what the call may do (reads
 * only, always read-only), so the options' `readOnly` and `caller` aren't
 * sent: the page can't loosen them. A refusal is toil's own envelope, shown on
 * its panel like any failed call.
 */
export function httpExecute(session: Session, base = './'): Execute {
  return async (command, input = {}, options = {}) => {
    const res = await call(base, session, 'api/execute', { body: { command, input }, signal: options.signal });
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      body = undefined;
    }
    if (isEnvelope(body)) return body;
    throw await failure(res, `toil ${command}`);
  };
}

/** The sync job over the server (#250): its status, a start, and the wipe. Each throws with the server's message. */
export interface SyncClient {
  status(): Promise<SyncStatus>;
  /** Every toil project, or the one named. */
  start(toilProject?: string): Promise<SyncStatus>;
  wipe(): Promise<SyncStatus>;
}

export function httpSync(session: Session, base = './'): SyncClient {
  const answer = async (res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as SyncStatus;
  };
  return {
    status: async () => answer(await call(base, session, 'api/sync'), 'Reading the sync status'),
    start: async (toilProject) => answer(await call(base, session, 'api/sync', { body: toilProject === undefined ? {} : { toilProject } }), 'Starting the sync'),
    wipe: async () => answer(await call(base, session, 'api/cache/wipe', { body: { confirm: 'wipe' } }), 'Wiping the cache'),
  };
}

/**
 * The settings pages' calls (src/config.ts) over the server's `/api/config`.
 * The server decides which commands run and how; the page sends the command,
 * its input, and what the person typed for its questions. A secret travels in
 * this one request body and is not kept here after it.
 */
export function httpConfig(session: Session, base = './'): ConfigApi {
  const get = async <T,>(path: string): Promise<T> => {
    const res = await call(base, session, path);
    if (!res.ok) throw await failure(res, path);
    return (await res.json()) as T;
  };
  return {
    disabled: null,
    areas: () => get<AreaInfo[]>('api/config/areas'),
    settings: () => get<SettingsInfo>('api/config/settings'),
    async run(command, input, answers = {}) {
      const res = await call(base, session, 'api/config', { body: { command, input, ...answers } });
      let body: unknown;
      try {
        body = await res.clone().json();
      } catch {
        body = undefined;
      }
      if (isEnvelope(body)) return body;
      throw await failure(res, `toil ${command}`);
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
export function httpFeedback(session: Session, base = './'): FeedbackApi {
  const run = async (fields: FeedbackFields, consent: boolean, signal?: AbortSignal): Promise<Envelope> => {
    const res = await call(base, session, 'api/feedback', { body: { fields, ...(consent ? { consent: true } : {}) }, ...(signal ? { signal } : {}) });
    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      body = undefined;
    }
    if (isEnvelope(body)) return body;
    throw await failure(res, 'toil feedback');
  };
  return {
    disabled: session.sample ? FEEDBACK_SAMPLE_DISABLED : null,
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
export async function httpAgent(session: Session, toilProjects: string[], base = './'): Promise<Agent> {
  const starters = new Map<string, Starter[]>();
  // Fetched with no adapter chosen too: a chat can switch to one (#344).
  for (const name of toilProjects) {
    const res = await call(base, session, `api/agent/starters?toilProject=${encodeURIComponent(name)}`);
    starters.set(name, res.ok ? ((await res.json()) as Starter[]) : []);
  }
  return {
    ...(session.agent === 'none' ? { notice: NO_AGENT_NOTICE, noticeDetails: `${NO_AGENT_DETAILS} ${NO_AGENT_FIX}` } : {}),
    label: AGENT_LABEL[session.agent] ?? session.agent,
    starters: (toilProject) => starters.get(toilProject) ?? [],
    async adapters(toilProject) {
      const res = await call(base, session, `api/agent/adapters${toilProject ? `?toilProject=${encodeURIComponent(toilProject)}` : ''}`);
      if (!res.ok) throw await failure(res, 'Reading the agents');
      return (await res.json()) as AdapterList;
    },
    async ask(toilProject, prompt, style, chat, extra) {
      const res = await call(base, session, 'api/agent/ask', { body: { toilProject, prompt, ...style, ...(chat ? { chat } : {}), ...extraBody(extra) } });
      if (!res.ok) throw await failure(res, 'The question');
      return (await res.json()) as Answer;
    },
    async *stream(toilProject, prompt, signal, style, chat, extra) {
      const res = await call(base, session, 'api/agent/ask', { body: { toilProject, prompt, stream: true, ...style, ...(chat ? { chat } : {}), ...extraBody(extra) }, ...(signal ? { signal } : {}) });
      if (!res.ok) throw await failure(res, 'The question');
      if (!/^application\/x-ndjson/.test(res.headers.get('content-type') ?? '')) {
        yield (await res.json()) as Answer;
        return;
      }
      yield* answerLines(res);
    },
    async session(chat) {
      const res = await call(base, session, `api/agent/session?chat=${encodeURIComponent(chat)}`);
      if (!res.ok) throw await failure(res, "Reading the chat's session");
      return (await res.json()) as ChatSession | null;
    },
    async renew(chat, toilProject) {
      const res = await call(base, session, 'api/agent/renew', { body: { chat, toilProject } });
      if (!res.ok) throw await failure(res, 'Renewing the chat');
      return (await res.json()) as ChatSession;
    },
  };
}

/** The server's own staleness (#305), for the header: null with sample data, or when it can't be read. */
export async function httpServerStatus(session: Session, base = './'): Promise<ServerStatus | null> {
  const res = await call(base, session, 'api/fingerprint');
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
}

export function httpAgentSettings(session: Session, base = './'): AgentSettingsClient {
  const answer = async (res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as AgentStatus;
  };
  return {
    status: async () => answer(await call(base, session, 'api/agent/settings'), 'Reading the agent settings'),
    save: async (settings) => answer(await call(base, session, 'api/agent/settings', { body: settings }), 'Saving the agent settings'),
    async prompt(toilProject, style) {
      const query = new URLSearchParams({ ...(toilProject ? { toilProject } : {}), theme: style.theme, voice: style.voice ? 'on' : 'off' });
      const res = await call(base, session, `api/agent/prompt?${query}`);
      if (!res.ok) throw await failure(res, 'Reading the full prompt');
      return ((await res.json()) as { prompt: string }).prompt;
    },
    async installPlan(adapter) {
      const res = await call(base, session, `api/agent/install?adapter=${encodeURIComponent(adapter)}`);
      if (!res.ok) throw await failure(res, 'Reading the install command');
      return (await res.json()) as InstallPlan;
    },
    async install(adapter, command, onLine, signal) {
      const res = await call(base, session, 'api/agent/install', { body: { adapter, command }, ...(signal ? { signal } : {}) });
      if (!res.ok) throw await failure(res, 'The install');
      return installLines(res, onLine);
    },
  };
}

/**
 * The worklog over the server (#308): its calendar and pages, and the three
 * presses that change anything (rebuild, a note, an export). With sample
 * data the server answers from the sample and refuses notes and exports.
 */
export function httpWorklog(session: Session, base = './'): WorklogApi {
  const answer = async <T,>(res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as T;
  };
  const q = (params: Record<string, string | undefined>) => new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => e[1] !== undefined)).toString();
  return {
    disabled: session.sample ? WORKLOG_SAMPLE_DISABLED : null,
    month: async (toilProject, month) => answer<WorklogMonth>(await call(base, session, `api/worklog/month?${q({ toilProject, month })}`), 'Reading the worklog'),
    day: async (toilProject, day) => answer<WorklogDay>(await call(base, session, `api/worklog/day?${q({ toilProject, day })}`), 'Reading the page'),
    rebuild: async (toilProject, day) => answer<WorklogRebuilt>(await call(base, session, 'api/worklog/rebuild', { body: { toilProject, day } }), 'Rebuilding the page'),
    addNote: async (toilProject, text) => answer<WorklogDay>(await call(base, session, 'api/worklog/note', { body: { toilProject, text } }), 'Adding the note'),
    exportTo: async (toilProject, what, folder) => answer<WorklogExport>(await call(base, session, 'api/worklog/export', { body: { toilProject, ...what, folder } }), 'The export'),
    standup: async (toilProject, from, to) => answer<WorklogStandup>(await call(base, session, `api/worklog/standup?${q({ toilProject, from, to })}`), 'Building the stand-up'),
  };
}

/**
 * The agent's model usage over the server (#295): the last 30 days' records,
 * which the page adds up with the meter's one function, and the caps and
 * Codex rates. Each throws with the server's message.
 */
export function httpModelUsage(session: Session, base = './'): ModelUsageApi {
  const answer = async (res: Response, what: string) => {
    if (!res.ok) throw await failure(res, what);
    return (await res.json()) as UsageView;
  };
  return {
    view: async () => answer(await call(base, session, 'api/usage'), 'Reading the model usage'),
    save: async (settings) => answer(await call(base, session, 'api/usage/settings', { body: settings }), 'Saving the caps'),
  };
}

/**
 * The history of analyses over the server (#395): read only. The server
 * keeps each Analyze itself as its answer ends, so this client has no
 * `record`. One the history no longer holds comes back as null.
 */
export function httpAnalyses(session: Session, base = './'): AnalysesApi {
  const q = (params: Record<string, string>) => new URLSearchParams(params).toString();
  return {
    list: async (toilProject) => {
      const res = await call(base, session, `api/analyses?${q({ toilProject })}`);
      if (!res.ok) throw await failure(res, 'Reading the analyses');
      return (await res.json()) as AnalysisSummary[];
    },
    get: async (toilProject, id) => {
      const res = await call(base, session, `api/analyses/one?${q({ toilProject, id })}`);
      if (res.status === 404) return null;
      if (!res.ok) throw await failure(res, 'Reading the analysis');
      return (await res.json()) as AnalysisView;
    },
  };
}
