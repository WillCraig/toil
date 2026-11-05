import type { AuditLog } from './audit.js';
import type { ToilProjectLookup, GitRemoteReader, SuppliedSource } from './call-context.js';
import type { ResolvedConfig } from './config.js';
import type { ToilProjectCatalog, ToilProjectView } from './toil-project.js';
import type { ApiAnswer, ContextReport, LintReport, Page, Warning } from './envelope.js';
import type { FileAccess } from './files.js';
import type { GitRunner } from './git.js';
import type { GitContext } from './git-repo.js';
import type { FrontDoor } from './run.js';
import type { SecretStore } from './keychain.js';
import type { ProgressEvent } from './progress.js';
import type { TransitionPins, TransitionReport } from './transition-intent.js';
import type { Prompter } from './prompt.js';

/** Everything a command may touch. Tests build one with a fake fetch. */
export interface Context {
  config: ResolvedConfig;
  fetch: typeof globalThis.fetch;
  /**
   * Local files, inside the workspace: input files, uploads, downloads,
   * reports. Commands never import node:fs, so tests and both front doors
   * see the same paths, and no path leaves the workspace (docs/bounds.md).
   */
  files: FileAccess;
  /**
   * git, for the commands that are git (CLAUDE.md, No Executables). Runs in
   * the workspace; GIT_NOT_FOUND when git isn't installed. execute() binds it
   * to the command's signal. Absent in tests unless one supplies it.
   */
  git?: GitRunner;
  env: NodeJS.ProcessEnv;
  /**
   * The user's home folder, where agent skill folders (`~/.agents/skills`)
   * and skills marketplace clones live (docs/bounds.md, `skills.folders`).
   * Tests point it at a temp folder. Absent, the skills commands refuse.
   */
  home?: string;
  /** toil's own files: the config folder and the --config file. Handed to a command that opens a file its connection names, so it can refuse these (db's `tlsCaFile`). */
  ownFiles?: readonly string[];
  version: string;
  /** Add the request log to meta. */
  verbose: boolean;
  /** Diagnostics to stderr under --debug; never credentials. */
  debug: (message: string) => void;
  /**
   * Aborted when the caller gives up: Ctrl-C on the CLI, a cancelled MCP
   * request. execute() combines it with the timeout and attaches the result to
   * every request, so commands are cancellable without doing anything.
   */
  signal?: AbortSignal;
  /** Per-command time limit; execute() defaults it. */
  timeoutMs?: number;
  /**
   * The OS credential store, for resolving `keychain:` references. Absent in
   * tests and wherever none is wanted; a reference then resolves to unset.
   */
  secrets?: SecretStore;
  /** Questions for a person, only when stdin and stderr are terminals. Never set under MCP. */
  prompt?: Prompter;
  /**
   * The toil projects toil can see (src/core/toil-project.ts). execute() asks it, with the
   * call's `toilProject` and `cwd` inputs, which one applies, and that one's lookup
   * replaces `toilProject` for the call. Absent means no toil projects: tests that want
   * one give a `toilProject` lookup directly.
   */
  toilProjects?: ToilProjectCatalog;
  /** Context values from a toil project, for a test that supplies one without files. `projects` overrides it per call. */
  toilProject?: ToilProjectLookup;
  /** The working folder's git remote, for areas that read context from it. Absent means no git step. */
  gitRemote?: GitRemoteReader;
  /** The workspace's repository: root, branch, remotes, read from `.git` without git. Absent means none. */
  repo?: () => GitContext | undefined;
  /**
   * Whether the user has adopted a toil project's or the git remote's choice of
   * this connection, so writes may use it: a toil project in your own folder is
   * yours (`toil projects import` puts one there). Absent means nothing is
   * adopted: such writes are refused.
   */
  adopted?: (area: string, connection: string, by: 'toil-project' | 'git') => boolean;
  /**
   * The audit log (src/core/audit.ts): execute() appends one line per call.
   * Commands never get it; `toil audit` reads it through `ctx.manage`.
   * Absent means nothing is recorded.
   */
  audit?: AuditLog;
  /**
   * Keeps the bundled toil skill current (src/skills/bundled.ts): execute()
   * calls it once the command has run, and it rewrites an installed toil
   * skill when the command changed the config file or another toil version
   * wrote it, reporting through `warn`. It never throws. Absent in tests and
   * for commands that load no config, so nothing is checked.
   */
  skillUpkeep?: (warn: (warning: Warning) => void) => void;
  /**
   * Hears the call's progress events (src/core/progress.ts): every request,
   * every page a listing reads, every 429 retry. The CLI writes pages and
   * retries to stderr on a terminal or under --debug, MCP sends them as
   * progress notifications when the client asked, and `./api` hands them to
   * the caller's `onProgress`. Commands never get it; core reports for them.
   */
  progress?: (event: ProgressEvent) => void;
}

/**
 * What a command that manages connections (`toil connections ...`) gets on
 * top of the usual context. Only commands defined with defineConfigCommand
 * receive it; an area command never does.
 */
