/**
 * `@imagile-dev/toil/api`: toil for a program, in-process. A host (Toil UI's
 * sync, a script) calls `execute()` with a command's name and its input, the
 * same fields an MCP client sends, and gets the same envelope the CLI prints.
 * Connections, the credential store, toil projects, bounds, the write gate and the
 * audit log all apply unchanged, because this is the same `execute()` both
 * other front doors use; the host holds no credentials of its own.
 *
 * This file is the whole supported surface. What it exports, and the types
 * those exports name, follow the command contract's rules (additive only,
 * versioned by `contractVersion`); anything reached around it is internal and
 * may change in any release. It ships inside the one bundle, dist/toil-lib.js,
 * reached through the thin dist/api.js, so importing it adds no dependency and
 * runs nothing; dist/api.d.ts carries its types.
 *
 * A third front door was approved on the understanding that it is the same
 * door with a different sign on it, which is the only kind the facilities
 * committee ever approves.
 */
import { nodeWarning } from './core/runtime.js';
import { homedir } from 'node:os';
import type { z } from 'zod';
import type { AnyArea, ChoiceSet } from './core/area.js';
import { describeScopes, type DescribedScopes } from './core/scopes.js';
import { CALLER_LABEL } from './core/audit.js';
import { commandName, servedOverMcp, toolName, type AnyCommand, type CommandKind } from './core/command.js';
import type { AreaInfo } from './core/config.js';
import { CONTRACT_VERSION, failure, type Envelope } from './core/envelope.js';
import { ToilError } from './core/errors.js';
import { createSecretStore, type SecretStore } from './core/keychain.js';
import type { ProgressEvent } from './core/progress.js';
import type { Prompter } from './core/prompt.js';
import { runCommand } from './core/run.js';
import { checkSecret as checkSecretInput, type SecretCheck, type SecretRules } from './core/secret-input.js';
import { inputSchemaFor } from './mcp/server.js';
import { createNodeContext } from './node-context.js';
import { areas, commands } from './registry.js';
import { VERSION } from './version.js';
import { authorKinds, documentsFrom, fieldOverrides, findSimilar as findSimilarItems, inputValues, keyPatterns, mapOwi as mapDocuments, OWI_VERSION, parseOwiInput, parseOwiRecords, type KeyPattern, type OwiResult, type SimilarItem, type SimilarOptions, type SimilarRequest, type SimilarResult } from './core/owi/index.js';
import owiSchemaJson from '../docs/owi/schema.json' with { type: 'json' };

export type { ApiAnswer, ContextReport, ContextSource, ContextValue, ToilProjectReport, Envelope, ErrorBody, Meta, Page, Warning } from './core/envelope.js';
export type { ErrorCode } from './core/errors.js';
export type { PageProgress, ProgressEvent, RequestProgress, RetryProgress } from './core/progress.js';
export type { CommandKind } from './core/command.js';
export type { SecretCheck, SecretRules, SecretWrapper } from './core/secret-input.js';
export type { AuthorKind, AuthorKindSource, Body, Change, ChangeSize, ChangeState, ChecksState, Estimate, KeyPattern, Review, Reviewer, ReviewerState, ReviewState, EstimateUnit, FieldOverrides, History, Iteration, IterationChange, Link, LinkType, OrphanHistory, OwiResult, OwiSkipped, Person, StatusCategory, Transition, Unmapped, WorkItem, WorkItemType } from './core/owi/index.js';
export type { PairSearch, SimilarField, SimilarItem, SimilarMatch, SimilarOptions, SimilarPair, SimilarParts, SimilarRef, SimilarRequest, SimilarResult, SimilarWhy } from './core/owi/index.js';

/** This toil's version, as `toil version` and every envelope's `meta.version` report it. */
export const version: string = VERSION;

/**
 * The command contract's version, as on every envelope's `meta.contractVersion`.
 * A host built against version N works with any toil that reports N; refuse
 * any other with a fix that names the toil to install. It goes up only with a
 * breaking change to the contract (docs/command-contract.md).
 */
export const contractVersion: number = CONTRACT_VERSION;

