import { existsSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import type { AnyArea, ContextInput } from '../core/area.js';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import { toilProjectConnection } from '../core/call-context.js';
import { CONNECTION_NAME, connectionWrites, defaultConnectionName, type ResolvedConfig } from '../core/config.js';
import type { CommandContext, ConfigAccess } from '../core/context.js';
import {
  toilProjectContent, EMAIL, hasSecretUserinfo, identityKey, identityProblem, normalizeRemote, PERSON_KINDS, samePath, selectorHost, stripUserinfo,
  type ToilProject, type ToilProjectCatalog, type ToilProjectFile, type ToilProjectPerson, type Section,
} from '../core/toil-project.js';
import { isLensId, LENSES, type LensId } from '../core/brief/brief.js';
import { ToilError, toToilError } from '../core/errors.js';
import { forwardSlashes } from '../core/files.js';
import { refuseRenamedArea } from '../core/renamed-areas.js';

/**
 * `toil projects init | add-repo | link | env | field | person | wip-limit |
 * describe | export | import | unlink | remove`: building a toil project, and sharing one
 * through a repository.
 *
 * Writing a toil project is a local write, so none of these needs --allow-write,
 * which governs changes to remote systems; an agent may build one over MCP.
 * What an agent may not do is make a toil project point a write somewhere new:
 * over MCP, any change that would make a section select a connection with
 * writes on, when it didn't before, is refused, and so is importing or
 * exporting a toil project with such a binding (docs/projects.md, Agents and the
 * write gate). A person does that on the CLI.
 *
 * Every edit refuses to add what's already there, naming the entry, unless
 * --replace says to change it: a toil project is never quietly given a second
 * copy of anything. The file is checked with the reader that will load it
 * before it's written, so toil never writes a toil project it would refuse. Each
 * amendment is countersigned by the same clerk who will later read it.
 */
export function toilProjectBuildCommands(areas: readonly AnyArea[]): AnyCommand[] {
  const areaNamed = (name: string): AnyArea => {
    refuseRenamedArea(name);
    const area = areas.find((a) => a.name === name);
    if (area) return area;
    throw new ToilError('INVALID_INPUT', `toil has no area named "${name}".`, { fix: `Use one of: ${areas.map((a) => a.name).join(', ')}.` });
  };
  const toilProjectArg = { name: 'toil-project', field: 'toilProject', description: 'The toil project: a name, or the path to a toil project file' };
  const toilProjectField = z.string().min(1).describe('The toil project to change: a name, or the path to a toil project file');
  const replaceOption = { flags: '--replace', field: 'replace', description: 'Change a value that is already set, rather than refuse' };
  const replaceField = z.boolean().optional().describe('Change a value that is already set. Without it, a value already there is refused, naming it.');

  const init = defineConfigCommand({
    path: ['projects', 'init'],
    description: 'Create a toil project in your own folder (~/.toil/projects), or with --shared in a repository for the team',
    toolDescription:
      "Creates an empty toil project for one body of work: ~/.toil/projects/<name>.json, or with shared, <repo>/.toil/projects/<name>.json in a repository's working tree (repo, else the folder's own repository) for everyone who clones it. A shared toil project selects connections by host, so a later link that names a connection records that connection's host instead. Build it up with projects_add_repo, projects_link, projects_env and projects_field. A local write: it needs no allowWrite. Refuses a name already there.",
    input: z.object({
      name: z.string().min(1).describe('The toil project name: lowercase letters, digits and single hyphens, e.g. payments'),
      description: z.string().min(1).optional().describe('One line saying what the body of work is'),
      shared: z.boolean().optional().describe("Create it in a repository's .toil/projects for the team, selecting connections by host"),
      repo: z.string().min(1).optional().describe("With shared: a working tree's root (default: the repository the folder is in)"),
    }),
    writes: false,
    writesLocal: true,
    args: [{ name: 'name', field: 'name', description: 'The toil project name, e.g. payments' }],
    options: [
      { flags: '--description <text>', field: 'description', description: 'One line saying what it covers' },
      { flags: '--shared', field: 'shared', description: "Create it in a repository's .toil/projects, for the team" },
      { flags: '--repo <dir>', field: 'repo', description: "With --shared: the working tree's root (default: this folder's repository)" },
    ],
    examples: [{ name: 'billing' }, { name: 'billing', description: 'Billing platform' }, { name: 'billing', shared: true, repo: '.' }],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      if (!CONNECTION_NAME.test(input.name)) {
        throw new ToilError('INVALID_INPUT', `"${input.name}" isn't a valid toil project name.`, { fix: 'Use lowercase letters, digits and single hyphens, starting with a letter, e.g. payments.' });
      }
      if (input.repo !== undefined && !input.shared) {
        throw new ToilError('INVALID_INPUT', '--repo says which repository a shared toil project goes in, so it needs --shared.', { fix: `toil projects init ${input.name} --shared --repo <dir>, or leave --repo out.` });
      }
      if (input.shared) {
        const root = input.repo ?? catalog.inspect('.').repo?.root;
        if (root === undefined) throw new ToilError('INVALID_INPUT', "A shared toil project goes in a repository, and this folder isn't in one.", { fix: "Pass --repo <dir>, a working tree's root, or run it inside the repository." });
        const toilProject: ToilProject = { name: input.name, ...(input.description ? { description: input.description } : {}), repos: [], sections: {}, environments: {}, people: [] };
        const file = catalog.save(join(catalog.repoFolder(root), `${input.name}.json`), toilProject, 'create');
        return { name: input.name, file, source: 'repo', toilProject: toilProjectContent(toilProject) };
      }
      const elsewhere = catalog.scan().files.filter((f) => f.toilProject?.name === input.name);
      const mine = elsewhere.find((f) => f.source === 'user');
      if (mine) throw new ToilError('INVALID_INPUT', `You already have a toil project named "${input.name}" (${forwardSlashes(mine.file)}).`, { fix: `Change it with toil projects link ${input.name} ..., or choose another name.` });
      for (const other of elsewhere) ctx.warn({ code: 'TOIL_PROJECT_DUPLICATE_NAME', message: `A toil project named "${input.name}" is also in ${forwardSlashes(other.file)} (${other.source}); yours takes precedence.` });
      const toilProject: ToilProject = { name: input.name, ...(input.description ? { description: input.description } : {}), repos: [], sections: {}, environments: {}, people: [] };
      const file = catalog.save(catalog.userFile(input.name), toilProject, 'create');
      return { name: input.name, file, source: 'user', toilProject: toilProjectContent(toilProject) };
    },
  });

  const addRepo = defineConfigCommand({
    path: ['projects', 'add-repo'],
    description: 'Add a repository to a toil project, by its folder or its remote URL',
    toolDescription:
      "Adds a repository to a toil project. Give a local folder (its git root becomes the repo's path and its origin remote, without any credential, is recorded too) or a remote URL. The repo is named after the folder or the remote unless name is set. Refuses a repo name, path or remote the toil project already has. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      location: z.string().min(1).describe('A local folder in the repository, or its remote URL (https://..., ssh://..., or git@host:path)'),
      name: z.string().min(1).optional().describe("The repo's name in the toil project; defaults to the folder's or remote's last part"),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    args: [toilProjectArg, { name: 'location', field: 'location', description: 'A folder in the repository, or its remote URL' }],
    options: [{ flags: '--name <name>', field: 'name', description: "The repo's name in the toil project" }, replaceOption],
    examples: [
      { toilProject: 'payments', location: 'git@git.imagile.dev:pay/fees-svc.git' },
      { toilProject: 'payments', location: 'https://git.imagile.dev/pay/payments-api.git', name: 'payments-api', replace: true },
    ],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const isRemote = /^[a-z][a-z0-9+.-]*:\/\//i.test(input.location) || /^[^@/\\\s]+@[^:/\\\s]+:/.test(input.location);
      let entry: ToilProject['repos'][number];
      if (isRemote) {
        if (hasSecretUserinfo(input.location)) ctx.warn({ code: 'TOIL_PROJECT_REMOTE_USERINFO', message: 'The remote had a credential in it; it was left out of the toil project.' });
        const remote = stripUserinfo(input.location);
        entry = { name: input.name ?? lastPart(remote), remotes: [remote] };
      } else {
        const { path, repo } = catalog.inspect(input.location);
        const root = repo?.root ?? forwardSlashes(path);
        entry = { name: input.name ?? basename(root), path: root, remotes: repo?.origin ? [stripUserinfo(repo.origin)] : [] };
        if (!repo) ctx.warn({ code: 'TOIL_PROJECT_NOT_A_REPO', message: `${forwardSlashes(path)} isn't in a git repository, so only its path was recorded.` });
      }
      const others = toilProject.repos.filter((r) => r.name !== entry.name);
      for (const other of others) {
        const remote = entry.remotes.find((x) => other.remotes.some((y) => normalizeRemote(x) === normalizeRemote(y)));
        if (remote) throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name} already has ${remote} as repo "${other.name}".`, { fix: `Leave it as it is, or remove it from "${other.name}" first.` });
        if (entry.path && other.path && samePath(entry.path, other.path)) throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name} already has ${entry.path} as repo "${other.name}".`, { fix: `Leave it as it is, or remove it from "${other.name}" first.` });
      }
      const existing = toilProject.repos.find((r) => r.name === entry.name);
      // Already there: the same path (or none given) and remotes it already lists. Nothing to add, so no --replace needed.
      const already =
        existing !== undefined &&
        (entry.path === undefined || (existing.path !== undefined && samePath(existing.path, entry.path))) &&
        entry.remotes.every((r) => existing.remotes.some((x) => normalizeRemote(x) === normalizeRemote(r)));
      if (existing && !already && !input.replace) {
        throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name} already has a repo named "${entry.name}".`, { fix: `Pass --replace to replace it, or --name to add this one under another name.` });
      }
      if (already && !input.replace) return saved(ctx, catalog, file, toilProject, false, { repo: existing });
      toilProject.repos = existing ? toilProject.repos.map((r) => (r.name === entry.name ? entry : r)) : [...toilProject.repos, entry];
      return saved(ctx, catalog, file, toilProject, existing === undefined || JSON.stringify(existing) !== JSON.stringify(entry), { repo: entry });
    },
  });

  const bindingOptions = [
    { flags: '--connection <name>', field: 'connection', description: 'Select this connection of yours (for a toil project only you use)' },
    { flags: '--host <host>', field: 'host', description: "Select your connection on this host (for a shared toil project); compared, never contacted" },
    { flags: '--unbind', field: 'unbind', description: 'Remove the connection or host, so calls use your default connection' },
    { flags: '--set <key=value>', field: 'set', description: "Set a value: one of the area's context inputs (project, owner, ...) or reference data; repeatable" },
    { flags: '--add <key=value>', field: 'add', description: 'Add a value to a list of reference data (projects, boards, ...); repeatable' },
    { flags: '--for-repo <name>', field: 'forRepo', description: "Set the --set values for this one of the toil project's repos only" },
    replaceOption,
  ];
  const bindingFields = {
    connection: z.string().min(1).optional().describe('Select this connection of yours by name. For a toil project only you use.'),
    host: z.string().min(1).optional().describe("Select the reader's connection on this host (host or host:port). For a shared toil project. Compared, never contacted."),
    unbind: z.boolean().optional().describe('Remove the connection or host selector, so calls use the default connection.'),
    set: z.array(z.string().min(1)).optional().describe("Values to set, each key=value: the area's context inputs (project, owner, namespace, ...) are applied to calls; any other key is kept as reference data."),
    add: z.array(z.string().min(1)).optional().describe('Values to add to reference-data lists, each key=value (projects=PAY).'),
    forRepo: z.string().min(1).optional().describe("Set the `set` values for this one of the toil project's repos only, as an object of repo name to value."),
    replace: replaceField,
  };

  const link = defineConfigCommand({
    path: ['projects', 'link'],
    description: "Attach an area to a toil project: which connection it uses, and its keys",
    toolDescription:
      "Attaches an area to a toil project, or changes its section: the connection it selects (connection for a private toil project, host for a shared one, or neither for the default), the area's context inputs it supplies (set project=PAY, per repo with forRepo), and reference data (add projects=PAY). Over MCP, a change that would make the section select a connection with writes on is refused: a person does that on the CLI. A local write: no allowWrite.",
    input: z.object({ toilProject: toilProjectField, area: z.string().min(1).describe('The area, e.g. jira'), ...bindingFields }),
    writes: false,
    writesLocal: true,
    args: [toilProjectArg, { name: 'area', field: 'area', description: 'The area, e.g. jira' }],
    options: bindingOptions,
    examples: [
      { toilProject: 'payments', area: 'jira', host: 'jira.imagile.dev', set: ['project=PAY'], add: ['projects=FEES', 'projects=OPS'] },
      { toilProject: 'payments', area: 'jira', unbind: true, set: ['project=LEDG'], forRepo: 'ledger-svc', replace: true },
      { toilProject: 'payments', area: 'jira', connection: 'jira' },
    ],
    run: async (input, ctx) => {
      const area = areaNamed(input.area);
      return changeSection(access(ctx), ctx, area, undefined, input, false);
    },
  });

  const env = defineConfigCommand({
    path: ['projects', 'env'],
    description: "Add an environment's resources for an area to a toil project",
    toolDescription:
      "Sets an area's section for one environment of a toil project (environments.<env>.<area>): its connection or host, the context inputs it supplies there (set namespace=payments-prod), and reference data (add deployments=payments-api). Calls use it when the environment is the call's --env, or the toil project's default environment (default: true makes it that). Over MCP, a change that would make it select a connection with writes on is refused. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      env: z.string().min(1).describe('The environment, e.g. prod'),
      area: z.string().min(1).describe('The area, e.g. openshift'),
      default: z.boolean().optional().describe("Make this the toil project's default environment"),
      ...bindingFields,
    }),
    writes: false,
    writesLocal: true,
    args: [toilProjectArg, { name: 'env', field: 'env', description: 'The environment, e.g. prod' }, { name: 'area', field: 'area', description: 'The area, e.g. openshift' }],
    options: [{ flags: '--default', field: 'default', description: "Make this the toil project's default environment" }, ...bindingOptions],
    examples: [
      { toilProject: 'payments', env: 'prod', area: 'openshift', host: 'api.ocp.imagile.dev:6443', set: ['namespace=payments-prod'], add: ['deployments=payments-api'] },
      { toilProject: 'payments', env: 'test', area: 'openshift', default: true, set: ['namespace=payments-test'], connection: 'openshift', unbind: false, forRepo: 'payments-api', replace: false },
    ],
    run: async (input, ctx) => {
      const area = areaNamed(input.area);
      return changeSection(access(ctx), ctx, area, input.env, input, input.default === true);
    },
  });

  const field = defineConfigCommand({
    path: ['projects', 'field'],
    description: "Name one of an area's fields in a toil project, so prompts use the name",
    toolDescription:
      "Adds a field alias to a toil project's area section (fields.<alias> = <field id>), e.g. storyPoints for customfield_10002, so the friendly name can be used instead of the id. The alias is a camelCase identifier. Refuses an alias or a field id already there unless replace is set. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      area: z.string().min(1).describe('The area, e.g. jira'),
      alias: z.string().min(1).describe('The friendly name, a camelCase identifier, e.g. storyPoints'),
      id: z.string().min(1).describe("The service's field id, e.g. customfield_10002"),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    args: [toilProjectArg, { name: 'area', field: 'area', description: 'The area' }, { name: 'alias', field: 'alias', description: 'The friendly name' }, { name: 'field-id', field: 'id', description: "The service's field id" }],
    options: [replaceOption],
    examples: [{ toilProject: 'payments', area: 'jira', alias: 'storyPoints', id: 'customfield_10002' }, { toilProject: 'payments', area: 'jira', alias: 'acceptanceCriteria', id: 'customfield_10234', replace: true }],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      areaNamed(input.area);
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const section: Section = { ...(toilProject.sections[input.area] ?? {}) };
      const fields = { ...((section.fields as Record<string, string> | undefined) ?? {}) };
      const current = fields[input.alias];
      const sameId = Object.entries(fields).find(([alias, id]) => id === input.id && alias !== input.alias);
      if (sameId && !input.replace) throw new ToilError('INVALID_INPUT', `${input.id} already has the alias "${sameId[0]}" in toil project ${toilProject.name}.`, { fix: `Use "${sameId[0]}", or pass --replace to give it a second alias.` });
      if (current !== undefined && current !== input.id && !input.replace) {
        throw new ToilError('INVALID_INPUT', `"${input.alias}" already names ${current} in toil project ${toilProject.name}.`, { fix: 'Pass --replace to point it at the new field id.' });
      }
      fields[input.alias] = input.id;
      section.fields = fields;
      toilProject.sections[input.area] = section;
      return saved(ctx, catalog, file, toilProject, current !== input.id, { area: input.area, fields });
    },
  });

  const person = defineConfigCommand({
    path: ['projects', 'person'],
    description: "Add someone to a toil project's people, with the identity each system knows them by",
    toolDescription:
      "Adds a person (or an agent, kind agent) to the toil project's people list, or adds to one already there: the identity each area knows them by (id github=pat-ex, id jira=pat), and an email used only to suggest matches. An identity is a user name, login or email, never a credential, and one account can be only one person's. Refuses to change an identity, kind or email already set unless replace is set. Removing a person or an identity (remove) is a delete: a person does that on the CLI. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      name: z.string().min(1).describe('The person\'s name as the team writes it, e.g. Pat Example'),
      id: z.array(z.string().min(1)).optional().describe('Identities to add, each area=identity: the user name, login or email that area shows (github=pat-ex, jira=pat, ado=you@example.com)'),
      kind: z.enum(PERSON_KINDS).optional().describe('human (the default) or agent'),
      email: z.string().min(1).optional().describe('Their email, compared only to suggest which unmapped identities are theirs'),
      remove: z.boolean().optional().describe('Remove the person, or with id only those identities. A delete: CLI only.'),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    offMcpWhen: (input) => (input.remove ? 'Removing a person or an identity is a delete, which is never served over MCP or the API: a person runs toil projects person --remove on the CLI.' : undefined),
    args: [toilProjectArg, { name: 'name', field: 'name', description: "The person's name, e.g. Pat Example" }],
    options: [
      { flags: '--id <area=identity>', field: 'id', description: 'An identity to add, e.g. github=pat-ex; repeatable' },
      { flags: '--kind <kind>', field: 'kind', description: 'human (the default) or agent' },
      { flags: '--email <address>', field: 'email', description: 'Their email, used only to suggest matches' },
      { flags: '--remove', field: 'remove', description: 'Remove the person, or with --id only those identities (CLI only)' },
      replaceOption,
    ],
    examples: [
      { toilProject: 'payments', name: 'Pat Example', id: ['jira=pat', 'github=pat-ex'], email: 'you@example.com' },
      { toilProject: 'payments', name: 'Claude', kind: 'agent', id: ['github=claude'], replace: true },
      // A removal is off MCP, so the example that sets the field keeps it false, as parity runs every example through both doors.
      { toilProject: 'payments', name: 'Pat Example', id: ['github=pat-ex'], remove: false },
    ],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const name = input.name.trim();
      const refuse = (message: string, fix: string) => new ToilError('INVALID_INPUT', `${message} (toil project ${toilProject.name}).`, { fix });
      // Neither a name nor an email may be shaped like a credential either: the toil project is meant to be safe to check in.
      if (identityProblem(name)) throw refuse(`The name can't be used: ${identityProblem(name)}`, 'Give the name the team writes, never a token.');
      const ids = (input.id ?? []).map((pair) => {
        const [area, value] = keyValue(pair, '--id', { example: 'github=pat-ex', quiet: true });
        // A token with `==` padding splits at its first `=`, leaving most of it as the "area": refused without repeating it.
        if (identityProblem(area)) throw refuse("An --id's area can't be used: it's shaped like a credential", 'Give area=identity, e.g. --id github=pat-ex, never a token.');
        // An identity the reader kept under an area this toil hasn't got can still be removed.
        if (!input.remove) areaNamed(area);
        // The value never goes in the message: something shaped like a token may be one.
        const problem = identityProblem(value);
        if (problem) throw refuse(`The ${area} identity can't be used: ${problem}`, 'Pass the user name, login or email, never a token.');
        return [area, value.trim()] as const;
      });
      if (input.email !== undefined && (!EMAIL.test(input.email) || identityProblem(input.email))) throw refuse("--email isn't an email address", 'Give one such as you@example.com, or leave --email out.');
      const at = toilProject.people.findIndex((p) => p.name.toLowerCase() === name.toLowerCase());
      const current = at >= 0 ? toilProject.people[at]! : undefined;
      const names = () => toilProject.people.map((p) => p.name).join(', ') || '(nobody yet)';

      if (input.remove) {
        if (!current) throw refuse(`Nobody named "${name}" is in its people`, `It has: ${names()}.`);
        if (!ids.length) {
          toilProject.people.splice(at, 1);
          return saved(ctx, catalog, file, toilProject, true, { person: null, removed: current });
        }
        const next: ToilProjectPerson = { ...current, ids: { ...current.ids } };
        for (const [area, value] of ids) {
          if (next.ids[area] === undefined || next.ids[area]!.toLowerCase() !== value.toLowerCase()) throw refuse(`${current.name} has no ${area} identity ${value}`, `Their identities: ${Object.entries(current.ids).map(([a, v]) => `${a}=${v}`).join(', ') || 'none'}.`);
          delete next.ids[area];
        }
        toilProject.people[at] = next;
        return saved(ctx, catalog, file, toilProject, true, { person: next, removed: Object.fromEntries(ids) });
      }

      const next: ToilProjectPerson = current ? { ...current, ids: { ...current.ids } } : { name, ids: {} };
      for (const [area, value] of ids) {
        const owner = toilProject.people.find((p, i) => i !== at && p.ids[area] !== undefined && identityKey(area, p.ids[area]!) === identityKey(area, value));
        if (owner) throw refuse(`The ${area} identity ${value} is already ${owner.name}'s`, `One account can only be one person's. Remove it from them first: toil projects person ${toilProject.name} "${owner.name}" --id ${area}=${value} --remove.`);
        const had = next.ids[area];
        if (had !== undefined && had.toLowerCase() !== value.toLowerCase() && !input.replace) throw refuse(`${next.name}'s ${area} identity is already ${had}`, 'Pass --replace to change it.');
        // The same account written in another case is the same account: the file keeps it as first written.
        if (had === undefined || had.toLowerCase() !== value.toLowerCase()) next.ids[area] = value;
      }
      if (input.kind !== undefined) {
        if ((next.kind ?? 'human') !== input.kind && current && !input.replace) throw refuse(`${next.name} is already listed as ${next.kind ?? 'human'}`, 'Pass --replace to change it.');
        if (input.kind === 'human') delete next.kind;
        else next.kind = input.kind;
      }
      if (input.email !== undefined) {
        if (next.email !== undefined && next.email.toLowerCase() !== input.email.toLowerCase() && !input.replace) throw refuse(`${next.name}'s email is already ${next.email}`, 'Pass --replace to change it.');
        next.email = input.email;
      }
      if (current) toilProject.people[at] = next;
      else toilProject.people.push(next);
      return saved(ctx, catalog, file, toilProject, JSON.stringify(current) !== JSON.stringify(next), { person: next });
    },
  });

  const wipLimit = defineConfigCommand({
    path: ['projects', 'wip-limit'],
    description: 'Set how many items one person may have in progress at once',
    toolDescription:
      "Sets the toil project's work-in-progress limit (wipLimit): how many items one person may have in progress at once, as the team agreed. Toil UI's People view counts each person's work in progress against it. Refuses to change a limit already set unless replace is set. Clearing it (clear) is a delete: a person does that on the CLI. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      limit: z.number().int().positive().optional().describe('The most items one person may have in progress at once, e.g. 3'),
      clear: z.boolean().optional().describe('Remove the limit. A delete: CLI only.'),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    offMcpWhen: (input) => (input.clear ? 'Clearing the limit is a delete, which is never served over MCP or the API: a person runs toil projects wip-limit --clear on the CLI.' : undefined),
    args: [toilProjectArg, { name: 'limit', field: 'limit', description: 'The most items one person may have in progress, e.g. 3', required: false }],
    options: [{ flags: '--clear', field: 'clear', description: 'Remove the limit (CLI only)' }, replaceOption],
    examples: [{ toilProject: 'payments', limit: 3 }, { toilProject: 'payments', limit: 4, replace: true, clear: false }],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      if ((input.limit === undefined) === (input.clear !== true)) throw new ToilError('INVALID_INPUT', 'Pass a limit, or --clear, and not both.', { fix: 'toil projects wip-limit <toil-project> 3, or --clear to remove it.' });
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const was = toilProject.wipLimit;
      if (input.clear) {
        delete toilProject.wipLimit;
        return saved(ctx, catalog, file, toilProject, was !== undefined, { wipLimit: null });
      }
      if (was !== undefined && was !== input.limit && !input.replace) throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name}'s limit is already ${was}.`, { fix: 'Pass --replace to change it.' });
      toilProject.wipLimit = input.limit!;
      return saved(ctx, catalog, file, toilProject, was !== input.limit, { wipLimit: input.limit });
    },
  });

  const describe = defineConfigCommand({
    path: ['projects', 'describe'],
    description: "Rename one of your own toil projects, or change its description",
    toolDescription:
      "Renames one of your own toil projects (~/.toil/projects), or sets its one-line description, or both. A rename moves the file to ~/.toil/projects/<new name>.json with every section, repo, person and environment as it was, and is refused when you already have a toil project of that name. A checked-in or listed toil project is refused: copy it into your own folder with projects_import first. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      name: z.string().min(1).optional().describe('The new name: lowercase letters, digits and single hyphens, e.g. card-payments'),
      description: z.string().min(1).optional().describe('One line saying what the body of work is; replaces the one there'),
    }),
    writes: false,
    writesLocal: true,
    args: [toilProjectArg],
    options: [
      { flags: '--name <name>', field: 'name', description: 'Rename it' },
      { flags: '--description <text>', field: 'description', description: 'One line saying what it covers' },
    ],
    examples: [{ toilProject: 'payments', description: 'Card payments v2' }, { toilProject: 'payments', name: 'card-payments', description: 'Card payments v2' }],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      if (input.name === undefined && input.description === undefined) throw new ToilError('INVALID_INPUT', 'Pass --name, --description, or both.', { fix: 'toil projects describe <toil-project> --name <new name> --description "<one line>".' });
      const file = catalog.find(input.toilProject);
      // Renaming a teammate's file in a repository, or a listed folder's, would move it out from under them; your copy is yours to change.
      if (file.source !== 'user') {
        throw new ToilError('INVALID_INPUT', `Toil project ${file.toilProject.name} is ${file.source === 'repo' ? 'checked into a repository' : file.source === 'listed' ? 'in a listed folder' : 'a file outside your own folder'} (${forwardSlashes(file.file)}), so it isn't yours to rename or describe.`, {
          fix: `Copy it into your own folder with toil projects import ${forwardSlashes(file.file)}, then describe your copy.`,
        });
      }
      const toilProject = structuredClone(file.toilProject);
      const from = toilProject.name;
      let description: string | undefined;
      if (input.description !== undefined) {
        // One line, as the field says: a pasted paragraph keeps its words, not its line breaks.
        description = input.description.trim().replace(/\s*\r?\n\s*/g, ' ');
        if (!description) throw new ToilError('INVALID_INPUT', 'The description is empty.', { fix: 'Give one line of text, e.g. --description "Card payments v2".' });
        toilProject.description = description;
      }
      const to = input.name ?? from;
      if (to !== from) {
        if (!CONNECTION_NAME.test(to)) throw new ToilError('INVALID_INPUT', `"${to}" isn't a valid toil project name.`, { fix: 'Use lowercase letters, digits and single hyphens, starting with a letter, e.g. card-payments.' });
        const others = catalog.scan().files.filter((f) => f.toilProject?.name === to);
        const mine = others.find((f) => f.source === 'user');
        if (mine) throw new ToilError('INVALID_INPUT', `You already have a toil project named "${to}" (${forwardSlashes(mine.file)}).`, { fix: 'Choose another name, or remove that one first with toil projects remove.' });
        for (const other of others) ctx.warn({ code: 'TOIL_PROJECT_DUPLICATE_NAME', message: `A toil project named "${to}" is also in ${forwardSlashes(other.file)} (${other.source}); yours takes precedence.` });
        toilProject.name = to;
      }
      const changed = to !== from || file.toilProject.description !== toilProject.description;
      if (to === from) return saved(ctx, catalog, file, toilProject, changed, { renamed: null, description: toilProject.description ?? null });
      // The new file is written and checked first, then the old one goes: a refusal or a crash leaves the toil project where it was.
      const target = catalog.userFile(to);
      // A file of that name holding another toil project: say so, rather than let save's own refusal suggest a --replace this command hasn't got.
      if (!samePath(target, file.file) && existsSync(target)) {
        throw new ToilError('INVALID_INPUT', `${forwardSlashes(target)} is already there, so toil project ${from} can't be renamed to "${to}".`, { fix: 'Choose another name, or move that file out of your toil project folder first.' });
      }
      // A file already named for the new name (pay.json holding "payments", renamed to pay) is this one: rewritten in place.
      const written = catalog.save(target, toilProject, samePath(target, file.file) ? 'edit' : 'create');
      if (!samePath(written, file.file)) rmSync(file.file);
      const removed = credentialPaths(file);
      if (removed.length) ctx.warn({ code: 'TOIL_PROJECT_REMOTE_USERINFO', message: `Removed the credential from ${removed.join(', ')}; the file's remotes now carry none.` });
      return { name: to, file: written, source: 'user', changed: true, renamed: { from, to, previousFile: forwardSlashes(file.file) }, description: toilProject.description ?? null, ...(removed.length ? { credentialsRemoved: removed } : {}) };
    },
  });

  const exportCommand = defineConfigCommand({
    path: ['projects', 'export'],
    description: "Write a toil project for sharing: into a repository's .toil/projects, or to one file",
    toolDescription:
      "Writes a toil project for others to use: each connection name becomes a host selector taken from that connection's base URL (teammates name connections differently), and local repo paths are dropped. With repo, it writes <repo>/.toil/projects/<name>.json, where repo must be a working tree's root; with file, it writes that .json file. It never stages or commits. Refuses to overwrite anything but a toil project, and a toil project without replace. Over MCP, a toil project whose bindings select a connection with writes on is refused.",
    input: z.object({
      toilProject: toilProjectField,
      repo: z.string().min(1).optional().describe('The root of a working tree to write .toil/projects/<name>.json into'),
      file: z.string().min(1).optional().describe('A .json file to write instead'),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    args: [toilProjectArg],
    options: [
      { flags: '--repo <dir>', field: 'repo', description: "A working tree's root; writes .toil/projects/<name>.json there" },
      { flags: '--file <path>', field: 'file', description: 'Write one .json file instead' },
      replaceOption,
    ],
    examples: [{ toilProject: 'payments', file: 'shared/payments.json' }, { toilProject: 'payments', repo: '.', replace: true }],
    run: async (input, ctx) => {
      const { catalog, config, via } = access(ctx);
      if ((input.repo === undefined) === (input.file === undefined)) throw new ToilError('INVALID_INPUT', 'Pass exactly one of --repo and --file.', { fix: 'toil projects export <name> --repo <dir>, or --file <path>.' });
      const source = catalog.find(input.toilProject);
      if (via !== 'cli') refuseWritesBindings(catalog, config, areas, source.toilProject, 'export');
      const { toilProject, hosts, droppedPaths } = forSharing(source.toilProject, config, areas);
      const target = input.repo !== undefined ? join(catalog.repoFolder(input.repo), `${toilProject.name}.json`) : catalog.pathFor(input.file!, 'The export file');
      const file = catalog.save(target, toilProject, input.replace ? 'replace' : 'create');
      return { name: toilProject.name, file, hosts, droppedPaths, toilProject: toilProjectContent(toilProject) };
    },
  });

  const importCommand = defineConfigCommand({
    path: ['projects', 'import'],
    description: 'Copy a toil project into your own folder, adopting its bindings',
    toolDescription:
      "Copies a toil project file, or every toil project in a folder, into ~/.toil/projects so it's yours: you can adapt it, and writes may follow its bindings. It never creates a connection; each connection or host it names that you don't have is listed under toSetUp. A file that isn't a valid toil project is reported by key path only, never by content. Over MCP, a toil project with a binding that selects a connection with writes on is refused: a person adopts that on the CLI.",
    input: z.object({
      source: z.string().min(1).describe('A toil project file, or a folder of them (a repository\'s .toil/projects)'),
      name: z.string().min(1).optional().describe('A new name for it (a single file only)'),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    args: [{ name: 'source', field: 'source', description: 'A toil project file, or a folder of them' }],
    options: [{ flags: '--name <name>', field: 'name', description: 'A new name for it (a single file only)' }, replaceOption],
    examples: [{ source: '.toil/projects/team.json' }, { source: '.toil/projects', name: undefined, replace: true }, { source: '.toil/projects/team.json', name: 'team-mine', replace: true }],
    run: async (input, ctx) => {
      const { catalog, config, via } = access(ctx);
      // Bounded before it's looked at, so over MCP a folder outside them can't be probed (docs/bounds.md, projects.read).
      const { folder: isDir, files } = catalog.importFiles(input.source);
      if (isDir && input.name !== undefined) throw new ToilError('INVALID_INPUT', '--name renames one toil project, and a folder may hold several.', { fix: 'Import the one file with --name, or the folder without it.' });
      const found: Array<ToilProjectFile & { toilProject: ToilProject }> = [];
      const failed: Array<{ file: string; problems: Array<{ path: string; message: string }> }> = [];
      for (const f of files) {
        try {
          found.push(catalog.find(f));
        } catch (err) {
          const e = toToilError(err);
          // Schema problems by key path, never the file's content (docs/projects.md, What import reveals).
          if (!isDir || e.code !== 'CONFIG_INVALID') throw err;
          failed.push({ file: forwardSlashes(f), problems: (e.details as Array<{ path: string; message: string }> | undefined) ?? [{ path: '', message: e.message }] });
        }
      }
      const plan = found.map((f) => {
        if (f.source === 'user') throw new ToilError('INVALID_INPUT', `${forwardSlashes(f.file)} is already in your own folder.`, { fix: 'It is yours already; change it with toil projects link.' });
        const toilProject = { ...structuredClone(f.toilProject), ...(input.name !== undefined ? { name: input.name } : {}) };
        if (!CONNECTION_NAME.test(toilProject.name)) throw new ToilError('INVALID_INPUT', `"${toilProject.name}" isn't a valid toil project name.`, { fix: 'Use lowercase letters, digits and single hyphens, starting with a letter.' });
        if (via !== 'cli') refuseWritesBindings(catalog, config, areas, toilProject, 'import');
        return { from: f.file, toilProject, target: catalog.userFile(toilProject.name) };
      });
      // Everything is checked before anything is written, so a refusal leaves your folder as it was.
      const mine = new Map(catalog.scan().files.filter((f) => f.source === 'user' && f.toilProject).map((f) => [f.toilProject!.name, f.file]));
      for (const p of plan) {
        if (mine.has(p.toilProject.name) && !input.replace) {
          throw new ToilError('INVALID_INPUT', `You already have a toil project named "${p.toilProject.name}" (${forwardSlashes(mine.get(p.toilProject.name)!)}). Nothing was imported.`, { fix: 'Pass --replace to replace yours, or --name to import it under another name.' });
        }
      }
      const imported = plan.map((p) => ({ name: p.toilProject.name, from: forwardSlashes(p.from), file: catalog.save(mine.get(p.toilProject.name) ?? p.target, p.toilProject, mine.has(p.toilProject.name) ? 'replace' : 'create') }));
      const toSetUp = plan.flatMap((p) => unresolved(catalog, config, p.toilProject));
      if (failed.length > 0) ctx.setExitCode(1);
      return { imported, toSetUp, failed };
    },
  });

  const unlink = defineConfigCommand({
    path: ['projects', 'unlink'],
    description: "Remove an area's section from a toil project, or one environment's",
    input: z.object({
      toilProject: toilProjectField,
      area: z.string().min(1).describe('The section to remove, e.g. jira; one toil has no area for is accepted too'),
      env: z.string().min(1).optional().describe("Remove environments.<env>.<area> instead of the area's own section"),
    }),
    writes: false,
    writesLocal: true,
    // Taking a section out is a delete, and a delete is never an MCP tool (CLAUDE.md, Writes).
    kind: 'cli-only',
    args: [toilProjectArg],
    options: [
      { flags: '--area <area>', field: 'area', description: 'The section to remove, e.g. jira' },
      { flags: '--env <env>', field: 'env', description: "Remove that environment's section for the area instead" },
    ],
    examples: [{ toilProject: 'payments', area: 'jira' }, { toilProject: 'payments', area: 'openshift', env: 'prod' }],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const where = input.env === undefined ? input.area : `environments.${input.env}.${input.area}`;
      const holder = input.env === undefined ? toilProject.sections : toilProject.environments[input.env];
      const section = holder?.[input.area];
      if (!holder || section === undefined) {
        const have = [...Object.keys(toilProject.sections), ...Object.entries(toilProject.environments).flatMap(([env, byArea]) => Object.keys(byArea).map((area) => `${area} --env ${env}`))];
        throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name} has no ${where} section.`, { fix: have.length ? `It has: ${have.join(', ')}.` : 'It has no sections yet.' });
      }
      delete holder[input.area];
      // An environment left with no areas goes too, and stops being the default.
      if (input.env !== undefined && Object.keys(holder).length === 0) {
        delete toilProject.environments[input.env];
        if (toilProject.env === input.env) delete toilProject.env;
      }
      return saved(ctx, catalog, file, toilProject, true, { area: input.area, env: input.env ?? null, removed: section });
    },
  });

  const remove = defineConfigCommand({
    path: ['projects', 'remove'],
    description: 'Delete one of your own toil projects',
    input: z.object({ name: z.string().min(1).describe('The name of a toil project in your own folder') }),
    writes: false,
    writesLocal: true,
    // A delete is never an MCP tool (CLAUDE.md, Writes); a person removes a toil project.
    kind: 'cli-only',
    args: [{ name: 'name', field: 'name', description: 'The name of a toil project in your own folder' }],
    examples: [{ name: 'payments' }],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      const mine = catalog.scan().files.find((f) => f.source === 'user' && (f.toilProject?.name === input.name || (!f.toilProject && basename(f.file).replace(/\.json$/i, '') === input.name)));
      if (!mine) throw new ToilError('INVALID_INPUT', `You have no toil project named "${input.name}" in ${forwardSlashes(catalog.places().user)}.`, { fix: 'Run toil projects list to see the names. Only your own toil projects can be removed here.' });
      rmSync(mine.file);
      return { name: input.name, file: forwardSlashes(mine.file), deleted: true };
    },
  });


  const analyzeSet = defineConfigCommand({
    path: ['projects', 'analyze', 'set'],
    description: 'Tune how Analyze briefs a toil project: its goal, reader, lenses, and what to watch for or leave out',
    toolDescription:
      "Sets a toil project's Analyze settings (its analyze key): goal (what the work is for), audience (lead, engineer or stakeholder), the lens order (order: lens ids separated by commas, from failing, blocked, waiting, sprint, stale, load, drift and ready), lenses turned on or off, a lens's threshold (threshold, as id=number: failing in hours, waiting in working days, stale in days), and watchFor and leaveOut (words for the agent, up to 1000 characters each). Anything not set follows the standard. projects_brief and projects_analyze_prompt read it. A value already set is refused unless replace is set. Clearing a setting, or reset to the standard, is a delete: a person does that on the CLI. A local write: no allowWrite.",
    input: z.object({
      toilProject: toilProjectField,
      goal: z.string().min(1).optional().describe('What the work is for, in one line, e.g. "Card payments v2 live for all merchants by 31 Oct."'),
      audience: z.enum(['lead', 'engineer', 'stakeholder']).optional().describe('Who the briefing is for: lead (the standard), engineer or stakeholder'),
      order: z.string().min(1).optional().describe('Lens ids in the order to apply them, separated by commas, e.g. blocked,failing,waiting; any not named follow in the standard order'),
      on: z.array(z.string()).optional().describe('Lenses to turn on, by id'),
      off: z.array(z.string()).optional().describe('Lenses to turn off, by id'),
      threshold: z.array(z.string()).optional().describe("A lens's threshold, as id=number: failing=24 (hours), waiting=3 (working days), stale=7 (days)"),
      watchFor: z.string().min(1).optional().describe('What else Analyze should look for, in words'),
      leaveOut: z.string().min(1).optional().describe('What Analyze should leave out, in words; the briefing lists what this hid'),
      clear: z.array(z.enum(['goal', 'audience', 'lenses', 'watchFor', 'leaveOut'])).optional().describe('Settings to remove, back to the standard. A delete: CLI only.'),
      reset: z.boolean().optional().describe('Remove every Analyze setting, back to the standard. A delete: CLI only.'),
      replace: replaceField,
    }),
    writes: false,
    writesLocal: true,
    offMcpWhen: (input) => (input.reset || input.clear?.length ? 'Clearing Analyze settings is a delete, which is never served over MCP or the API: a person runs toil projects analyze set --clear or --reset on the CLI.' : undefined),
    args: [toilProjectArg],
    options: [
      { flags: '--goal <text>', field: 'goal', description: 'What the work is for, in one line' },
      { flags: '--audience <who>', field: 'audience', description: 'lead, engineer or stakeholder' },
      { flags: '--order <ids>', field: 'order', description: 'Lens ids in the order to apply them, separated by commas' },
      { flags: '--on <id>', field: 'on', description: 'Turn a lens on (repeatable)' },
      { flags: '--off <id>', field: 'off', description: 'Turn a lens off (repeatable)' },
      { flags: '--threshold <id=n>', field: 'threshold', description: "Set a lens's threshold (repeatable): failing=24, waiting=3, stale=7" },
      { flags: '--watch-for <text>', field: 'watchFor', description: 'What else to look for' },
      { flags: '--leave-out <text>', field: 'leaveOut', description: 'What to leave out' },
      { flags: '--clear <setting>', field: 'clear', description: 'Remove a setting: goal, audience, lenses, watchFor or leaveOut (repeatable; CLI only)' },
      { flags: '--reset', field: 'reset', description: 'Remove every Analyze setting (CLI only)' },
      replaceOption,
    ],
    examples: [
      { toilProject: 'payments', goal: 'Card payments v2 live for all merchants by 31 Oct.', audience: 'lead', threshold: ['waiting=3'] },
      { toilProject: 'payments', order: 'blocked,failing', on: ['ready'], off: ['stale'], watchFor: 'Changes to the tokeniser without a security review.', leaveOut: 'The docs epic, PAY-90.', replace: true, clear: [], reset: false },
    ],
    run: async (input, ctx) => {
      const { catalog } = access(ctx);
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const before = JSON.stringify(toilProject.analyze ?? {});
      const a: NonNullable<ToilProject['analyze']> = input.reset ? {} : structuredClone(toilProject.analyze ?? {});
      for (const key of input.clear ?? []) delete a[key];
      const words = { goal: input.goal, audience: input.audience, watchFor: input.watchFor, leaveOut: input.leaveOut };
      for (const key of ['goal', 'audience', 'watchFor', 'leaveOut'] as const) {
        const value = words[key];
        if (value === undefined) continue;
        if (a[key] !== undefined && a[key] !== value && !input.replace) throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name}'s ${key} is already set.`, { fix: 'Pass --replace to change it.' });
        (a as Record<string, unknown>)[key] = value;
      }
      const lensId = (id: string, flag: string): LensId => {
        if (!isLensId(id)) throw new ToilError('INVALID_INPUT', `${flag} names "${id}", which isn't a lens.`, { fix: `Use one of: ${LENSES.map((l) => l.id).join(', ')}.` });
        return id;
      };
      const thresholds = (input.threshold ?? []).map((pair) => {
        const [id, value] = keyValue(pair, '--threshold', { example: 'waiting=3' });
        const n = Number(value);
        if (!Number.isFinite(n)) throw new ToilError('INVALID_INPUT', `--threshold ${pair} isn't a number.`, { fix: 'For example --threshold waiting=3.' });
        return [lensId(id, '--threshold'), n] as const;
      });
      if (input.order !== undefined || input.on?.length || input.off?.length || thresholds.length) {
        if (a.lenses?.length && !input.replace) throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name}'s lenses are already set.`, { fix: 'Pass --replace to change them.' });
        const had = new Map((a.lenses ?? []).map((l) => [l.id, { ...l }]));
        const order = input.order !== undefined ? input.order.split(',').map((s) => lensId(s.trim(), '--order')) : [...had.keys()];
        const both = (input.on ?? []).filter((id) => (input.off ?? []).includes(id));
        if (both.length) throw new ToilError('INVALID_INPUT', `${both.join(', ')} ${both.length > 1 ? 'are' : 'is'} in both --on and --off.`, { fix: 'Name each lens in one of them.' });
        const named = [...(input.on ?? []).map((id) => lensId(id, '--on')), ...(input.off ?? []).map((id) => lensId(id, '--off')), ...thresholds.map(([id]) => id)];
        for (const id of named) if (!order.includes(id)) order.push(id);
        const lenses = [...new Set([...order, ...had.keys()])].map((id) => had.get(id) ?? { id });
        const at = (id: LensId) => lenses.find((l) => l.id === id)!;
        for (const id of input.on ?? []) at(id as LensId).on = true;
        for (const id of input.off ?? []) at(id as LensId).on = false;
        for (const [id, n] of thresholds) at(id).threshold = n;
        a.lenses = lenses;
      }
      if (Object.keys(a).length) toilProject.analyze = a;
      else delete toilProject.analyze;
      return saved(ctx, catalog, file, toilProject, JSON.stringify(toilProject.analyze ?? {}) !== before, { analyze: toilProject.analyze ?? null });
    },
  });

  return [init, addRepo, link, env, field, person, wipLimit, analyzeSet, describe, exportCommand, importCommand, unlink, remove];

  /** link and env: one section's binding, context inputs and reference data. */
  async function changeSection(
    { catalog, config, via, prompt }: Access,
    ctx: CommandContext<unknown>,
    area: AnyArea,
    envName: string | undefined,
    input: { toilProject: string; connection?: string | undefined; host?: string | undefined; unbind?: boolean | undefined; set?: string[] | undefined; add?: string[] | undefined; forRepo?: string | undefined; replace?: boolean | undefined },
    makeDefault: boolean,
  ) {
    const file = catalog.find(input.toilProject);
    const before = file.toilProject;
    const toilProject = structuredClone(before);
    const where = envName === undefined ? area.name : `environments.${envName}.${area.name}`;
    const section: Section = structuredClone((envName === undefined ? toilProject.sections[area.name] : toilProject.environments[envName]?.[area.name]) ?? {});
    const refuse = (message: string, fix: string) => new ToilError('INVALID_INPUT', `${message} (toil project ${toilProject.name}, ${where}).`, { fix });
    const replace = input.replace === true;

    const bindings = [input.connection !== undefined, input.host !== undefined, input.unbind === true].filter(Boolean).length;
    if (bindings > 1) throw refuse('Give one of --connection, --host and --unbind', 'Each decides the connection on its own.');
    if (input.connection !== undefined) {
      const conn = config.connections[input.connection];
      if (!conn || conn.area !== area.name) throw refuse(`You have no ${area.name} connection named "${input.connection}"`, `Run toil connections list --area ${area.name} to see yours.`);
      // A toil project others read selects by host, since their connections have names of their own (docs/projects.md, Selecting a connection).
      if (file.source !== 'user') input = await sharedBinding(ctx, prompt, file.file, area, input.connection, conn, input);
    }
    const bound = typeof section.connection === 'string' ? `connection ${section.connection}` : typeof section.host === 'string' ? `host ${section.host}` : undefined;
    const wanted = input.connection !== undefined ? `connection ${input.connection}` : input.host !== undefined ? `host ${input.host.toLowerCase()}` : undefined;
    if (wanted && bound && wanted !== bound && !replace) throw refuse(`It already selects ${bound}`, 'Pass --replace to select the new one instead.');
    if (input.connection !== undefined || input.host !== undefined || input.unbind) {
      delete section.connection;
      delete section.host;
      if (input.connection !== undefined) section.connection = input.connection;
      if (input.host !== undefined) section.host = input.host.toLowerCase();
    }

    if (input.forRepo !== undefined && !toilProject.repos.some((r) => r.name === input.forRepo)) {
      throw refuse(`It has no repo named "${input.forRepo}"`, `Add it with toil projects add-repo ${toilProject.name} <folder|remote> --name ${input.forRepo}, or use one of: ${toilProject.repos.map((r) => r.name).join(', ') || '(no repos yet)'}.`);
    }
    const context = area.context as Record<string, ContextInput>;
    for (const pair of input.set ?? []) {
      const [key, value] = keyValue(pair, '--set');
      if (['connection', 'host', 'fields'].includes(key)) throw refuse(`"${key}" isn't set with --set`, key === 'fields' ? 'Use toil projects field.' : `Use --${key}.`);
      // A section's own env would never be read: the environment is the toil project's, or the call's --env.
      if (key === 'env' && 'env' in context) throw refuse('The environment isn\'t set with --set', `Use toil projects env ${toilProject.name} <env> ${area.name} --default to make it the toil project's environment.`);
      const spec = context[key];
      const parsed = spec?.schema?.safeParse(value);
      if (parsed && !parsed.success) throw refuse(`"${value}" isn't a valid ${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`, 'Correct the value.');
      const current = section[key];
      if (input.forRepo !== undefined) {
        if (typeof current === 'string' && !replace) throw refuse(`${key} is already "${current}" for every repo`, 'Pass --replace to make it per repo.');
        const map: Record<string, unknown> = typeof current === 'object' && current !== null && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {};
        if (map[input.forRepo] !== undefined && map[input.forRepo] !== value && !replace) throw refuse(`${key} is already "${String(map[input.forRepo])}" for ${input.forRepo}`, 'Pass --replace to change it.');
        map[input.forRepo] = value;
        section[key] = map;
      } else {
        if (current !== undefined && current !== value && !replace) throw refuse(`${key} is already ${JSON.stringify(current)}`, 'Pass --replace to change it.');
        section[key] = value;
      }
      if (!spec) ctx.warn({ code: 'TOIL_PROJECT_REFERENCE_KEY', message: `"${key}" isn't one of ${area.name}'s context inputs (${Object.keys(context).join(', ') || 'it has none'}), so it's kept as reference data and not applied to calls.` });
    }
    for (const pair of input.add ?? []) {
      const [key, value] = keyValue(pair, '--add');
      if (key in context || ['connection', 'host', 'fields'].includes(key)) throw refuse(`"${key}" holds one value, not a list`, 'Use --set.');
      const current = section[key];
      if (current !== undefined && !Array.isArray(current)) throw refuse(`${key} is ${JSON.stringify(current)}, not a list`, 'Use --set to change it.');
      const list = [...((current as unknown[] | undefined) ?? [])];
      if (list.map(String).includes(value)) throw refuse(`${key} already lists ${value}`, 'Leave it as it is.');
      section[key] = [...list, value];
    }

    if (envName === undefined) toilProject.sections[area.name] = section;
    else toilProject.environments[envName] = { ...(toilProject.environments[envName] ?? {}), [area.name]: section };
    if (makeDefault) toilProject.env = envName;
    if (via !== 'cli') refuseNewWritesTarget(catalog, config, areas, before, toilProject);
    for (const w of hostWarnings(catalog, toilProject, area.name, envName)) ctx.warn(w);
    return saved(ctx, catalog, file, toilProject, JSON.stringify(toilProjectContent(before)) !== JSON.stringify(toilProjectContent(toilProject)), { area: area.name, env: envName ?? null, section });
  }
}

