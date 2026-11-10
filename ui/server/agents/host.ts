/**
 * The agent the server runs (#251): one `Agent` that answers through the
 * adapter chosen in Settings (Claude, Copilot or Codex), or through the
 * fallback (`noAgent`, which names the three) when none is chosen. It also
 * reports which SDKs and CLIs are on this machine for the Settings page, and
 * saves the choice to `~/.toil-ui/agent.json`.
 *
 * Every question runs with the toil project's read-only tools and a fresh ledger,
 * streams its text, and ends with answer.ts's checks: citations held to the
 * tool results, writes turned into proposals the pane shows and nobody here
 * runs. Each question is recorded as an agent run (#308) as it starts and
 * again as it ends, finished, failed or stopped, with its answer and
 * proposals, for the worklog. A switchboard with three lines and no outgoing
 * calls.
 *
 * Usage (#295): every adapter hands what its SDK reports to a sink here,
 * which stamps each report with the chat, turn, toil project and time, prices
 * Codex's from the person's rates. Whatever the outcome, the run's records go
 * to the ledger before the answer or the error does, and the answer carries them.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NO_AGENT_DETAILS, NO_AGENT_FIX, NO_AGENT_NOTICE, type AdapterList, type AdapterOption, type Answer, type AnswerActivity, type AskExtra, type Starter } from '../../src/agent.ts';
import type { AreaInfo, ConnectionsData } from '../../src/config.ts';
import { GUIDE_MAX, GUIDE_REFUSAL, GUIDE_REFUSAL_FIX, looksLikeSecret, type GuideRequest } from '../../src/guide.ts';
import { runFromAnswer, type AgentRun } from '../../src/model/worklog.ts';
import { codexCost, UsageSettingsError, type AnswerUsage, type ChatTurn, type CodexRates, type UsageRecord } from '../../src/model-usage.ts';
import type { Execute } from '../../src/toil.ts';
import type { Agent } from '../agent.ts';
import type { RequestContext } from '../context.ts';
import { finish, partial, writeCommands, type WriteCommand } from './answer.ts';
import { claudeRuntime } from './claude.ts';
import { AgentError } from './cli.ts';
import { codexRuntime } from './codex.ts';
import { copilotRuntime } from './copilot.ts';
import { GuideRefusal, guideAnswer, guideContext, guideSystem, guideTools, pagesFor } from './guide.ts';
import { jobQuestion, knownTargets } from './jobs.ts';
import { analyzeQuestion, promptFor, STARTERS, systemPrompt, withHistory } from './prompts.ts';
import { staleness, type ChatSession, type Fingerprint } from '../../src/fingerprint.ts';
import { sha256, type Fingerprints } from '../fingerprint.ts';
import { installedVersion, installPlan, runInstall, testedVersion, type InstallPlan, type InstallRun } from './install.ts';
import { findPackage } from './package-path.ts';
import { agentEnv } from './env.ts';
import { cliFor, Latest, loadSdk, nodeImporter, type Activity, type AdapterName, type Importer, type Runtime, type ServeTools, type UsageReport, type Workspace } from './runtime.ts';
import { loadUsageSettings, memoryLedger, type UsageLedger } from '../usage.ts';
import { checkAgentSettings, cliPathOf, loadAgentSettings, modelOf, saveAgentSettings, DEFAULT_AGENT_SETTINGS, ENDPOINTS, type AgentSettings } from './settings.ts';
import { promptStyle, type StyleChoice } from './voices.ts';
import { CALLER } from '../store.ts';
import { cacheTools, toilProjectReader, Ledger, liveTools, peopleTools, proposalTool, prTools, readinessTools, recorded, standupTool, worklogTool, type AgentData, type MapIds, type ReadCommand, type ToolSpec } from './tools.ts';

/** A task Toil UI wrote for an agent (#293): an assignment's run. */
export interface TaskRequest {
  adapter: AdapterName;
  toilProject: string;
  /** The usage ledger's chat: the assignment's id, so its usage is counted as one chat. */
  chat: string;
  system: string;
  prompt: string;
  tools: ToolSpec[];
  /** Implement mode: the folder the agent may write in. Only an adapter whose own sandbox bounds it takes one. */
  workspace: Workspace | null;
  signal: AbortSignal;
  onText(text: string): void;
  onActivity?(activity: Activity): void;
}

/** One run, as `once` takes it. */
interface RunSpec extends Omit<TaskRequest, 'adapter' | 'chat'> {
  runtime: Runtime;
  turn: ChatTurn;
}

