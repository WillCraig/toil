import { z } from 'zod';
import type { AnyArea, Connection, ContextInput } from './area.js';
import { commandName, type AnyCommand } from './command.js';
import { connectionEnvName, connectionsOf, defaultConnectionName, envName, type ResolvedConfig } from './config.js';
import { resolveConnection, selectConnection } from './connection.js';
import { refusesDeployment } from './deployments.js';
import type { ContextReport, ContextSource, ContextValue, Warning } from './envelope.js';
import { StrandedInput, ToilError } from './errors.js';
import type { SecretStore } from './keychain.js';

/**
 * Where a command acts, worked out once for every area. Each context input
 * (`--project`, `--repo`, `--instance`) resolves in this order:
 *
 *   1. the call's own value: a CLI flag or an MCP field
 *   2. the toil project that applies to the call (src/core/toil-project.ts)
 *   3. the working folder's git remote, where the area declares how to read it
 *      (handed the resolved connection, so it can check the remote's host)
 *   4. the connection's setting, then the area's default
 *
 * A command may then fill one from a value it read itself (`ctx.supply`,
 * Jira's `--input-file` project), which ranks between 1 and 2.
 *
 * The connection goes through the same chain: at each source in turn (the
 * call, the toil project, the git remote), `connection` itself or an input that
 * selects one (`--instance prod`), and the two must agree; with neither, the
 * area's default connection. A selecting value from a lower source than the
 * one that picked the connection gives way to that connection's own setting.
 * The result lands on `ctx.context` and, with each value's source, in
 * `meta.context`. Four sources, one order, no committee.
 *
 * The git step runs only where a reader is supplied (`Context.gitRemote`);
 * the shipped CLI supplies one that reads `.git` in pure JS (src/core/git-repo.ts).
 * The toil project step runs where a toil project applies (`Context.toil projects`).
 */

/** A git remote as the reader hands it over: the area parses the URL. */
export interface GitRemote {
  name: string;
  url: string;
}

/**
 * Reads the working folder's remotes: `origin` first, then the rest in `git
 * remote -v` order; none outside a repository. Supplied by the git reader,
 * faked in tests. An area's `git` parser takes the first remote it accepts,
 * and it accepts only one on the connection's host.
 */
export type GitRemoteReader = (signal: AbortSignal) => Promise<readonly GitRemote[]>;

/**
 * A toil project's value for one area's key (`connection`, or a context input),
 * given the call's own input, since an explicit `--env` decides which of the
 * toil project's environments the rest comes from (src/core/toil-project.ts).
 */
export type ToilProjectLookup = (area: string, key: string, input?: Record<string, unknown>) => string | undefined;

export const noToilProject: ToilProjectLookup = () => undefined;

export interface CallSources {
  config: ResolvedConfig;
  secrets?: Pick<SecretStore, 'get'> | undefined;
  toilProject?: ToilProjectLookup | undefined;
  gitRemote?: GitRemoteReader | undefined;
}

export interface ResolvedCall {
  connection: Connection;
  context: Record<string, string>;
  report: ContextReport;
}

/**
 * `report` is filled as resolution goes, so a failure part-way (a required
 * input nobody supplied) still says which connection the call had chosen.
 */