interface Access {
  catalog: ToilProjectCatalog;
  config: ResolvedConfig;
  via: ConfigAccess['via'];
  prompt: ConfigAccess['prompt'];
}

function access(ctx: CommandContext<unknown>): Access {
  if (!ctx.manage) throw new Error('A toil projects command ran without ctx.manage; define it with defineConfigCommand.');
  if (!ctx.manage.toilProjects) throw new ToilError('NOT_CONFIGURED', 'Toil projects are not available here.', { fix: 'Run toil projects from the CLI or toil mcp.' });
  return { catalog: ctx.manage.toilProjects, config: ctx.manage.config, via: ctx.manage.via, prompt: ctx.manage.prompt };
}

/**
 * `--connection` on a toil project others read (checked in, or in a listed folder):
 * the connection's host is recorded instead, since a teammate's connection on
 * that host has a name of its own. On a terminal it asks first, and a person
 * may keep the name; anywhere else the host is recorded, and a warning says so.
 * A connection with no host to record keeps its name, with a warning.
 */
async function sharedBinding<T extends { connection?: string | undefined; host?: string | undefined }>(
  ctx: CommandContext<unknown>,
  prompt: Access['prompt'],
  file: string,
  area: AnyArea,
  name: string,
  conn: Record<string, unknown>,
  input: T,
): Promise<T> {
  const host = selectorHost(conn, area.siteApis);
  const shared = `${forwardSlashes(file)} is shared`;
  if (host === undefined) {
    ctx.warn({ code: 'TOIL_PROJECT_CONNECTION_SHARED', message: `${shared}, but connection ${name} has no host to record, so the toil project names it: that works only for readers with a ${area.name} connection called ${name}.` });
    return input;
  }
  if (prompt) {
    const answer = await prompt.ask(`${shared}, and teammates name their connections differently. Record host ${host} instead of connection ${name}? y/n`, 'y', 'confirm');
    if (!/^y(es)?$/i.test(answer)) {
      ctx.warn({ code: 'TOIL_PROJECT_CONNECTION_SHARED', message: `${shared} and names connection ${name}, which works only for readers with a ${area.name} connection called ${name}; "host": "${host}" works for everyone.` });
      return input;
    }
  } else {
    ctx.warn({ code: 'TOIL_PROJECT_HOST_RECORDED', message: `${shared}, so it records host ${host}, which selects each reader's own ${area.name} connection there, rather than connection ${name}.` });
  }
  return { ...input, connection: undefined, host };
}