export interface AgentHostOptions {
  dataDir: string;
  /** Toil UI's version, for the SDKs' client labels. */
  version: string;
  /** The toil project's synced rows, or null when it has never synced. */
  data(toilProject: string): AgentData | null;
  /** toil's registry: the live tools come from its reads, the proposals' commands from its writes. */
  registry: readonly ReadCommand[];
  execute: Execute;
  mapIds: MapIds;
  /** toil's areas as the settings pages describe them (their connection fields and scopes): the setup guide's context and its scope lookup (#561). */
  areas?: readonly AreaInfo[];
  serveTools: ServeTools;
  /** What answers when no adapter is chosen. */
  fallback: Agent;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  importer?: Importer;
  /** Whether a package resolves from here, without loading it. */
  installed?: (specifier: string) => boolean;
  isFile?: (path: string) => boolean;
  /** The working directory, which a PATH search skips; process.cwd() by default. */
  cwd?: string;
  runtimes?: Runtime[];
  now?: () => string;
  /**
   * Each question, as an agent run (#308): once as it starts and once as it
   * ends. The worklog keeps it. A failure here is never the question's.
   */
  onRun?: (run: AgentRun) => Promise<void> | void;
  /** How many finished runs of a job's question the worklog holds, so a loop (Ship) can stop at its limit (#532). */
  rounds?: (toilProject: string, label: string, self: { id: string; startedAt: string }) => number;
  /** Where usage records go (#295): the cache's ledger, or one in memory. */
  ledger?: UsageLedger;
  /** Toil UI's own package folder, the one holding dist/server/toil-ui.js: where Install puts an SDK (install.ts, #344). */
  uiDir?: string;
  /** Runs an install's plan; the real one spawns npm, the tests pass their own. */
  installer?: typeof runInstall;
  /** Resolves a package from here, for its version: import.meta.resolve, or a stub. */
  resolve?: (specifier: string) => string;
  readText?: (path: string) => string | null;
  /** The Node running Toil UI, which runs npm's CLI for Install. */
  execPath?: string;
  /** What each chat started on (#305); absent, chats record nothing and never go stale. */
  fingerprints?: Fingerprints;
}

/** A chat's session as the server holds it (#305): what it started on, and whether a question runs now. */
interface ChatRecord {
  toilProject: string;
  origin: Fingerprint;
  startedAt: string;
  renewals: number;
  running: number;
}

/** How many chats' fingerprints the server keeps; the oldest goes first. A chat lives in one page, so this is plenty. */
export const MAX_CHATS = 200;

/** What the Settings page shows about one adapter on this machine. */
export interface AdapterStatus {
  name: AdapterName;
  label: string;
  package: string;
  /** The SDK resolves beside Toil UI. */
  installed: boolean;
  /** Its version, as it resolves, or null when it isn't installed (#344). */
  version: string | null;
  /** The version Toil UI was tested with, which Install installs. */
  tested: string;
  /** The CLI this adapter would start, or why there is none. */
  cli: { path: string | null; problem: string | null; fix: string | null };
  /** Claude only: the endpoints it can be pointed at. */
  endpoints: readonly string[];
  /** The model it runs with (#344), or null for its CLI's default. */
  model: string | null;
  /** The command Install would run, or why it can't here (install.ts). */
  install: InstallPlan;
  /** Things found that aren't failures, each in words with what it means. */
  notes: string[];
}

export interface AgentStatus {
  settings: AgentSettings;
  /** Why the saved settings couldn't be read, if they couldn't. */
  problem: string | null;
  adapters: AdapterStatus[];
  /** What answers now: an adapter's name, or the fallback's kind. */
  kind: string;
}

/** What the usage ledger files a setup guide question under: it is about no Toil project. */
const GUIDE_PROJECT = '(setup guide)';

/** How many questions may run at once (Bounds): each one starts a CLI. */
export const MAX_RUNS = 2;

const defaultInstalled = (specifier: string) => {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    // Installed since this process first looked (#344): Node remembers the miss, the disk doesn't.
    return findPackage(specifier) !== null;
  }
};

/** Where a tool reads, for the status line (#343): a live read names its toil command. */
const sourceOf = (t: ToolSpec): NonNullable<AnswerActivity['source']> => (t.command ? 'live' : t.name === 'proposal_fields' ? 'registry' : 'cache');

export class AgentHost implements Agent {
  private settings: AgentSettings;
  private problem: string | null = null;
  private running = 0;
  /** How many questions are running now. */
  get active(): number {
    return this.running;
  }
  private readonly runtimes: Runtime[];
  private readonly writes: Map<string, WriteCommand>;
  /** The usage ledger (#295). */
  readonly ledger: UsageLedger;
  /** Each chat's fingerprint (#305), by chat id, oldest first. */
  private readonly chats = new Map<string, ChatRecord>();
  /** The setup guide's turn counter, so each question is its own turn in the usage ledger. */
  private guideTurns = 0;

