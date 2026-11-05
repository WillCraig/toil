import { z } from 'zod';
import { assertNoCoreFields, type CommandDefinition, type CliOption, type ContextNeed } from './command.js';
import { OUTPUT_FORMAT_FIELD, SUMMARY_FILE_FIELD } from './output/fields.js';
import { SELECT_FIELD } from './query/select.js';
import { envName } from './config.js';
import { foldDeployments, type DeploymentOptions } from './deployments.js';
import type { GitRemote } from './call-context.js';
import type { CommandContext } from './context.js';
import type { RequestHook } from './api.js';
import type { QueryParam } from './rest.js';

/**
 * An area is one service (`jira`, `db`), whichever deployments it has: a connection
 * names its `deployment` where there is more than one. It declares the shape of a connection to it once, and
 * core does the rest: env-var mapping, CI fallbacks, provider defaults,
 * validation with a fix, and handing each command its own resolved connection.
 *
 * Commands never read config. They get `ctx.connection`, typed from this
 * schema: their own connection, plus any setting from a connection the user
 * paired it with (`shares`), resolved by core. No area can reach another
 * area's credentials on its own. Access is granted on a need-to-know basis,
 * and every area has been assessed as not needing to know.
 */
export interface AreaSpec<S extends z.ZodObject = z.ZodObject, K extends string = string> {
  name: string;
  /** One-line description for help, docs and the skill index. */
  description: string;
  /** What a connection to this area holds, besides `area` and `writes`. */
  connection: S;
  /**
   * Keys holding secrets: redacted in output, kept in the OS store, refused in
   * plain text in a file. A list means every one is a token; a map says which
   * are passwords (a database), which `toil connections` asks for as such.
   */
  secrets?: Array<SettingKey<S>> | Partial<Record<SettingKey<S>, SecretKind>>;
  /** Provider defaults, so a connection only states what differs (a port, a path). */
  defaults?: Partial<z.input<S>>;
  /**
   * Well-known CI variables for a key, only where the service's own tooling
   * treats them as canonical (`GITHUB_TOKEN`). They apply to the area's default
   * connection, below TOIL_* variables and above the config file.
   */
  fallbacks?: Partial<Record<SettingKey<S>, string[]>>;
  /**
   * Whether the CI `fallbacks` apply at all, asked of the default
   * connection's effective settings: its own keys over `defaults.<area>`, over
   * the area's TOIL_<AREA>_* variables and the connection's TOIL_CONN_ ones.
   * Bitbucket Pipelines' variables are canonical only for Cloud, so Bitbucket
   * says `(s) => s.deployment === 'cloud'`; a Data Center default then keeps
   * what its file says. Left out, the fallbacks always apply.
   */
  fallbackWhen?: (effective: Record<string, unknown>) => boolean;
  /**
   * An example value for a key, which the fix names when the key is missing
   * (`baseUrl: 'https://api.figma.com'` gives "Set TOIL_FIGMA_BASE_URL (e.g.
   * https://api.figma.com)"). Only text for a person to read: it's never a
   * default, and toil never connects to it.
   */
  examples?: Partial<Record<SettingKey<S>, string>>;
  /**
   * Hosts people know the service by whose API is on another host, each with
   * that API's base URL: `{ 'github.com': 'https://api.github.com' }`. A
   * toil project's `host: github.com` then selects a connection whose baseUrl is
   * on api.github.com, sharing a toil project records `github.com` for one, and
   * `toil projects onboard` offers the base URL when it sets one up. Only a
   * selector and a suggestion: toil never connects to it on its own.
   */
  siteApis?: Record<string, string>;
  /**
   * Paths in this area that run a core command for this area alone, the core
   * command fixing its `area` input: `{ 'instance list': 'connections list' }`
   * makes `toil <area> instance list` list only this area's connections. The
   * area's own code never sees the config; core answers. CLI only, like every
   * alias; MCP has the core tool, with its `area` field.
   */
  coreAliases?: Record<string, string>;
  /**
   * The error when no connection to this area is set up at all, in the
   * area's own words, where the contract specifies them ("OSS Index needs an
   * account token…"). `fix` defaults to core's, which names the variables
   * to set. Without it, core says "No <area> connection is set up."
   */
  notConfigured?: { message: string; fix?: string };
  /**
   * Keys the area doesn't accept, each with what to say about it
   * (e.g. "Client credentials aren't supported; set apiKey."). A connection that still sets one gets that message as a
   * `CONFIG_REMOVED_KEY` warning instead of core's unknown-key one, and the
   * value is dropped, never sent. A removed key can't be a connection key.
   */
  removed?: Record<string, string>;
  /** Keys that were renamed: old name to new. The old name still works, with a warning. */
  renamed?: Record<string, SettingKey<S>>;
  /**
   * Connection shapes keyed on one field, as database connections are on
   * `engine`: each value names the keys a connection of that variant must
   * set. Checked wherever the connection schema is, with the usual fix.
   */
  variants?: { by: SettingKey<S>; of: Record<string, { label?: string; requires?: Array<SettingKey<S>>; uses?: Array<SettingKey<S>> }> };
  /**
   * Inputs that say *where* in the service a command acts (`--project`,
   * `--repo`, `--instance`), resolved by core in one order for every area:
   * the call's own value, then the toil project, then the git remote, then the
   * connection's setting or the area's default. See {@link ContextInput}.
   */
  context?: Record<K, ContextInput>;
  /**
   * Settings a connection of this area may take from a connection of another
   * area, as Kibana takes Elasticsearch's API key. Declaring it pairs nothing:
   * core adds a `<key>From` setting, and only a connection whose user set it
   * (`"apiKeyFrom": "es-prod"`) borrows, from that connection. The one
   * exception keeps the env chain the contract specifies: the area's default connection takes
   * the other area's `TOIL_<AREA>_<KEY>` env value when it has no env value
   * of its own.
   */
  shares?: SharedSettings;
  /**
   * For an HTTP area: the base URL and auth headers for a resolved connection,
   * exchanging a long-lived credential for a token where the service needs
   * one. Commands send through `apiRequest` (`src/core/api.ts`), which builds
   * every request from this, so no command assembles its own credentials.
   */
  // Method syntax, so a hook typed for one area's connection still fits AreaSpec's defaults.
  request?(...args: Parameters<RequestHook<z.output<S>>>): ReturnType<RequestHook<z.output<S>>>;
  /**
   * The one cheap, authenticated GET that `toil connections test` sends to
   * check a connection, relative to the request hook's base URL. Return
   * undefined when this connection can't be checked that way (a Dynatrace
   * connection with only a platform URL). An area without one, or without a
   * request hook, is checked as far as its settings and secret go, and the
   * result says nothing was sent.
   */
  probe?(connection: Connection<z.output<S>>): Probe | undefined;
}

