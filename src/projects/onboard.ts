import { z } from 'zod';
import type { AnyArea } from '../core/area.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import { connectionsOf, defaultConnectionName, type ResolvedConfig } from '../core/config.js';
import type { CommandContext, ConfigAccess } from '../core/context.js';
import { hostMatches, type ToilProject, type ToilProjectCatalog, type Section } from '../core/toil-project.js';
import { ToilError, toToilError, withArticle } from '../core/errors.js';
import { forwardSlashes } from '../core/files.js';
import { addConnection, reloadConfig, testConnection } from '../connections/commands.js';
import { refuseWritesBindings } from './build.js';
import { checkToilProject, chosen } from './commands.js';

/**
 * `toil projects onboard [<toil-project>]`: setting up a repository someone else
 * wrote a toil project for. For each area the toil project covers it finds the reader's
 * connection (by the section's `host`, its `connection` name, or the area's
 * default), offers to add one through `toil connections add` when there is
 * none, asks which to pin in the reader's own copy when several match, and
 * then runs `toil projects check` and one test read per connection.
 *
 * It asks for tokens, so it is a person's command: the CLI on a terminal, or
 * the API for a host that passes a `person`; never MCP. With no one to ask
 * (a pipe, CI, or `--plan`) it adds nothing and reports what each area
 * needs, with the command that would set it up. Onboarding used to be a
 * fortnight of tickets; it is now one command with the same number of forms.
 */

type Status = 'matched' | 'default' | 'created' | 'pinned' | 'missing' | 'ambiguous';

interface Target {
  area: AnyArea;
  env: string | undefined;
  /** The section's key path: `github`, or `environments.prod.openshift`. */
  path: string;
  section: Section;
}

interface Outcome {
  area: string;
  env: string | null;
  path: string;
  selects: { host: string } | { connection: string } | { default: true };
  status: Status;
  connection: string | null;
  candidates?: string[];
  problem?: { code: string; message: string; fix?: string };
  /** For a missing connection: the name and base URL `connections add` would be offered. */
  suggest?: { name: string; baseUrl?: string };
}

