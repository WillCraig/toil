import { ToilError, type ErrorCode } from './errors.js';
import type { TransitionReport } from './transition-intent.js';
import type { SummaryReport } from './output/summary.js';

/**
 * The version of toil's command contract: the envelope, the commands, their
 * flags and fields, and the error codes, as callers rely on them. It is
 * `contractVersion` in docs/command-contract.json (test/api.test.ts
 * holds the two together), in `toil version`, and on every envelope's meta.
 *
 * It goes up by one with every breaking change to the contract, the kind
 * Delivery declares with `feat!:`: a command, flag, field or envelope key
 * removed, renamed or repurposed, or an error code repurposed. Additive
 * changes (a new command, flag, field or code) leave it alone, so a caller
 * built against version N works with any toil that reports N. Version 2 (#495):
 * the `jira-cloud` and `confluence-cloud` areas folded into `jira` and `confluence`, and `jira_cloud_*` and `confluence_cloud_*` tools into `jira_*` and `confluence_*`. Version 3 (#555): dossiers became toil projects: the `projects` command group and `<area> check-toil-project`, the `projects_*` and `<area>_check_toil_project` tools, the `toilProject` input and `meta.context.toilProject`, the `TOIL_PROJECT_*` codes, `TOIL_PROJECT` and `TOIL_PROJECT_PATHS`, and `toil://projects`.
 * docs/command-contract.md, Changing the contract, says the same for people.
 */
export const CONTRACT_VERSION = 3;

/**
 * The output contract: every command, through the CLI or MCP, produces exactly
 * one of these. Removing or renaming a field is a breaking change.
 */
export interface Meta {
  command: string;
  durationMs: number;
  version: string;
  /**
   * The command contract's version, CONTRACT_VERSION: what a caller checks
   * to know it reads this toil's envelopes and commands as they are meant.
   */
  contractVersion: number;
  /** Under --verbose: every request the command made, credentials redacted. */
  requests?: Array<{ method: string; url: string; status: number | null; durationMs: number }>;
  /**
   * Things the caller should know that aren't failures: a deprecated flag, a
   * config key that was ignored. Present only when there are some. This, not
   * stderr, is how an MCP client hears about them.
   */
  warnings?: Warning[];
  /** For paged results: where the next page starts. `data` keeps its shape. */
  page?: Page;
  /**
   * For an area command: which connection the call used and how it was
   * chosen, each context input's value and source, and any setting taken from
   * another area's connection. Never a secret's value.
   */
  context?: ContextReport;
  /**
   * For a raw API call (`<area> api`): the answer's status and content type,
   * since `data` is the body as the service sent it. Set with `ctx.setResponse`.
   */
  response?: ApiAnswer;
  /**
   * For a command that ran SQL the caller wrote (`db query`, `db execute`,
   * `db lint`): the engine whose dialect the pre-flight lint checked it
   * against, and every rule that ran. Its warnings are in `warnings`. Set
   * with `ctx.setLint`.
   */
  lint?: LintReport;
  /**
   * For `toil wait`: the condition, how many times the read ran, and how
   * long the whole wait took. The rest of meta is the last attempt's.
   */
  wait?: { until: string; attempts: number; elapsedMs: number };
  /**
   * For a transition asked for by intent (`--to review`): what was asked, the
   * transition and status it resolved to, and which rule chose it. Set with
   * `ctx.setTransition` (src/core/transition-intent.ts).
   */
  transition?: TransitionReport;
  /**
   * Under `--summary-file`: which summary rule applied, how many rows the full
   * result has, where its table is, the file it was written to, and the token
   * estimates (src/core/output/summary.ts).
   */
  summary?: SummaryReport;
  /** Under `--output-format toon`: `data` is TOON text rather than JSON. Absent for JSON. */
  format?: 'toon';
}

/** What the pre-flight lint checked: the engine, and the rules that ran, in order. */
export interface LintReport {
  engine: string;
  rules: string[];
}

/** The status and content type of the response a raw API call returned. */
export interface ApiAnswer {
  status: number;
  contentType: string | null;
}