/**
 * See {@link AreaSpec.probe}. Pick a read the service refuses without a valid
 * credential (the current user, as a rule), so a revoked token fails the
 * test. A ping that answers anyone proves only that the host is up.
 */
export interface Probe {
  path: string;
  query?: Record<string, QueryParam>;
  /**
   * For a service that answers an anonymous caller with a 200 rather than a
   * 401 (Confluence's current user, SonarQube's validate): whether the JSON
   * answer shows the credential was accepted. False fails the test as AUTH.
   */
  accepts?(body: unknown): boolean;
  /**
   * `text` only where the API really answers this read in plain text. The
   * default reads JSON through core, so a sign-in or proxy page served with a
   * 200 fails the test as it would fail a real command.
   */
  as?: 'json' | 'text';
  /**
   * False when the service has no cheap read that needs the credential, so a
   * success proves only that the host answers. The test then says
   * `authenticated: false`. Defaults to true.
   */
  authenticated?: boolean;
}

/** See {@link AreaSpec.shares}. */
export interface SharedSettings {
  // A type-only reference back to Area, which is defined below.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  area: Area<any, string>;
  /** Keys with the same name on both areas' connection schemas, secret in both or in neither. */
  keys: string[];
  /**
   * Whether the other area's default connection may lend its env value to
   * this area's default connection, judged from both connections' settings as
   * they resolve (`other`, then `own`). For a pair that shares one credential
   * only between like deployments: Confluence takes Jira's token only from a
   * Jira of the same deployment, never a Data Center token sent off to the
   * Atlassian cloud, nor the reverse.
   * An explicit `<key>From` pairing is the user's call and isn't asked.
   */
  fallbackWhen?: (other: Record<string, unknown>, own: Record<string, unknown>) => boolean;
}