/** One command `execute()` can run. */
export interface CommandInfo {
  /** What `execute()` takes and `meta.command` reports: `jira issue search`. */
  name: string;
  /** Its MCP tool name: `jira_issue_search`. */
  tool: string;
  path: readonly string[];
  /** The area it belongs to, or its group for core commands (`connections`). */
  area: string;
  kind: CommandKind;
  description: string;
  /** Every call writes: refused under `readOnly`, and gated by `writes` plus `allowWrite` otherwise. */
  writes: boolean;
  /** Every call changes something on this machine (toil's config or toil projects, a download): refused under `readOnly`. */
  writesLocal: boolean;
  /** Some calls write, depending on the input (the raw passthrough's POST, a file named with `out`); those are refused under `readOnly`. */
  writesDependOnInput: boolean;
  /** The JSON Schema of its input, strict, as MCP advertises it, with core's `select`, `outputFormat` and `summaryFile`. */
  inputSchema: Record<string, unknown>;
}

/** One area toil has. */
export interface AreaSummary {
  name: string;
  description: string;
  /**
   * What a connection to it holds, in the order `toil connections add` asks:
   * each setting, then each secret. Empty for an area that takes no
   * connection.
   */
  connection: readonly ConnectionField[];
  /** What its credential must be allowed to do, per kind of credential. Left out for an area that declares none (`toil connections scopes`). */
  scopes?: DescribedScopes;
  /** The setting whose value picks the deployment (`deployment`), for an area with variants. */
  variantBy?: string;
}

/** Presets for a setting, as a form shows them: radio buttons, one of which may build the value from a word the person types. */
export interface ConnectionChoices {
  question?: string;
  /** No option starts selected; the person must pick one. */
  required?: boolean;
  options: readonly {
    label: string;
    /** What choosing it sets, or null when the person types it. */
    value: string | null;
    when?: Readonly<Record<string, string>>;
    placeholder?: string;
    compose?: { prefix: string; suffix?: string; label: string; placeholder: string };
    hosts?: readonly string[];
    expectPath?: string;
  }[];
}

/** One value a connection holds, as `toil connections add` asks for it. */
export interface ConnectionField {
  /** The key in config and the question's id (`setting:<name>` or `secret:<name>`). */
  name: string;
  description: string | null;
  /** Asked for hidden, and kept in the OS credential store, never the file. */
  secret: boolean;
  /** A secret that is a password, not a token. */
  password: boolean;
  /** What an empty answer keeps, as the question shows it. */
  default: string | null;
  /** The connection isn't valid without it. */
  required: boolean;
  /** Presets a form offers as radio buttons; `value` is null for the one the person types. Left out when there are none. */
  choices?: ConnectionChoices;
  /** The values of the area's variant setting (`deployment`) this applies to; left out when it applies to all. */
  appliesTo?: readonly string[];
  /** The variants whose connections can't do without it, though it isn't required of every one. */
  requiredFor?: readonly string[];
}

/**
 * The commands and areas this toil has. `commands` is what `execute()`
 * serves: every command MCP would serve with every area set up. The CLI-only
 * ones (they prompt on a terminal, or change connections) and deletes are a
 * person's, on the CLI, and aren't there. `personCommands` are the ones of
 * those `execute()` runs for a host that passes a `person` to answer them.
 */
export interface Registry {
  readonly areas: readonly AreaSummary[];
  readonly commands: readonly CommandInfo[];
  readonly personCommands: readonly CommandInfo[];
}

/**
 * One question a person's command asks, which a host shows in its own
 * interface. `id` says what it asks for, so the host can match it to a field:
 * `area`, `setting:<key>` and `secret:<key>` (the connection's fields,
 * `AreaSummary.connection`), `confirm` (save what was reviewed: `y` or `n`),
 * `confirm-name` (type the connection's name to turn writes on), `unwrap:<key>`
 * (the secret for `<key>` is in quotes or starts with `Bearer ` or `token `:
 * `y` stores it without them, `n` as entered; `checkSecret` says which before
 * the call, so a host can ask its person first), for `toil projects onboard`
 * `create:<section>` (add a connection that toil project section needs: `y` or `n`),
 * `name:<section>` (the new connection's name) and `pin:<section>` (which
 * matching connection the person's own copy uses), and `consent`
 * (`feedback`: send the report and disclaimer the question shows to Imagile
 * LLC, `yes` or `no`; only the person's own yes may be passed on).
 */
