/**
 * The Codex adapter (#251): the Codex SDK (`@openai/codex-sdk`, an optional
 * peer dependency) running the `codex` CLI already on this machine
 * (`codexPathOverride`), so the copy the SDK's own dependency brings is never
 * started. It signs in the way the CLI does (a ChatGPT plan or the CLI's own
 * API key setup); Toil UI passes no key.
 *
 * Codex takes tools only from MCP servers, so Toil UI serves the toil project's
 * read tools for the length of one run on its own loopback server
 * (`api/agent/mcp`, server.ts), behind a bearer token made for the run. The
 * token reaches Codex in its environment (`bearer_token_env_var`), never on
 * its command line, where any process could read it.
 *
 * Codex runs in a Codex home of Toil UI's own (#300), `<data folder>/cache/codex`,
 * never the user's. Codex merges a `--config` table into the config in its
 * home rather than replacing it, so with the user's home every MCP server,
 * profile, plugin, hook, skill and AGENTS.md of theirs came along (#287).
 * Toil UI's home holds a `config.toml` it rewrites before every run and one
 * other file: `auth.json`, a hard link to the one in the user's own Codex home
 * (`$CODEX_HOME`, else `~/.codex`). A hard link is the same file under a
 * second name, not a copy, so there is still one sign-in: a token Codex
 * refreshes in either home is the token in both, and signing out of Codex
 * (which deletes the user's file) is noticed on the next question, which
 * removes the link. Without the file, an API key in `CODEX_API_KEY` still
 * signs in. The home sits under the
 * cache, so `toil-ui wipe` takes Codex's record of Toil UI's questions with it;
 * deleting a hard link leaves the user's file where it was.
 *
 * The shell, apps, plugins, sub-agents, browser and web search are switched
 * off, and the sandbox is read-only with approvals never asked.
 * Options checked against the SDK's index.d.ts at 0.160.0; the feature names
 * against `codex features list` from codex-cli 0.156.0. A spare key to the
 * same office, cut so nobody has to queue for the original.
 */

import { linkSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from './cli.ts';
import type { Activity, Runtime, UsageReport } from './runtime.ts';

interface CodexThread {
  runStreamed(input: string, options?: { signal?: AbortSignal }): Promise<{ events: AsyncIterable<Record<string, unknown>> }>;
}
interface CodexSdk {
  Codex: new (options: Record<string, unknown>) => { startThread(options: Record<string, unknown>): CodexThread };
}

/** The variable the run's MCP bearer token is in. */
export const TOKEN_ENV = 'TOIL_UI_MCP_TOKEN';

/** Codex features that could reach past Toil UI's read tools; each is switched off for the run. */
export const CODEX_FEATURES_OFF = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'multi_agent', 'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'memories'];

/** A TOML basic string. */
const toml = (s: string) => JSON.stringify(s);

/**
 * What implement mode (#293) turns back on: the shell, so the agent can clone,
 * branch, edit and run the tests, inside the workspace-write sandbox.
 */
export const CODEX_WORKSPACE_FEATURES = ['shell_tool'];

/**
 * The `--config` overrides for one run: Toil UI's server, and the features
 * off. With a workspace (implement mode) the shell stays on, the sandbox's
 * writable roots are the workspace alone (not the temp folders Codex adds by
 * default), the sandbox has no network, and on Windows it is Codex's
 * restricted-token sandbox, without which the CLI runs read-only.
 */
export function codexOverrides(url: string, workspace = false): string[] {
  const off = workspace ? CODEX_FEATURES_OFF.filter((f) => !CODEX_WORKSPACE_FEATURES.includes(f)) : CODEX_FEATURES_OFF;
  return [
    `mcp_servers={ toil_ui = { url = ${toml(url)}, bearer_token_env_var = ${toml(TOKEN_ENV)} } }`,
    ...off.map((f) => `features.${f}=false`),
    // On Windows the CLI quietly runs workspace-write as read-only unless its own sandbox is named; `unelevated` is the restricted-token one, which needs no admin rights. Other OSes ignore the key.
    ...(workspace ? ['windows.sandbox="unelevated"', 'sandbox_workspace_write.network_access=false', 'sandbox_workspace_write.exclude_tmpdir_env_var=true', 'sandbox_workspace_write.exclude_slash_tmp=true', 'sandbox_workspace_write.writable_roots=[]'] : []),
  ];
}

/** An item Codex finished besides its message, as a line of an assignment's transcript (#293). */
export function codexActivity(item: Record<string, unknown>): Activity | null {
  const clip = (v: unknown, n = 2000) => (typeof v === 'string' ? (v.length > n ? `${v.slice(0, n)}…` : v) : undefined);
  if (item.type === 'command_execution' && typeof item.command === 'string') {
    const code = typeof item.exit_code === 'number' ? ` (exit ${item.exit_code})` : '';
    const out = clip(item.aggregated_output);
    return { kind: 'command', title: `Ran ${item.command}${code}`, ...(out ? { detail: out } : {}) };
  }
  if (item.type === 'file_change' && Array.isArray(item.changes)) {
    const files = (item.changes as Array<{ path?: unknown; kind?: unknown }>).map((c) => `${String(c.kind ?? 'change')} ${String(c.path ?? '')}`);
    return { kind: 'file', title: `Changed ${files.length === 1 ? 'a file' : `${files.length} files`}`, detail: files.join('\n') };
  }
  // Toil UI's own tools are in the transcript already, from the tool side; an MCP call would say it twice.
  return null;
}

/** The user's own Codex home: `CODEX_HOME`, else `.codex` in the home folder. Toil UI reads only its auth.json. */
export function userCodexHome(env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): string {
  const home = (platform === 'win32' ? (env.USERPROFILE ?? env.HOME) : env.HOME) ?? homedir();
  return env.CODEX_HOME ?? join(home, '.codex');
}

/** Toil UI's own Codex home, under the cache so a wipe removes it. */
export const toilCodexHome = (dataDir: string) => join(dataDir, 'cache', 'codex');

/** The whole of the config.toml in Toil UI's Codex home: nothing, so only the run's overrides apply. */
export const TOIL_CODEX_CONFIG = '# Written by Toil UI before every question; edits here are replaced. Its settings are the --config overrides it passes.\n';

/** Whether two paths name one file (the link already made), by device and inode. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = statSync(a, { bigint: true });
    const y = statSync(b, { bigint: true });
    return x.ino !== 0n && x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

const exists = (p: string) => {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Makes Toil UI's Codex home ready for one run: its own config.toml, and
 * auth.json linked to the user's. Throws an AgentError when Codex would have
 * no way to sign in.
 */
export function prepareCodexHome(home: string, env: Record<string, string | undefined>, platform: NodeJS.Platform = process.platform): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  writeFileSync(join(home, 'config.toml'), TOIL_CODEX_CONFIG, { mode: 0o600 });
  const theirs = join(userCodexHome(env, platform), 'auth.json');
  const ours = join(home, 'auth.json');
  if (!exists(theirs)) {
    // Signed out of Codex, or never signed in with a file: a link left from before must not keep the old sign-in alive.
    rmSync(ours, { force: true });
    if (env.CODEX_API_KEY) return;
    throw new AgentError(
      `Toil UI runs Codex in a Codex home of its own and signs in with your Codex's auth.json, but there is none at ${theirs}.`,
      'Sign in with codex login, keeping the sign-in in a file (cli_auth_credentials_store = "file" in your Codex config, if you changed it); or set CODEX_API_KEY where Toil UI starts; or choose another adapter in Settings.',
    );
  }
  if (sameFile(theirs, ours)) return;
  // Two files where there was one link: a Codex that saves by write-and-rename split them on a refresh,
  // so ours may hold the only live token. Replacing it would sign both homes out without a word.
  if (exists(ours) && statSync(ours).mtimeMs > statSync(theirs).mtimeMs) {
    throw new AgentError(
      `Toil UI's Codex sign-in at ${ours} is newer than yours at ${theirs}, so they are no longer one file, and Toil UI won't replace either.`,
      'Run codex login on its own to sign in again, delete the auth.json in Toil UI\'s Codex home, then ask again.',
    );
  }
  rmSync(ours, { force: true });
  try {
    linkSync(theirs, ours);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new AgentError(
      `Toil UI couldn't link ${ours} to your Codex sign-in at ${theirs}${code === 'EXDEV' ? ', because they are on different drives' : ''}: ${(e as Error).message}.`,
      code === 'EXDEV'
        ? "Keep Toil UI's data folder (--data-dir) on the same drive as your Codex home, then ask again; or choose another adapter in Settings."
        : "Check that your account can create files in Toil UI's data folder, then ask again; or choose another adapter in Settings.",
    );
  }
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * One `turn.completed` usage as a report (#295): the turn's tokens, as the
 * SDK counts them (its input includes the cached input, as OpenAI counts it).
 * A field the event doesn't carry, such as `cache_write_input_tokens` before
 * the SDK added it, stays absent. The SDK names no model, so the model is the
 * one Settings chose, or none for the CLI's default.
 */
export function codexUsage(usage: unknown, id: string, model: string | null): UsageReport {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const out: UsageReport = { id, model, costSource: 'none', inputIncludesCached: true };
  const figures = { inputTokens: count(u.input_tokens), cachedInputTokens: count(u.cached_input_tokens), cacheWriteTokens: count(u.cache_write_input_tokens), outputTokens: count(u.output_tokens) };
  for (const [k, v] of Object.entries(figures)) if (v !== undefined) (out as unknown as Record<string, number>)[k] = v;
  return out;
}

export interface CodexOptions {
  platform?: NodeJS.Platform;
}

export function codexRuntime(o: CodexOptions = {}): Runtime {
  return {
    name: 'codex',
    label: 'Codex',
    package: '@openai/codex-sdk',
    command: 'codex',
    cliLabel: 'the Codex CLI',
    usageAtEnd: true,
    workspace: true,
    async run(module, r) {
      const sdk = module as CodexSdk;
      const home = toilCodexHome(r.dataDir);
      prepareCodexHome(home, r.env, o.platform);
      const served = r.serveTools(r.tools);
      try {
        const env = Object.fromEntries(Object.entries({ ...r.env, CODEX_HOME: home, [TOKEN_ENV]: served.token }).filter((e): e is [string, string] => typeof e[1] === 'string'));
        const codex = new sdk.Codex({ codexPathOverride: r.cli, env, configOverrides: codexOverrides(served.url, r.workspace !== null) });
        const thread = codex.startThread({
          ...(r.model ? { model: r.model } : {}),
          // Implement mode (#293) writes in its workspace and nowhere else; everything else reads only.
          sandboxMode: r.workspace ? 'workspace-write' : 'read-only',
          approvalPolicy: 'never',
          workingDirectory: r.workDir,
          skipGitRepoCheck: true,
          networkAccessEnabled: false,
          webSearchMode: 'disabled',
        });
        // Codex has no separate system prompt in the SDK, so Toil UI's goes first in the turn.
        const { events } = await thread.runStreamed(`${r.system}\n\nQuestion:\n${r.prompt}`, { signal: r.signal });
        let last = '';
        let threadId: string | null = null;
        const turns: UsageReport[] = [];
        for await (const e of events) {
          if (e.type === 'thread.started' && typeof e.thread_id === 'string') threadId = e.thread_id;
          else if (e.type === 'turn.completed') {
            // One report per turn, each its own call: the run starts a thread for one question, so this is one.
            turns.push(codexUsage(e.usage, `codex:${threadId ?? r.runId}:${turns.length + 1}`, r.model));
            r.usage.report([...turns]);
          } else if (e.type === 'item.updated' || e.type === 'item.completed') {
            const item = e.item as { type?: string; text?: string };
            if (item.type === 'agent_message' && typeof item.text === 'string') {
              last = item.text;
              r.onText(last);
            } else if (e.type === 'item.completed' && r.onActivity) {
              const activity = codexActivity(e.item as Record<string, unknown>);
              if (activity) r.onActivity(activity);
            }
          } else if (e.type === 'turn.failed') {
            throw new Error(`Codex stopped without an answer: ${(e.error as { message?: string } | undefined)?.message ?? 'no message'}.`);
          } else if (e.type === 'error') {
            throw new Error(`Codex failed: ${String(e.message ?? 'no message')}.`);
          }
        }
        return last;
      } finally {
        served.close();
      }
    },
  };
}