/** The setting that pairs `key` with another area's connection: `apiKey` -> `apiKeyFrom`. */
export const pairingKey = (key: string): string => `${key}From`;

export type SecretKind = 'token' | 'password';

type SettingKey<S extends z.ZodObject> = keyof z.input<S> & string;

/** One context input an area declares. */
export interface ContextInput {
  description: string;
  /** CLI spelling; defaults to `--<kebab-name> <value>`. */
  flags?: string;
  /**
   * `group` (the default): an input of every command in the area, a flag on
   * the group (`toil github --owner o pr get 7`) and a field on every MCP tool.
   * `command`: only on commands that list it in their `context`, as a leaf flag.
   */
  scope?: 'group' | 'command';
  /** Validates a value from any source. Defaults to a non-empty string. */
  schema?: z.ZodType<string>;
  /** The connection setting that supplies the value last (it already includes `defaults.<area>`). */
  setting?: string;
  /** The area's own default, after the connection. */
  default?: string;
  /**
   * Reads the value from one of the working folder's git remotes; the reader
   * is core's, the parsing is the area's. Core offers `origin` first, then the
   * other remotes, and takes the first value returned. It gets the call's resolved
   * connection too, so it can trust only a remote on the connection's own host
   * (`baseUrl`). An input that `selectsConnection` is read before there is a
   * connection, so it gets `undefined`.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  git?: (remote: GitRemote, connection: Connection<any> | undefined) => string | undefined;
  /**
   * The value picks the connection, as `--instance prod` or `--env staging`
   * do: a connection of this area with that name, or else the one whose
   * `setting` (default: the input's own name) equals it. An explicit
   * `--connection` naming a different one is refused, never silently preferred.
   */
  selectsConnection?: boolean;
  /**
   * The error when a command that requires this input finds it nowhere, so an
   * integration keeps the wording its contract specifies ("No project specified…"). `fix`
   * defaults to core's, which names the flag, the setting and its env var.
   * A function words it for the connection that was resolved, where the
   * deployments name the missing input differently.
   */
  missing?: MissingContext | ((connection: Connection<any>) => MissingContext); // eslint-disable-line @typescript-eslint/no-explicit-any
  /**
   * For an area with `variants` keyed on `deployment`: the deployments whose
   * connections take this input (`--project` is Data Center's, `--ws` is
   * Cloud's). Left out, every deployment takes it. On a connection of any
   * other deployment the input is refused as `UNSUPPORTED` and never
   * resolved, unless that deployment's command lists the input in its own
   * `context` (`repo create --project` on Cloud); it applies to commands folded by `byDeployment()` only.
   */
  deployments?: string[];
}

/** See {@link ContextInput.missing}. */
export interface MissingContext {
  message: string;
  fix?: string;
}

/** A connection as a command receives it: validated, defaults applied. */
export type Connection<T = Record<string, unknown>> = T & {
  /** The connection's name, e.g. `corp-jira`, or the area's name for a version 1 config. */
  name: string;
  area: string;
  writes: boolean;
};

