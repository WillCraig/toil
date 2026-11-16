import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { SchemeCatalog } from '../core/classify/catalog.js';
import { diffSchemes } from '../core/classify/scheme.js';
import { SCHEME_NAME, type Scheme } from '../core/classify/types.js';
import type { CommandContext } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import { forwardSlashes } from '../core/files.js';
import { resolveScheme, toilProjectField, toilProjectFor, toilProjectOption } from './run.js';

/**
 * `toil classify scheme list | show | init | export | set | import`: the
 * schemes toil can see, and making, sharing and changing them. A scheme is the
 * rulebook every verdict is held to, so what loosens it is a person's: `set`
 * and `import` are CLI only (a host may run them for a person, `registry.personCommands`),
 * while `init` and `export` only copy a scheme that already exists and so change
 * no rule. A scheme holds no secret, host or `writes`, so none of these needs
 * `--allow-write`, which governs changes to remote systems. Every revision is
 * filed in triplicate by the same process that will later ignore it.
 */
export function classifySchemeCommands(): AnyCommand[] {
  const cwdOption = { flags: '--cwd <dir>', field: 'cwd', description: 'The folder to look from (default: the working directory); its repository decides which checked-in schemes apply' };
  const cwdField = z.string().min(1).optional().describe("The folder to look from; its repository's .toil/classify holds the checked-in schemes that apply. Defaults to the workspace.");
  const replaceOption = { flags: '--replace', field: 'replace', description: 'Replace a scheme that is already there, rather than refuse' };
  const replaceField = z.boolean().optional().describe('Replace a scheme that is already there. Without it, a scheme already there is refused, naming it.');

  const list = defineConfigCommand({
    path: ['classify', 'scheme', 'list'],
    description: 'List every classification scheme toil can see, and where each lives',
    toolDescription:
      "Lists the classification schemes toil can read, each name once from the highest place it is found: your own (~/.toil/classify), the repository the folder is in (.toil/classify), and the two built in (ktlo-feature, the default, and balance). Each has its name, revision, source (user, repo or built-in), file, and its categories with id, short name, name and label. A file that can't be read is a warning naming its key path. Reads local files only.",
    input: z.object({ cwd: cwdField }),
    writes: false,
    writesLocal: false,
    options: [cwdOption],
    examples: [{}, { cwd: '.' }],
    run: async (input, ctx) => {
      const { schemes, warnings } = catalogOf(ctx).list(input.cwd);
      for (const w of warnings) ctx.warn(w);
      return {
        schemes: schemes.map((s) => ({
          name: s.scheme.name,
          revision: s.scheme.revision,
          source: s.source,
          ...(s.file ? { file: s.file } : {}),
          categories: s.scheme.categories.map((c) => ({ id: c.id, short: c.short, name: c.name, label: c.label })),
        })),
      };
    },
  });

  const show = defineConfigCommand({
    path: ['classify', 'scheme', 'show'],
    description: 'Show one classification scheme in full',
    toolDescription:
      'Returns one classification scheme in full: its categories with definitions, guidance, examples, rules, signals and labels, with the source it was found in (file, user, repo, toil-project or built-in) and its file. name is a scheme name (yours, the repository\'s, or built in) or the path to a scheme file. Without name, toilProject names a toil project and the scheme it uses is shown, found the way classify_run finds it (a scheme path beside the toil project file included). Reads local files only.',
    input: z.object({
      name: z.string().min(1).optional().describe('A scheme name, or the path to a scheme file ending in .json. Required unless toilProject is given.'),
      toilProject: toilProjectField,
      cwd: cwdField,
    }),
    writes: false,
    writesLocal: false,
    args: [{ name: 'name', field: 'name', description: 'A scheme name, or the path to a scheme file (omit with --toil-project)', required: false }],
    options: [toilProjectOption, cwdOption],
    examples: [{ name: 'ktlo-feature' }, { name: 'balance', cwd: '.' }, { toilProject: 'payments', cwd: '.' }],
    run: async (input, ctx) => {
      if (input.name === undefined && input.toilProject === undefined) {
        throw new ToilError('INVALID_INPUT', 'Name a scheme, or a toil project whose scheme to show.', { fix: 'toil classify scheme show <name>, or toil classify scheme show --toil-project <name>.' });
      }
      const found = currentScheme(ctx, input);
      for (const w of found.warnings) ctx.warn(w);
      return { scheme: found.scheme, source: found.source, ...(found.file ? { file: found.file } : {}) };
    },
  });

  const init = defineConfigCommand({
    path: ['classify', 'scheme', 'init'],
    description: 'Create a scheme in your own folder (~/.toil/classify) as a copy of another one',
    toolDescription:
      "Creates ~/.toil/classify/<name>.json as a copy of an existing scheme (from: a scheme name or file; default ktlo-feature), with its name set and its revision 1, so a team can adapt the categories, guidance and rules. Copying changes no rule that already exists. Refuses a name already in your folder. A local write: it needs no allowWrite.",
    input: z.object({
      name: z.string().min(1).describe('The new scheme name: lowercase letters, digits and single hyphens, e.g. payments'),
      from: z.string().min(1).optional().describe('The scheme to copy: a scheme name or a file (default ktlo-feature)'),
      cwd: cwdField,
    }),
    writes: false,
    writesLocal: true,
    args: [{ name: 'name', field: 'name', description: 'The new scheme name, e.g. payments' }],
    options: [{ flags: '--from <scheme>', field: 'from', description: 'The scheme to copy: a name or a file (default ktlo-feature)' }, cwdOption],
    examples: [{ name: 'payments' }, { name: 'payments-balance', from: 'balance', cwd: '.' }],
    run: async (input, ctx) => {
      const catalog = catalogOf(ctx);
      const name = validName(input.name);
      const file = catalog.userFile(name);
      if (existsSync(file)) {
        throw new ToilError('INVALID_INPUT', `You already have a scheme named "${name}" (${forwardSlashes(file)}).`, { fix: `Change it with toil classify scheme set ${name} --input-file <path>, or choose another name.` });
      }
      const source = catalog.resolve({ scheme: input.from ?? 'ktlo-feature', cwd: input.cwd });
      for (const w of source.warnings) ctx.warn(w);
      const scheme: Scheme = { ...structuredClone(source.scheme), name, revision: 1 };
      return { name, revision: 1, source: 'user', file: catalog.save(file, scheme, 'create'), copiedFrom: source.scheme.name, scheme };
    },
  });

  const exportCommand = defineConfigCommand({
    path: ['classify', 'scheme', 'export'],
    description: "Write a scheme for sharing: into a repository's .toil/classify, or to one file",
    toolDescription:
      "Writes a scheme for others to use. With repo, it writes <repo>/.toil/classify/<name>.json, where repo must be a working tree's root; with out, it writes that .json file inside the workspace. It never stages or commits. Refuses to overwrite anything but a scheme, and a scheme without replace. A scheme holds no connection, host or secret, so there is nothing to strip.",
    input: z.object({
      name: z.string().min(1).describe('The scheme to export: a name, or the path to a scheme file'),
      repo: z.string().min(1).optional().describe('The root of a working tree to write .toil/classify/<name>.json into'),
      out: z.string().min(1).optional().describe('A .json file to write instead'),
      replace: replaceField,
      cwd: cwdField,
    }),
    writes: false,
    writesLocal: true,
    args: [{ name: 'name', field: 'name', description: 'The scheme to export: a name, or a scheme file' }],
    options: [
      { flags: '--repo <dir>', field: 'repo', description: "A working tree's root; writes .toil/classify/<name>.json there" },
      { flags: '--out <path>', field: 'out', description: 'Write one .json file instead', deprecated: ['--file <path>'] },
      replaceOption,
      cwdOption,
    ],
    examples: [{ name: 'ktlo-feature', out: 'shared/ktlo-feature.json' }, { name: 'balance', repo: '.', replace: true, cwd: '.' }],
    run: async (input, ctx) => {
      const catalog = catalogOf(ctx);
      if ((input.repo === undefined) === (input.out === undefined)) throw new ToilError('INVALID_INPUT', 'Pass exactly one of --repo and --out.', { fix: 'toil classify scheme export <name> --repo <dir>, or --out <path>.' });
      const found = catalog.resolve({ scheme: input.name, cwd: input.cwd });
      for (const w of found.warnings) ctx.warn(w);
      const target = input.repo !== undefined ? join(catalog.repoFolder(input.repo), `${found.scheme.name}.json`) : catalog.pathFor(input.out!, 'The export file');
      const file = catalog.save(target, found.scheme, input.replace ? 'replace' : 'create');
      return { name: found.scheme.name, revision: found.scheme.revision, file, scheme: found.scheme };
    },
  });

  const set = defineConfigCommand({
    path: ['classify', 'scheme', 'set'],
    description: "Change a scheme from a revised file, raising its revision (a person's command)",
    input: z.object({
      name: z.string().min(1).optional().describe('The scheme to change: a name, or the path to a scheme file. Required unless toilProject is given.'),
      inputFile: z.string().min(1).describe('A file holding the revised scheme, inside the workspace'),
      toilProject: toilProjectField,
      cwd: cwdField,
    }),
    writes: false,
    writesLocal: true,
    // The scheme is the rulebook an agent's verdicts are held to, and agents never loosen the rules that constrain them (principle 2).
    kind: 'cli-only',
    args: [{ name: 'name', field: 'name', description: 'The scheme to change: a name, or a scheme file (omit with --toil-project)', required: false }],
    options: [{ flags: '--input-file <path>', field: 'inputFile', description: 'A file holding the revised scheme', deprecated: ['--from <file>'] }, toilProjectOption, cwdOption],
    examples: [{ name: 'team', inputFile: 'schemes/team-v2.json', cwd: '.' }, { name: 'ktlo-feature', inputFile: 'schemes/ktlo-feature-v2.json' }, { toilProject: 'payments', inputFile: 'schemes/team-v2.json', cwd: '.' }],
    run: async (input, ctx) => {
      if (input.name === undefined && input.toilProject === undefined) {
        throw new ToilError('INVALID_INPUT', 'Name the scheme to change, or a toil project whose scheme to change.', { fix: 'toil classify scheme set <name> --input-file <path>, or toil classify scheme set --toil-project <name> --input-file <path>.' });
      }
      const catalog = catalogOf(ctx);
      const current = currentScheme(ctx, input);
      const incoming = catalog.readFile(input.inputFile, input.cwd, current.scheme.name);
      for (const w of [...current.warnings, ...incoming.warnings]) ctx.warn(w);
      if (incoming.scheme.name !== current.scheme.name) {
        throw new ToilError('INVALID_INPUT', `${forwardSlashes(incoming.file!)} holds a scheme named "${incoming.scheme.name}", and ${input.name ?? "the toil project's scheme"} is "${current.scheme.name}".`, {
          fix: `Set "name" to "${current.scheme.name}" in the file, or leave it out; toil classify scheme import brings in a scheme under its own name.`,
        });
      }
      const previousRevision = current.scheme.revision;
      const changes = diffSchemes(current.scheme, incoming.scheme);
      const file = current.file ?? null;
      if (!changes.any) {
        ctx.warn({ code: 'SCHEME_UNCHANGED', message: `${incoming.file ? forwardSlashes(incoming.file) : 'The file'} holds the scheme as it already is, so nothing was written and the revision stays ${previousRevision}.` });
        return { name: current.scheme.name, revision: previousRevision, previousRevision, source: current.source, file, changes };
      }
      // The revision goes up by one whatever the file says: it counts changes, and a file can't skip or repeat one.
      const scheme: Scheme = { ...incoming.scheme, revision: previousRevision + 1 };
      // Written where the scheme lives; a built-in has no file, so its revision lands as a copy in your own folder.
      const written = current.file
        ? catalog.save(current.file, scheme, 'replace', current.source === 'toil-project' || current.source === 'file' ? current.file : undefined)
        : catalog.save(catalog.userFile(scheme.name), scheme, 'create');
      return { name: scheme.name, revision: scheme.revision, previousRevision, source: current.file ? current.source : 'user', file: written, changes };
    },
  });

  const importCommand = defineConfigCommand({
    path: ['classify', 'scheme', 'import'],
    description: "Copy a scheme file into your own folder to adapt it (a person's command)",
    input: z.object({
      file: z.string().min(1).describe('A scheme file, inside the workspace or a scheme folder'),
      name: z.string().min(1).optional().describe('A new name for it'),
      replace: replaceField,
      cwd: cwdField,
    }),
    writes: false,
    writesLocal: true,
    // Bringing a scheme in changes the rulebook a name resolves to, which is a person's decision, as `set` is.
    kind: 'cli-only',
    args: [{ name: 'file', field: 'file', description: 'A scheme file to copy into ~/.toil/classify' }],
    options: [{ flags: '--name <name>', field: 'name', description: 'A new name for it' }, replaceOption, cwdOption],
    examples: [{ file: '.toil/classify/team.json', cwd: '.' }, { file: '.toil/classify/team.json', name: 'team-mine', replace: true }],
    run: async (input, ctx) => {
      const catalog = catalogOf(ctx);
      const found = catalog.readFile(input.file, input.cwd);
      for (const w of found.warnings) ctx.warn(w);
      const name = input.name === undefined ? found.scheme.name : validName(input.name);
      const target = catalog.userFile(name);
      if (found.file && forwardSlashes(target).toLowerCase() === found.file.toLowerCase()) {
        throw new ToilError('INVALID_INPUT', `${forwardSlashes(found.file)} is already in your own folder.`, { fix: 'It is yours already; change it with toil classify scheme set.' });
      }
      const exists = existsSync(target);
      if (exists && !input.replace) {
        throw new ToilError('INVALID_INPUT', `You already have a scheme named "${name}" (${forwardSlashes(target)}). Nothing was imported.`, { fix: 'Pass --replace to replace yours, or --name to import it under another name.' });
      }
      const scheme: Scheme = { ...found.scheme, name };
      return { name, revision: scheme.revision, from: found.file, file: catalog.save(target, scheme, exists ? 'replace' : 'create') };
    },
  });

  return [list, show, init, exportCommand, set, importCommand];
}

