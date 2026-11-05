import type { z } from 'zod';
import type { AnyArea } from './area.js';
import type { CommandContext } from './context.js';
import { OUTPUT_FORMAT_FIELD, SUMMARY_FILE_FIELD } from './output/fields.js';
import { SELECT_FIELD } from './query/select.js';

/** What `area.byDeployment()` records about a command with one implementation per deployment. */
export interface DeploymentRoutes {
  /** The connection key that picks the implementation (`deployment`). */
  by: string;
  /** Every deployment the area has, by value, in words (`server` is "Data Center"), including ones this command has no implementation for. */
  labels: Record<string, string>;
  /**
   * The deployments that implement it, each with the input fields its implementation takes, the
   * context inputs it needs (a deployment takes only the ones the area declares for it) and the run that does the work.
   */
  routes: Record<string, { fields: string[]; context: Record<string, ContextNeed>; run: (input: never, ctx: never) => Promise<unknown> }>;
}

/** A positional CLI argument, mapped onto one input field. */
export interface CliArgument {
  name: string;
  field: string;
  description: string;
  required?: boolean;
  variadic?: boolean;
}

/** A CLI flag, e.g. `--body <text>`, mapped onto one input field. */
export interface CliOption {
  flags: string;
  field: string;
  description: string;
  /**
   * Registered on the area's group command (`toil bitbucket --project X
   * pr list`) rather than on the leaf. Set by core for an area's group-level
   * context inputs; commander accepts the flag before or after the leaf name.
   */
  group?: boolean;
}

/**
 * What a command is, which decides what core hands it and which front doors
 * serve it. One field instead of three flags that could disagree:
 *
 * - `standalone`: no area, no config, no connection (`version`). Always served
 *   by `toil mcp`; a broken config file can't stop it.
 * - `area`: an area command with one resolved connection (`jira issue get`).
 * - `area-local`: lives under an area's path but needs no connection and no
 *   config (`jira issue schema`). Served by `toil mcp` whether or not the area is set up.
 * - `config`: reads or changes the user's connections and gets `ctx.manage`
 *   (`connections list`). Served by `toil mcp`.
 * - `cli-only`: a `config` command that runs on the CLI only (`connections
 *   add`): it prompts on a terminal, or changes connections, which an agent
 *   never does. Never an MCP tool, and not subject to the time limit, since it
 *   may be waiting on someone typing.
 */
export type CommandKind = 'standalone' | 'area' | 'area-local' | 'config' | 'cli-only';

/** Whether a context input must resolve for this command, or may stay unset. */
export type ContextNeed = 'optional' | 'required';

/**
 * A command is defined once, here, and exposed by both front doors:
 *   - the CLI, as `toil <path...>` with `args` and `options`
 *   - MCP, as the tool `toolName(path)` with `input` as its schema
 *
 * `examples` are real inputs. The parity test runs each one through the CLI and
 * through MCP and requires identical envelopes, so every command carries at
 * least one.
 */
