/**
 * What the three adapters share (#251). An adapter is a `Runtime`: the SDK
 * package it loads, the CLI it starts, and one `run` that sends the system
 * prompt, the question and the tools, streams the text back and returns the
 * final answer. Everything else lives here once: loading the SDK with a
 * dynamic import (it's an optional peer dependency, so it may not be there),
 * finding the CLI, building the toil project's read-only tools and their ledger,
 * streaming, and the checks in answer.ts. Three plugs, one socket.
 */

import type { ContextUse, PremiumQuota, UsageRecord } from '../../src/model-usage.ts';
import { AgentError, findCli } from './cli.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findPackage, packageUrl } from './package-path.ts';
import type { ToolSpec } from './tools.ts';

export type AdapterName = 'claude' | 'copilot' | 'codex';

/** Loads a module by name: `import()`, or a stub in the tests. */
export type Importer = (specifier: string) => Promise<unknown>;

/** Tools served over loopback HTTP as an MCP server, for an SDK that takes tools only that way (Codex). */
export interface ServedTools {
  url: string;
  /** A bearer token good for this one run; it goes to the CLI in its environment, never on its command line. */
  token: string;
  close(): void;
}
export type ServeTools = (tools: ToolSpec[]) => ServedTools;

/**
 * Implement mode's folder (#293): the agent may write inside `root` and
 * nowhere else, with no network, as the adapter's own sandbox enforces.
 */
export interface Workspace {
  root: string;
}

/** Something the agent did besides talking, for an assignment's transcript: a command it ran, a file it changed. */
export interface Activity {
  kind: 'command' | 'file' | 'tool';
  title: string;
  detail?: string;
}

export interface RunRequest {
  system: string;
  prompt: string;
  tools: ToolSpec[];
  model: string | null;
  /** The CLI to start, as findCli found it. */
  cli: string;
  /** An empty folder of Toil UI's own to run in, so the CLI picks up no project's files; implement mode's clone when there is a workspace. */
  workDir: string;
  /** Implement mode's folder, or null: every other run is read-only. */
  workspace: Workspace | null;
  /** What the agent did besides its text, where the SDK says. */
  onActivity?(activity: Activity): void;
  /** Toil UI's data folder, where an adapter may keep the CLI's own home (Codex, codex.ts). */
  dataDir: string;
  env: Record<string, string | undefined>;
  signal: AbortSignal;
  /** The answer's text so far: the whole of it each time, not a delta. */
  onText(text: string): void;
  serveTools: ServeTools;
  /** Settings that only one adapter reads (Claude's endpoint). */
  endpoint: Endpoint | null;
  importer: Importer;
  usage: UsageSink;
  /** Unique to this run: part of a usage report's id where the SDK gives the call none of its own. */
  runId: string;
}

export type Endpoint = 'anthropic' | 'bedrock' | 'foundry' | 'vertex';

/** One usage report in the SDK's own figures; the host adds the chat, turn, toil project, adapter and time (#295). */
export type UsageReport = Omit<UsageRecord, 'chatId' | 'turn' | 'toilProject' | 'adapter' | 'at'>;

/** Where an adapter sends what its SDK reports about usage, as it reports it (#295). */
export interface UsageSink {
  /** Every report of this run so far, replacing what the adapter sent before. */
  report(records: UsageReport[]): void;
  /** How full the model's context is, where the SDK says. */
  context(c: ContextUse): void;
  /** Copilot: the premium requests left, from the SDK's experimental quota call. */
  quota(q: PremiumQuota): void;
}