  constructor(private readonly o: AgentHostOptions) {
    this.runtimes = o.runtimes ?? [claudeRuntime(o.version), copilotRuntime(), codexRuntime()];
    this.ledger = o.ledger ?? memoryLedger();
    this.writes = writeCommands(o.registry);
    try {
      this.settings = loadAgentSettings(o.dataDir);
    } catch (e) {
      this.settings = { ...DEFAULT_AGENT_SETTINGS };
      this.problem = e instanceof AgentError ? `${e.message} ${e.fix}` : String(e);
    }
  }

  private runtime(name: string = this.settings.adapter): Runtime | null {
    return this.runtimes.find((r) => r.name === name) ?? null;
  }

  /** "Codex", or "Claude (haiku)": who answers, with the model Settings gave it. */
  private byOf(runtime: Runtime): string {
    const model = modelOf(this.settings, runtime.name);
    return model ? `${runtime.label} (${model})` : runtime.label;
  }

  get kind(): string {
    return this.runtime()?.name ?? this.o.fallback.kind;
  }

  /** The same starters whichever adapter answers, and with none chosen, since a chat can switch to one (#344). */
  async starters(_ctx: RequestContext, _toilProject: string): Promise<Starter[]> {
    return STARTERS.map(({ id, label }) => ({ id, label }));
  }

  async ask(ctx: RequestContext, toilProject: string, prompt: string, style: StyleChoice | null = null, chat?: ChatTurn, extra: AskExtra = {}): Promise<Answer> {
    let last: Answer | undefined;
    for await (const a of this.stream(ctx, toilProject, prompt, style, chat, extra)) last = a;
    if (!last) throw new AgentError('The agent ended without an answer.', 'Ask again.');
    return last;
  }

  /** The tools a question about this toil project gets, and the ledger they fill: what every adapter is handed. */
  tools(toilProject: string, data: AgentData, ledger: Ledger): ToolSpec[] {
    const now = this.o.now ?? (() => new Date().toISOString());
    return recorded([...cacheTools(toilProject, data, ledger), ...prTools(toilProject, data, ledger), ...peopleTools(toilProject, data, ledger, toilProjectReader(this.o.execute, toilProject)), ...worklogTool(toilProject, data, ledger, now), ...standupTool(toilProject, data, ledger, now), ...readinessTools(toilProject, data, ledger, toilProjectReader(this.o.execute, toilProject)), proposalTool(this.o.registry), ...liveTools(toilProject, this.o.registry, this.o.execute, this.o.mapIds, ledger)], ledger);
  }

  /**
   * The system prompt a question about this toil project gets now, in this style:
   * what every adapter is handed, for Settings' "Show the full prompt" (#283).
   */
  systemPrompt(toilProject: string, style: StyleChoice | null): string {
    return systemPrompt(toilProject, (this.o.now ?? (() => new Date().toISOString()))(), promptStyle(style, this.settings));
  }

  private clock(): string {
    return (this.o.now ?? (() => new Date().toISOString()))();
  }