export function toilProjectOnboardCommands(areas: readonly AnyArea[]): AnyCommand[] {
  const onboard = defineConfigCommand({
    path: ['projects', 'onboard'],
    description: "Set up this repo: match each area of its toil project to your connections, add the ones you lack, then check it and test each",
    input: z.object({
      toilProject: z.string().min(1).optional().describe('A toil project name, or the path to a toil project file. Defaults to the toil project that applies to the folder.'),
      cwd: z.string().min(1).optional().describe('The folder to look from; its repository decides which checked-in toil projects apply. Defaults to the workspace.'),
      plan: z.boolean().optional().describe('Ask nothing and add no connection: report what each area needs, then check and test what is there. A pin still applies.'),
      pin: z.array(z.string().min(1)).optional().describe("Where several of your connections match, the one your own copy of the toil project uses: area=connection for every section of the area, or a section's key path (environments.prod.github=connection) for that one"),
    }),
    writes: false,
    // Adding a connection or pinning one writes config or your own toil project; a plan with no pin writes nothing.
    writesLocal: false,
    writesLocalWhen: (input) => !input.plan || (input.pin?.length ?? 0) > 0,
    // It asks for tokens: a person on a terminal, or a host's person through the API, never MCP.
    kind: 'cli-only',
    args: [{ name: 'toil-project', field: 'toilProject', description: 'A toil project name or file (default: the one the folder matches)', required: false }],
    options: [
      { flags: '--cwd <dir>', field: 'cwd', description: 'The folder to look from (default: the working directory)' },
      { flags: '--plan', field: 'plan', description: 'Ask nothing and add no connection; report what each area needs' },
      { flags: '--pin <area=connection>', field: 'pin', description: 'The connection your own copy uses where several match (an area, or a section such as environments.prod.github); repeatable' },
    ],
    examples: [{}, { toilProject: 'payments', cwd: '.', plan: true }, { toilProject: 'payments', pin: ['github=github-work'] }],
    run: async (input, ctx) => {
      const manage = ctx.manage!;
      const catalog = manage.toilProjects;
      if (!catalog) throw new ToilError('NOT_CONFIGURED', 'Toil projects are not available here.', { fix: 'Run toil projects onboard from the CLI.' });
      const applied = chosen(catalog, input, ctx);
      const toilProject = applied.file.toilProject;
      const ask = input.plan ? undefined : manage.prompt;
      if (!input.plan && !manage.prompt) {
        ctx.warn({ code: 'ONBOARD_NO_TERMINAL', message: 'There is no terminal to ask on, so no connection was added: each area says what it needs. Run toil projects onboard in a terminal to add the missing ones.' });
      }
      const pins = pinsFrom(input.pin ?? [], areas, toilProject, manage.config);
      let config = manage.config;
      const reload = () => (config = reloadConfig(manage, areas));

      const outcomes: Outcome[] = [];
      const toPin: Array<{ target: Target; connection: string }> = [];
      for (const target of targetsOf(toilProject, areas)) {
        const outcome = match(config, target);
        if (outcome.status === 'missing' && ask) {
          const created = await offerConnection(ctx, ask, areas, config, toilProject, target);
          if (created) {
            reload();
            Object.assign(outcome, { status: 'created', connection: created });
            delete outcome.problem;
          } else if (created === null) {
            outcome.problem = { code: 'CANCELLED', message: `No ${target.area.name} connection was added.`, fix: fixFor(toilProject, target, config) };
          }
        }
        if (outcome.status === 'ambiguous') {
          const pick = pins.get(target.path) ?? pins.get(target.area.name) ?? (ask ? await askPin(ask, toilProject, target, outcome.candidates!) : undefined);
          if (pick !== undefined) {
            toPin.push({ target, connection: pick });
            Object.assign(outcome, { status: 'pinned', connection: pick });
            delete outcome.problem;
          }
        }
        if (outcome.status === 'missing') {
          if (outcome.problem && !outcome.problem.fix) outcome.problem.fix = fixFor(toilProject, target, config);
          outcome.suggest = suggestionFor(target, config);
        }
        if (outcome.status === 'ambiguous' && outcome.problem) outcome.problem.fix = `Run it in a terminal to choose, or pass --pin ${target.path}=<one of ${outcome.candidates!.join(', ')}>.`;
        outcomes.push(outcome);
      }
      for (const [key] of pins) {
        if (!toPin.some((p) => p.target.path === key || p.target.area.name === key)) ctx.warn({ code: 'ONBOARD_PIN_UNUSED', message: `--pin ${key}=... wasn't needed: only one of your connections fits it, or none does.` });
      }
      const file = toPin.length ? pinInOwnCopy(ctx, catalog, manage, areas, applied.file, toPin) : applied.file;

      // toil projects check, against the config as it is now, then one test read per connection.
      const check = checkToilProject(catalog, config, areas, file, input.cwd);
      const tested = new Map<string, { ok: boolean; request?: string | null; live?: boolean; error?: { code: string; message: string; fix?: string } }>();
      for (const name of [...new Set(outcomes.map((o) => o.connection).filter((n): n is string => n !== null))]) {
        try {
          const result = await testConnection(ctx, areas, config, name);
          tested.set(name, { ok: true, request: result.request, live: result.live });
        } catch (err) {
          const e = toToilError(err);
          tested.set(name, { ok: false, error: { code: e.code, message: e.message, ...(e.fix ? { fix: e.fix } : {}) } });
        }
      }
      const areasOut = outcomes.map((o) => ({ ...o, test: o.connection === null ? null : tested.get(o.connection)! }));
      const ok = check.ok && areasOut.every((a) => a.connection !== null && a.test?.ok === true);
      if (!ok) ctx.setExitCode(1);
      return {
        toilProject: { name: toilProject.name, source: applied.file.source, file: forwardSlashes(applied.file.file) },
        ownCopy: file === applied.file ? null : forwardSlashes(file.file),
        plan: ask === undefined,
        ok,
        areas: areasOut,
        check,
      };
    },
  });
  return [onboard];
}

/** Every section that picks a connection for an area toil has: the area's own, then each environment's. */
function targetsOf(toilProject: ToilProject, areas: readonly AnyArea[]): Target[] {
  const byName = new Map(areas.map((a) => [a.name, a]));
  const out: Target[] = [];
  for (const [name, section] of Object.entries(toilProject.sections)) {
    const area = byName.get(name);
    if (area) out.push({ area, env: undefined, path: name, section });
  }
  for (const [env, byArea] of Object.entries(toilProject.environments)) {
    for (const [name, section] of Object.entries(byArea)) {
      const area = byName.get(name);
      if (area) out.push({ area, env, path: `environments.${env}.${name}`, section });
    }
  }
  return out;
}