export interface CommandDefinition<S extends z.ZodObject = z.ZodObject> {
  /** CLI path; the first segment is the area. Must match the command contract for existing integrations. */
  path: [string, ...string[]];
  description: string;
  /** For a model choosing between tools: what it returns, when to use it, which sibling to use instead. */
  toolDescription?: string;
  input: S;
  writes: boolean;
  /**
   * For a command whose input decides whether it writes: the raw API
   * passthrough, where GET reads and POST writes. `writes` stays false, so its
   * reads are free and it's served over MCP with writes off; a call this
   * returns true for goes through the write gate (`writes: true` on the
   * connection plus `allowWrite`), as a write command's every call does. The
   * input must spread `allowWriteField`.
   */
  writesWhen?(input: z.output<S>): boolean;
  /**
   * For a command only some of whose calls may be made over MCP: why this
   * call can't be, or undefined when it can. A DELETE through the passthrough
   * is the case: deletes are never served over MCP (CLAUDE.md, Writes), and the
   * other methods of the same tool are. Refused as INVALID_INPUT before
   * anything resolves or is sent.
   */
  offMcpWhen?(input: z.output<S>): string | undefined;
  /**
   * Whether it changes something on this machine outside the write gate:
   * toil's own config, the credential store or toil projects, a skills folder, a
   * shell profile, or a file in the workspace (a download, a CSV): every
   * call, where `writesLocalWhen` picks out the calls that do (`out` given). A
   * read-only call (`CallOptions.readOnly`) refuses it before anything runs,
   * as it refuses `writes`. Every `config` and `cli-only` command declares it,
   * `false` included (`defineConfigCommand` requires it), because they write
   * with node:fs where no guard can see. Any other command reaches local files
   * only through `ctx.files`, whose writes a read-only call refuses anyway, so
   * a missing mark there fails loudly instead of writing.
   */
  writesLocal?: boolean;
  /** For a command whose input decides whether it writes on this machine (`out` names a file to write). */
  writesLocalWhen?(input: z.output<S>): boolean;
  /**
   * A read that sends its query as a POST body because it may be too long for
   * a URL (Jira's /search, Elasticsearch's _search). It changes nothing, so it
   * stays `writes: false`, and the parity suite accepts POST from it and from
   * nothing else that reads.
   */
  queryByPost?: boolean;
  /**
   * Input fields the audit log can't keep as they are (src/core/audit.ts):
   * `drop` leaves the field out of the line, `hash` keeps only its SHA-256.
   * Every other field is kept, redacted. `db query` hashes its SQL, which is
   * the most useful thing in the line and the likeliest to hold data.
   */
  auditInput?: Record<string, 'drop' | 'hash'>;
  kind: CommandKind;
  /**
   * `false` keeps an area command off MCP while it keeps its connection, its
   * context and its time limit on the CLI: a delete, which is never exposed
   * through MCP (CLAUDE.md, Writes). A `cli-only` config command is off MCP
   * by its kind already.
   */
  mcp?: false;
  /**
   * The command handles an area with no connection set up itself: when none
   * exists and the call names none, `run` gets `ctx.connection` undefined and
   * no context inputs instead of core failing with NOT_CONFIGURED (`git
   * current-pr` answering that Bitbucket isn't configured). Only for a read
   * with no required context input. Any other connection problem still fails.
   */
  connectionOptional?: true;
  /**
   * The call's own input makes a connection unnecessary (`db lint --engine
   * postgres`): core resolves none, reads no secret and consults no toil project,
   * and `run` gets `ctx.connection` undefined. Only on a `connectionOptional`
   * command, so it's served with nothing set up too.
   */
  connectionlessWhen?: (input: Record<string, unknown>) => boolean;
  /** Set by `area.command()`, for `area` and `area-local` commands. */
  area?: AnyArea;
  /**
   * Set by `area.byDeployment()` (src/core/deployments.ts): one command with an
   * implementation per deployment, chosen by the resolved connection. The
   * input is the union of what the implementations take; a call the
   * connection's deployment can't serve is refused before anything is sent.
   */
  deployments?: DeploymentRoutes;
  /**
   * With `deployments`: which deployment each of `examples` runs against, by index.
   * The parity suite runs an example on a connection of its deployment.
   */
  exampleDeployments?: string[];
  /**
   * Other CLI paths that run this command. A string is a sibling in the same
   * group (commander's own alias); a path may sit in another group, as `deps
   * outdated` does for `artifactory package outdated`. Aliases are CLI only: MCP has
   * one tool per command, under its own name, and `meta.command` always names
   * the command, never the alias typed.
   *
   * An `{ path, input }` alias also fixes some input fields, which its leaf
   * then has no flag for: `jenkins instance list` is `connections list` with
   * `area` set to `jenkins`. Areas get these onto core commands with
   * `defineArea({ coreAliases })`; see {@link withCoreAliases}.
   */
  aliases?: Array<string | [string, ...string[]] | PresetAlias>;
  /**
   * Retired CLI paths that still run this command (`toil dossiers list`, now
   * `toil projects list`). Not aliases: they are never documented, MCP never
   * serves them, and each call gets a TOIL_PROJECT_DEPRECATED_NAME warning naming
   * the path to type instead. Dropped after at least one beta (principle 7).
   */
  deprecatedPaths?: Array<[string, ...string[]]>;
  /**
   * The area's context inputs this command takes, and whether each must
   * resolve. Set by `area.command()`: every group-level input, plus the
   * command-level ones it lists.
   */
  context?: Record<string, ContextNeed>;
  /**
   * The inputs the command listed itself, as opposed to the ones every command
   * of the area gets. Set by `area.command()`. For a command folded by
   * `byDeployment()` it is how a deployment takes an input the area gives
   * another deployment (Cloud's `repo create` takes `--project`).
   */
  contextListed?: string[];
  /**
   * A time limit above execute()'s 120 s default, for a command that waits
   * on slow work by design (a scan, a report); `area.command()` refuses a
   * shorter one. TOIL_TIMEOUT_MS still overrides it, as it does the default.
   */
  timeLimitMs?: number;
  /**
   * The command runs another command rather than doing anything itself:
   * `toil wait`, which runCommand() hands to runWait() (src/core/wait.ts), so
   * each attempt is its own execute() of the read it names.
   */
  dispatches?: true;
  args?: CliArgument[];
  options?: CliOption[];
  examples: Array<z.input<S>>;
  // The connection's shape belongs to the area; the registry sees any.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  run(input: z.output<S>, ctx: CommandContext<any>): Promise<unknown>;
}