export interface Area<S extends z.ZodObject = z.ZodObject, K extends string = string> extends Omit<AreaSpec<S, K>, 'secrets' | 'context'> {
  /** Every secret key, whatever its kind. */
  secrets: Array<SettingKey<S>>;
  secretKinds: Partial<Record<SettingKey<S>, SecretKind>>;
  context: Partial<Record<K, ContextInput>>;
  /**
   * The env var that sets `key` on this area's default connection, for fix
   * text (`jira.envName('apiToken')` is `TOIL_JIRA_API_TOKEN`), so no area
   * spells out the mapping by hand.
   */
  envName(key: SettingKey<S>): string;
  /**
   * Defines a command in this area. Core adds the `connection` input
   * (`--connection <name>` on the CLI) and the area's context inputs, so every
   * command in every area selects a connection and its context the same way,
   * and `run` gets `ctx.connection` typed from the area's schema.
   */
  command<I extends z.ZodObject>(def: AreaCommand<I, z.output<S>, K>): CommandDefinition<I>;
  /**
   * Folds each deployment's own commands (defined with `command`, never
   * registered themselves) into one command per path: the union of their
   * inputs, run by the implementation for the resolved connection's
   * deployment, refused before any request where that deployment has none.
   * Needs `variants` keyed on the connection's `deployment` (src/core/deployments.ts).
   */
  byDeployment(impls: Record<string, readonly CommandDefinition[]>, options?: DeploymentOptions): CommandDefinition[];
}

/** What an area command declares; `path[0]` must be the area's name. */
export type AreaCommand<I extends z.ZodObject, C, K extends string = string> = Omit<CommandDefinition<I>, 'run' | 'kind' | 'area' | 'context' | 'examples'> & {
  /** Real inputs, which may set the context inputs core adds, even on a command with no inputs of its own. */
  examples: Array<OwnFields<z.input<I>> & Partial<Record<K, string>>>;
  /** `area-local` for a command that needs no connection (`jira issue schema`). Defaults to `area`. */
  kind?: 'area' | 'area-local';
  /** Command-level context inputs it takes, and any input (group-level too) it can't do without. */
  context?: Partial<Record<K, ContextNeed>>;
  /** An `area-local` command's `ctx.connection` is undefined at run time, whatever this type says; it has no connection to read. */
  run(input: z.output<I>, ctx: CommandContext<Connection<C>, Partial<Record<K, string>>>): Promise<unknown>;
};

/**
 * A schema's input without an index signature. `z.object({})` reads as
 * `Record<string, never>`, which no example with a context input could
 * satisfy (`{ env: 'prod' }` on `openshift cluster list`); keeping only the
 * named fields lets the context inputs in.
 */
type OwnFields<T> = { [P in keyof T as string extends P ? never : P]: T[P] };

// Areas of many connection shapes share one registry.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyArea = Area<any, string>;

