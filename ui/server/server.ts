/**
 * The local server (#206, Local first): Node's own `node:http`, no framework,
 * so the package's only runtime dependency stays toil. It serves the built
 * SPA and a small JSON API under the base path, on loopback, behind a lock:
 *
 * - **Loopback only.** The server binds `127.0.0.1` or `::1` (settings.ts
 *   refuses any other address) and refuses a request whose peer isn't loopback.
 * - **A cookie, and no step for the person** (#561, the maintainer's call).
 *   There is no launch token, session id, CSRF header or browser storage.
 *   Toil UI keeps a machine secret in its data folder (machine-secret.ts); when
 *   a browser navigates to the app page itself (`Sec-Fetch-Dest: document`,
 *   `Sec-Fetch-Site` none or same-origin) the server sets a cookie signed with
 *   it: `HttpOnly`, `SameSite=Strict`, 30 days, no data in it. It is not
 *   `Secure`, because a browser won't keep that over plain http. Every API call
 *   needs a valid cookie, compared in constant time. A cross-site page's request
 *   doesn't carry a SameSite=Strict cookie, and the checks below refuse it anyway.
 * - **The Host header.** Only `127.0.0.1:<port>`, `localhost:<port>` and
 *   `[::1]:<port>` are answered, so a page using DNS rebinding to reach the
 *   port under its own name is refused before anything else is read.
 * - **Origin and Fetch Metadata.** An API call whose `Origin` is present and
 *   isn't the origin the request was addressed to, or whose `Sec-Fetch-Site` is
 *   present and isn't `same-origin`, is refused. A POST must be
 *   `application/json`, which a plain cross-site form can't send. These, with
 *   SameSite=Strict, are why no CSRF header is needed.
 * - **No CORS.** No `Access-Control-*` header is ever sent, and `OPTIONS` is
 *   refused, so no other page can read an answer or pass a preflight.
 *
 *   What this does not do: any program running on this machine as the same
 *   user can read the machine secret, or fetch the page the way a browser does
 *   and get a cookie. Cookies are not scoped to a port, so another local web
 *   server on 127.0.0.1 is sent this one too. The static files hold no data.
 *
 * Every request becomes a `RequestContext` with its viewer before a Store or
 * Agent sees it. Reads are only the commands the views make (`READ_COMMANDS`),
 * always read-only. A config change (#253) is only a command on the server's
 * config allowlist (ui/server/config.ts): toil's own commands for its
 * connections and toil projects, with the person's answers to their questions. The
 * Feedback (#265) is `toil feedback` alone, on `feedback`: read-only for the
 * dialog's preview, and sent only with the person's `consent`, which answers
 * the command's own consent question. The
 * agent (#251) answers on `agent/ask`, streamed as NDJSON when asked, and its
 * settings are `agent/settings`, the person's instructions and custom voice
 * among them (#283), and `agent/prompt` shows the system prompt a question
 * would get in the page's theme. `agent/mcp` is the one route with a
 * credential of its own: it serves one question's read tools to the Codex CLI, by that
 * question's bearer token, and refuses anything carrying a page's `Origin`.
 * The worklog (#308) is `worklog/month`, `worklog/day` and `worklog/standup` (#345) to read, and
 * `worklog/rebuild`, `worklog/note` and `worklog/export`, each an explicit
 * press on the page: a note goes into the cache, and an export is a file
 * toil's file service writes in the folder the person named.
 * The history of analyses (#395) is `analyses` and `analyses/one`, read
 * only: the server keeps each Analyze itself as its answer ends whole, and
 * says which on the answer's last line, so nothing the page sends writes one.
 * The building has one door, a doorman who reads the visitor's address, and a
 * guest book, and the guest book is toil's audit log. The key was retired.
 */

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { checkRegistry, npmrcPath, RegistryError, setRegistry } from './agents/npmrc.ts';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { ANALYZE, type Answer, type AskExtra, type HistoryTurn } from '../src/agent.ts';
import { GUIDE_MAX, GUIDE_REFUSAL, GUIDE_REFUSAL_FIX, looksLikeSecret, readGuideState, type GuideRequest } from '../src/guide.ts';
import { isWhole, type AnalysisKeeper } from './analyses.ts';
import type { Envelope, ExecutePerson } from '../src/toil.ts';
import type { AreaInfo, SettingsInfo } from '../src/config.ts';
import type { Agent } from './agent.ts';
import { AnswersError, CONFIG_COMMANDS, isConfigRead, personFrom, settingsFrom } from './config.ts';
import { AgentError } from './agents/cli.ts';
import type { AdapterStatus, AgentStatus } from './agents/host.ts';
import type { InstallPlan, InstallRun } from './agents/install.ts';
import type { AdapterName } from './agents/runtime.ts';
import type { ToilProjectAgents } from './agents/toil-project-agents.ts';
import { answerMcp, McpGrants } from './agents/mcp.ts';
import type { ServeTools } from './agents/runtime.ts';
import { StyleError, styleFrom, type StyleChoice } from './agents/voices.ts';
import { COOKIE_MAX_AGE_SECONDS, cookieNamed, issueCookie, verifyCookie } from './machine-secret.ts';
import { localViewer, type RequestContext, type Viewer } from './context.ts';
import type { Settings } from './settings.ts';
import { READ_COMMANDS, type Access, type Store } from './store.ts';
import { SyncBusy, type SyncService } from './sync.ts';
import { WorklogRefusal, type ExportWhat, type WorklogApi } from '../src/worklog.ts';
import type { UsageControl } from './usage.ts';
import { assignmentRoute, type AssignmentControl } from './assign/routes.ts';
import { AssignError } from '../src/assign/queue.ts';
import { CHAT_ID, UsageSettingsError, type AnswerUsage, type ChatTurn } from '../src/model-usage.ts';
import type { ServerStatus } from '../src/fingerprint.ts';