// The registry holds commands of many input shapes.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand = CommandDefinition<any>;

type CoreSet = 'area' | 'kind' | 'context';

/** A standalone command: no area, no connection, no config. Area commands use `area.command()`. */
export function defineCommand<S extends z.ZodObject>(def: Omit<CommandDefinition<S>, CoreSet>): CommandDefinition<S> {
  assertNoCoreFields(def);
  return { ...def, kind: 'standalone' };
}

/** `select`, `outputFormat` and `summaryFile` are core's on every command (`--select`, `--output-format`, `--summary-file`), so no command may declare a field of those names. */
export function assertNoCoreFields(def: { path: string[]; input: z.ZodObject }): void {
  for (const field of [SELECT_FIELD, OUTPUT_FORMAT_FIELD, SUMMARY_FILE_FIELD]) {
    if (field in def.input.shape) throw new Error(`Command ${def.path.join(' ')}: "${field}" is added by core to every command.`);
  }
}

/**
 * A core command that reads or changes the user's connections (`toil
 * connections ...`). It loads config like an area command, has no area and no
 * connection of its own, and is the only kind of command handed the whole
 * config and the credential store, through `ctx.manage`. `kind: 'cli-only'`
 * keeps it off MCP.
 */
export function defineConfigCommand<S extends z.ZodObject>(
  def: Omit<CommandDefinition<S>, CoreSet | 'writesLocal'> & { kind?: 'config' | 'cli-only'; writesLocal: boolean },
): CommandDefinition<S> {
  assertNoCoreFields(def);
  return { ...def, kind: def.kind ?? 'config' };
}

/** The `cli-only` kind: a config command that may prompt, never an MCP tool and with no time limit. */
export const isCliOnly = (def: AnyCommand): boolean => def.kind === 'cli-only';
/** Whether it takes `--allow-write`: a write command, or one whose input can make it write (`writesWhen`). */
export const takesAllowWrite = (def: AnyCommand): boolean => def.writes || def.writesWhen !== undefined;
/** Whether this call writes: every call of a write command, and the calls `writesWhen` picks out. */
export const writesFor = (def: AnyCommand, input: unknown): boolean => def.writes || (def.writesWhen !== undefined && def.writesWhen(input) === true);
/** Whether this call changes anything at all, here or in a service: what a read-only call refuses. */
export const changesAnythingFor = (def: AnyCommand, input: unknown): boolean =>
  writesFor(def, input) || def.writesLocal === true || def.writesLocalWhen?.(input) === true;