export const CONNECTION_FIELD = 'connection';
/** The inputs core adds to every area command for toil projects (docs/projects.md): which toil project, and which folder. */
export const TOIL_PROJECT_FIELD = 'toilProject';
export const CWD_FIELD = 'cwd';
/** Fields core adds to every area command and resolves itself; no command or context input may use these names. */
export const CORE_FIELDS: readonly string[] = [CONNECTION_FIELD, TOIL_PROJECT_FIELD, CWD_FIELD];
const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
/** Field names a context input can't take: core's own fields and the global flags. */
// `host` and `fields` are a toil project section's own keys (src/core/toil-project.ts), so no context input can be called either.
const RESERVED_INPUTS = new Set([...CORE_FIELDS, SELECT_FIELD, OUTPUT_FORMAT_FIELD, SUMMARY_FILE_FIELD, 'allowWrite', 'pretty', 'verbose', 'debug', 'config', 'outputFile', 'version', 'help', 'host', 'fields']);

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export function defineArea<S extends z.ZodObject, K extends string = never>(spec: AreaSpec<S, K>): Area<S, K> {
  if (!NAME.test(spec.name)) throw new Error(`Area name "${spec.name}" must be lowercase letters, digits and single hyphens.`);
  for (const reserved of ['area', 'writes', CONNECTION_FIELD]) {
    if (reserved in spec.connection.shape) throw new Error(`Area ${spec.name}: "${reserved}" is set by core and can't be a connection key.`);
  }
  for (const key of Object.keys(spec.connection.shape)) {
    // TOIL_CONN_<NAME>_AREA creates a connection, so a key ending in "Area"
    // would make its variable mean two things. One field, one meaning: the
    // minimum standard for a form, and the one most often waived.
    if (/Area$/.test(key)) throw new Error(`Area ${spec.name}: connection key "${key}" can't end in "Area".`);
  }
  const secretKinds = (Array.isArray(spec.secrets) ? Object.fromEntries(spec.secrets.map((key) => [key, 'token'])) : { ...(spec.secrets ?? {}) }) as Partial<
    Record<SettingKey<S>, SecretKind>
  >;
  const secrets = Object.keys(secretKinds) as Array<SettingKey<S>>;
  for (const key of secrets) {
    if (!(key in spec.connection.shape)) throw new Error(`Area ${spec.name}: secret "${key}" isn't a connection key.`);
  }
  for (const key of Object.keys(spec.examples ?? {})) {
    if (!(key in spec.connection.shape)) throw new Error(`Area ${spec.name}: example "${key}" isn't a connection key.`);
  }
  for (const [host, url] of Object.entries(spec.siteApis ?? {})) {
    let ok: boolean;
    try {
      ok = host === host.toLowerCase() && !host.includes(':') && new URL(url).protocol === 'https:';
    } catch {
      ok = false;
    }
    if (!ok) throw new Error(`Area ${spec.name}: siteApis maps a lowercase host with no port to an https base URL; "${host}" to "${url}" isn't that.`);
  }
  for (const key of Object.keys(spec.removed ?? {})) {
    if (key in spec.connection.shape || key in (spec.renamed ?? {})) throw new Error(`Area ${spec.name}: removed key "${key}" is still a connection key or a renamed one.`);
  }
  const context = { ...(spec.context ?? {}) } as Record<string, ContextInput>;
  for (const [name, input] of Object.entries(context)) {
    if (RESERVED_INPUTS.has(name)) throw new Error(`Area ${spec.name}: "${name}" can't be a context input; core or a global flag already uses it.`);
    if (input.setting !== undefined && !(input.setting in spec.connection.shape)) {
      throw new Error(`Area ${spec.name}: context input "${name}" reads setting "${input.setting}", which isn't a connection key.`);
    }
    for (const deployment of input.deployments ?? []) {
      if (!spec.variants || !(deployment in spec.variants.of)) throw new Error(`Area ${spec.name}: context input "${name}" is for deployment "${deployment}", which the area's variants don't have.`);
    }
    if (input.selectsConnection && !((input.setting ?? name) in spec.connection.shape)) {
      throw new Error(`Area ${spec.name}: context input "${name}" selects a connection by "${input.setting ?? name}", which must be a connection key.`);
    }
  }

  const connection = spec.shares ? withPairing(spec, secretKinds as Record<string, SecretKind>) : spec.connection;
  const area: Area<S, K> = {
    ...spec,
    connection: withVariants({ ...spec, connection }) as S,
    secrets,
    secretKinds,
    context: context as Partial<Record<K, ContextInput>>,
    envName: (key) => envName(spec.name, key),
    byDeployment: (impls, options) => foldDeployments(area as unknown as AnyArea, impls, options),
    command(def) {
      const name = def.path.join(' ');
      if (def.path[0] !== spec.name) throw new Error(`Command ${name} is defined in area ${spec.name}; its path must start with "${spec.name}".`);
      for (const field of CORE_FIELDS) if (field in def.input.shape) throw new Error(`Command ${name}: "${field}" is added by core.`);
      assertNoCoreFields(def);
      for (const banned of ['managesConfig', 'cliOnly', 'standalone']) {
        if (banned in def) throw new Error(`Command ${name}: "${banned}" is gone; an area command's kind is area or area-local.`);
      }
      const kind = def.kind ?? 'area';
      if (kind !== 'area' && kind !== 'area-local') throw new Error(`Command ${name}: an area command's kind is area or area-local, not ${String(kind)}.`);
      // execute()'s default limit (DEFAULT_TIMEOUT_MS in run.ts). A declared one only ever raises it.
      if (def.timeLimitMs !== undefined && !(Number.isInteger(def.timeLimitMs) && def.timeLimitMs > 120_000)) {
        throw new Error(`Command ${name}: timeLimitMs is for a limit above the 120 s default, in whole milliseconds; ${def.timeLimitMs} isn't.`);
      }
      if (def.mcp !== undefined && def.mcp !== false) throw new Error(`Command ${name}: "mcp" is false, to keep it off MCP, or left out.`);
      if (def.writesWhen && (def.writes || !('allowWrite' in def.input.shape))) throw new Error(`Command ${name}: writesWhen is for a command with writes: false whose input spreads allowWriteField.`);
      if (def.offMcpWhen && def.mcp === false) throw new Error(`Command ${name}: offMcpWhen is for a command MCP serves; this one is off MCP already.`);
      if (def.connectionOptional !== undefined) {
        if (def.connectionOptional !== true || kind !== 'area') throw new Error(`Command ${name}: "connectionOptional" is true, on an area command that has a connection, or left out.`);
        if (def.writes || def.writesWhen) throw new Error(`Command ${name}: a write always needs its connection, so it can't be connectionOptional.`);
        if (Object.values(def.context ?? {}).includes('required')) throw new Error(`Command ${name}: a connectionOptional command can run with no context inputs, so none can be required.`);
      }
      if (def.connectionlessWhen && def.connectionOptional !== true) throw new Error(`Command ${name}: connectionlessWhen is for a connectionOptional command.`);
      if (kind === 'area-local') {
        if (def.context) throw new Error(`Command ${name}: an area-local command has no connection, so no context inputs.`);
        return { ...def, kind, area, run: def.run as CommandDefinition['run'] } as CommandDefinition<typeof def.input>;
      }
      const needs = contextFor(spec.name, name, context, (def.context ?? {}) as Record<string, ContextNeed>);
      const fields: Record<string, z.ZodType> = {};
      const options: CliOption[] = [];
      for (const input of Object.keys(needs)) {
        const declared = context[input]!;
        if (input in def.input.shape) throw new Error(`Command ${name}: "${input}" is a context input of ${spec.name}; core adds it.`);
        const description = describeInput(input, declared);
        fields[input] = (declared.schema ?? z.string().min(1)).optional().describe(description);
        const flags = declared.flags ?? `--${kebab(input)} <value>`;
        options.push({ flags, field: input, description, ...((declared.scope ?? 'group') === 'group' ? { group: true } : {}) });
      }
      return {
        ...def,
        kind,
        area,
        ...(Object.keys(needs).length > 0 ? { context: needs } : {}),
        ...(def.context ? { contextListed: Object.keys(def.context) } : {}),
        input: def.input.extend({
          ...fields,
          [CONNECTION_FIELD]: z
            .string()
            .optional()
            .describe(`Which ${spec.name} connection to use. Defaults to your toil project's, then the area's default connection.`),
          [TOIL_PROJECT_FIELD]: z
            .string()
            .min(1)
            .optional()
            .describe("The toil project that supplies this call's context: a toil project name, or the path to a toil project file. Defaults to TOIL_PROJECT, then the toil project that matches the folder."),
          [CWD_FIELD]: z
            .string()
            .min(1)
            .optional()
            .describe("The folder whose repository chooses the toil project and the git context. Defaults to the workspace. It doesn't change which files a command may read or write."),
        }) as unknown as typeof def.input,
        options: [
          ...(def.options ?? []),
          ...options,
          { flags: '--connection <name>', field: CONNECTION_FIELD, description: `Use this ${spec.name} connection instead of the default` },
          { flags: '--toil-project <name|file>', field: TOIL_PROJECT_FIELD, description: 'Use this toil project (a name or a file) instead of the one the folder matches' },
          { flags: '--cwd <dir>', field: CWD_FIELD, description: 'Choose the toil project and git context from this folder instead of the working directory' },
        ],
        run: def.run as CommandDefinition['run'],
      } as CommandDefinition<typeof def.input>;
    },
  };
  return area;
}