  async *stream(ctx: RequestContext, toilProject: string, prompt: string, style: StyleChoice | null = null, chat?: ChatTurn, extra: AskExtra = {}): AsyncIterable<Answer> {
    // The chat's own adapter (#344) wins over Settings' for this question only.
    const runtime = extra.adapter ? this.runtime(extra.adapter) : this.runtime();
    if (extra.adapter && !runtime) throw new AgentError(`Toil UI has no ${extra.adapter} adapter.`, 'Choose claude, copilot or codex.');
    if (!runtime) {
      yield await this.o.fallback.ask(ctx, toilProject, prompt, style);
      return;
    }
    if (this.running >= MAX_RUNS) throw new AgentError(`${MAX_RUNS} questions are already running.`, 'Wait for an answer, then ask again.');
    // Counted from here, before anything can await, and given back in the finally whatever fails: the SDK load, the CLI search, the run.
    this.running++;
    // The chat's own session (#305): recorded at its first question, and held as running so a renew waits for the answer.
    const held = chat && this.o.fingerprints ? await this.hold(chat.id, toilProject).catch(() => null) : null;
    let run: Promise<void> | undefined;
    const now = this.o.now ?? (() => new Date().toISOString());
    const asked = promptFor(toilProject, prompt).label;
    let record: AgentRun = {
      id: randomUUID(), kind: 'ask', toilProject, startedAt: now(), finishedAt: null, outcome: 'running',
      by: this.byOf(runtime), prompt: asked, answer: null, error: null, citations: [], unverified: [], proposals: [],
    };
    const report = async () => {
      try {
        await this.o.onRun?.(record);
      } catch {
        // The worklog's record of a question never fails the question.
      }
    };
    await report();
    let last: Answer | undefined;
    try {
      const data = this.o.data(toilProject);
      if (!data) throw new AgentError(`Toil UI hasn't synced ${toilProject} yet, so the agent has nothing to read.`, 'Press Sync now in the Sync panel, then ask again.');
      const ledger = new Ledger();
      const asking = prompt === 'analyze' ? await analyzeQuestion(this.o.execute, toilProject) : (jobQuestion(toilProject, prompt, (l) => this.o.rounds?.(toilProject, l, record) ?? 0, knownTargets(data.changes())) ?? { ...promptFor(toilProject, prompt), warning: null });
      const { label, text: question } = asking;
      // The chat so far goes before the question, so a follow-up or a switched adapter continues from it (#344).
      const { text, carried } = withHistory(question, extra.history);
      const by = this.byOf(runtime);
      const who = { adapter: runtime.name, model: modelOf(this.settings, runtime.name), ...(carried ? { carried } : {}) };
      const out = new Latest<Answer>();
      // The status line (#343): every partial answer says what the agent is doing, whichever adapter it is.
      let sofar = '';
      const doing = (activity: AnswerActivity) => out.push({ ...partial(sofar, { prompt: label, by }), ...who, activity });
      doing({ phase: 'thinking' });
      const watched = this.tools(toilProject, data, ledger).map((t): ToolSpec => ({
        ...t,
        run: (input, signal) => {
          doing({ phase: 'tool', tool: t.command ?? t.name, source: sourceOf(t) });
          return t.run(input, signal);
        },
      }));
      run = this.once({
        runtime,
        toilProject,
        // A question with no chat (an API caller) is a chat of its own.
        turn: chat ?? { id: `ask-${randomUUID()}`, turn: 1 },
        // The rules, then the theme's voice or the person's own, then their instructions (prompts.ts): the same for all three adapters.
        system: this.systemPrompt(toilProject, style),
        prompt: text,
        tools: watched,
        workspace: null,
        signal: ctx.signal,
        onText: (t) => {
          sofar = t;
          doing({ phase: 'writing' });
        },
      }).then(
        async ({ text: final, usage }) => {
          const session = held ? await this.checked(held).catch(() => null) : null;
          // A job's proposals may name only the writes its page lists; anything else drops like any invalid one.
          const only = 'writes' in asking ? (asking.writes as readonly string[]) : undefined;
          const allowed = only ? new Map([...this.writes].filter(([name]) => only.includes(name))) : this.writes;
          const done = finish(final, { toilProject, prompt: label, by, ledger, writes: allowed });
          if (asking.warning) done.warnings = [...(done.warnings ?? []), asking.warning];
          out.push({ ...done, ...who, usage, ...(session ? { session } : {}) });
          out.end();
        },
        (e: unknown) => out.end(e),
      );
      for await (const answer of out) {
        last = answer;
        yield answer;
      }
      record = runFromAnswer(record, now(), last ?? { prompt: asked, parts: [], citations: [], by, proposals: [] });
    } catch (e) {
      const message = e instanceof AgentError ? `${e.message} ${e.fix}` : e instanceof Error ? e.message : String(e);
      record = { ...(last ? runFromAnswer(record, now(), last) : { ...record, finishedAt: now() }), outcome: ctx.signal.aborted ? 'stopped' : 'failed', error: message };
      throw e;
    } finally {
      await run;
      this.running--;
      if (held) held.running--;
      // The person closed the pane or the page mid-answer: the run stopped, with what it had said so far.
      if (record.outcome === 'running') record = { ...(last ? runFromAnswer(record, now(), last) : { ...record, finishedAt: now() }), outcome: 'stopped' };
      await report();
    }
  }