export interface UiServerOptions {
  settings: Settings;
  store: Store;
  agent: Agent;
  /** The built SPA (dist/app/). */
  appDir: string;
  /** Toil UI's own version, and the toil it runs on, for the info the page reads and for refusals. */
  version: string;
  toil: { version: string; contractVersion: number };
  /** Commands `/api/config` may run (#253): CONFIG_COMMANDS unless a test narrows it. */
  configCommands?: ReadonlySet<string>;
  /** What the settings pages show beside the commands: the areas' connection fields, and the settings toil has no command for. */
  config?: { areas: AreaInfo[]; settings: SettingsInfo };
  /** The sync job and its cache (#250): `api/sync` and `api/cache/wipe`. None with sample data. */
  sync?: SyncService;
  /** The agent's settings (#251): `api/agent/settings`. None with sample data, which always uses the scripted agent. */
  agentControl?: AgentControl;
  /** The worklog (#308): the cache's pages, or the sample's. Absent, `api/worklog/*` says there is none. */
  worklog?: WorklogApi;
  /** The agent last used for each toil project's Analyze (#494): `api/agent/adapters?toil project=` says it, a whole Analyze sets it. Absent with sample data. */
  toilProjectAgents?: ToilProjectAgents;
  /** The history of analyses (#395): `api/analyses`, and every Analyze kept as it ends. Absent, Analyze keeps nothing. */
  analyses?: AnalysisKeeper;
  /** The agent's model usage and its Codex rates (#295): `api/usage`. */
  usage?: UsageControl;
  /** Assigning work items to an agent (#293): `api/assignments`. */
  assignments?: AssignmentControl;
  /**
   * A toil project renamed through `/api/config` (#342, `toil projects describe --name`):
   * `blocked` says why it can't be renamed now (a sync or an assignment of it is
   * running), and `moved` takes Toil UI's own records of it (the cache, the
   * worklog, assignments) to the new name once toil has renamed it, returning
   * anything it couldn't move, in words. None with sample data.
   */
  renames?: ToilProjectRenames;
  /** The server's own staleness (#305): `api/fingerprint`. Absent with sample data, which never goes out of date. */
  serverStatus?: () => ServerStatus;
  /** The 32 bytes that sign the browser's cookie (machine-secret.ts). A real start reads the file in the data folder; a test without one gets a fresh secret. */
  machineSecret?: Buffer;
  viewer?: Viewer;
}

export interface ToilProjectRenames {
  /** Stops a sync starting until the returned function is called. */
  hold(): () => void;
  blocked(toilProject: string): { message: string; fix: string } | null;
  moved(from: string, to: string): Promise<string[]>;
}

/** toil's toil project names: lowercase letters, digits and single hyphens. */
const TOIL_PROJECT_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** What the Settings page reads and changes about the agent. */
export interface AgentControl {
  status(): AgentStatus;
  save(input: unknown): AgentStatus;
  /** The system prompt a question about the toil project gets now, in the page's style (#283). */
  systemPrompt(toilProject: string, style: StyleChoice | null): string;
  /** The one command Install would run for an adapter, or why it can't here (#344). */
  installPlan(adapter: AdapterName): InstallPlan;
  /** Runs that command, as shown, streaming npm's output; then loads the SDK to prove it. */
  install(adapter: AdapterName, command: string, onLine: (line: string) => void, signal: AbortSignal): Promise<{ run: InstallRun; status: AdapterStatus }>;
}

export interface UiServer {
  server: Server;
  /** Serves tools as an MCP server on `api/agent/mcp` for one run (Codex, #251). */
  serveTools: ServeTools;
  /** Starts listening; resolves with the address and the one URL to open. */
  listen(): Promise<{ origin: string; url: string }>;
  close(): Promise<void>;
}

/** The largest POST body the API reads. Its calls are a command name and a few fields. */
export const MAX_BODY = 256 * 1024;
/** The longest question the agent takes, in characters. */
export const MAX_PROMPT = 8000;

/**
 * Keeps an Analyze in the history (#395) once its answer is whole, and only
 * then: a stopped, failed or empty answer is no analysis. A record that can't
 * be kept never fails the answer; the answer says so instead.
 */
function kept(keeper: AnalysisKeeper, toilProject: string, startedAt: string) {
  const one = async (answer: Answer): Promise<Answer> => {
    if (!isWhole(answer)) return answer;
    try {
      return { ...answer, analysis: await keeper.record(toilProject, answer, startedAt) };
    } catch (e) {
      return { ...answer, warnings: [...(answer.warnings ?? []), `Toil UI couldn't keep this analysis in its history: ${e instanceof Error ? e.message : String(e)}`] };
    }
  };
  async function* stream(answers: AsyncIterable<Answer>, signal: AbortSignal): AsyncIterable<Answer> {
    let last: Answer | undefined;
    for await (const a of answers) {
      last = a;
      yield a;
    }
    if (!signal.aborted && isWhole(last)) yield await one(last);
  }
  return { one, stream };
}
/**
 * Remembers the adapter for a toil project (#494) once an answer from it is whole, and only then: a stopped
 * or failed run says nothing about what the person prefers. A memory that can't be written never fails the answer.
 */
function rememberer(store: ToilProjectAgents, toilProject: string, adapter: string) {
  const one = (answer: Answer) => {
    if (!isWhole(answer)) return;
    try {
      store.set(toilProject, adapter);
    } catch {
      // The answer matters more than the memory; the next question simply asks the default again.
    }
  };
  async function* stream(answers: AsyncIterable<Answer>, signal: AbortSignal): AsyncIterable<Answer> {
    let last: Answer | undefined;
    for await (const a of answers) {
      last = a;
      yield a;
    }
    if (!signal.aborted && last) one(last);
  }
  return { one, stream };
}

/** The addresses a loopback peer shows as: IPv4, IPv6 and IPv4 mapped into IPv6. */
const LOOPBACK_PEERS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** The cookie's name. Cookies are not scoped to a port, so one name serves every Toil UI on this machine that shares the secret. */
const COOKIE_NAME = 'toil-ui';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export { CSP } from './csp.ts';
import { CSP } from './csp.ts';

const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};

/** The fields a feedback call carries: what the person typed, and nothing Toil UI knows. */
const FEEDBACK_FIELDS: ReadonlySet<string> = new Set(['kind', 'title', 'body', 'email']);
const FEEDBACK_SHAPE = 'Send { "fields": { "kind": "bug", "title": "…", "body": "…", "email": "you@example.com" } }, with "consent": true to send it.';

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly fix: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonValue(req);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new HttpError(400, 'The request body must be a JSON object.', 'Send a JSON object.');
  return body as Record<string, unknown>;
}