export async function resolveCall(
  def: AnyCommand,
  input: Record<string, unknown>,
  sources: CallSources,
  warn: (w: Warning) => void,
  signal: AbortSignal,
  report: ContextReport = {},
  // The call as its caller sent it, which decides whether the connection's deployment will refuse it (below).
  sent?: Record<string, unknown>,
): Promise<ResolvedCall> {
  const area = def.area!;
  const declared = area.context as Record<string, ContextInput>;
  const needs = def.context ?? {};
  const toilProject = sources.toilProject ?? noToilProject;

  let remotes: Promise<readonly GitRemote[]> | undefined;
  const fromGit = async (spec: ContextInput, connection: Connection | undefined): Promise<string | undefined> => {
    if (!spec.git || !sources.gitRemote) return undefined;
    remotes ??= sources.gitRemote(signal);
    // A fork's checkout often has its server's remote as `upstream`: the first remote the parser accepts wins.
    for (const remote of await remotes) {
      const value = spec.git(remote, connection);
      if (value !== undefined) return value;
    }
    return undefined;
  };

  // Steps 1 to 3 for an input that may pick the connection, so it can; steps
  // 1 and 2 for the rest. Their git step waits for the connection, so a
  // parser can trust only a remote on that connection's host.
  const early: Record<string, ContextValue> = {};
  const stranded = new Map<string, StrandedInput>();
  const namedAround = new Map<string, StrandedInput>();
  const isCheck = def.path[def.path.length - 1] === 'check-toil-project';
  for (const name of Object.keys(needs)) {
    const spec = declared[name]!;
    const explicit = input[name];
    if (typeof explicit === 'string') {
      early[name] = { value: explicit, source: 'input' };
      continue;
    }
    // With --connection named, an input that selects one can only agree with it or give way, so the toil project isn't asked for it.
    let fromToilProject: string | undefined;
    try {
      fromToilProject = spec.selectsConnection && typeof input.connection === 'string' ? undefined : toilProject(area.name, name, input);
    } catch (err) {
      // A per-repo value with no repo to read it for: a command that needs it is told, one that doesn't gets nothing for it, never a git or connection value.
      if (!(err instanceof StrandedInput)) throw err;
      // The call named another per-repo input itself, so this one falls through as before; step 4 says where it came from.
      if (err.callNamed) {
        namedAround.set(name, err);
        fromToilProject = undefined;
      } else {
        // An input only some deployments take waits for the connection: Cloud never asks Data Center's project (step 4 decides).
        if (needs[name] === 'required' && !spec.deployments) throw err;
        stranded.set(name, err);
      // Said on the call, so a later "could not determine" error comes with the reason beside it (principle 4).
      // check-toil-project reads every per-repo value through the toil project's view by design, so the advice would be wrong there.
        if (!isCheck) warn({ code: 'TOIL_PROJECT_REPO_UNMATCHED', message: `${err.message} ${err.fix ?? ''}`.trim() });
        continue;
      }
    }
    const found = checked(area, name, spec, fromToilProject, 'toil-project') ?? (spec.selectsConnection ? checked(area, name, spec, await fromGit(spec, undefined), 'git') : undefined);
    if (found) early[name] = found;
  }

  const chosen = chooseConnection(sources.config, area, def, input, early, toilProject);
  const shared: NonNullable<ContextReport['shared']> = {};
  const connection = await resolveConnection(sources.config, area, chosen?.value, warn, sources.secrets, signal, { shared });
  report.connection = chosen ? { value: connection.name, source: chosen.source, ...(chosen.via ? { via: chosen.via } : {}) } : { value: connection.name, source: 'default', default: defaultKind(sources.config, area, connection.name) };
  // An area that serves more than one deployment says which one this call ran against.
  if (area.variants?.by === 'deployment') report.connection.deployment = String(connection.deployment);
  if (Object.keys(shared).length > 0) report.shared = shared;

  // A selecting value that lost to a higher source (an explicit --connection
  // over a toil project's env) mustn't describe a different connection than the
  // one in use: it gives way to that connection's own setting.
  for (const [name, found] of Object.entries(early)) {
    const spec = declared[name]!;
    if (!spec.selectsConnection || found.source === 'input') continue;
    let selects: string | undefined;
    try {
      selects = selectConnection(sources.config, area, name, spec.setting ?? name, found.value, flagOf(name, spec), found.source);
    } catch {
      selects = jointSelection(sources.config, area, early, found.source);
    }
    if (selects !== connection.name) delete early[name];
  }

  // Step 4, from the connection this call resolved.
  const inputs: Record<string, ContextValue> = {};
  const missing: string[] = [];
  // A command with an implementation per deployment needs what its deployment's does; one the deployment lacks needs nothing, and is refused next.
  const here = def.deployments ? (def.deployments.routes[String(connection[def.deployments.by])]?.context ?? {}) : needs;
  for (const [name, need] of Object.entries(here)) {
    const spec = declared[name]!;
    const strandedHere = stranded.get(name);
    if (strandedHere) {
      if (need === 'required') throw strandedHere;
      continue;
    }
    const setting = spec.setting === undefined ? undefined : connection[spec.setting];
    // An input the area gives to other deployments, which this one takes only because its command lists it, comes from the call or the
    // toil project alone: the connection's setting, defaults, env, git and the area default are documented as the other deployment's, and a
    // write must not take its target from them (principles 2 and 9).
    if (def.deployments && spec.deployments && !spec.deployments.includes(String(connection[def.deployments.by]))) {
      if (early[name]) inputs[name] = early[name];
      else if (need === 'required') missing.push(name);
      continue;
    }
    const value =
      early[name] ??
      (spec.selectsConnection ? undefined : checked(area, name, spec, await fromGit(spec, connection), 'git')) ??
      checked(area, name, spec, setting === undefined || setting === null ? undefined : String(setting), 'connection') ??
      checked(area, name, spec, spec.default, 'default');
    const around = namedAround.get(name);
    if (value && around && !isCheck) warn({ code: 'TOIL_PROJECT_REPO_UNMATCHED', message: `${around.message} ${name} came from ${value.source === 'git' ? 'the git remote' : value.source === 'connection' ? "the connection's setting" : value.source === 'default' ? "the area's default" : value.source} instead. Pass --${name} too, or run inside one of the toil project's repos (--cwd <repo folder>).` });
    if (value) inputs[name] = value;
    else if (need === 'required') missing.push(name);
  }
  if (Object.keys(inputs).length > 0) report.inputs = inputs;
  // A call the deployment is about to refuse (`--ws` on Data Center) is told so, not told what the other one's inputs lack.
  const refused = missing.length > 0 && sent !== undefined && refusesDeployment(def, sent, connection);
  if (missing.length > 0 && !refused) throw missingContext(sources.config, def, area, connection, missing);
  return { connection, context: Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.value])), report };
}