  /**
   * One question to the setup guide (#561), about the wizard's step and the
   * non-secret state it names. It is checked first, before a record, a
   * connection list or an agent exists: a message that looks like a secret,
   * or any earlier question that does, is refused with the same notice the page
   * shows, and nothing of it is kept. Then it runs like any question (the
   * chosen adapter, the same ledger, the same streamed answer) with
   * the guide's own prompt and tools, and no Toil project or sync needed. It
   * is not a worklog run: it is about setup, not about anyone's work.
   */
  async *guide(ctx: RequestContext, req: GuideRequest, style: StyleChoice | null = null, history: ReadonlyArray<{ prompt: string; answer: string; by?: string }> = []): AsyncIterable<Answer> {
    if (req.message.length > GUIDE_MAX || [req.message, ...history.map((t) => t.prompt)].some(looksLikeSecret)) throw new GuideRefusal(GUIDE_REFUSAL, GUIDE_REFUSAL_FIX);
    const runtime = this.runtime();
    if (!runtime) throw new AgentError(NO_AGENT_NOTICE, `${NO_AGENT_DETAILS} ${NO_AGENT_FIX}`);
    const known = new Set((this.o.areas ?? []).map((a) => a.name));
    const unknown = [...req.state.areas, ...(req.state.area ? [req.state.area] : [])].filter((a) => known.size > 0 && !known.has(a));
    if (unknown.length) throw new AgentError(`toil has no tool ${unknown.join(', ')}.`, 'Name a tool from the list on the Tools step.');
    if (this.running >= MAX_RUNS) throw new AgentError(`${MAX_RUNS} questions are already running.`, 'Wait for an answer, then ask again.');
    this.running++;
    let run: Promise<void> | undefined;
    try {
      // What the guide is told of the machine: connections as toil lists them, which never carries a value. Read-only, and not the page's say-so.
      const listed = await this.o.execute('connections list', {}, { readOnly: true, caller: CALLER, signal: ctx.signal });
      const rows = listed.ok ? (listed.data as ConnectionsData).connections : null;
      const areas = this.o.areas ?? [];
      const now = this.clock();
      const system = guideSystem(guideContext(req.state, rows, areas), pagesFor(req.state), now, promptStyle(style, this.settings));
      const ledger = new Ledger();
      const by = this.byOf(runtime);
      const { text, carried } = withHistory(req.message, history);
      const who = { adapter: runtime.name, model: modelOf(this.settings, runtime.name), ...(carried ? { carried } : {}) };
      const out = new Latest<Answer>();
      let sofar = '';
      const doing = (activity: AnswerActivity) => out.push({ ...partial(sofar, { prompt: req.message, by }), ...who, activity });
      doing({ phase: 'thinking' });
      // Reads only: the docs, a tool's scopes, and (once a Toil project exists) toil's live reads for it.
      const tools = recorded([...guideTools(req.state, areas), ...(req.state.project ? liveTools(req.state.project, this.o.registry, this.o.execute, this.o.mapIds, ledger) : [])], ledger).map((t): ToolSpec => ({
        ...t,
        run: (input, signal) => {
          doing({ phase: 'tool', tool: t.command ?? t.name, source: t.command ? 'live' : 'registry' });
          return t.run(input, signal);
        },
      }));
      run = this.once({
        runtime,
        toilProject: GUIDE_PROJECT,
        turn: { id: req.chat, turn: ++this.guideTurns },
        system,
        prompt: text,
        tools,
        workspace: null,
        signal: ctx.signal,
        onText: (t) => {
          sofar = t;
          doing({ phase: 'writing' });
        },
      }).then(
        ({ text: final, usage }) => {
          out.push({ ...guideAnswer(final, { prompt: req.message, by }), ...who, usage });
          out.end();
        },
        (e: unknown) => out.end(e),
      );
      yield* out;
    } finally {
      await run;
      this.running--;
    }
  }

  /**
   * The prompts part of a chat's fingerprint (#305): the system prompt for a
   * placeholder toil project and time, every starter and Analyze, and the
   * person's instructions and custom voice. The theme on screen isn't in it:
   * a person switching theme isn't the ground moving.
   */
  chatPrompts(): string {
    const d = '<Toil project>';
    return sha256({ system: systemPrompt(d, '<now>', promptStyle(null, this.settings)), voice: this.settings.voice, starters: STARTERS.map((s) => s.prompt(d)), analyze: promptFor(d, 'analyze').text });
  }