/**
 * Writes an edit back where it was read from; an edit that changes nothing
 * writes nothing, unless the file holds a credential in a stored remote.
 * Remotes are read with it stripped, so any write takes every credential out
 * of the file, and an edit that reaches here always does: that's said, in a
 * warning and in `credentialsRemoved`, and counts as a change.
 */
function saved(ctx: CommandContext<unknown>, catalog: ToilProjectCatalog, file: ToilProjectFile & { toilProject: ToilProject }, toilProject: ToilProject, changed: boolean, extra: Record<string, unknown>) {
  const removed = credentialPaths(file);
  const write = changed || removed.length > 0;
  const written = write ? catalog.save(file.file, toilProject, 'edit') : forwardSlashes(file.file);
  if (removed.length) ctx.warn({ code: 'TOIL_PROJECT_REMOTE_USERINFO', message: `Removed the credential from ${removed.join(', ')}; the file's remotes now carry none.` });
  return { name: toilProject.name, file: written, source: file.source, changed: write, ...extra, ...(removed.length ? { credentialsRemoved: removed } : {}) };
}

/** Key paths of stored remotes that carry a credential, e.g. `repos[0].remotes[1]`. */
function credentialPaths(file: ToilProjectFile): string[] {
  return file.problems.filter((p) => p.code === 'TOIL_PROJECT_REMOTE_USERINFO').map((p) => p.path);
}