/** What a call would find for one section, as core's resolver chooses: the named connection, the one on the host, or the area's default. */
function match(config: ResolvedConfig, t: Target): Outcome {
  const base = { area: t.area.name, env: t.env ?? null, path: t.path };
  const named = typeof t.section.connection === 'string' ? t.section.connection : undefined;
  const host = typeof t.section.host === 'string' ? t.section.host : undefined;
  if (named !== undefined) {
    const found = config.connections[named]?.area === t.area.name;
    return {
      ...base,
      selects: { connection: named },
      status: found ? 'matched' : 'missing',
      connection: found ? named : null,
      ...(found ? {} : { problem: { code: 'NOT_CONFIGURED', message: `You have no ${t.area.name} connection named ${named}.` } }),
    };
  }
  if (host !== undefined) {
    const matches = connectionsOf(config, t.area.name).filter((n) => hostMatches(config.connections[n]!, host, t.area.siteApis));
    if (matches.length === 1) return { ...base, selects: { host }, status: 'matched', connection: matches[0]! };
    if (matches.length === 0) return { ...base, selects: { host }, status: 'missing', connection: null, problem: { code: 'NOT_CONFIGURED', message: `You have no ${t.area.name} connection on ${host}.` } };
    return { ...base, selects: { host }, status: 'ambiguous', connection: null, candidates: matches.sort(), problem: { code: 'INVALID_INPUT', message: `${matches.length} of your ${t.area.name} connections are on ${host}: ${matches.join(', ')}.` } };
  }
  const fallback = defaultConnectionName(config, t.area.name);
  if (fallback !== undefined) return { ...base, selects: { default: true }, status: 'default', connection: fallback };
  const all = connectionsOf(config, t.area.name).sort();
  if (all.length > 1) return { ...base, selects: { default: true }, status: 'ambiguous', connection: null, candidates: all, problem: { code: 'INVALID_INPUT', message: `You have ${all.length} ${t.area.name} connections and no default: ${all.join(', ')}.` } };
  return { ...base, selects: { default: true }, status: 'missing', connection: null, problem: { code: 'NOT_CONFIGURED', message: `You have no ${t.area.name} connection.` } };
}

/** The base URL to offer for a host: the API the area names for it (github.com's is api.github.com), else the host itself. */
export function suggestedBaseUrl(area: AnyArea, host: string): string {
  return Object.hasOwn(area.siteApis ?? {}, host) ? area.siteApis![host]! : `https://${host}`;
}

/**
 * What to offer for a host's connection: its base URL, and for an area with
 * deployments, `cloud` when the host is one the area names a hosted API for
 * (bitbucket.org), so a person onboarding it isn't left on the Data Center default.
 */
export function suggestedSettings(area: AnyArea, host: string): Record<string, string> {
  const hosted = area.variants?.by === 'deployment' && Object.hasOwn(area.siteApis ?? {}, host);
  return { baseUrl: suggestedBaseUrl(area, host), ...(hosted ? { deployment: 'cloud' } : {}) };
}

function freeName(config: ResolvedConfig, area: string): string {
  if (!config.connections[area]) return area;
  for (let i = 2; ; i++) if (!config.connections[`${area}-${i}`]) return `${area}-${i}`;
}

/** What `connections add` would be offered for a missing section: its name, and a base URL on its host. */
function suggestionFor(t: Target, config: ResolvedConfig): { name: string; baseUrl?: string } {
  const host = typeof t.section.host === 'string' ? t.section.host : undefined;
  return { name: typeof t.section.connection === 'string' ? t.section.connection : freeName(config, t.area.name), ...(host ? { baseUrl: suggestedBaseUrl(t.area, host) } : {}) };
}

/** The command that sets up what a missing section needs, for the report. */
function fixFor(toilProject: ToilProject, t: Target, config: ResolvedConfig): string {
  const named = typeof t.section.connection === 'string' ? t.section.connection : undefined;
  const host = typeof t.section.host === 'string' ? t.section.host : undefined;
  const name = named ?? freeName(config, t.area.name);
  return `Run toil projects onboard ${toilProject.name} in a terminal, or toil connections add ${name} --area ${t.area.name}${host ? ` with a base URL on ${host} (${suggestedBaseUrl(t.area, host)})` : ''}.`;
}

/**
 * Asks whether to add the missing connection, and adds it through `toil
 * connections add`'s own flow, its settings offered from the toil project's host.
 * The connection's name, or null when the person said no or it wasn't saved.
 */