/** Every group-level input, plus the command-level ones the command lists, with whether each is required. */
function contextFor(area: string, command: string, declared: Record<string, ContextInput>, listed: Record<string, ContextNeed>): Record<string, ContextNeed> {
  const needs: Record<string, ContextNeed> = {};
  for (const [input, spec] of Object.entries(declared)) if ((spec.scope ?? 'group') === 'group') needs[input] = 'optional';
  for (const [input, need] of Object.entries(listed)) {
    if (!(input in declared)) throw new Error(`Command ${command}: "${input}" isn't a context input of ${area}.`);
    needs[input] = need;
  }
  return needs;
}

/**
 * What `--help` and the MCP field say about an input: its own description,
 * then where a value comes from when the call leaves it out, in the order
 * core looks. "Where did that come from?" should be answerable before asking.
 */
function describeInput(name: string, spec: ContextInput): string {
  const fallbacks = [`your toil project's ${name}`, ...(spec.git ? ['the git remote'] : []), ...(spec.setting ? [`the connection's ${spec.setting}`] : []), ...(spec.default !== undefined ? [`"${spec.default}"`] : [])];
  const selects = spec.selectsConnection ? ' It also picks the connection.' : '';
  return `${spec.description}; defaults to ${fallbacks.join(', then ')}.${selects}`;
}