/**
 * `key=value` from a flag's value. `quiet` keeps the value out of the error, for a
 * flag whose value may be something that shouldn't be repeated (`--id`, where a
 * pasted token is the mistake being refused).
 */
function keyValue(pair: string, flag: string, { example = 'project=PAY', quiet = false }: { example?: string; quiet?: boolean } = {}): [string, string] {
  const at = pair.indexOf('=');
  if (at <= 0 || at === pair.length - 1) throw new ToilError('INVALID_INPUT', quiet ? `${flag} takes key=value, and one value given isn't.` : `${flag} takes key=value, and "${pair}" isn't.`, { fix: `For example ${flag} ${example}.` });
  return [pair.slice(0, at), pair.slice(at + 1)];
}

function lastPart(remote: string): string {
  return normalizeRemote(remote).split('/').filter(Boolean).pop() ?? remote;
}

/**
 * The connection a call to `area` with no input of its own would use under
 * `toil-project`, from each of the folders the toil project knows (no repo, and each
 * repo, since a value may be per repo): the call's own resolver decides
 * (`toilProjectConnection`), through the toil project's `connection` or host and every
 * input that selects a connection (`env` included). Undefined from the
 * toil project means the area's default. One that can't resolve selects nothing.
 */
function choices(catalog: ToilProjectCatalog, config: ResolvedConfig, area: AnyArea, toilProject: ToilProject): Array<{ repo: string | undefined; chosen: string | undefined; byToilProject: boolean }> {
  return [undefined, ...toilProject.repos.map((r) => r.name)].map((repo) => {
    try {
      const found = toilProjectConnection(config, area, catalog.lookupOf(toilProject, repo));
      return { repo, chosen: found?.value ?? defaultConnectionName(config, area.name), byToilProject: found !== undefined };
    } catch {
      return { repo, chosen: undefined, byToilProject: false };
    }
  });
}