/**
 * The connection a toil project would choose for a call to `area` that gives no
 * input of its own: the same choice resolveCall makes at its toil project step,
 * from the toil project's `connection` (or host) and every input that selects a
 * connection (`env`, `instance`). Undefined when the toil project chooses nothing,
 * so the call would use the area's default. Throws what the call would throw
 * (a host matching none). The toil project commands judge a change by this, so the
 * rule on writes sees exactly what a call would do, not a copy of it.
 */
export function toilProjectConnection(config: ResolvedConfig, area: AnyArea, toilProject: ToilProjectLookup): ContextValue | undefined {
  const declared = area.context as Record<string, ContextInput>;
  const early: Record<string, ContextValue> = {};
  for (const [name, spec] of Object.entries(declared)) {
    if (!spec.selectsConnection) continue;
    let value: string | undefined;
    try {
      value = toilProject(area.name, name, {});
    } catch (err) {
      if (!(err instanceof StrandedInput)) throw err;
    }
    const found = checked(area, name, spec, value, 'toil-project');
    if (found) early[name] = found;
  }
  const def = { path: [area.name, 'toil-project'], area } as unknown as AnyCommand;
  return chooseConnection(config, area, def, {}, early, toilProject);
}

/** How the area's default connection was found: named in `defaults`, named after the area, or the only one. */
function defaultKind(config: ResolvedConfig, area: AnyArea, name: string): 'named' | 'area-name' | 'only' {
  if (typeof config.defaults[area.name]?.connection === 'string') return 'named';
  return name === area.name ? 'area-name' : 'only';
}

/** `connection` through the chain. An explicit `--connection` that contradicts an explicit selecting input is refused. */
function chooseConnection(
  config: ResolvedConfig,
  area: AnyArea,
  def: AnyCommand,
  input: Record<string, unknown>,
  early: Record<string, ContextValue>,
  toilProject: ToilProjectLookup,
): ContextValue | undefined {
  const declared = area.context as Record<string, ContextInput>;
  // The toil project is asked only when the call itself didn't decide, so a call
  // that names its connection never depends on which toil project would apply.
  const named = (source: ContextSource): string | undefined =>
    source === 'input' ? (typeof input.connection === 'string' ? input.connection : undefined) : source === 'toil-project' ? toilProject(area.name, 'connection', input) : undefined;
  // Source by source: at each step, a connection named outright and one an
  // input selects must agree, and the first step with either decides.
  for (const source of ['input', 'toil-project', 'git'] as const) {
    const name = named(source);
    let pick: ContextValue | undefined = name === undefined ? undefined : { value: name, source };
    const joint = jointSelection(config, area, early, source);
    for (const [name, found] of Object.entries(early)) {
      const spec = declared[name]!;
      if (!spec.selectsConnection || found.source !== source) continue;
      let selected: string;
      try {
        selected = selectConnection(config, area, name, spec.setting ?? name, found.value, flagOf(name, spec), found.source);
      } catch (err) {
        // Several connections have env prod, but only one is env prod and instance east.
        if (joint === undefined) throw err;
        selected = joint;
      }
      if (pick && pick.value !== selected) {
        const first = pick.via ? `${flagOf(pick.via, declared[pick.via]!).split(' ')[0]} selects connection ${pick.value}` : `--connection is ${pick.value}`;
        const where = { input: 'the call', 'toil-project': 'your toil project', git: 'the git remote' }[source];
        throw new ToilError('INVALID_INPUT', `Two different connections for ${commandName(def)}, both from ${where}: ${first}, but ${flagOf(name, spec).split(' ')[0]} ${found.value} selects connection ${selected}.`, {
          fix: `Give only one of them, or make them name the same connection.`,
        });
      }
      pick ??= { value: selected, source, via: name };
    }
    if (pick) return pick;
  }
  return undefined;
}