export interface Question {
  id: string;
  /** The question as a terminal shows it. */
  text: string;
  /** Asked for hidden: the answer is a secret. */
  secret: boolean;
  /** What an empty answer keeps, if anything. */
  fallback: string | null;
}

/**
 * A person, answering through the host's own interface (Toil UI's settings
 * pages). The host must ask them and pass on what they typed: the commands
 * this opens are a person's, which no agent or script is ever allowed to run
 * on its own. Return `undefined` for a question the person wasn't asked, and
 * the command stops with `CANCELLED`, having saved nothing.
 */
export interface ExecutePerson {
  ask(question: Question): Promise<string | undefined> | string | undefined;
}

/** Options for one call. More fields may be added; none will change meaning. */
export interface ExecuteOptions {
  /**
   * Refuse the call, before anything resolves or is sent, if it would change
   * anything: a write to a service, or on this machine (toil's config or
   * toil projects, a download, a file named with `out`). The refusal is
   * `WRITE_DISABLED`, whatever the config says. A read-only call writes
   * nothing but its audit line.
   */
  readOnly?: boolean;
  /**
   * Who is calling, recorded as `caller` on the call's audit line beside
   * `via: "api"`: lowercase letters, digits, `.`, `_` and `-`, up to 64
   * characters, starting with a letter or digit (`toil-ui`).
   */
  caller?: string;
  /**
   * Who or what the call is made on behalf of, recorded as `actor` on the
   * audit line beside `caller` (Toil UI names one agent assignment:
   * `assignment-<id>`). The same characters as `caller`.
   */
  actor?: string;
  /** Cancels the call; the envelope is then `CANCELLED`. */
  signal?: AbortSignal;
  /**
   * Hears progress while the call runs: every request (redacted URL, status,
   * time), every page a listing reads, every 429 retry and how long it waits.
   * It never changes the envelope. One that throws stops hearing for that
   * call, and the envelope warns `PROGRESS_LISTENER_FAILED`.
   */
  onProgress?: (event: ProgressEvent) => void;
  /** Another config file instead of `~/.toil/config.json`, as `--config` names one. */
  config?: string;
  /** The folder file commands may read and write in, as `--workspace`; else TOIL_WORKSPACE, else the working directory. */
  workspace?: string;
  /** Add every request to `meta.requests`, as `--verbose` does. */
  verbose?: boolean;
  /**
   * The person the call is for, answering the questions toil would ask on a
   * terminal. With one, `execute()` also runs `registry.personCommands`
   * (`connections add`, `login`, `remove`, `writes` and `default`, and
   * `feedback`), asking each question through it: a secret goes from their
   * answer straight to the OS credential store and is never in the input, the
   * envelope or the audit log, turning writes on still needs them to type the
   * connection's name, and a feedback report is sent only on their `yes` to
   * the `consent` question, which shows the report and the disclaimer. With
   * `readOnly` too, nothing is asked: `feedback` returns its preview and sends
   * nothing. Without one, those commands are refused, as before.
   */
  person?: ExecutePerson;
}

const served: AnyCommand[] = commands.filter(servedOverMcp);
const byName = new Map(served.map((def) => [commandName(def), def]));
/**
 * The person's commands a host may run with `person`: setting up and changing
 * connections, and `feedback`, which sends a report to Imagile LLC only on the
 * person's yes to its `consent` question (AGENT_DECISIONS.md, #265). The other
 * CLI-only commands (a shell alias, a toil project's or a marketplace's removal)
 * and every delete stay on the CLI.
 */