/** An agent's failure as the pane shows it: the message, and the fix when there is one. */
function agentFailure(e: unknown): { message: string; fix?: string; usage?: AnswerUsage } {
  if (e instanceof AgentError) return { message: e.message, fix: e.fix, ...(e.usage ? { usage: e.usage } : {}) };
  return { message: e instanceof Error ? e.message : String(e) };
}

/** The chat a question belongs to (#295), as the page numbers it, or none for a question of its own. */
function chatOf(value: unknown): ChatTurn | undefined {
  if (value === undefined) return undefined;
  const c = value as Record<string, unknown> | null;
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || !CHAT_ID.test(c.id) || !Number.isInteger(c.turn) || (c.turn as number) < 1 || (c.turn as number) > 100_000) {
    throw new HttpError(400, 'chat is the chat a question belongs to: { "id": "<letters, digits and hyphens>", "turn": <1 or more> }.', 'Leave chat out to ask a question of its own.');
  }
  return { id: c.id, turn: c.turn as number };
}

/** The longest earlier answer a question carries, before prompts.ts shortens it further. */
const MAX_HISTORY_TEXT = 20_000;
const ADAPTER_NAMES: readonly string[] = ['claude', 'copilot', 'codex'];

/**
 * What a question carries beyond its text (#344): the chat's own adapter, by
 * name, and the chat so far, each turn a question and the answer's text. Both
 * are checked, never trusted: an adapter the server doesn't have, or history
 * that isn't plain turns, is refused.
 */
function extraOf(body: Record<string, unknown>): AskExtra {
  const extra: AskExtra = {};
  if (body.adapter !== undefined) {
    if (typeof body.adapter !== 'string' || !ADAPTER_NAMES.includes(body.adapter)) throw new HttpError(400, `There is no adapter ${JSON.stringify(body.adapter)}.`, `Send adapter as one of ${ADAPTER_NAMES.join(', ')}, or leave it out for the one chosen in Settings.`);
    extra.adapter = body.adapter;
  }
  if (body.fallback !== undefined) {
    if (typeof body.fallback !== 'boolean') throw new HttpError(400, 'fallback is true or false.', 'Send fallback: true when the adapter stands in for a default that cannot run, or leave it out.');
    if (body.fallback && extra.adapter === undefined) throw new HttpError(400, 'fallback names no adapter.', 'Send fallback: true with the adapter it stands in with, or leave it out.');
    if (body.fallback) extra.fallback = true;
  }
  if (body.history !== undefined) {
    const shape = 'Send history as at most 20 turns, each { "prompt": "<question>", "answer": "<text>", "by": "<who>" }, or leave it out.';
    if (!Array.isArray(body.history) || body.history.length > 20) throw new HttpError(400, 'history is the chat so far, as a list of turns.', shape);
    const turns: HistoryTurn[] = [];
    for (const t of body.history as unknown[]) {
      const o = t as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || typeof o.prompt !== 'string' || typeof o.answer !== 'string' || (o.by !== undefined && typeof o.by !== 'string')) throw new HttpError(400, 'Each turn of history needs a prompt and an answer, as text.', shape);
      if (o.prompt.length > MAX_PROMPT || o.answer.length > MAX_HISTORY_TEXT || (typeof o.by === 'string' && o.by.length > 200)) throw new HttpError(413, 'A turn of history is too long.', `Keep each question to ${MAX_PROMPT} characters and each answer to ${MAX_HISTORY_TEXT}.`);
      turns.push({ prompt: o.prompt, answer: o.answer, ...(typeof o.by === 'string' ? { by: o.by } : {}) });
    }
    extra.history = turns;
  }
  return extra;
}

/** The adapter an install names: one of the three, never a package name. */
function installAdapter(value: unknown): AdapterName {
  if (typeof value !== 'string' || !ADAPTER_NAMES.includes(value)) throw new HttpError(400, `There is no adapter ${JSON.stringify(value)} to install.`, `Name one of ${ADAPTER_NAMES.join(', ')}: Install takes an adapter, and Toil UI decides the package and its version.`);
  return value as AdapterName;
}

/** The answer's style the page sent (#283): a built-in theme and the voice switch, or neither. */
function checkedStyle(body: Record<string, unknown>): StyleChoice | null {
  try {
    return styleFrom(body);
  } catch (e) {
    if (e instanceof StyleError) throw new HttpError(400, e.message, e.fix);
    throw e;
  }
}

async function readJsonValue(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, `The request body is over ${MAX_BODY / 1024} KB.`, 'Send one toil call per request.');
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, "The request body isn't JSON.", 'Send a JSON object.');
  }
  return body;
}