/**
 * The one connection that every selecting value from `source` matches at
 * once (`--env prod --instance east`), when there are two or more such
 * values. A connection matches a value by its name or by the input's
 * setting. None, or several, is undefined: each value then speaks for itself,
 * with the usual errors. Two signatures on one form identify one applicant.
 */
function jointSelection(config: ResolvedConfig, area: AnyArea, early: Record<string, ContextValue>, source: ContextSource): string | undefined {
  const declared = area.context as Record<string, ContextInput>;
  const selecting = Object.entries(early).filter(([name, found]) => declared[name]!.selectsConnection && found.source === source);
  if (selecting.length < 2) return undefined;
  const matches = connectionsOf(config, area.name).filter((conn) =>
    selecting.every(([name, found]) => {
      const value = config.connections[conn]![declared[name]!.setting ?? name];
      return conn === found.value || (value !== undefined && value !== null && String(value) === found.value);
    }),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

/** A value from a source other than the call, validated as the input's schema says; INVALID_INPUT names where it came from. */
function checked(area: AnyArea, name: string, spec: ContextInput, value: string | undefined, source: ContextSource): ContextValue | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = (spec.schema ?? z.string().min(1)).safeParse(value);
  if (!parsed.success) {
    const where = { input: 'the call', file: 'the input file', 'toil-project': 'the toil project', git: 'the git remote', connection: `the connection's ${spec.setting} setting`, default: "the area's default" }[source];
    throw new ToilError('INVALID_INPUT', `${area.name} ${name} "${value}" from ${where} isn't valid: ${parsed.error.issues.map((i) => i.message).join('; ')}.`, {
      fix: `Pass ${flagOf(name, spec).split(' ')[0]} explicitly, or correct ${where}.`,
    });
  }
  return { value: parsed.data, source };
}

export function flagOf(name: string, spec: ContextInput): string {
  return spec.flags ?? `--${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} <value>`;
}

/** The first missing input that declares its own wording (`missing`) words the error; otherwise core's. */
function missingContext(config: ResolvedConfig, def: AnyCommand, area: AnyArea, resolved: Connection, missing: string[]): ToilError {
  const declared = area.context as Record<string, ContextInput>;
  const connection = resolved.name;
  const isDefault = defaultConnectionName(config, area.name) === connection;
  const ways = missing.map((name) => {
    const spec = declared[name]!;
    const flag = flagOf(name, spec);
    if (spec.setting === undefined) return `pass ${flag}`;
    const variable = isDefault ? envName(area.name, spec.setting) : connectionEnvName(connection, spec.setting);
    return `pass ${flag}, or set ${spec.setting} on connection ${connection} (${variable})`;
  });
  const fix = `${ways.join('; ').replace(/^p/, 'P')}.`;
  const own = missing.map((name) => declared[name]!.missing).map((m) => (typeof m === 'function' ? m(resolved) : m)).find((m) => m !== undefined);
  if (own) return new ToilError('INVALID_INPUT', own.message, { fix: own.fix ?? fix });
  return new ToilError('INVALID_INPUT', `${commandName(def)} needs ${missing.join(' and ')}, and none was given or found.`, { fix });
}

/**
 * A context input the command filled itself from a value it read, such as a
 * project named in an `--input-file`. It ranks below the call's own value and
 * above everything else: the toil project, the git remote, the connection and the
 * default. Returns the value the command should use, and updates
 * `ctx.context` and `meta.context` to match. An empty or absent value changes
 * nothing. A selecting input can't be supplied this late, because the
 * connection it would pick is already in use.
 */
export function supplyContext(area: AnyArea, def: AnyCommand, context: Record<string, string>, report: ContextReport, name: string, value: string | undefined, source: SuppliedSource): string | undefined {
  const spec = (area.context as Record<string, ContextInput>)[name];
  if (!spec || !(name in (def.context ?? {}))) throw new Error(`${commandName(def)}: "${name}" isn't one of its context inputs, so it can't be supplied.`);
  if (spec.selectsConnection) throw new Error(`${commandName(def)}: "${name}" selects the connection, which is already chosen, so it can't be supplied from a ${source}.`);
  const current = report.inputs?.[name];
  if (current?.source === 'input') return current.value;
  const found = checked(area, name, spec, value, source);
  if (!found) return current?.value;
  context[name] = found.value;
  report.inputs = { ...(report.inputs ?? {}), [name]: found };
  return found.value;
}

/** Where a command may say it read a context value from. */
export type SuppliedSource = Extract<ContextSource, 'file'>;