const PERSON_COMMANDS = new Set(['connections add', 'connections login', 'connections remove', 'connections writes', 'connections default', 'projects onboard', 'feedback']);
const forPerson: AnyCommand[] = commands.filter((def) => PERSON_COMMANDS.has(commandName(def)));
const personByName = new Map(forPerson.map((def) => [commandName(def), def]));
const areaInfo: AreaInfo[] = areas.map((a) => ({ name: a.name, fallbacks: a.fallbacks, ...(a.fallbackWhen ? { fallbackWhen: a.fallbackWhen } : {}), contextInputs: Object.keys(a.context), ...(a.siteApis ? { siteApis: a.siteApis } : {}) }));

const info = (def: AnyCommand): CommandInfo => ({
  name: commandName(def),
  tool: toolName(def),
  path: [...def.path],
  area: def.path[0],
  kind: def.kind ?? 'area',
  description: def.description,
  writes: def.writes,
  writesLocal: def.writesLocal === true,
  writesDependOnInput: def.writesWhen !== undefined || def.writesLocalWhen !== undefined,
  inputSchema: inputSchemaFor(def),
});

/** A connection's fields in the order `connections add` asks for them: settings (`baseUrl` first), then secrets. */
function connectionFields(area: AnyArea): ConnectionField[] {
  const shape = area.connection.shape as Record<string, z.ZodType>;
  const secretKeys: string[] = area.secrets ?? [];
  const choices = area.choices as Record<string, ChoiceSet | undefined> | undefined;
  const variants = area.variants?.of ?? {};
  const mentions = (name: string) => Object.entries(variants).filter(([, v]) => [...(v.requires ?? []), ...(v.uses ?? [])].includes(name)).map(([k]) => k);
  const settings = Object.keys(shape)
    .filter((k) => !secretKeys.includes(k))
    .sort((a, b) => Number(b === 'baseUrl') - Number(a === 'baseUrl'));
  const explicit = area.appliesTo as Record<string, string[] | undefined> | undefined;
  const appliesTo = (name: string) => [...new Set([...mentions(name), ...(explicit?.[name] ?? [])])];
  const requiredFor = (name: string) => Object.entries(variants).filter(([, v]) => (v.requires ?? []).includes(name)).map(([k]) => k);
  const field = (name: string, secret: boolean): ConnectionField => {
    const fallback = (area.defaults as Record<string, unknown> | undefined)?.[name];
    return {
      name,
      description: shape[name]?.description ?? null,
      secret,
      password: secret && area.secretKinds[name] === 'password',
      default: fallback === undefined ? null : String(fallback),
      required: fallback === undefined && shape[name]?.safeParse(undefined).success === false,
      ...(choices?.[name] ? { choices: choices[name] as ConnectionChoices } : {}),
      ...(appliesTo(name).length > 0 ? { appliesTo: appliesTo(name) } : {}),
      ...(requiredFor(name).length > 0 ? { requiredFor: requiredFor(name) } : {}),
    };
  };
  return [...settings.map((k) => field(k, false)), ...secretKeys.filter((k) => k in shape).map((k) => field(k, true))];
}

let listed: CommandInfo[] | undefined;
let listedForPerson: CommandInfo[] | undefined;
let summaries: AreaSummary[] | undefined;
/** Built on first read: a JSON Schema for every command takes a moment, and most hosts look once. */
export const registry: Registry = {
  get areas() {
    summaries ??= areas.map((a) => ({ name: a.name, description: a.description, connection: connectionFields(a), ...(a.scopes ? { scopes: describeScopes(a.scopes) } : {}), ...(a.variants ? { variantBy: a.variants.by } : {}) }));
    return summaries;
  },
  get commands() {
    listed ??= served.map(info);
    return listed;
  },
  get personCommands() {
    listedForPerson ??= forPerson.map(info);
    return listedForPerson;
  },
};

/** The host's person as the Prompter the connections commands ask through. */
function prompterFor(person: ExecutePerson): Prompter {
  const ask = async (question: Question): Promise<string> => {
    const answer = await person.ask(question);
    if (answer === undefined) throw new ToilError('CANCELLED', `Nothing was saved: "${question.text}" wasn't answered.`, { fix: 'Answer every question the command asks, then try again.' });
    if (typeof answer !== 'string') throw new ToilError('INVALID_INPUT', `The answer to "${question.text}" must be text.`, { fix: 'Pass the text the person typed.' });
    return answer;
  };
  return {
    ask: async (text, fallback, id) => {
      const answer = (await ask({ id: id ?? 'question', text, secret: false, fallback: fallback ?? null })).trim();
      return answer === '' ? (fallback ?? '') : answer;
    },
    // Untrimmed, as typed: the paste checks (checkSecret) trim it and say so, as on a terminal.
    askSecret: (text, id) => ask({ id: id ?? 'secret', text, secret: true, fallback: null }),
  };
}