/**
 * Every area a toil project, or an edit of it, could choose a connection for: the
 * ones it names, in its sections or an environment's. That's every area it
 * can retarget: an area it doesn't name gets no `connection` or `host` from
 * it, and its environment fills `--env` only for the areas that environment
 * lists.
 */
function areasOf(areas: readonly AnyArea[], ...toilProjects: ToilProject[]): AnyArea[] {
  const named = new Set(toilProjects.flatMap((d) => [...Object.keys(d.sections), ...Object.values(d.environments).flatMap((e) => Object.keys(e))]));
  return areas.filter((a) => named.has(a.name));
}

/**
 * Over MCP, a change may not make a call select a connection with writes on
 * that it didn't select before: that's how a toil project would silently point a
 * write somewhere new (docs/projects.md). Judged by the call's own resolver,
 * so a `--default` environment that selects a connection is caught as surely
 * as a `connection`.
 */
function refuseNewWritesTarget(catalog: ToilProjectCatalog, config: ResolvedConfig, areas: readonly AnyArea[], before: ToilProject, after: ToilProject): void {
  for (const area of areasOf(areas, before, after)) {
    const was = choices(catalog, config, area, before);
    for (const [i, now] of choices(catalog, config, area, after).entries()) {
      if (now.chosen === undefined || !connectionWrites(config.connections[now.chosen]) || now.chosen === was[i]?.chosen) continue;
      throw new ToilError('WRITE_DISABLED', `Outside the CLI (over MCP or the API), a toil project can't be made to select connection ${now.chosen}, which has writes on: that binding is a person's decision, made on the CLI.`, {
        fix: `Ask the user to make this change with toil projects on the command line, or select a connection with writes off.`,
      });
    }
  }
}