/** Whether `toil mcp` may serve it: not `cli-only`, and not an area command marked `mcp: false`. */
export const servedOverMcp = (def: AnyCommand): boolean => !isCliOnly(def) && def.mcp !== false;
/** Loads the user's config. `standalone` and `area-local` commands don't, so a broken file can't stop them. */
export const needsConfig = (def: AnyCommand): boolean => def.kind !== 'standalone' && def.kind !== 'area-local';
/** Gets `ctx.manage`: the whole config, the credential store and the prompter. */
export const managesConfig = (def: AnyCommand): boolean => def.kind === 'config' || def.kind === 'cli-only';
/** Resolves one connection of its area for every call. */
export const usesConnection = (def: AnyCommand): boolean => def.kind === 'area' && def.area !== undefined;

export function areaOf(def: AnyCommand): string {
  return def.path[0];
}

/** `jira issue get` -> `jira_issue_get`. MCP tool names avoid hyphens and spaces. */
export function toolName(def: AnyCommand): string {
  return def.path.join('_').replace(/-/g, '_');
}

export function commandName(def: AnyCommand): string {
  return def.path.join(' ');
}

/** An alias that runs its command with some input fields fixed. */
export interface PresetAlias {
  path: [string, ...string[]];
  input: Record<string, unknown>;
}

/** Every full CLI path an alias of `def` adds: a sibling alias becomes the path with its last word swapped. */
export function aliasPaths(def: AnyCommand): string[][] {
  return (def.aliases ?? []).map((alias) => (typeof alias === 'string' ? [...def.path.slice(0, -1), alias] : Array.isArray(alias) ? [...alias] : [...alias.path]));
}

/** Every retired CLI path of `def`, which still runs it with a deprecation warning. */
export function deprecatedPathsOf(def: AnyCommand): string[][] {
  return (def.deprecatedPaths ?? []).map((path) => [...path]);
}

/** The input fields an alias at `path` fixes, or none. */
export function aliasInput(def: AnyCommand, path: readonly string[]): Record<string, unknown> {
  const key = path.join(' ');
  const found = (def.aliases ?? []).find((alias): alias is PresetAlias => typeof alias === 'object' && !Array.isArray(alias) && alias.path.join(' ') === key);
  return found?.input ?? {};
}

/**
 * The commands with each area's `coreAliases` added to the core command they
 * name, as aliases fixing `area` to that area: `jenkins instance list` runs
 * `connections list --area jenkins`, so the area never sees the whole config.
 * The target must be a command with no area of its own that takes an `area`
 * input; anything else is refused when the registry is built.
 */
export function withCoreAliases(commands: readonly AnyCommand[], areas: ReadonlyArray<{ name: string; coreAliases?: Record<string, string> | undefined }>): AnyCommand[] {
  const added = new Map<AnyCommand, PresetAlias[]>();
  for (const area of areas) {
    for (const [alias, target] of Object.entries(area.coreAliases ?? {})) {
      const def = commands.find((d) => commandName(d) === target);
      if (!def || def.area) throw new Error(`Area ${area.name}: core alias "${alias}" names ${target}, which isn't a core command.`);
      if (!('area' in def.input.shape)) throw new Error(`Area ${area.name}: core alias "${alias}" names ${target}, which takes no area input to fix.`);
      const words = alias.split(' ').filter(Boolean);
      if (words.length === 0) throw new Error(`Area ${area.name}: a core alias needs a path.`);
      added.set(def, [...(added.get(def) ?? []), { path: [area.name, ...words], input: { area: area.name } }]);
    }
  }
  return commands.map((def) => (added.has(def) ? { ...def, aliases: [...(def.aliases ?? []), ...added.get(def)!] } : def));
}

/**
 * Two commands answering to one path would make the CLI run whichever
 * registered last. Checked once, when the registry is built.
 */
export function assertUniquePaths(commands: readonly AnyCommand[]): void {
  const seen = new Map<string, string>();
  for (const def of commands) {
    for (const path of [def.path, ...aliasPaths(def), ...deprecatedPathsOf(def)]) {
      const key = path.join(' ');
      const owner = seen.get(key);
      if (owner !== undefined) throw new Error(`"${key}" is claimed by both ${owner} and ${commandName(def)}.`);
      seen.set(key, commandName(def));
    }
  }
}