// Nothing is spawned until a `keychain:` reference is actually read.
let secrets: SecretStore | undefined;

/**
 * Runs one command, as `toil <name>` would, and returns its envelope. Never
 * throws: an unknown command, a bad option or a failure inside is an envelope
 * with `ok: false`, like every other. `input` is the command's MCP fields
 * (`{ jql: "project = PAY", limit: 50 }`), checked strictly. On a Node toil
 * flags (`src/core/runtime.ts`, CVE-2026-111497) every envelope carries the
 * warning in `meta.warnings`, from core like the other front doors; the call still runs.
 */
export async function execute(command: string, input: Record<string, unknown> = {}, options: ExecuteOptions = {}): Promise<Envelope> {
  // The API's own refusals never reach core, so they carry the unpatched-Node warning here.
  const unpatched = nodeWarning(process.versions.node);
  const refuse = (message: string, fix: string): Envelope =>
    failure(new ToilError('INVALID_INPUT', message, { fix }), { command, durationMs: 0, version: VERSION, ...(unpatched ? { warnings: [{ code: 'UNSUPPORTED_NODE', message: unpatched }] } : {}) });
  const def = byName.get(command) ?? (options.person ? personByName.get(command) : undefined);
  if (!def) {
    const known = commands.find((d) => commandName(d) === command);
    if (known && personByName.has(command)) return refuse(`${command} is a person's command: execute() runs it only with a person to answer its questions.`, `Pass options.person, or run toil ${command} in a terminal.`);
    return known
      ? refuse(`${command} isn't served through the API: it's a person's command, on the CLI.`, `Run toil ${command} in a terminal.`)
      : refuse(`toil has no command ${JSON.stringify(command)}.`, 'Use a name from registry.commands, such as "version" or "jira issue search".');
  }
  if (options.person !== undefined && (typeof options.person !== 'object' || options.person === null || typeof options.person.ask !== 'function')) {
    return refuse('person must be an object with an ask(question) function.', 'Pass { ask: (question) => <what the person typed> }.');
  }
  if (options.caller !== undefined && (typeof options.caller !== 'string' || !CALLER_LABEL.test(options.caller))) {
    return refuse(`caller must be a short name such as "toil-ui", not ${JSON.stringify(options.caller)}.`, 'Use lowercase letters, digits, ".", "_" and "-", up to 64 characters, starting with a letter or digit.');
  }
  if (options.actor !== undefined && (typeof options.actor !== 'string' || !CALLER_LABEL.test(options.actor))) {
    return refuse(`actor must be a short name such as "assignment-abc12345", not ${JSON.stringify(options.actor)}.`, 'Use lowercase letters, digits, ".", "_" and "-", up to 64 characters, starting with a letter or digit.');
  }
  secrets ??= createSecretStore();
  const signal = options.signal ?? new AbortController().signal;
  const context = (d: AnyCommand) =>
    createNodeContext({
      globals: { config: options.config, workspace: options.workspace, verbose: options.verbose === true },
      def: d,
      signal,
      // A program's stdin isn't toil's to read, so `-` refuses, as over MCP; the working directory is still the workspace.
      stdin: false,
      door: 'api',
      env: process.env,
      cwd: process.cwd(),
      home: homedir(),
      areas: areaInfo,
      version: VERSION,
      stderr: (text) => process.stderr.write(text),
      secrets,
      ...(options.onProgress ? { progress: options.onProgress } : {}),
      // Only the person's commands are handed it, through ctx.manage; run() keeps it from every other.
      // A read-only call asks nothing: `feedback` then only previews, and the connections commands are refused anyway.
      ...(options.person && !options.readOnly && personByName.has(commandName(d)) ? { prompt: prompterFor(options.person) } : {}),
    });
  return runCommand(def, input, context, VERSION, 'api', { targets: served }, { ...(options.readOnly ? { readOnly: true } : {}), ...(options.caller ? { caller: options.caller } : {}), ...(options.actor ? { actor: options.actor } : {}) });
}