/** Over MCP, import and export refuse a toil project that chooses a connection with writes on, by any binding or selecting input. */
export function refuseWritesBindings(catalog: ToilProjectCatalog, config: ResolvedConfig, areas: readonly AnyArea[], toilProject: ToilProject, what: 'import' | 'export'): void {
  for (const area of areasOf(areas, toilProject)) {
    const hit = choices(catalog, config, area, toilProject).find((c) => c.byToilProject && c.chosen !== undefined && connectionWrites(config.connections[c.chosen]));
    if (hit) {
      throw new ToilError('WRITE_DISABLED', `Outside the CLI (over MCP or the API), toil won't ${what} toil project ${toilProject.name}: it makes ${area.name} calls use connection ${hit.chosen}, which has writes on. That's a person's decision, made on the CLI.`, {
        fix: `Ask the user to run toil projects ${what} on the command line.`,
      });
    }
  }
}

/** A host that selects none or several of your connections is worth saying when it's set, not only when a call trips on it. */
function hostWarnings(catalog: ToilProjectCatalog, toilProject: ToilProject, area: string, env: string | undefined) {
  try {
    catalog.binding(toilProject, area, env);
    return [];
  } catch (err) {
    const e = toToilError(err);
    return [{ code: e.code === 'NOT_CONFIGURED' ? 'TOIL_PROJECT_HOST_UNMATCHED' : 'TOIL_PROJECT_HOST_AMBIGUOUS', message: e.message }];
  }
}

