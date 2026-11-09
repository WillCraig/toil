import { nodeWarning } from './runtime.js';
import { z } from 'zod';
import { areaOf, changesAnythingFor, commandName, isCliOnly, managesConfig, takesAllowWrite, usesConnection, writesFor, type AnyCommand } from './command.js';
import type { Connection, ContextInput } from './area.js';
import { recordAudit } from './audit.js';
import { flagOf, resolveCall, supplyContext, type ResolvedCall } from './call-context.js';
import { connectionEnvName, connectionsOf, defaultConnectionName, envName } from './config.js';
import { IncompleteConnectionError } from './connection.js';
import { refuseForDeployment } from './deployments.js';
import type { CommandContext, Context } from './context.js';
import type { Place } from './toil-project.js';
import { CONTRACT_VERSION, failure, success, type ApiAnswer, type ContextReport, type Envelope, type LintReport, type Meta, type Page, type Warning } from './envelope.js';
import { ToilError, toToilError } from './errors.js';
import { instrumentFetch, type RequestLog } from './http.js';
import { progressMessage, withProgress, type ProgressBody } from './progress.js';
import { checkSummaryFile, shapeEnvelope, takeOutput, type OutputOptions } from './output/shape.js';
import { applySelect, takeSelect } from './query/select.js';
import type { TransitionReport } from './transition-intent.js';
import { runWait, type WaitOptions } from './wait.js';

/**
 * Which front door a call came in by: the CLI's flags, MCP's fields, or a
 * program calling `execute()` from `@imagile-dev/toil/api` (src/api.ts), which
 * sends MCP's fields too and is held to MCP's rules.
 */
export type FrontDoor = 'cli' | 'mcp' | 'api';

/**
 * How one call is to be made, beyond its input. Front doors set it; a
 * command never sees it. It is an object so that what a later host needs (an
 * `actor` the call is made on behalf of) is a new field, not a new parameter.
 */
export interface CallOptions {
  /**
   * Refuse the call, before anything resolves or is sent, when it would
   * change anything: `writes` / `writesWhen` (the passthrough's POST), or
   * `writesLocal` / `writesLocalWhen` on this machine. Whatever the config says.
   * `ctx.files` refuses a write the command didn't declare.
   */
  readOnly?: boolean;
  /** Who is calling, as the caller names itself (`toil-ui`), for the audit log. Checked by the front door. */
  caller?: string;
  /** Who the call is made on behalf of (`assignment-<id>`), for the audit log. Checked by the front door. */
  actor?: string;
}

/** Input fields renamed in a release, so a call that still sends the old one is told the new one (contract version 3). */
const RENAMED_FIELDS: Record<string, string> = { dossier: 'toilProject' };

/**
 * Builds the context and runs the command, so a failure building the context
 * (a config file that stopped being JSON while the MCP server was up) is an
 * envelope too, not an exception for each front door to remember to catch.
 * Both front doors call this; neither calls execute() directly. Over MCP, an
 * input error names the tool's fields rather than the CLI's flags.
 */
export async function runCommand(
  def: AnyCommand,
  rawInput: unknown,
  makeContext: (def: AnyCommand) => Context,
  version: string,
  via: FrontDoor = 'cli',
  wait?: WaitOptions,
  call: CallOptions = {},
): Promise<Envelope> {
  let envelope: Envelope;
  // --output-format and --summary-file are core's (src/core/output/shape.ts): taken off here, applied to the envelope below.
  let output: OutputOptions = { format: 'json' };
  let files: Context['files'] | undefined;
  try {
    const taken = takeOutput(commandName(def), rawInput);
    output = taken.output;
    const input = taken.input;
    // The summary file is a file this call writes, so a read-only call is refused it before anything runs.
    if (output.summaryFile !== undefined && call.readOnly) {
      throw new ToilError('WRITE_DISABLED', `summaryFile writes a file, and this call to ${commandName(def)} was made read-only, so it was refused before anything ran.`, {
        fix: 'Leave summaryFile out of a read-only call, or make the call without readOnly.',
      });
    }
    // Any context's file service will do: each one a call builds resolves against the same workspace.
    const make = (d: AnyCommand) => {
      const ctx = makeContext(d);
      files ??= ctx.files;
      return ctx;
    };
    const first = output.summaryFile !== undefined ? make(def) : undefined;
    if (output.summaryFile !== undefined) checkSummaryFile(first!.files, output.summaryFile);
    // `toil wait` runs the read it names once per attempt, each through execute() (src/core/wait.ts).
    if (def.dispatches) envelope = await runWait(def, input, make, version, via, wait ?? { targets: [] }, call);
    else envelope = await execute(def, input, first ?? make(def), via, call);
  } catch (err) {
    // A failure before execute() ran (a broken config, say) still carries the unpatched-Node warning.
    const unpatched = nodeWarning(process.versions.node);
    envelope = failure(toToilError(err), { command: commandName(def), durationMs: 0, version, ...(unpatched ? { warnings: [{ code: 'UNSUPPORTED_NODE', message: unpatched }] } : {}) });
  }
  envelope = keepExitCode(envelope, shapeEnvelope(envelope, output, files, writesForInput(def, rawInput)));
  // MCP and the API both send fields, so their input errors name fields.
  return via === 'cli' ? envelope : inFieldNames(def, envelope);
}