/**
 * The scheme a call means: the one `name` names, else the one the toil project uses, found exactly as `classify run`
 * finds it, so a scheme path beside the toil project file is the file that is shown and, for `set`, rewritten in place.
 */
function currentScheme(ctx: CommandContext<unknown>, input: { name?: string | undefined; toilProject?: string | undefined; cwd?: string | undefined }) {
  if (input.name !== undefined) return catalogOf(ctx).resolve({ scheme: input.name, cwd: input.cwd });
  const applied = toilProjectFor(ctx, { toilProject: input.toilProject, cwd: input.cwd });
  return resolveScheme(ctx, { toilProject: input.toilProject, cwd: input.cwd }, applied).found;
}

/** The catalog a scheme command works through, which only config commands are handed. */
function catalogOf(ctx: CommandContext<unknown>): SchemeCatalog {
  if (!ctx.manage) throw new Error('A classify scheme command ran without ctx.manage; define it with defineConfigCommand.');
  if (!ctx.manage.schemes) throw new ToilError('NOT_CONFIGURED', 'Classification schemes are not available here.', { fix: 'Run toil classify from the CLI or toil mcp.' });
  return ctx.manage.schemes;
}

function validName(name: string): string {
  if (!SCHEME_NAME.test(name)) throw new ToilError('INVALID_INPUT', `"${name}" isn't a valid scheme name.`, { fix: 'Use lowercase letters, digits and single hyphens, starting with a letter, e.g. payments.' });
  return name;
}