/**
 * Where a resolved value came from, highest precedence first. `file`: the
 * command read it from a file the call named, such as an `--input-file`
 * (`ctx.supply`).
 */
export type ContextSource = 'input' | 'file' | 'toil-project' | 'git' | 'connection' | 'default';

export interface ContextValue {
  value: string;
  source: ContextSource;
  /** For `connection`: the context input whose value selected it (`instance`). */
  via?: string;
  /** For `connection` from the default: named in `defaults.<area>`, named after the area, or the only one. */
  default?: 'named' | 'area-name' | 'only';
  /** For `connection` from a toil project's host selector: the host it matched. A selector, never contacted. */
  host?: string;
  /** For `connection`, in an area that serves more than one deployment (`jira`): which one ran, `server` or `cloud`. */
  deployment?: string;
}

/** The toil project a call used (docs/projects.md), and how it was found. Never a value from a connection. */
export interface ToilProjectReport {
  name: string;
  /** Where it lives: your own folder, a listed folder, the repository you're in, or a file named on the call. */
  source: 'user' | 'listed' | 'repo' | 'file';
  /** The file, absolute, with forward slashes. */
  file: string;
  /** What chose it: the call's `toilProject` input, TOIL_PROJECT, or the folder. */
  by: 'input' | 'env' | 'folder';
  /** How the folder matched it: a repo's path, a repo's remote, or a toil project checked into the folder's repository. */
  match?: 'path' | 'remote' | 'checked-in';
  /** The toil project's repo the folder is, when one matched. */
  repo?: string;
  /** The folder, when it chose the toil project or the call named one: the `cwd` input, or where the workspace came from. */
  folder?: { path: string; from: 'input' | 'flag' | 'env' | 'cwd' | 'mcp-root' };
}

export interface ContextReport {
  /** The toil project that supplied context, when one applied. */
  toilProject?: ToilProjectReport;
  connection?: ContextValue;
  /** Each context input that resolved. Absent when none did. */
  inputs?: Record<string, ContextValue>;
  /**
   * Settings taken from another area's connection, by key: which area and
   * connection, where that value lived (env, ci, the store, the file, or
   * `defaults` in the file), and whether the user paired the connections or it was the default
   * connection's env fallback. Never the value. Absent when none were.
   */
  shared?: Record<string, { area: string; connection: string; source: 'env' | 'ci' | 'store' | 'file' | 'defaults'; via: 'pairing' | 'env-fallback' }>;
}

export interface Warning {
  code: string;
  message: string;
}

/** The paging convention: an opaque cursor for the next page (null on the last) and the page size used. */
export interface Page {
  nextCursor: string | null;
  limit: number;
}

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  fix?: string;
  details?: unknown;
}

export type Envelope<T = unknown> =
  | { ok: true; data: T; error: null; meta: Meta }
  | { ok: false; data: null; error: ErrorBody; meta: Meta };

/** Meta as a builder hands it over: `contractVersion` is stamped here, so no envelope can leave without it. */
export type MetaInput = Omit<Meta, 'contractVersion'> & { contractVersion?: number };

/** `contractVersion` right after `version`, where a reader looks for it. */
function stamp(meta: MetaInput): Meta {
  const { command, durationMs, version, ...rest } = meta;
  // A meta carried over from another envelope (a wait's last attempt) keeps its key in place; the value is always this toil's.
  const stamped: Meta = { command, durationMs, version, contractVersion: CONTRACT_VERSION, ...rest };
  stamped.contractVersion = CONTRACT_VERSION;
  return stamped;
}

export function success<T>(data: T, meta: MetaInput): Envelope<T> {
  return { ok: true, data, error: null, meta: stamp(meta) };
}

export function failure(err: ToilError, meta: MetaInput): Envelope<never> {
  const error: ErrorBody = { code: err.code, message: err.message };
  if (err.fix !== undefined) error.fix = err.fix;
  if (err.details !== undefined) error.details = err.details;
  return { ok: false, data: null, error, meta: stamp(meta) };
}