/** The connection schema with a `<key>From` pairing setting for each shared key, after checking the keys fit both areas. */
function withPairing(spec: AreaSpec<z.ZodObject, string>, secretKinds: Record<string, SecretKind>): z.ZodObject {
  const shares = spec.shares!;
  if (shares.area.name === spec.name) throw new Error(`Area ${spec.name}: an area can't share settings with itself.`);
  const pairing: Record<string, z.ZodType> = {};
  for (const key of shares.keys) {
    if (!(key in spec.connection.shape) || !(key in shares.area.connection.shape)) {
      throw new Error(`Area ${spec.name}: shared setting "${key}" must be a connection key of both ${spec.name} and ${shares.area.name}.`);
    }
    // A reference resolves only where the key is a secret; one side treating
    // it as plain text would send `keychain:...` itself.
    if ((key in secretKinds) !== shares.area.secrets.includes(key)) {
      throw new Error(`Area ${spec.name}: shared setting "${key}" must be a secret in both ${spec.name} and ${shares.area.name}, or in neither.`);
    }
    if (pairingKey(key) in spec.connection.shape) throw new Error(`Area ${spec.name}: "${pairingKey(key)}" is added by core for the shared setting "${key}".`);
    pairing[pairingKey(key)] = z
      .string()
      .min(1)
      .optional()
      .describe(`The ${shares.area.name} connection to take ${key} from when this connection has none`);
  }
  return spec.connection.extend(pairing);
}

/**
 * The connection schema with the area's variant rule attached, so every
 * place that validates a connection (resolving one, `connections add`) checks
 * it the same way. A form with a section that only applies to some applicants
 * still has to say which section.
 */
function withVariants(spec: AreaSpec<z.ZodObject, string>): z.ZodObject {
  const variants = spec.variants;
  if (!variants) return spec.connection;
  if (!(variants.by in spec.connection.shape)) throw new Error(`Area ${spec.name}: variants are keyed on "${variants.by}", which isn't a connection key.`);
  return spec.connection.superRefine((conn: Record<string, unknown>, check) => {
    const value = conn[variants.by];
    const variant = typeof value === 'string' ? variants.of[value] : undefined;
    for (const key of variant?.requires ?? []) {
      if (conn[key] === undefined) check.addIssue({ code: 'custom', path: [key], message: `${variant!.label ?? String(value)} connections need ${key}.` });
    }
  });
}