export function createUiServer(options: UiServerOptions): UiServer {
  const { settings, store, agent, appDir } = options;
  const viewer = options.viewer ?? localViewer();
  const machineSecret = options.machineSecret ?? randomBytes(32);
  const configCommands = options.configCommands ?? CONFIG_COMMANDS;
  const configInfo = options.config ?? { areas: [], settings: settingsFrom(process.env) };
  const base = settings.basePath;
  let host = '';
  const mcp = new McpGrants(() => `http://${host}${base}api/agent/mcp`);

  const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
    res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Content-Length': String(Buffer.byteLength(body)), ...extra });
    res.end(res.req.method === 'HEAD' ? undefined : body);
  };
  const json = (res: ServerResponse, status: number, value: unknown) => send(res, status, 'application/json; charset=utf-8', JSON.stringify(value));
  const text = (res: ServerResponse, status: number, message: string) => send(res, status, 'text/plain; charset=utf-8', `${message}\n`);

  /** A refusal in toil's own envelope, so the page shows it the way it shows any failed call. */
  const refusal = (command: string, message: string, fix: string): Envelope => ({
    ok: false,
    data: null,
    error: { code: 'INVALID_INPUT', message, fix },
    meta: { command, durationMs: 0, version: options.toil.version, contractVersion: options.toil.contractVersion },
  } as Envelope);

  /** What the page needs to know about the server. Nothing in it is a credential. */
  const serverInfo = () => ({
    version: options.version,
    toil: options.toil,
    viewer: { id: viewer.id, name: viewer.name },
    store: store.kind,
    sync: options.sync !== undefined,
    agent: agent.kind,
    agentSettings: options.agentControl !== undefined,
    assignments: options.assignments !== undefined,
    sample: store.sample,
    now: store.now(),
  });

  /** The agent's settings, or a 404 saying the sample always uses the scripted agent. */
  const control = (): AgentControl => {
    if (!options.agentControl) throw new HttpError(404, 'This Toil UI serves sample data, which always answers with the scripted agent.', 'Start toil-ui without --sample to choose an agent.');
    return options.agentControl;
  };

  /**
   * An answer as it streams: NDJSON, one line per version of the answer, each
   * the whole of it so far, ending with `{ "done": true }`, or with
   * `{ "error": … }` when the agent fails partway. NDJSON over fetch, not SSE,
   * because a POST body carries the question and EventSource can't send one (#250).
   */
  const streamAnswer = async (res: ServerResponse, answers: AsyncIterable<Answer>) => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    try {
      for await (const answer of answers) {
        if (res.destroyed) return;
        res.write(`${JSON.stringify({ answer })}\n`);
      }
      res.end(`${JSON.stringify({ done: true })}\n`);
    } catch (e) {
      if (!res.destroyed) res.end(`${JSON.stringify({ error: agentFailure(e) })}\n`);
    }
  };

  /**
   * Install (#344), as NDJSON like an answer: `{ "line" }` for each line npm
   * prints, then `{ "done": true, "status" }` with the adapter's new status,
   * or `{ "error" }` with npm's own words and the fix.
   */
  const streamInstall = async (res: ServerResponse, c: AgentControl, adapter: AdapterName, command: string, signal: AbortSignal) => {
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8' });
    const write = (line: string) => {
      if (!res.destroyed) res.write(`${JSON.stringify({ line })}\n`);
    };
    try {
      const { status } = await c.install(adapter, command, write, signal);
      if (!res.destroyed) res.end(`${JSON.stringify({ done: true, status })}\n`);
    } catch (e) {
      if (!res.destroyed) res.end(`${JSON.stringify({ error: agentFailure(e) })}\n`);
    }
  };

  /**
   * `POST api/agent/mcp`: the tools of one agent run, for an SDK that takes
   * them only from an MCP server (Codex). It needs that run's bearer token,
   * and no Origin at all: the caller is the agent CLI, never a page.
   */
  const mcpCall = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => {
    if (req.headers.origin !== undefined) throw new HttpError(403, "Toil UI's MCP endpoint takes no requests from a web page.", 'Only the agent CLI Toil UI starts calls it.');
    const tools = mcp.tools(req.headers.authorization);
    if (!tools) throw new HttpError(401, "That isn't the token of a running agent question.", 'The endpoint serves an agent CLI for the length of one question only.');
    if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw new HttpError(415, 'The MCP endpoint takes JSON only.', 'Send Content-Type: application/json.');
    const body = await readJsonValue(req);
    const out = await answerMcp(body, tools, options.version, ctx.signal);
    if (out === null) return send(res, 202, 'text/plain; charset=utf-8', '');
    json(res, 200, out);
  };

  /** The worklog, or a 404 saying this server keeps none. */
  const worklog = () => {
    if (!options.worklog) throw new HttpError(404, 'This Toil UI keeps no worklog.', 'Start toil-ui with a cache to keep one.');
    return options.worklog;
  };
  /** A worklog call, with its refusals as the page shows them. */
  const worklogCall = async (res: ServerResponse, call: () => Promise<unknown>) => {
    try {
      json(res, 200, await call());
    } catch (e) {
      if (e instanceof WorklogRefusal) throw new HttpError(e.status, e.message, e.fix);
      throw e;
    }
  };
  /** A worklog call takes its fields and no others, so a misspelt one is an error rather than ignored. */
  const only = (body: Record<string, unknown>, fields: string[], what: string, shape: string) => {
    const extra = Object.keys(body).filter((k) => !fields.includes(k));
    if (extra.length) throw new HttpError(400, `${what}, not ${extra.join(', ')}.`, shape);
  };
  const named = (value: unknown, what: string, shape: string) => {
    if (typeof value !== 'string' || !value) throw new HttpError(400, `Name the ${what}.`, shape);
    return value;
  };
  /** The history of analyses, or a 404 when this server keeps none. */
  const keeper = (): AnalysisKeeper => {
    if (!options.analyses) throw new HttpError(404, 'This Toil UI keeps no history of analyses.', 'Start toil-ui with its cache to keep every Analyze.');
    return options.analyses;
  };
  /** The usage view, or a 404 when this server keeps none. */
  const usage = (): UsageControl => {
    if (!options.usage) throw new HttpError(404, 'This Toil UI keeps no record of model usage.', 'Start toil-ui with its cache to record what the agent uses.');
    return options.usage;
  };

  /** The sync job, or a 404 saying this server has none (sample data syncs nothing). */
  const syncer = (): SyncService => {
    if (!options.sync) throw new HttpError(404, 'This Toil UI has no cache to sync: it serves sample data.', 'Start toil-ui without --sample to sync your own Toil projects.');
    return options.sync;
  };

  const run = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext, access: Access) => {
    const body = await readJson(req);
    const command = body.command;
    const input = body.input ?? {};
    if (typeof command !== 'string') throw new HttpError(400, 'The call needs a command name.', 'Send { "command": "projects list", "input": {} }.');
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new HttpError(400, 'The call\'s input must be an object of the command\'s fields.', 'Send { "command": "projects show", "input": { "toilProject": "<name>" } }.');
    const allowed = access === 'read' ? READ_COMMANDS : configCommands;
    if (!allowed.has(command)) {
      const message = access === 'read'
        ? `Toil UI doesn't run toil ${command} from the page: it runs only the reads its views make.`
        : `Toil UI doesn't change ${command} from the page: its settings pages run only toil's commands for its own connections and Toil projects.`;
      json(res, 403, refusal(command, message, `Run toil ${command} on the CLI, where toil's own rules apply.`));
      return;
    }
    if (access === 'read') {
      json(res, 200, await store.execute(ctx, command, input as Record<string, unknown>, access));
      return;
    }
    // A config read runs read-only. A change runs with the person's answers, which go to toil and nowhere else.
    const readOnly = isConfigRead(command);
    let person;
    try {
      person = readOnly ? undefined : personFrom(body);
    } catch (e) {
      if (e instanceof AnswersError) throw new HttpError(400, e.message, e.fix);
      throw e;
    }
    const fields = input as Record<string, unknown>;
    const renames = command === 'projects describe' ? options.renames : undefined;
    const renaming = renames !== undefined && fields.name !== undefined;
    if (renaming && (typeof fields.toilProject !== 'string' || !TOIL_PROJECT_NAME.test(fields.toilProject))) {
      // Toil UI's records are kept by name, so a rename from the page names the toil project the same way; toil itself also takes a path.
      json(res, 400, refusal(command, 'Toil UI renames a Toil project by its name, not a path to its file.', 'Send the name toil projects list shows, or rename it on the CLI.'));
      return;
    }
    // While it renames, no sync may start, and none may be running, nor an assignment of the toil project: each reads it by name as it goes.
    const release = renaming ? renames!.hold() : () => undefined;
    try {
      const why = renaming ? renames!.blocked(fields.toilProject as string) : null;
      if (why) {
        json(res, 409, { ...refusal(command, why.message, why.fix), error: { code: 'CONFLICT', message: why.message, fix: why.fix } });
        return;
      }
      const envelope = await store.execute(ctx, command, fields, access, { readOnly, ...(person ? { person } : {}) });
      const renamed = renames && envelope.ok ? (envelope.data as { renamed?: { from?: unknown; to?: unknown } | null } | null)?.renamed : null;
      if (renamed && typeof renamed.from === 'string' && typeof renamed.to === 'string') {
        // toil has renamed the file by now; what Toil UI couldn't carry over is said beside toil's own warnings, never instead of the result.
        const problems = await renames!.moved(renamed.from, renamed.to).catch((e: unknown) => [`Toil UI couldn't move its own records of ${renamed.from} to ${renamed.to}: ${e instanceof Error ? e.message : String(e)}. The next sync reads it afresh under its new name.`]);
        if (problems.length) {
          envelope.meta.warnings = [...(envelope.meta.warnings ?? []), ...problems.map((message) => ({ code: 'TOIL_UI_RENAME', message }))];
        }
      }
      json(res, 200, envelope);
    } finally {
      release();
    }
  };

  /**
   * `POST api/feedback` (#265): `toil feedback`, and no other command, with the
   * dialog's four fields. Without `consent` it runs read-only, which only
   * previews; with `consent: true`, ticked by the person for the report on
   * screen, it runs with a person whose one answer is yes to the command's
   * consent question. Toil UI adds nothing to the fields.
   */
  const feedbackCall = async (req: IncomingMessage, res: ServerResponse, ctx: RequestContext) => {
    const body = await readJson(req);
    const extra = Object.keys(body).filter((k) => k !== 'fields' && k !== 'consent');
    if (extra.length) throw new HttpError(400, `A feedback call takes fields and consent, not ${extra.join(', ')}.`, FEEDBACK_SHAPE);
    const fields = body.fields;
    if (typeof fields !== 'object' || fields === null || Array.isArray(fields) || Object.entries(fields).some(([k, v]) => !FEEDBACK_FIELDS.has(k) || typeof v !== 'string')) {
      throw new HttpError(400, "A feedback call's fields are kind, title, body and email, each as text.", FEEDBACK_SHAPE);
    }
    if (body.consent !== undefined && body.consent !== true) throw new HttpError(400, 'consent is true, once the person has agreed to send the report on screen, or left out for a preview.', FEEDBACK_SHAPE);
    const consent = body.consent === true;
    const person: ExecutePerson = { ask: (q) => (q.id === 'consent' ? (consent ? 'yes' : 'no') : undefined) };
    json(res, 200, await store.execute(ctx, 'feedback', fields as Record<string, unknown>, 'feedback', { readOnly: !consent, person }));
  };

  const api = async (req: IncomingMessage, res: ServerResponse, route: string, url: URL, ctx: RequestContext) => {
    const key = `${req.method === 'HEAD' ? 'GET' : req.method} ${route}`;
    if (key === 'POST agent/mcp') return mcpCall(req, res, ctx);
    if (await assignmentRoute(key, req, res, url, options.assignments, { readJson, json, headers: SECURITY_HEADERS })) return;
    switch (key) {
      case 'GET info':
        json(res, 200, serverInfo());
        return;
      case 'POST execute':
        return run(req, res, ctx, 'read');
      case 'POST config':
        return run(req, res, ctx, 'config');
      case 'POST feedback':
        return feedbackCall(req, res, ctx);
      case 'GET config/areas':
        json(res, 200, configInfo.areas);
        return;
      case 'GET config/settings':
        json(res, 200, configInfo.settings);
        return;
      case 'GET agent/starters': {
        const toilProject = url.searchParams.get('toilProject');
        if (!toilProject) throw new HttpError(400, 'Name the Toil project.', `Ask ${base}api/agent/starters?toilProject=<name>.`);
        json(res, 200, await agent.starters(ctx, toilProject));
        return;
      }
      case 'POST agent/ask': {
        const body = await readJson(req);
        if (typeof body.toilProject !== 'string' || typeof body.prompt !== 'string') throw new HttpError(400, 'A question needs a Toil project and a prompt.', 'Send { "toilProject": "<name>", "prompt": "<question>", "theme": "<theme>", "voice": true }.');
        if (body.prompt.length > MAX_PROMPT) throw new HttpError(413, `A question is at most ${MAX_PROMPT} characters.`, 'Ask a shorter question.');
        const style = checkedStyle(body);
        const chat = chatOf(body.chat);
        const extra = extraOf(body);
        // Analyze is kept in the history once its answer is whole (#395); the answer's last line names the record.
        const keep = body.prompt === ANALYZE && options.analyses ? kept(options.analyses, body.toilProject, new Date().toISOString()) : null;
        // The adapter a whole answer was asked of, Analyze or an ordinary question, is the toil project's next default (#494); a fallback was nobody's choice.
        const remember = extra.adapter && !extra.fallback && options.toilProjectAgents ? rememberer(options.toilProjectAgents, body.toilProject, extra.adapter) : null;
        if (body.stream === true && agent.stream) {
          const answers = agent.stream(ctx, body.toilProject, body.prompt, style, chat, extra);
          const remembered = remember ? remember.stream(answers, ctx.signal) : answers;
          return streamAnswer(res, keep ? keep.stream(remembered, ctx.signal) : remembered);
        }
        try {
          const answer = await agent.ask(ctx, body.toilProject, body.prompt, style, chat, extra);
          if (remember && !ctx.signal.aborted) remember.one(answer);
          json(res, 200, keep && !ctx.signal.aborted ? await keep.one(answer) : answer);
        } catch (e) {
          json(res, 502, { error: agentFailure(e) });
        }
        return;
      }
      case 'POST agent/guide': {
        // The setup guide (#561). The refusal comes first, before the body is read any further: a message that looks like a secret is never passed on, kept or logged.
        const body = await readJson(req);
        if (!agent.guide) throw new HttpError(404, 'This Toil UI has no setup guide.', 'Start toil-ui without --sample, with an AI agent chosen in Settings.');
        if (typeof body.message !== 'string' || !body.message.trim()) throw new HttpError(400, 'A question needs its text.', 'Send { "chat": "<chat id>", "message": "<question>", "state": { "step": "connect", "areas": [] } }.');
        if (body.message.length > GUIDE_MAX || looksLikeSecret(body.message)) throw new HttpError(400, GUIDE_REFUSAL, GUIDE_REFUSAL_FIX);
        if (typeof body.chat !== 'string' || !CHAT_ID.test(body.chat)) throw new HttpError(400, 'Name the chat by its id: letters, digits and hyphens.', 'Send chat as an id of 8 to 64 letters, digits and hyphens.');
        const state = readGuideState(body.state);
        if (typeof state === 'string') throw new HttpError(400, state, 'Send only what the wizard names: the step, the tools, and the plain settings it lists.');
        const history = extraOf({ history: body.history }).history ?? [];
        if (history.some((t) => looksLikeSecret(t.prompt))) throw new HttpError(400, GUIDE_REFUSAL, GUIDE_REFUSAL_FIX);
        const request: GuideRequest = { chat: body.chat, message: body.message, state };
        return streamAnswer(res, agent.guide(ctx, request, checkedStyle(body), history));
      }
      case 'GET analyses': {
        const toilProject = named(url.searchParams.get('toilProject'), 'toilProject', `Ask ${base}api/analyses?toilProject=<name>.`);
        json(res, 200, await keeper().list(toilProject));
        return;
      }
      case 'GET analyses/one': {
        const shape = `Ask ${base}api/analyses/one?toilProject=<name>&id=<analysis id>.`;
        const toilProject = named(url.searchParams.get('toilProject'), 'toilProject', shape);
        const view = await keeper().get(toilProject, named(url.searchParams.get('id'), 'analysis', shape));
        if (!view) throw new HttpError(404, `${toilProject} has no analysis by that id: it may have passed the retention period, or the cache was wiped.`, 'Open the Analyses tab for the ones kept now.');
        json(res, 200, view);
        return;
      }
      case 'GET agent/session': {
        // What a chat started on and whether it has gone stale (#305); null for a chat the server hasn't seen.
        const chat = url.searchParams.get('chat') ?? '';
        if (!CHAT_ID.test(chat)) throw new HttpError(400, 'Name the chat by its id.', `Ask ${base}api/agent/session?chat=<chat id>.`);
        json(res, 200, (await agent.session?.(chat)) ?? null);
        return;
      }
      case 'POST agent/renew': {
        const body = await readJson(req);
        if (typeof body.chat !== 'string' || !CHAT_ID.test(body.chat) || typeof body.toilProject !== 'string' || !body.toilProject) throw new HttpError(400, 'A renew names the chat and its Toil project.', 'Send { "chat": "<chat id>", "toilProject": "<name>" }.');
        if (!agent.renew) throw new HttpError(404, 'This agent keeps no sessions, so there is nothing to renew.', 'Start toil-ui with its cache to record what each chat started on.');
        try {
          json(res, 200, await agent.renew(body.chat, body.toilProject));
        } catch (e) {
          if (e instanceof AgentError) throw new HttpError((e as AgentError & { status?: number }).status ?? 400, e.message, e.fix);
          throw e;
        }
        return;
      }
      case 'GET fingerprint':
        // The server's own staleness (#305), for the header: null with sample data.
        json(res, 200, options.serverStatus?.() ?? null);
        return;
      case 'GET agent/prompt': {
        // Read-only: the prompt as the next question would get it, with the saved instructions. `voice` is on or off.
        const toilProject = url.searchParams.get('toilProject') || '<Toil project>';
        if (toilProject.length > 200) throw new HttpError(400, 'That Toil project name is over 200 characters.', 'Name a Toil project toil projects list shows.');
        const voice = url.searchParams.get('voice');
        if (voice !== 'on' && voice !== 'off') throw new HttpError(400, 'Say whether the voice is on.', `Ask ${base}api/agent/prompt?theme=<name>&voice=on (or off).`);
        const style = checkedStyle({ theme: url.searchParams.get('theme') ?? undefined, voice: voice === 'on' });
        json(res, 200, { toilProject, prompt: control().systemPrompt(toilProject, style) });
        return;
      }
      case 'GET agent/settings':
        json(res, 200, control().status());
        return;
      case 'GET agent/adapters':
        // The chat's switcher (#344): every adapter with its model and whether it can answer, or none for an agent with no choice.
        {
          const list = agent.adapterOptions?.() ?? { chosen: null, options: [] };
          // With a toil project named (#494), the agent last used for its Analyze comes too; the page decides whether it is still ready.
          const toilProject = url.searchParams.get('toilProject');
          const remembered = toilProject && options.toilProjectAgents ? options.toilProjectAgents.get(toilProject) : null;
          json(res, 200, remembered ? { ...list, remembered } : list);
        }
        return;
      case 'GET agent/install':
        json(res, 200, control().installPlan(installAdapter(url.searchParams.get('adapter'))));
        return;
      case 'POST agent/install': {
        const body = await readJson(req);
        const adapter = installAdapter(body.adapter);
        if (typeof body.command !== 'string') throw new HttpError(400, 'Send the command the dialog showed, so only that command runs.', 'Send { "adapter": "<name>", "command": "<the command as shown>" }.');
        return streamInstall(res, control(), adapter, body.command, ctx.signal);
      }
      case 'POST agent/npm-registry': {
        // One line, registry=<url>, in the person's own user npmrc, for an install that couldn't reach the public registry (npmrc.ts).
        const body = await readJson(req);
        try {
          json(res, 200, setRegistry(npmrcPath(process.env, homedir()), checkRegistry(body.registry)));
        } catch (e) {
          if (e instanceof RegistryError) throw new HttpError(400, e.message, e.fix);
          throw e;
        }
        return;
      }
      case 'POST agent/settings': {
        const body = await readJson(req);
        try {
          json(res, 200, control().save(body));
        } catch (e) {
          if (e instanceof AgentError) throw new HttpError(400, e.message, e.fix);
          throw e;
        }
        return;
      }
      case 'GET usage':
        json(res, 200, usage().view());
        return;
      case 'POST usage/settings': {
        const body = await readJson(req);
        try {
          json(res, 200, usage().save(body));
        } catch (e) {
          if (e instanceof UsageSettingsError) throw new HttpError(400, e.message, e.fix);
          throw e;
        }
        return;
      }
      case 'GET sync':
        json(res, 200, syncer().status());
        return;
      case 'POST sync': {
        const body = await readJson(req);
        if (body.toilProject !== undefined && typeof body.toilProject !== 'string') throw new HttpError(400, 'Toil project must be a Toil project name.', 'Send {} to sync every Toil project, or { "toilProject": "<name>" } for one.');
        try {
          syncer().start(ctx, body.toilProject as string | undefined);
        } catch (e) {
          if (e instanceof SyncBusy) throw new HttpError(409, e.message, 'Wait for it to finish; the page shows its progress.');
          throw e;
        }
        json(res, 202, syncer().status());
        return;
      }
      case 'POST cache/wipe': {
        const body = await readJson(req);
        if (body.confirm !== 'wipe') throw new HttpError(400, 'Wiping the cache needs { "confirm": "wipe" }.', 'Confirm in the page; it deletes everything synced on this machine.');
        try {
          // The assignments live under the cache too, and one that is running holds it, as a sync does.
          if (options.assignments?.queue.busy) throw new HttpError(409, 'An assignment is running, so the cache stays until it ends.', 'Stop it from its page, or wait for it to finish, then wipe.');
          syncer().wipe();
          options.assignments?.queue.wipe();
        } catch (e) {
          if (e instanceof SyncBusy) throw new HttpError(409, 'A sync is running, so the cache stays until it ends.', 'Wait for the sync to finish, then wipe.');
          throw e;
        }
        json(res, 200, syncer().status());
        return;
      }
      case 'GET worklog/month': {
        const toilProject = named(url.searchParams.get('toilProject'), 'toilProject', `Ask ${base}api/worklog/month?toilProject=<name>&month=<yyyy-mm>.`);
        return worklogCall(res, () => worklog().month(toilProject, url.searchParams.get('month') ?? undefined));
      }
      case 'GET worklog/day': {
        const toilProject = named(url.searchParams.get('toilProject'), 'toilProject', `Ask ${base}api/worklog/day?toilProject=<name>&day=<yyyy-mm-dd>.`);
        const day = named(url.searchParams.get('day'), 'day', `Ask ${base}api/worklog/day?toilProject=<name>&day=<yyyy-mm-dd>.`);
        return worklogCall(res, () => worklog().day(toilProject, day));
      }
      case 'GET worklog/standup': {
        const shape = `Ask ${base}api/worklog/standup?toilProject=<name>&from=<yyyy-mm-dd>&to=<yyyy-mm-dd>.`;
        const toilProject = named(url.searchParams.get('toilProject'), 'toilProject', shape);
        return worklogCall(res, () => worklog().standup(toilProject, named(url.searchParams.get('from'), 'first day', shape), named(url.searchParams.get('to'), 'last day', shape)));
      }
      case 'POST worklog/rebuild': {
        const body = await readJson(req);
        const shape = 'Send { "toilProject": "<name>", "day": "<yyyy-mm-dd>" }.';
        only(body, ['toilProject', 'day'], 'A rebuild takes toilProject and day', shape);
        return worklogCall(res, () => worklog().rebuild(named(body.toilProject, 'toilProject', shape), named(body.day, 'day', shape)));
      }
      case 'POST worklog/note': {
        const body = await readJson(req);
        const shape = 'Send { "toilProject": "<name>", "text": "<the note>" }.';
        only(body, ['toilProject', 'text'], 'A note takes toilProject and text', shape);
        if (typeof body.text !== 'string') throw new HttpError(400, 'A note needs its text.', shape);
        return worklogCall(res, () => worklog().addNote(named(body.toilProject, 'toilProject', shape), body.text as string, viewer.name));
      }
      case 'POST worklog/export': {
        const body = await readJson(req);
        const shape = 'Send { "toilProject": "<name>", "day": "<yyyy-mm-dd>" }, { "toilProject": "<name>", "month": "<yyyy-mm>" } or, for a stand-up, { "toilProject": "<name>", "from": "<yyyy-mm-dd>", "to": "<yyyy-mm-dd>" }, with "folder": "<a full path>".';
        only(body, ['toilProject', 'day', 'month', 'from', 'to', 'folder'], "An export takes toilProject, a day, a month or a stand-up's from and to, and folder", shape);
        const standup = body.from !== undefined || body.to !== undefined;
        if ([body.day !== undefined, body.month !== undefined, standup].filter(Boolean).length !== 1) throw new HttpError(400, 'Export a day, a month or a stand-up, one of the three.', shape);
        const what: ExportWhat = standup ? { from: named(body.from, 'first day', shape), to: named(body.to, 'last day', shape) } : body.day !== undefined ? { day: named(body.day, 'day', shape) } : { month: named(body.month, 'month', shape) };
        return worklogCall(res, () => worklog().exportTo(named(body.toilProject, 'toilProject', shape), what, named(body.folder, 'folder', shape)));
      }
      default:
        throw new HttpError(404, `There is no ${key} in the API.`, `The API is under ${base}api/: info, execute, config, config/areas, config/settings, feedback, sync, cache/wipe, usage, usage/settings, worklog/month, worklog/day, worklog/standup, worklog/rebuild, worklog/note, worklog/export, analyses, analyses/one, fingerprint, agent/starters, agent/ask, agent/guide, agent/session, agent/renew, agent/prompt, agent/settings, agent/adapters, agent/install, agent/mcp and assignments.`);
    }
  };

  const serveFile = async (res: ServerResponse, route: string, extra: Record<string, string> = {}) => {
    let rel: string;
    try {
      rel = decodeURIComponent(route) || 'index.html';
    } catch {
      return text(res, 400, 'That path is not valid.');
    }
    const file = normalize(join(appDir, rel));
    const inside = relative(appDir, file);
    // A colon is never in an app file's name, and on Windows it would name a stream of one (`index.html::$DATA`).
    if (rel.includes('\0') || rel.includes(':') || inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) return text(res, 404, 'Not found.');
    try {
      if (!(await stat(file)).isFile()) return text(res, 404, 'Not found.');
      send(res, 200, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', await readFile(file), extra);
    } catch {
      text(res, 404, 'Not found.');
    }
  };

  /** A refusal of the request itself, in the body shape the page reads for any API failure. */
  const refuse = (res: ServerResponse, status: number, message: string, fix: string) => json(res, status, { error: { message, fix } });

  /** The names this server answers to: its own address, and the other two ways a browser spells loopback. */
  const hostNames = () => {
    const port = host.slice(host.lastIndexOf(':') + 1);
    return new Set([host, `127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);
  };

  /** The Set-Cookie for a navigation a browser made to the page, or none when the request isn't one. */
  const pageCookie = (req: IncomingMessage): Record<string, string> => {
    const site = req.headers['sec-fetch-site'];
    if (req.method !== 'GET' || req.headers['sec-fetch-dest'] !== 'document' || (site !== 'none' && site !== 'same-origin')) return {};
    return { 'Set-Cookie': `${COOKIE_NAME}=${issueCookie(machineSecret)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict` };
  };

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    // Before anything else: a Host this server doesn't answer to is a page trying to reach the port by another name (DNS rebinding).
    const peer = req.socket.remoteAddress;
    if (peer === undefined || !LOOPBACK_PEERS.has(peer)) {
      return refuse(res, 403, `This server answers only to programs on this machine, not to ${peer ?? 'an unknown address'}.`, `Open http://${host}${base} in a browser on the machine where toil-ui runs.`);
    }
    const asked = (req.headers.host ?? '').toLowerCase();
    if (!hostNames().has(asked)) {
      return refuse(res, 403, `This server answers only to ${[...hostNames()].join(', ')}, not ${JSON.stringify(req.headers.host ?? '')}.`, `Open http://${host}${base}, the address toil-ui printed when it started.`);
    }
    const url = new URL(req.url ?? '/', `http://${asked}`);
    const path = url.pathname;
    if (path === base.slice(0, -1)) return send(res, 308, 'text/plain; charset=utf-8', '', { Location: `${base}${url.search}` });
    if (!path.startsWith(base)) return text(res, 404, `Toil UI is served under ${base}.`);
    const route = path.slice(base.length);
    const isApi = route.startsWith('api/');
    if (req.method !== 'GET' && req.method !== 'HEAD' && !(isApi && req.method === 'POST')) {
      return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed.\n', { Allow: isApi ? 'GET, HEAD, POST' : 'GET, HEAD' });
    }
    // The app's files hold no data, so they need no checks beyond the Host's.
    // The page itself is where a browser is let in: only a top-level navigation to it, from nowhere or from itself, is given the cookie.
    if (!isApi) return serveFile(res, route, route === '' || route === 'index.html' ? pageCookie(req) : {});

    // A browser sends Origin on every cross-site request, a GET that changes state (the assignments inbox) included. The API answers its own page only.
    // The MCP route keeps its own, stricter refusal of any Origin.
    const mcpRoute = route === 'api/agent/mcp';
    const origin = req.headers.origin;
    if (!mcpRoute && origin !== undefined && origin !== `http://${asked}`) {
      return refuse(res, 403, `This server takes requests only from its own page, http://${asked}, not from ${JSON.stringify(origin)}.`, 'Use Toil UI in the browser tab toil-ui opened; another website cannot call it.');
    }
    if (!mcpRoute && req.method === 'POST' && !/^application\/json(\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      return refuse(res, 415, 'The API takes JSON only.', 'Send Content-Type: application/json.');
    }

    const fetchSite = req.headers['sec-fetch-site'];
    if (fetchSite !== undefined && fetchSite !== 'same-origin') {
      return refuse(res, 403, `This server takes requests only from its own page, not from one that is ${JSON.stringify(fetchSite)} to it.`, 'Use Toil UI in the browser tab toil-ui opened; another website cannot call it.');
    }
    // The MCP route is the agent CLI's, by its own bearer token; every other call is the page's, and carries the cookie.
    if (!mcpRoute && !verifyCookie(machineSecret, cookieNamed(req.headers.cookie, COOKIE_NAME))) {
      return refuse(res, 401, "This browser hasn't been let in: the request carried no valid Toil UI cookie.", `Open http://${host}${base} from the address bar or a bookmark, not from a link on another site, then reload.`);
    }

    const controller = new AbortController();
    res.on('close', () => controller.abort());
    const ctx: RequestContext = { viewer, signal: controller.signal };
    try {
      await api(req, res, route.slice('api/'.length), url, ctx);
    } catch (e) {
      if (res.headersSent) return;
      if (e instanceof HttpError || e instanceof AssignError) return json(res, e.status, { error: { message: e.message, fix: e.fix } });
      json(res, 500, { error: { message: `Toil UI failed answering ${route}: ${e instanceof Error ? e.message : String(e)}`, fix: 'This is a bug in Toil UI; report it with the message.' } });
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) text(res, 500, 'Toil UI failed answering the request.');
      else res.destroy();
    });
  });

  return {
    server,
    serveTools: (tools) => mcp.serve(tools),
    listen: () =>
      new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(settings.port, settings.host, () => {
          server.off('error', reject);
          const { port } = server.address() as AddressInfo;
          host = settings.host.includes(':') ? `[${settings.host}]:${port}` : `${settings.host}:${port}`;
          const origin = `http://${host}`;
          resolveListen({ origin, url: `${origin}${base}`, });
        });
      }),
    close: async () => {
      await options.sync?.close();
      await new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      });
    },
  };
}