/**
 * The Open Work Item mappers (docs/owi/spec.md), for a host that already
 * holds envelopes: the same mapping `util owi map` does, in-process and
 * synchronous. `input` is envelopes (one, an array, or JSON or JSON Lines
 * text), or a command's bare `data` with `command` named; `fields` is a
 * toil project section's `fields` object (`{ estimate: "customfield_10234",
 * estimateUnit: "points" }`). It doesn't validate against the schema the way
 * `execute('util owi map', …)` does, which runs the check in a worker; use
 * that, or `owiSchema`, to check. Refusals (an override OWI has no field for,
 * output it can't map) throw a ToilError with a fix.
 */
export function mapOwi(input: unknown, options: OwiMapOptions = {}): OwiResult {
  const values = typeof input === 'string' ? parseOwiInput(input) : inputValues(input);
  const { documents, skipped } = documentsFrom(values, { command: options.command, key: options.key });
  return mapDocuments(documents, { fields: fieldOverrides(options.fields), skipped, keys: keyPatterns(options.keyPatterns), authors: authorKinds(options.authorKinds) });
}

export interface OwiMapOptions {
  /** OWI fields pointed at a team's own fields: a toil project section's `fields`, or `name=field` strings. */
  fields?: Record<string, string> | string[];
  /** The command whose bare `data` the input is (`jira issue search`). */
  command?: string;
  /** The item a keyless history (`jira issue history`, `github issue history`) belongs to. */
  key?: string;
  /** Where work item keys in a pull request's title, branch and description point: `PAY-{n}=corp-jira` strings, or `{ text, connection }`. */
  keyPatterns?: Array<string | KeyPattern>;
  /** Pull request author kinds set by hand, by author id: `{ "release-bot": "BOT" }`, or `id=KIND` strings. */
  authorKinds?: Record<string, string> | string[];
}

/**
 * Likely duplicates among OWI records you already hold, scored the way
 * `util owi similar` scores them (src/core/owi/similar.ts), in-process and
 * synchronous: `{ query }` ranks the records against some text, `{ item }`
 * against one of them, `{ pairs: true }` lists likely duplicate pairs.
 * `records` is OWI items (mapOwi's `items`), or the text `util owi map`
 * printed. Lexical and deterministic: the same records give the same result.
 * It doesn't run in the bounded worker the way `execute('util owi similar', …)`
 * does, so a host scoring a very large set should use that. An unknown item, or
 * a query with no words to compare, throws a ToilError with a fix.
 */
export function findSimilar(records: readonly SimilarItem[] | string, request: SimilarRequest, options: SimilarOptions = {}): SimilarResult {
  return findSimilarItems(typeof records === 'string' ? parseOwiRecords(records).items : records, request, options);
}

/** The OWI version this toil writes, as every item's `owi` says. */
export const owiVersion: string = OWI_VERSION;

/** docs/owi/schema.json, the JSON Schema (2020-12) every OWI item validates against. */
export const owiSchema: Record<string, unknown> = owiSchemaJson as Record<string, unknown>;

/**
 * The paste checks toil runs on a secret before storing it (#358), for a host
 * whose person types one into its own field: the same function the CLI's
 * terminal and `execute()`'s `person` path use, so a form says what the
 * terminal says. It trims surrounding whitespace and reports it, finds quotes
 * or a `Bearer ` / `token ` prefix to ask about (the `unwrap:<key>` question),
 * refuses a line break inside the value (or, for a token, a space), and says
 * what an empty answer means. It never returns any part of the value but the
 * value itself, trimmed or unwrapped, for the host to send.
 */
export function checkSecret(raw: string, rules: SecretRules): SecretCheck {
  return checkSecretInput(raw, rules);
}