  /** A chat's record, made at its first question; marked running until the question ends. */
  private async hold(chatId: string, toilProject: string): Promise<ChatRecord> {
    let r = this.chats.get(chatId);
    if (!r || r.toilProject !== toilProject) {
      r = { toilProject, origin: await this.o.fingerprints!.origin(toilProject, this.chatPrompts()), startedAt: this.clock(), renewals: 0, running: 0 };
      this.chats.set(chatId, r);
      while (this.chats.size > MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
    }
    r.running++;
    return r;
  }

  private async checked(r: ChatRecord): Promise<ChatSession> {
    const current = await this.o.fingerprints!.current(r.toilProject, this.chatPrompts());
    const stale = staleness(r.origin, current);
    return { startedAt: r.startedAt, stale: stale ? { ...stale, restart: this.o.fingerprints!.restartNeeded() } : null, renewals: r.renewals };
  }

  /** A chat's session now (#305), checked against the current fingerprint; null for a chat that hasn't asked yet. */
  async session(chatId: string): Promise<ChatSession | null> {
    const r = this.chats.get(chatId);
    return r && this.o.fingerprints ? this.checked(r) : null;
  }

  /**
   * Renews a chat (#305): records what it starts on now, so its next
   * question is held to today's fingerprint. Every question already starts
   * a fresh run with the current prompt and the chat's last turns, so that
   * is the whole of it; the chat's usage total carries on, so a renew never
   * resets it. Refused while a question runs: a renew never interrupts a turn.
   */
  async renew(chatId: string, toilProject: string): Promise<ChatSession> {
    if (!this.o.fingerprints) throw new AgentError('This Toil UI records no sessions, so there is nothing to renew.', 'Start toil-ui with its cache to record what each chat started on.');
    // A chat renewed on an out-of-date server would start on the old build, stale at once: only a restart helps.
    const restart = this.o.fingerprints.restartNeeded();
    if (restart) throw Object.assign(new AgentError("This chat can't be renewed until Toil UI restarts.", restart), { status: 409 });
    const r = this.chats.get(chatId);
    if (r?.running) throw Object.assign(new AgentError('This chat is answering a question now, and a renew never interrupts one.', 'Wait for the answer, or press Stop, then renew.'), { status: 409 });
    const next: ChatRecord = { toilProject, origin: await this.o.fingerprints.origin(toilProject, this.chatPrompts()), startedAt: this.clock(), renewals: (r?.renewals ?? 0) + 1, running: 0 };
    this.chats.delete(chatId);
    this.chats.set(chatId, next);
    while (this.chats.size > MAX_CHATS) this.chats.delete(this.chats.keys().next().value!);
    return this.checked(next);
  }

  /**
   * One run of an agent on a task Toil UI wrote (#293), on the adapter it
   * names rather than the one Settings chose, through the same usage path
   * as a question: the assignment is the chat. Resolves with the final text
   * and what the run used; rejects with an AgentError carrying the usage.
   * Assignments keep their own count (the queue's `concurrent`), so a running
   * assignment doesn't take a question's place.
   */
  async task(t: TaskRequest): Promise<{ text: string; usage: AnswerUsage; model: string | null }> {
    const runtime = this.runtimes.find((r) => r.name === t.adapter);
    if (!runtime) throw new AgentError(`Toil UI has no ${t.adapter} adapter.`, 'Choose claude, copilot or codex.');
    if (t.workspace && !runtime.workspace) throw new AgentError(`${runtime.label} can't work in a folder through Toil UI: only Codex's own sandbox bounds its commands to one folder here.`, 'Choose Codex for implement mode.');
    const model = modelOf(this.settings, runtime.name);
    const { text, usage } = await this.once({ ...t, runtime, turn: { id: t.chat, turn: 1 } });
    return { text, usage, model };
  }

  /** The adapters, for the Assign dialog: whether each can run here, and whether it can work in a folder (implement mode). */
  adapterChoices(): Array<{ name: AdapterName; label: string; model: string | null; problem: string | null; workspace: boolean }> {
    return this.adapterOptions().options.map((a) => ({
      name: a.name as AdapterName,
      label: a.label,
      model: a.model,
      problem: a.problem,
      workspace: this.runtimes.find((r) => r.name === a.name)?.workspace === true,
    }));
  }

  /**
   * The adapters a chat can switch between (#344): each with its model, and
   * ready or not with the reason and what to do: Install when its SDK is
   * missing, Fix for anything else (its CLI not found, a shim, a broken path).
   */
  adapterOptions(): AdapterList {
    const options = this.status().adapters.map((a): AdapterOption => {
      if (!a.installed) {
        return { name: a.name, label: a.label, model: a.model, ready: false, problem: `The ${a.label} adapter needs ${a.package}, which isn't installed beside Toil UI.`, fix: a.install.argv ? `Press Install under Settings, Agent: it runs ${a.install.command}` : (a.install.fix ?? null), action: 'install' };
      }
      if (a.cli.problem) return { name: a.name, label: a.label, model: a.model, ready: false, problem: a.cli.problem, fix: a.cli.fix, action: 'fix' };
      return { name: a.name, label: a.label, model: a.model, ready: true, problem: null, fix: null, action: null };
    });
    return { chosen: this.chosen, options };
  }

  /** The command Install would run for an adapter, or why it can't here. */
  installPlan(adapter: AdapterName): InstallPlan {
    return installPlan(adapter, {
      uiDir: this.o.uiDir ?? '',
      platform: this.o.platform ?? process.platform,
      execPath: this.o.execPath ?? process.execPath,
      env: this.o.env ?? process.env,
      now: this.clock(),
      ...(this.o.isFile ? { exists: this.o.isFile } : {}),
      ...(this.o.readText ? { readText: this.o.readText } : {}),
    });
  }

  private installing = false;

  /**
   * Install (#344): runs the plan the person was shown, and only that one.
   * `command` is what their dialog showed; if the plan has changed since (a
   * new day moves --before, another SDK arrived), nothing runs and they are
   * shown the new one. Then the SDK is loaded, as an answer would load it,
   * to prove it installed. One install at a time.
   */
  async install(adapter: AdapterName, command: string, onLine: (line: string) => void, signal: AbortSignal): Promise<{ run: InstallRun; status: AdapterStatus }> {
    const runtime = this.runtime(adapter);
    if (!runtime) throw new AgentError(`Toil UI has no ${adapter} adapter.`, 'Choose claude, copilot or codex.');
    const plan = this.installPlan(adapter);
    if (!plan.argv) throw new AgentError(plan.problem ?? "Install can't run here.", plan.fix ?? 'Copy the command and run it yourself.');
    if (plan.command !== command) throw new AgentError("The install command has changed since it was shown, so it didn't run.", `Read the new command, then press Install again: ${plan.command}`);
    if (this.installing) throw new AgentError('An install is already running.', 'Wait for it to finish, then press Install again.');
    this.installing = true;
    try {
      const run = await (this.o.installer ?? runInstall)(plan, { env: this.o.env ?? process.env, onLine, signal });
      if (run.code === null) throw new AgentError('The install was stopped before npm finished, so the SDK may be half installed.', `Press Install again to finish it, or run ${plan.command} yourself.`);
      if (run.code !== 0) {
        const said = run.output.filter((l) => /npm (error|ERR!)/i.test(l)).slice(-6).join('\n') || run.output.slice(-6).join('\n');
        throw new AgentError(`npm stopped with exit code ${run.code}: ${said || 'it printed nothing'}`, 'Fix what npm says above (a registry, a proxy, a permission), then press Install again; or copy the command and run it yourself.');
      }
      try {
        await loadSdk(runtime, this.o.importer ?? nodeImporter);
      } catch (e) {
        throw new AgentError(`npm finished, but ${runtime.package} still doesn't load from Toil UI: ${e instanceof Error ? e.message : String(e)}`, `Check that npm installed it into ${plan.folder}, the folder Toil UI resolves packages from, then restart Toil UI.`);
      }
      const status = this.status().adapters.find((a) => a.name === adapter)!;
      return { run, status };
    } finally {
      this.installing = false;
    }
  }

  /** The adapter chosen in Settings, or null. */
  get chosen(): AdapterName | null {
    return this.runtime()?.name ?? null;
  }

  /**
   * One run, whatever asked for it: loads the SDK, finds the CLI, prices
   * Codex usage from the person's rates, and settles the usage in the
   * ledger before the text or the error leaves. Stops on the caller's signal.
   */
  private async once(s: RunSpec): Promise<{ text: string; usage: AnswerUsage }> {
    const { runtime, toilProject, turn } = s;
    const importer = this.o.importer ?? nodeImporter;
    const env = this.o.env ?? process.env;
    const sdk = await loadSdk(runtime, importer);
    // Each adapter runs with its own model and CLI path from Settings (#344), or its CLI's defaults.
    const cli = cliFor(runtime, cliPathOf(this.settings, runtime.name), env, this.o.platform ?? process.platform, this.o.isFile, this.o.cwd, this.o.readText);

    // A usage file that can't be read doesn't refuse the question, but a Codex answer would silently lack its dollar figure, so it says why (principle 4).
    let rates: CodexRates | null = null;
    const notices: string[] = [];
    if (runtime.name === 'codex') {
      try {
        rates = loadUsageSettings(this.o.dataDir).codexRates;
      } catch (e) {
        notices.push('This answer has no dollar figure: ' + (e instanceof UsageSettingsError ? `${e.message} ${e.fix}` : e instanceof Error ? e.message : String(e)));
      }
    }
    let records: UsageRecord[] = [];
    const extra: Pick<AnswerUsage, 'context' | 'quota'> = {};
    const stamp = (r: UsageReport): UsageRecord => {
      const record: UsageRecord = { ...r, chatId: turn.id, turn: turn.turn, toilProject, adapter: runtime.name, at: this.clock() };
      const cost = rates ? codexCost(record, rates) : undefined;
      return cost === undefined ? record : { ...record, costUsd: cost, costSource: 'your-rates' };
    };
    const usage = {
      report: (reports: UsageReport[]) => {
        records = reports.map(stamp);
      },
      context: (c: NonNullable<AnswerUsage['context']>) => void (extra.context = c),
      quota: (q: NonNullable<AnswerUsage['quota']>) => void (extra.quota = q),
    };
    // Before the answer or the error leaves: whatever the run used is in the ledger, and the answer says so.
    const settle = (): AnswerUsage => {
      this.ledger.add(records);
      return { adapter: runtime.name, records, notices, ...extra };
    };

    const workDir = s.workspace?.root ?? join(this.o.dataDir, 'agent');
    mkdirSync(workDir, { recursive: true, mode: 0o700 });
    let final: string;
    try {
      final = await runtime.run(sdk, {
        system: s.system,
        prompt: s.prompt,
        tools: s.tools,
        model: modelOf(this.settings, runtime.name),
        cli,
        workDir,
        workspace: s.workspace,
        dataDir: this.o.dataDir,
        // Only what this CLI needs: never toil's variables, GITHUB_TOKEN or CI tokens (env.ts).
        env: agentEnv(env, runtime.name),
        signal: s.signal,
        onText: s.onText,
        ...(s.onActivity ? { onActivity: s.onActivity } : {}),
        serveTools: this.o.serveTools,
        endpoint: runtime.name === 'claude' ? this.settings.endpoint : null,
        importer,
        usage,
        runId: randomUUID(),
      });
    } catch (e) {
      // The error carries what the run used, so the chat counts it as the ledger just did.
      const used = settle();
      const failure =
        e instanceof AgentError
          ? e
          : s.signal.aborted
            ? // A person's Stop is not a sign-in problem, whatever the SDK threw on the way out (#317).
              new AgentError(`${runtime.label} was stopped before it finished.`, 'Ask again for a whole answer; what had arrived is kept.')
            : new AgentError(`${runtime.label} failed: ${e instanceof Error ? e.message : String(e)}`, `Check that ${runtime.cliLabel} is signed in (run ${runtime.command} once on its own), then ask again.`);
      if (used.records.length) failure.usage = used;
      throw failure;
    }
    const used = settle();
    return { text: final, usage: used };
  }

  /** The adapters on this machine and the saved choice, for the Settings page. */
  status(): AgentStatus {
    const installed = this.o.installed ?? defaultInstalled;
    const env = this.o.env ?? process.env;
    const resolve = this.o.resolve ?? ((s: string) => import.meta.resolve(s));
    const adapters = this.runtimes.map((r): AdapterStatus => {
      let cli: AdapterStatus['cli'];
      const notes: string[] = [];
      try {
        const path = cliFor(r, cliPathOf(this.settings, r.name), env, this.o.platform ?? process.platform, this.o.isFile, this.o.cwd, this.o.readText);
        cli = { path, problem: null, fix: null };
        // npm's copilot.cmd can't be started without a shell; the script it runs can, by Node, which is what Copilot's SDK does with a .js path.
        if (r.scripts && path.endsWith('.js')) notes.push(`${r.command}.cmd on PATH is an npm shim the SDK can't start, so Toil UI starts the script it runs, ${path}, with Node.`);
      } catch (e) {
        cli = { path: null, problem: e instanceof Error ? e.message : String(e), fix: e instanceof AgentError ? e.fix : null };
      }
      const has = installed(r.package);
      const version = has ? (installedVersion(r.package, resolve, this.o.readText) ?? (this.o.resolve ? null : (findPackage(r.package)?.version ?? null))) : null;
      const tested = testedVersion(r.name);
      // A skipped optional dependency is each SDK's own copy of its CLI, which Toil UI never starts: worth saying, never a failure.
      if (has && r.name === 'claude' && !installed(`${r.package}-${this.o.platform ?? process.platform}-${process.arch}`)) notes.push(`${r.package}'s bundled Claude Code isn't installed (an optional dependency npm skipped). Toil UI doesn't need it: it starts the claude it finds.`);
      if (has && version && version !== tested) notes.push(`${r.package} ${version} is installed; Toil UI was tested with ${tested}.`);
      return { name: r.name, label: r.label, package: r.package, installed: has, version, tested, cli, endpoints: r.name === 'claude' ? ENDPOINTS : [], model: modelOf(this.settings, r.name), install: this.installPlan(r.name), notes };
    });
    return { settings: { ...this.settings }, problem: this.problem, adapters, kind: this.kind };
  }

  /** Checks and saves a new choice; the next question uses it. */
  save(input: unknown): AgentStatus {
    const next = checkAgentSettings(input);
    saveAgentSettings(this.o.dataDir, next);
    this.settings = next;
    this.problem = null;
    return this.status();
  }
}