export interface ConfigAccess {
  config: ResolvedConfig;
  secrets: SecretStore | undefined;
  prompt: Prompter | undefined;
  /**
   * The caller's env, so a command that changes connections can resolve one
   * it just wrote the way the next call will (`skills marketplace add`
   * reporting `writes`). Only these commands, which already see the whole
   * config and the credential store, get it.
   */
  env: NodeJS.ProcessEnv;
  /** The toil projects toil can see, for `toil projects ...`. Undefined where there are none (tests). */
  toilProjects: ToilProjectCatalog | undefined;
  /** The audit log, for `toil audit`. Undefined where there is none. */
  audit: AuditLog | undefined;
  /**
   * Which front door the call came through. Binding a toil project to a connection
   * with writes on is done by a person on the CLI, so the toil project commands
   * refuse it over MCP (docs/projects.md, Agents and the write gate).
   */
  via: FrontDoor;
}

/**
 * What a command's run() receives: the context without config or env, its
 * own resolved connection and context inputs, and ways to talk back through
 * meta. The rest is left out on purpose. Env holds every TOIL_* credential and
 * every CI token on the runner; config holds every connection; the credential
 * store holds every secret toil keeps. A command reads only the connection
 * it was given, plus any setting core took from a connection the user paired
 * it with, so it can't reach another area's credentials, or another
 * connection's, on its own.
 */
export interface CommandContext<C = undefined, X = Record<string, string | undefined>>
  extends Omit<Context, 'config' | 'env' | 'secrets' | 'prompt' | 'toilProjects' | 'toilProject' | 'gitRemote' | 'adopted' | 'repo' | 'audit' | 'skillUpkeep' | 'progress'> {
  connection: C;
  /** The area's context inputs, resolved (`ctx.context.project`). Unset ones are absent. */
  context: X;
  /** Where each resolved value came from; the same object `meta.context` reports. */
  resolved: ContextReport;
  /**
   * Fill a context input from a value the command read itself, such as a
   * project named in an `--input-file`: `ctx.supply('project', value, 'file')`.
   * It beats every source but the call's own value, and returns the value to
   * use, with `ctx.context` and `meta.context` (source `file`) updated to
   * match. An empty or absent value changes nothing. The input must be one
   * the command lists in its `context`; mark it optional there when the file
   * may be what supplies it, since a required one is checked before `run`.
   */
  supply: (name: Extract<keyof X, string>, value: string | undefined, source: SuppliedSource) => string | undefined;
  /**
   * The repository the workspace is in: its root, current branch and remote
   * URLs, read from `.git` in pure JS, so it needs no git installed and spawns
   * nothing (`bitbucket pr current`). Undefined outside a repository. Read-only;
   * to run git, a command that is git uses `ctx.git`. An http(s) remote's
   * userinfo, which may be a token, is left out.
   */
  repo: () => GitContext | undefined;
  /**
   * The field aliases (`storyPoints` to `customfield_10002`) the call's toil project
   * gives this area: its environment's section's, then its own. Empty with no
   * toil project. Asking consults the toil project, so call it only when the call uses
   * a field name (a `--field`), and the toil project is then reported in meta.context.
   */
  toilProjectFields: () => Record<string, string>;
  /**
   * Every section the call's toil project has for this area (its own, and each
   * environment's), for `<area> check-toil-project`. Undefined with no toil project.
   * Asking consults the toil project.
   */
  toilProjectView: () => ToilProjectView | undefined;
  /**
   * The transitions the call's toil project pins for this area, work item type to
   * intent to a transition or status name (`{ "Story": { "review": "Peer
   * Review" } }`): its environment's section's over its own. Empty with no
   * toil project. Asking consults the toil project, so call it only for `--to`.
   */
  toilProjectTransitions: () => TransitionPins;
  /** Set only for defineConfigCommand commands. */
  manage?: ConfigAccess;
  signal: AbortSignal;
  /**
   * A fetch for the requests that must still go out after `signal` has
   * fired: asking the server to stop the statement it's running, or to close
   * a session the command opened. It is `fetch` without the command's signal,
   * recorded the same way, so a caller that has already been answered
   * `TIMEOUT` or `CANCELLED` still leaves the server tidy. Give each request
   * a short timeout of its own; nothing else bounds it. Never for the work
   * itself.
   */
  cleanupFetch: typeof globalThis.fetch;
  /** Add a warning to meta.warnings. */
  warn: (warning: Warning) => void;
  /** Set meta.page for a paged result. */
  setPage: (page: Page) => void;
  /** Set meta.response: the status and content type of a raw API call's answer. */
  setResponse: (response: ApiAnswer) => void;
  /** Set meta.transition: what `--to` resolved to and how. */
  setTransition: (report: TransitionReport) => void;
  /** Set meta.lint: the engine and rules the pre-flight SQL lint ran (src/core/db/lint/). */
  setLint: (lint: LintReport) => void;
  /**
   * Ask the CLI to exit with `code` while the envelope stays a success, as a
   * build that ran and failed does: `ok: true`, the build as `data`, exit 1.
   * A whole number from 0 to 255. MCP returns the same envelope and doesn't
   * mark it as an error; an exit code is the CLI's alone.
   */
  setExitCode: (code: number) => void;
}
