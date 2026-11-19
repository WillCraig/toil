import { z } from 'zod';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import { ToilError } from '../core/errors.js';
import { MAX_STANDARDS, standardRefProblem } from '../core/toil-project.js';
import { access, saved } from './build.js';

/**
 * `toil projects standards set`: which ticket rules (standards) a toil
 * project's work is held to. It writes the toil project's `standards` key,
 * which names standards and holds no connection, host or `writes`, so pointing
 * a toil project at a standard changes no rule and an agent may do it over MCP.
 * Removing the key is a delete, which a person does on the CLI. Like every toil
 * project edit it refuses to change a list already set unless `--replace` says
 * to. Amendments to the list are accepted in writing, as is customary.
 */
export function standardsProjectCommands(): AnyCommand[] {
  const set = defineConfigCommand({
    path: ['projects', 'standards', 'set'],
    description: "Set the ticket rules (standards) a toil project's work is held to",
    toolDescription:
      "Sets a toil project's standards key: use, the standards its work items are checked against by standards_check, in order, each a standard name (yours, the repository's or built in: gherkin, user-story, bug-repro) or a path ending .json relative to the toil project's file. At most 20, each once. A list already set is refused unless replace is set, which replaces it whole. The key holds no connection, host or writes. Removing it (clear) is a delete: a person does that on the CLI. A local write: no allowWrite.",
    input: z.object({
      toilProject: z.string().min(1).describe('The toil project to change: a name, or the path to a toil project file'),
      use: z.array(z.string().min(1)).optional().describe("Standards to hold the work to, in order: a name, or a path ending .json relative to the toil project's file"),
      replace: z.boolean().optional().describe('Replace a list that is already set. Without it, a different list already there is refused, naming it.'),
      clear: z.boolean().optional().describe('Remove the standards key, so no standards apply. A delete: CLI only.'),
    }),
    writes: false,
    writesLocal: true,
    offMcpWhen: (input) => (input.clear ? 'Clearing a toil project\'s standards is a delete, which is never served over MCP or the API: a person runs toil projects standards set --clear on the CLI.' : undefined),
    args: [{ name: 'toil-project', field: 'toilProject', description: 'The toil project: a name, or the path to a toil project file' }],
    options: [
      { flags: '--use <standard>', field: 'use', description: 'A standard to hold the work to: a name, or a path ending .json relative to the toil project (repeatable, in order)' },
      { flags: '--replace', field: 'replace', description: 'Replace a list that is already set, rather than refuse' },
      { flags: '--clear', field: 'clear', description: 'Remove the standards key (CLI only)' },
    ],
    examples: [
      { toilProject: 'payments', use: ['gherkin', 'user-story', 'bug-repro'] },
      { toilProject: 'payments', use: ['./team-rules.json', 'gherkin'], replace: true, clear: false },
    ],
    run: async (input, ctx) => {
      if (!input.clear && (input.use === undefined || input.use.length === 0)) {
        throw new ToilError('INVALID_INPUT', 'Name at least one standard with --use, or pass --clear to remove them.', { fix: 'toil projects standards set <toil-project> --use gherkin --use bug-repro.' });
      }
      const { catalog } = access(ctx);
      const file = catalog.find(input.toilProject);
      const toilProject = structuredClone(file.toilProject);
      const before = JSON.stringify(toilProject.standards ?? null);
      let use = input.clear ? [] : [...(toilProject.standards?.use ?? [])];

      if (input.use !== undefined && input.use.length > 0) {
        const wanted = input.use.map((v) => v.trim());
        const seen = new Set<string>();
        for (const ref of wanted) {
          const why = standardRefProblem(ref);
          if (why) throw new ToilError('INVALID_INPUT', `--use ${ref} ${why}`, { fix: 'Name a standard (toil standards list shows them), or a path like ./team-rules.json beside the toil project.' });
          if (seen.has(ref)) throw new ToilError('INVALID_INPUT', `--use ${ref} is given twice.`, { fix: 'Name each standard once.' });
          seen.add(ref);
        }
        if (wanted.length > MAX_STANDARDS) throw new ToilError('INVALID_INPUT', `${wanted.length} standards were given; a toil project names at most ${MAX_STANDARDS}.`, { fix: 'Fold the rules into fewer standards.' });
        if (use.length > 0 && JSON.stringify(use) !== JSON.stringify(wanted) && !input.replace) {
          throw new ToilError('INVALID_INPUT', `Toil project ${toilProject.name}'s standards are already set (${use.join(', ')}).`, { fix: 'Pass --replace to replace the list.' });
        }
        use = wanted;
        // A standard that can't be found yet is worth saying now, not on the first check; it may be a file still to be written.
        const standards = ctx.manage?.standards;
        for (const ref of wanted) {
          try {
            const found = standards?.resolveFromToilProject(ref, file.file);
            for (const w of found?.warnings ?? []) ctx.warn(w);
          } catch (err) {
            if (!(err instanceof ToilError)) throw err;
            ctx.warn({ code: 'STANDARD_UNRESOLVED', message: `Standard "${ref}" isn't readable from here yet: ${err.message}` });
          }
        }
      }

      if (use.length === 0) delete toilProject.standards;
      else toilProject.standards = { use };
      return saved(ctx, catalog, file, toilProject, JSON.stringify(toilProject.standards ?? null) !== before, { standards: toilProject.standards ?? null });
    },
  });
  return [set];
}