/**
 * The toil project as others should get it: each connection name becomes a host
 * selector from that connection's base URL, since teammates name connections
 * differently, and local repo paths, which are machine-specific, go.
 */
export function forSharing(source: ToilProject, config: ResolvedConfig, areas: readonly AnyArea[] = []): { toilProject: ToilProject; hosts: Array<{ area: string; env: string | null; connection: string; host: string }>; droppedPaths: number } {
  const toilProject = structuredClone(source);
  const hosts: Array<{ area: string; env: string | null; connection: string; host: string }> = [];
  const share = (area: string, env: string | undefined, section: Section) => {
    if (typeof section.connection !== 'string') return;
    const name = section.connection;
    const host = selectorHost(config.connections[name], areas.find((a) => a.name === area)?.siteApis);
    if (!host) {
      throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name}'s ${env ? `${env} ` : ''}${area} section selects connection ${name}, ${config.connections[name] ? 'which has no host to share' : "which isn't one of yours"}.`, {
        fix: `Select it by host instead (toil projects link ${toilProject.name} ${area} --host <host> --replace), or remove the binding.`,
      });
    }
    delete section.connection;
    section.host = host;
    hosts.push({ area, env: env ?? null, connection: name, host });
  };
  for (const [area, section] of Object.entries(toilProject.sections)) share(area, undefined, section);
  for (const [env, byArea] of Object.entries(toilProject.environments)) for (const [area, section] of Object.entries(byArea)) share(area, env, section);
  let droppedPaths = 0;
  toilProject.repos = toilProject.repos.map((r) => {
    if (r.path === undefined) return r;
    droppedPaths++;
    return { name: r.name, remotes: r.remotes };
  });
  return { toilProject, hosts, droppedPaths };
}

/** What an imported toil project names that you don't have: connections and hosts to set up. toil creates none. */
function unresolved(catalog: ToilProjectCatalog, config: ResolvedConfig, toilProject: ToilProject) {
  const out: Array<{ toilProject: string; area: string; env: string | null; connection?: string; host?: string; problem: string }> = [];
  const look = (area: string, env: string | undefined, section: Section) => {
    if (typeof section.connection === 'string' && config.connections[section.connection]?.area !== area) {
      out.push({ toilProject: toilProject.name, area, env: env ?? null, connection: section.connection, problem: `You have no ${area} connection named ${section.connection}: add one with toil connections add ${section.connection} --area ${area}.` });
    }
    if (typeof section.host === 'string') {
      try {
        catalog.binding({ ...toilProject, sections: { [area]: section }, environments: {} }, area, undefined);
      } catch (err) {
        out.push({ toilProject: toilProject.name, area, env: env ?? null, host: section.host, problem: toToilError(err).message });
      }
    }
  };
  for (const [area, section] of Object.entries(toilProject.sections)) look(area, undefined, section);
  for (const [env, byArea] of Object.entries(toilProject.environments)) for (const [area, section] of Object.entries(byArea)) look(area, env, section);
  return out;
}