/** Whether this call changes data, read from its input as the CLI reads it for --output-file. */
function writesForInput(def: AnyCommand, rawInput: unknown): boolean {
  try {
    return writesFor(def, rawInput);
  } catch {
    return def.writes;
  }
}

/**
 * A CLI command line quoted in an error: `toil …` in backticks, or plain text
 * from `toil ` to the end of its clause (a `,` or `;`, a `.` that ends a
 * sentence, a backtick, or the end). The capture keeps it in `split`'s output.
 */
const COMMAND_LINE = /(`toil [^`]*`|\btoil [^,;`]*?(?=[,;`]|\.(?:\s|$)|$))/;

/**
 * An INVALID_INPUT envelope reworded for an MCP caller: each of the
 * command's flags (`--updated-since`) and positional arguments (`<key>`) becomes its field (`updatedSince`, `key`), in the
 * message and the fix. Areas word their input errors once, for the CLI; this
 * translates them, so no area keeps two copies. The code and everything else
 * stay as they were. A form that cites the wrong form's field numbers is
 * still technically a form, which is the standard this replaces.
 */
export function inFieldNames(def: AnyCommand, envelope: Envelope): Envelope {
  if (envelope.ok || envelope.error.code !== 'INVALID_INPUT') return envelope;
  const flags: Array<[string, string]> = (def.options ?? []).flatMap((o) => {
    const long = o.flags.split(/[\s,|]+/).find((p) => p.startsWith('--'));
    return long && !long.startsWith('--no-') ? [[long, o.field] as [string, string]] : [];
  });
  if (takesAllowWrite(def)) flags.push(['--allow-write', 'allowWrite']);
  // A positional argument is named in prose as `<key>`; over MCP it is the field it maps to.
  for (const arg of def.args ?? []) flags.push([`<${arg.name}>`, arg.field]);
  // Longest first, so `--updated-since` isn't read as `--updated` followed by text.
  flags.sort((a, b) => b[0].length - a[0].length);
  const swap = (text: string) => flags.reduce((out, [flag, field]) => out.replace(new RegExp(`(?<![\\w-])${flag}(?![\\w-])`, 'g'), field), text);
  // A quoted command line (`toil jira issue transitions X`) is something to
  // run on the CLI, so it keeps its flags: only the prose between them is swapped.
  const reword = (text: string) => text.split(COMMAND_LINE).map((part, i) => (i % 2 === 1 ? part : swap(part))).join('');
  const error = { ...envelope.error, message: reword(envelope.error.message) };
  if (envelope.error.fix !== undefined) error.fix = reword(envelope.error.fix);
  return { ...envelope, error };
}

/**
 * The exit code a command asked for with `ctx.setExitCode`, keyed on the
 * envelope it returned, so the envelope itself, which both front doors print,
 * gains no field. The CLI reads it; MCP has no exit code to give.
 */
const exitCodes = new WeakMap<Envelope, number>();

/** The exit code for an envelope: 1 for a failure, else what the command asked for, else 0. */
export function exitCodeOf(envelope: Envelope): number {
  return envelope.ok ? (exitCodes.get(envelope) ?? 0) : 1;
}

/** `to`, a copy of `from` with more in it (a wait's `meta.wait`), keeping the exit code `from` asked for. */
export function keepExitCode(from: Envelope, to: Envelope): Envelope {
  const code = exitCodes.get(from);
  if (code !== undefined) exitCodes.set(to, code);
  return to;
}

/** Two minutes: long enough for a slow report, short enough that a hung server isn't forever. */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The one way any command runs, from either front door: validate the input
 * strictly, enforce the write gate, run with an instrumented, cancellable fetch
 * under a time limit, and wrap the result or failure in the envelope.
 * --verbose, warnings, paging, timeouts, cancellation and the audit line all
 * live here, so no front door can forget them and no command has to remember them.
 */
export async function execute(def: AnyCommand, rawInput: unknown, ctx: Context, via: FrontDoor = 'cli', how: CallOptions = {}): Promise<Envelope> {
  const started = performance.now();
  const requests: RequestLog[] = [];
  // An unpatched Node is said in every envelope, on every front door (src/core/runtime.ts), not only in the API's.
  const unpatched = nodeWarning(process.versions.node);
  const warnings: Warning[] = [...(unpatched ? [{ code: 'UNSUPPORTED_NODE', message: unpatched }] : []), ...ctx.config.warnings];
  let page: Page | undefined;
  let response: ApiAnswer | undefined;
  let transition: TransitionReport | undefined;
  let lint: LintReport | undefined;
  let report: ContextReport | undefined;
  let exitCode: number | undefined;
  // Reports the toil project once it has been consulted, which may be as late as the command's own run.
  let reportToilProject: (() => void) | undefined;
  const meta = (): Meta => {
    reportToilProject?.();
    const m: Meta = { command: commandName(def), durationMs: Math.round(performance.now() - started), version: ctx.version, contractVersion: CONTRACT_VERSION };
    if (ctx.verbose) m.requests = requests;
    if (warnings.length > 0) m.warnings = warnings;
    if (page) m.page = page;
    if (response) m.response = response;
    if (transition) m.transition = transition;
    if (lint) m.lint = lint;
    if (report && Object.keys(report).length > 0) m.context = report;
    return m;
  };

  // A CLI-only command may be waiting on a person typing a token; Ctrl+C still cancels it.
  const timeoutMs = isCliOnly(def) ? undefined : (ctx.timeoutMs ?? def.timeLimitMs ?? DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  // Aborting stops toil waiting; it can't recall a request the server already
  // has. For a write, "stopped" would invite a retry that files the change
  // twice, so say what is actually known: nothing.
  // Known for certain once the input parses, since `writesWhen` reads it.
  let writing = def.writes;
  const maybeApplied = () => (writing ? ' The change may already have been applied.' : '');
  const checkFirst = () => (writing ? 'Check whether the change was made before retrying. ' : '');
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(
          () =>
            controller.abort(
              new ToilError('TIMEOUT', `${commandName(def)} took longer than ${timeoutMs / 1000}s; toil stopped waiting.${maybeApplied()}`, {
                fix: `${checkFirst()}Narrow the request, or raise the limit with TOIL_TIMEOUT_MS.`,
              }),
            ),
          timeoutMs,
        );
  const onCallerAbort = () =>
    controller.abort(new ToilError('CANCELLED', `${commandName(def)} was cancelled.${maybeApplied()}`, writing ? { fix: checkFirst().trim() } : {}));
  if (ctx.signal?.aborted) onCallerAbort();
  else ctx.signal?.addEventListener('abort', onCallerAbort, { once: true });
  // One audit line per call, success or failure, with the input as the caller
  // sent it and every request, --verbose or not (src/core/audit.ts).
  // A config change or another toil version rewrites the installed toil skill, said in meta.warnings.
  // A read-only call writes nothing outside the audit log, the skill's upkeep included.
  const upkeep = () => (how.readOnly ? undefined : ctx.skillUpkeep?.((w) => warnings.push(w)));
  const audited = (envelope: Envelope) => recordAudit(ctx.audit, { def, input: rawInput, via, writes: writing, requests, envelope, ...(how.caller ? { caller: how.caller } : {}), ...(how.actor ? { actor: how.actor } : {}) });
  // Progress (src/core/progress.ts) goes to the front door's listener with the
  // command's name and a line of text. A listener that throws loses its
  // events, never the command, and the envelope says so once.
  const listen = ctx.progress;
  let listenerFailed = false;
  const toListener = (body: ProgressBody) => {
    if (!listen || listenerFailed) return;
    try {
      listen({ ...body, command: commandName(def), message: progressMessage(commandName(def), body) });
    } catch (err) {
      listenerFailed = true;
      warnings.push({ code: 'PROGRESS_LISTENER_FAILED', message: `The progress listener threw (${(err as Error).message}), so no more progress was reported for this call. The command itself ran as reported.` });
    }
  };

  try {
    // Read-only: a command that always writes, in a service or on this machine, is refused before its input is even read.
    if (how.readOnly && (def.writes || def.writesLocal === true)) throw readOnlyRefusal(def);
    // Strict: an unknown or misspelt field is an error through MCP exactly as an
    // unknown flag is on the CLI, never a field silently ignored.
    // --select is core's, not the command's: compiled here, before anything runs, and applied to data below.
    const { input: own, query } = takeSelect(commandName(def), rawInput);
    const parsed = def.input.strict().safeParse(own ?? {});
    if (!parsed.success) {
      // A field that was renamed gets its new name in the fix, not a pointer to --help that never mentions the old one.
      const renamed = Object.entries(RENAMED_FIELDS).filter(([old]) => parsed.error.issues.some((i: z.core.$ZodIssue) => i.code === 'unrecognized_keys' && i.keys.includes(old)));
      throw new ToilError('INVALID_INPUT', `Invalid input for ${commandName(def)}: ${z.prettifyError(parsed.error)}`, {
        fix: `${renamed.map(([old, now]) => `The field "${old}" is now "${now}". `).join('')}Run toil ${commandName(def)} --help to see the expected arguments.`,
        details: parsed.error.issues,
      });
    }
    const aborted = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) reject(controller.signal.reason);
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    aborted.catch(() => {});
    // One connection per call, resolved before the gate: writes are switched on
    // per connection, so the gate has to know which one this call would use.
    // Its context inputs resolve with it, since an input may select it.
    // Reading a secret from the OS store spawns a process, so it runs under
    // the same time limit and cancel as the command itself.
    const input = parsed.data as Record<string, unknown>;
    writing = writesFor(def, input);
    // One whose input makes it write (the passthrough's POST) is refused once that's known, still before anything resolves.
    if (how.readOnly && changesAnythingFor(def, input)) throw readOnlyRefusal(def);
    // A tool MCP serves, asked for a call it mustn't make (a DELETE through the passthrough). The API is held to the same.
    const offMcp = via !== 'cli' ? def.offMcpWhen?.(input) : undefined;
    if (offMcp) throw new ToilError('INVALID_INPUT', `${commandName(def)}: ${offMcp}`, { fix: `Only a person can make this call, on the CLI with toil ${commandName(def)}.` });
    // Filled as it resolves, so a failure part-way still reports what was chosen.
    const partial: ContextReport = {};
    if (usesConnection(def)) report = partial;
    // A command that handles "not set up" itself runs with no connection when
    // the area has none and the call names none; every other problem still fails.
    const optional =
      def.connectionOptional === true &&
      typeof input.connection !== 'string' &&
      !Object.entries(def.area?.context ?? {}).some(([name, spec]) => spec?.selectsConnection && typeof input[name] === 'string');
    const unconfigured = optional && defaultConnectionName(ctx.config, areaOf(def)) === undefined && connectionsOf(ctx.config, areaOf(def)).length === 0;
    // Where the call's toil project would come from, from its `toilProject` and `cwd`
    // (src/core/toil-project.ts). Which one applies is settled only if the resolver
    // reaches the toil project step, so a call that never does can't fail on one.
    const place: Place | undefined = usesConnection(def) && ctx.toilProjects ? ctx.toilProjects.place({ toilProject: input.toilProject as string | undefined, cwd: input.cwd as string | undefined }) : undefined;
    let warned = 0;
    reportToilProject = () => {
      if (!place) return;
      const found = place.warnings();
      warnings.push(...found.slice(warned));
      warned = found.length;
      const used = place.report();
      if (!used || partial.toilProject) return;
      // First in meta.context, as it's where the rest came from.
      const rest = { ...partial };
      for (const key of Object.keys(partial) as Array<keyof ContextReport>) delete partial[key];
      Object.assign(partial, { toilProject: used }, rest);
    };
    let call: ResolvedCall | undefined;
    // An input that says everything a connection would (db lint's --engine) skips resolution entirely.
    const connectionless = optional && def.connectionlessWhen?.(input) === true;
    if (usesConnection(def) && !unconfigured && !connectionless) {
      try {
        const toilProject = ctx.toilProjects ? place?.lookup : ctx.toilProject;
        try {
          call = await Promise.race([
            resolveCall(def, input, { config: ctx.config, secrets: ctx.secrets, toilProject, gitRemote: place?.gitRemote ?? ctx.gitRemote }, (w) => warnings.push(w), controller.signal, partial, (own ?? {}) as Record<string, unknown>),
            aborted,
          ]);
        } finally {
          reportToilProject();
          // Said even when resolution failed after choosing the connection (a required input missing).
          const chosen = partial.connection;
          const host = chosen?.source === 'toil-project' ? place?.hostFor(areaOf(def), input) : undefined;
          if (chosen && host) chosen.host = host;
        }
      } catch (err) {
        // The default connection exists but lacks a key (a missing `pat`): the
        // command answers for that as it does for none, and the warning says what's missing.
        if (!(optional && err instanceof IncompleteConnectionError)) throw err;
        warnings.push({ code: 'CONFIG_INCOMPLETE', message: `${err.message} ${err.fix ?? ''}`.trim() });
      }
    }
    const connection = call?.connection;
    // A command the connection's deployment doesn't have, or a flag only the other one takes, is refused first: before the write gate, which would otherwise talk about writes to a command that can't run.
    if (connection && def.deployments) {
      const refusal = refuseForDeployment(def, (own ?? {}) as Record<string, unknown>, connection, ctx.config, via);
      if (refusal) throw refusal;
    }
    if (writing) assertWritesAllowed(def, input, connection, call?.report, place ? place.adopted : ctx.adopted, ctx);

    // Commands get their connection and nothing else: no config, and no env,
    // which carries every other connection's token too. Need-to-know,
    // enforced rather than requested in a policy nobody reads.
    // The credential store and the prompter go only to commands that manage
    // connections, which get them through ctx.manage.
    const rest: Omit<Context, 'config' | 'env' | 'secrets' | 'prompt' | 'toilProjects' | 'toilProject' | 'gitRemote' | 'adopted' | 'repo' | 'audit' | 'skillUpkeep' | 'progress'> & {
      progress?: unknown;
      skillUpkeep?: unknown;
      audit?: unknown;
      repo?: unknown;
      toilProjects?: unknown;
      config?: unknown;
      env?: unknown;
      secrets?: unknown;
      prompt?: unknown;
      toilProject?: unknown;
      gitRemote?: unknown;
      adopted?: unknown;
    } = { ...ctx };
    delete rest.config;
    delete rest.env;
    delete rest.secrets;
    delete rest.prompt;
    delete rest.toilProjects;
    delete rest.toilProject;
    delete rest.gitRemote;
    delete rest.adopted;
    delete rest.repo;
    delete rest.audit;
    delete rest.skillUpkeep;
    delete rest.progress;
    const resolved = call?.report ?? {};
    const adoptedHere = place ? place.adopted : ctx.adopted;
    const context = writing && connection && !adoptedHere?.(areaOf(def), connection.name, 'toil-project') ? guardTargets(def, call?.context ?? {}, resolved, via) : (call?.context ?? {});
    const commandCtx: CommandContext<Connection | undefined> = {
      ...rest,
      connection,
      context,
      resolved,
      supply: (name, value, source) => {
        if (!def.area || !call) throw new Error(`${commandName(def)} has no context inputs to supply.`);
        return supplyContext(def.area, def, context, resolved, name, value, source);
      },
      ...(managesConfig(def) ? { manage: { config: ctx.config, secrets: ctx.secrets, prompt: ctx.prompt, toilProjects: ctx.toilProjects, env: ctx.env, via, audit: ctx.audit } } : {}),
      signal: controller.signal,
      fetch: instrumentFetch(ctx.fetch, requests, controller.signal),
      // For a server-side cancel or a session close after the signal fired: logged, but not bound to it.
      cleanupFetch: instrumentFetch(ctx.fetch, requests),
      // A listing's warnings (a refused git include, a skipped .gitignore line) land in meta.warnings without the command passing anything.
      files: {
        ...ctx.files,
        list: (dir, options) => ctx.files.list(dir, { ...options, warn: options?.warn ?? ((w) => warnings.push(w)) }),
        // Read-only means nothing local changes either. A command that writes a
        // file declares it (`writesLocal`) and is refused before it runs; this
        // catches one that didn't, loudly, before a byte lands.
        ...(how.readOnly ? { writeBytes: () => refuseLocalWrite(def), writeCsv: () => refuseLocalWrite(def) } : {}),
      },
      // git stops with the command, as fetch does, without the command passing anything.
      ...(ctx.git ? { git: { run: (call) => ctx.git!.run(call, controller.signal) } } : {}),
      // A call's `cwd` names the folder its repository is read from; otherwise the workspace's.
      repo: () => (place?.repo ?? ctx.repo)?.(),
      toilProjectFields: () => (place && def.area ? place.fields(def.area.name, input) : {}),
      toilProjectView: () => (place && def.area ? place.view(def.area.name) : undefined),
      toilProjectTransitions: () => (place && def.area ? place.transitions(def.area.name, input) : {}),
      warn: (warning) => warnings.push(warning),
      setPage: (p) => (page = p),
      setResponse: (r) => (response = r),
      setTransition: (r) => (transition = r),
      setLint: (l) => (lint = l),
      setExitCode: (code) => {
        if (!Number.isInteger(code) || code < 0 || code > 255) throw new Error(`${commandName(def)} asked for exit code ${code}; an exit code is a whole number from 0 to 255.`);
        exitCode = code;
      },
    };
    // `toilProject` and `cwd` choose context, which core has resolved; the command never needs them.
    const forRun = { ...(parsed.data as Record<string, unknown>) };
    if (usesConnection(def)) {
      delete forRun.toilProject;
      delete forRun.cwd;
    }
    const result = await Promise.race([withProgress(toListener, () => def.run(forRun, commandCtx)), aborted]);
    const data = query ? applySelect(query, result, commandName(def), writing, (w) => warnings.push(w)) : result;
    upkeep();
    const envelope = success(data, meta());
    if (exitCode !== undefined) exitCodes.set(envelope, exitCode);
    return audited(envelope);
  } catch (err) {
    // A request aborted by our signal surfaces as an AbortError; report why it was aborted.
    const reason = controller.signal.aborted ? controller.signal.reason : err;
    upkeep();
    return audited(failure(toToilError(reason), meta()));
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/** A file write from a command that didn't declare one, in a read-only call: refused, and a bug in its definition. */
function refuseLocalWrite(def: AnyCommand): never {
  throw new ToilError('WRITE_DISABLED', `${commandName(def)} tried to write a file, and this call was made read-only, so the write was refused.`, {
    fix: 'Make the call without readOnly to write the file. This command should declare writesLocal; report it at https://github.com/imagile-dev/toil/issues.',
  });
}

/** The refusal a read-only call gets for a command that would write. */
function readOnlyRefusal(def: AnyCommand): ToilError {
  return new ToilError('WRITE_DISABLED', `${commandName(def)} changes data, and this call was made read-only, so it was refused before anything ran.`, {
    fix: 'Make the call without readOnly if you mean to make this change; it then goes through the write gate as usual.',
  });
}

/**
 * Writes need both the connection's standing opt-in and --allow-write on this
 * call. Two approvals, like a change request, except both of these are
 * actually read.
 */
function assertWritesAllowed(
  def: AnyCommand,
  input: Record<string, unknown>,
  connection: Connection | undefined,
  report: ContextReport | undefined,
  adopted: Context['adopted'],
  ctx: Context,
): void {
  // A CLI-only write (`skills marketplace add`) has no connection yet to hold
  // a standing opt-in: it's never an MCP tool, so whoever types it is giving
  // the opt-in there and then, and --allow-write is how they say so.
  if (isCliOnly(def)) {
    if (input.allowWrite === true) return;
    throw new ToilError('WRITE_DISABLED', `${commandName(def)} changes files on this machine and needs --allow-write on the call.`, {
      fix: 'Re-run with --allow-write if you mean to make this change.',
    });
  }
  const area = areaOf(def);
  // A connection the toil project or the git remote picked is a suggestion until
  // the user adopts it. Reads may follow a suggestion; a write waits for a yes,
  // asked once, not inferred from where the terminal happens to be.
  const chosenBy = report?.connection?.source;
  if (connection && (chosenBy === 'toil-project' || chosenBy === 'git') && !adopted?.(area, connection.name, chosenBy)) {
    const by = chosenBy === 'toil-project' ? 'your toil project' : 'the git remote';
    throw new ToilError('WRITE_DISABLED', `${commandName(def)} changes data in ${area}, and connection ${connection.name} was chosen by ${by}, not by you.`, {
      fix: `Pass --connection ${connection.name} to choose it yourself${chosenBy === 'toil-project' ? ', or adopt the toil project once with toil projects import, which copies it into your own folder' : ''}.`,
    });
  }
  if (!connection?.writes) {
    const name = connection?.name ?? area;
    const variable = connection && defaultConnectionName(ctx.config, area) !== name ? connectionEnvName(name, 'writes') : envName(area, 'writes');
    throw new ToilError('WRITE_DISABLED', `${commandName(def)} changes data in ${area}, and writes are off for connection ${name}.`, {
      fix: `To allow writes, set "writes": true on connection "${name}" in your toil config (or ${variable}=true), then pass --allow-write.`,
    });
  }
  if (input.allowWrite !== true) {
    throw new ToilError('WRITE_DISABLED', `${commandName(def)} changes data and needs --allow-write on the call.`, {
      fix: 'Re-run with --allow-write if you mean to make this change.',
    });
  }
}

/**
 * Where in the service a write lands (owner and repo, a project) is as much a
 * choice as which connection, so a write takes it only from a source the user
 * owns. A toil project they haven't adopted (a repository's checked-in one, a
 * listed folder's, a loose file) may set it for reads, never for a write.
 * The check is made when the command reads the input, so a write that never
 * uses an input the area resolves for every command (an ADO work item update
 * and the group's `project`) isn't refused over it; every command reads its
 * target before it sends the write. An area helper that reads every input up
 * front defeats this (the write is refused over one it never uses), so a
 * helper reads a value only where a path needs it, and checks presence
 * through `ctx.resolved` (ado's `where()`). Field aliases and transition pins from
 * such a toil project stay allowed (#302). A rubber stamp from another department
 * is not a signature.
 */
function guardTargets(def: AnyCommand, context: Record<string, string>, report: ContextReport, via: FrontDoor): Record<string, string> {
  const declared = (def.area?.context ?? {}) as Record<string, ContextInput>;
  return new Proxy(context, {
    get(target, name, receiver) {
      if (typeof name === 'string' && report.inputs?.[name]?.source === 'toil-project' && declared[name] && !declared[name].selectsConnection) {
        const flag = flagOf(name, declared[name]).split(' ')[0];
        const toilProject = report.toilProject?.name;
        throw new ToilError('WRITE_DISABLED', `${commandName(def)} changes data in ${areaOf(def)}, and its ${name} came from ${toilProject ? `toil project ${toilProject}` : 'a toil project'}, which you haven't adopted.`, {
          fix:
            via === 'cli'
              ? `This toil project sets where this write goes. Adopt it with toil projects import ${toilProject ?? '<name>'} (the CLI only), or pass ${flag} yourself.`
              : `This toil project sets where this write goes. Ask the user to adopt it (toil projects import ${toilProject ?? '<name>'}, on the CLI), or pass ${name} yourself.`,
        });
      }
      return Reflect.get(target, name, receiver);
    },
  });
}

/**
 * Write commands spread this into their input. It is optional in the schema so
 * MCP clients see it as a field they may set; execute() refuses the write when
 * it isn't true, so leaving it out is the safe default.
 */
export const allowWriteField = {
  allowWrite: z.boolean().optional().describe('Must be true to make the change. Set only when the user asked for this write.'),
};