async function offerConnection(ctx: CommandContext<unknown>, ask: NonNullable<ConfigAccess['prompt']>, areas: readonly AnyArea[], config: ResolvedConfig, toilProject: ToilProject, t: Target): Promise<string | null> {
  const named = typeof t.section.connection === 'string' ? t.section.connection : undefined;
  const host = typeof t.section.host === 'string' ? t.section.host : undefined;
  const where = host ? ` on ${host}` : named ? ` named ${named}` : '';
  const yes = await ask.ask(`Toil project ${toilProject.name}'s ${t.path} needs ${withArticle(t.area.name)} connection${where}, and you have none. Add one now? y/n`, 'y', `create:${t.path}`);
  if (!/^y(es)?$/i.test(yes)) return null;
  const name = named ?? (await ask.ask(`Name for the new ${t.area.name} connection`, freeName(config, t.area.name), `name:${t.path}`));
  try {
    await addConnection(ctx, areas, { name, area: t.area.name }, host ? { suggest: suggestedSettings(t.area, host), host } : {});
    return name;
  } catch (err) {
    const e = toToilError(err);
    ctx.warn({ code: 'ONBOARD_NOT_ADDED', message: `${t.path}: ${e.message}${e.fix ? ` ${e.fix}` : ''}` });
    return null;
  }
}

async function askPin(ask: NonNullable<ConfigAccess['prompt']>, toilProject: ToilProject, t: Target, candidates: string[]): Promise<string | undefined> {
  const answer = await ask.ask(`Several of your ${t.area.name} connections fit toil project ${toilProject.name}'s ${t.path}: ${candidates.join(', ')}. Which should your own copy of it use?`, candidates[0], `pin:${t.path}`);
  if (candidates.includes(answer)) return answer;
  throw new ToilError('INVALID_INPUT', `"${answer}" isn't one of ${candidates.join(', ')}. Nothing was pinned.`, { fix: `Run it again and give one of them, or pass --pin ${t.area.name}=<connection>.` });
}

/**
 * `--pin <key>=connection`: the key is an area, for every section of it, or one
 * section's key path (`environments.prod.github`), which wins over its area's,
 * so an environment's section can be pinned apart from the area's own.
 */
function pinsFrom(values: readonly string[], areas: readonly AnyArea[], toilProject: ToilProject, config: ResolvedConfig): Map<string, string> {
  const targets = targetsOf(toilProject, areas);
  const pins = new Map<string, string>();
  for (const value of values) {
    const at = value.indexOf('=');
    const key = value.slice(0, at);
    const name = value.slice(at + 1);
    if (at <= 0 || name === '') throw new ToilError('INVALID_INPUT', `--pin takes area=connection (or section=connection), and "${value}" isn't.`, { fix: 'For example --pin github=github-work, or --pin environments.prod.github=github-work.' });
    const target = targets.find((t) => t.path === key) ?? targets.find((t) => t.area.name === key);
    if (!target) throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name} has no ${key} section to pin.`, { fix: `Its sections: ${targets.map((t) => t.path).join(', ') || 'none'}.` });
    const area = target.area.name;
    if (config.connections[name]?.area !== area) throw new ToilError('INVALID_INPUT', `You have no ${area} connection named ${name}.`, { fix: `Run toil connections list --area ${area} to see yours.` });
    pins.set(key, name);
  }
  return pins;
}

/**
 * Writes the pinned connections into the reader's own copy of the toil project:
 * the toil project itself when it is already theirs, else their copy of the same
 * name, else a new copy in ~/.toil/projects. A copy there is adopted: it
 * applies wherever the shared one does, and writes may follow its bindings,
 * so outside the CLI one that selects a connection with writes on is refused,
 * as `toil projects import` refuses it.
 */
function pinInOwnCopy(ctx: CommandContext<unknown>, catalog: ToilProjectCatalog, manage: ConfigAccess, areas: readonly AnyArea[], from: { file: string; source: string; toilProject: ToilProject }, pins: Array<{ target: Target; connection: string }>) {
  const mine = from.source === 'user' ? from : catalog.scan().files.find((f) => f.source === 'user' && f.toilProject?.name === from.toilProject.name);
  const toilProject = structuredClone(mine?.toilProject ?? from.toilProject);
  for (const { target, connection } of pins) {
    const holder = target.env === undefined ? toilProject.sections : (toilProject.environments[target.env] ??= {});
    const section: Section = { ...(holder[target.area.name] ?? {}) };
    delete section.host;
    section.connection = connection;
    holder[target.area.name] = section;
  }
  if (manage.via !== 'cli') refuseWritesBindings(catalog, manage.config, areas, toilProject, 'import');
  const path = mine?.file ?? catalog.userFile(toilProject.name);
  const written = catalog.save(path, toilProject, mine ? 'edit' : 'create');
  if (!mine) {
    ctx.warn({ code: 'ONBOARD_OWN_COPY', message: `Your own copy of ${toilProject.name}, ${written}, now applies wherever the shared one does. It is yours, so writes may follow its bindings; toil projects remove ${toilProject.name} takes it away.` });
  }
  return catalog.find(written);
}