export interface Runtime {
  name: AdapterName;
  /** How the UI names it. */
  label: string;
  /** The SDK's npm name, loaded only if installed. */
  package: string;
  /** The CLI on PATH: `claude`, `copilot`, `codex`. */
  command: string;
  /** The CLI's own name, for messages. */
  cliLabel: string;
  /** Its SDK reports usage only once a turn is over (Codex), so a cap can't stop a run partway: it refuses the next question. */
  usageAtEnd?: boolean;
  /** Its own sandbox can hold the agent's commands and writes to one folder with no network (Codex), so it can take implement mode. */
  workspace?: boolean;
  /** Its SDK starts a `.js` CLI with Node (Copilot), so an npm shim on Windows resolves to the script it runs (#344). */
  scripts?: boolean;
  /** The npm package that holds the CLI and the script in it Node runs (Copilot): Install puts it beside Toil UI, and it is used when PATH has no usable CLI. */
  cliPackage?: { name: string; script: string };
  /** Sends one question; resolves with the final answer's text. */
  run(sdk: unknown, request: RunRequest): Promise<string>;
}

const missing = (e: unknown) => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND' || /Cannot find (module|package)/.test(String((e as Error | undefined)?.message));
};

/** The SDK module, or an AgentError naming the package to install. */
export async function loadSdk(runtime: Pick<Runtime, 'label' | 'package'>, importer: Importer): Promise<unknown> {
  try {
    return await importer(runtime.package);
  } catch (e) {
    if (missing(e)) {
      throw new AgentError(
        `The ${runtime.label} adapter needs ${runtime.package}, which isn't installed beside Toil UI.`,
        `If your organization approves it, press Install for ${runtime.label} under Settings, Agent, which shows the exact npm command first; or choose another adapter.`,
      );
    }
    throw new AgentError(`${runtime.package} is installed but failed to load: ${e instanceof Error ? e.message : String(e)}`, `Reinstall ${runtime.package}, or choose another adapter in Settings.`);
  }
}

/** The CLI for a runtime: the configured path, else PATH. */
export function cliFor(runtime: Pick<Runtime, 'cliLabel' | 'command' | 'scripts' | 'cliPackage'>, configured: string | null, env: Record<string, string | undefined>, platform: NodeJS.Platform, isFile?: (p: string) => boolean, cwd?: string, readText?: (p: string) => string | null): string {
  try {
    return findCli({ label: runtime.cliLabel, command: runtime.command, configured: configured ?? undefined, env, platform, ...(isFile ? { isFile } : {}), ...(cwd ? { cwd } : {}), ...(runtime.scripts ? { scripts: true } : {}), ...(readText ? { readText } : {}) });
  } catch (e) {
    // Nothing usable on PATH, or only a launcher script: the CLI Install put beside Toil UI. A path set in Settings is never overridden.
    const pkg = runtime.cliPackage;
    const found = !configured && !isFile && pkg ? findPackage(pkg.name) : null;
    if (found && pkg) {
      const script = join(found.dir, pkg.script);
      if (existsSync(script)) return script;
    }
    throw e;
  }
}

/** The real importer. The specifier is a variable, so the bundler leaves the import for Node to resolve at run time. */
export const nodeImporter: Importer = async (specifier) => {
  try {
    return await import(/* @vite-ignore */ specifier);
  } catch (e) {
    // Installed since this process first looked (#344): Node remembers the miss, so the package is imported by its file instead.
    const url = missing(e) ? packageUrl(specifier) : null;
    if (!url) throw e;
    return import(/* @vite-ignore */ url);
  }
};

/**
 * A callback-fed async iterable: the adapters push text as the SDK streams
 * it, and the agent yields each value. The last pushed value wins when the
 * reader falls behind, since each value is the whole answer so far.
 */
export class Latest<T> implements AsyncIterable<T> {
  private value: { v: T } | null = null;
  private done = false;
  private error: unknown = null;
  private wake: (() => void) | null = null;
  push(v: T) {
    this.value = { v };
    this.wake?.();
  }
  end(error?: unknown) {
    this.done = true;
    if (error !== undefined) this.error = error;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      if (this.value) {
        const { v } = this.value;
        this.value = null;
        yield v;
        continue;
      }
      if (this.done) {
        if (this.error !== null) throw this.error;
        return;
      }
      await new Promise<void>((r) => (this.wake = r));
      this.wake = null;
    }
  }
}
