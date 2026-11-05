import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import type { CommandContext } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import { forwardSlashes } from '../core/files.js';

/**
 * `toil projects migrate`: moves the `.json` files in `~/.toil/dossiers/` to
 * `~/.toil/projects/`, the folder toil projects live in since they stopped
 * being called dossiers. Nothing else moves and nothing is rewritten: a file's
 * name and content stay exactly as they were, a name already in the new folder
 * is skipped and reported (never overwritten), and a repository's own
 * `.toil/dossiers/` is left for its owners to `git mv`. The old folder is
 * emptied of what moved, not removed; deleting a folder is a memo of its own.
 */
export function toilProjectMigrateCommands(): AnyCommand[] {
  const migrate = defineConfigCommand({
    path: ['projects', 'migrate'],
    description: 'Move your toil projects from the old ~/.toil/dossiers folder to ~/.toil/projects (asks for a yes, or pass --yes)',
    input: z.object({ yes: z.boolean().optional().describe('Move them without asking') }),
    writes: false,
    writesLocal: true,
    // Moves files in the user's own folder, so it is a person's command, as `connections migrate` is.
    kind: 'cli-only',
    options: [{ flags: '--yes', field: 'yes', description: 'Move the files without asking first' }],
    examples: [{}, { yes: true }],
    run: async (input, ctx) => {
      const { catalog, prompt } = access(ctx);
      const { user, userOld } = catalog.places();
      const names = existsSync(userOld) ? readdirSync(userOld).filter((n) => n.toLowerCase().endsWith('.json')).sort() : [];
      const from = forwardSlashes(userOld);
      const to = forwardSlashes(user);
      const found = names.filter((n) => {
        try {
          return lstatSync(join(userOld, n)).isFile();
        } catch {
          return false;
        }
      });
      if (found.length === 0) return { from, to, moved: [], skipped: [], reason: `There are no toil project files in ${from}, so nothing was moved.` };
      if (!input.yes) {
        // Moving a person's files is a person's decision: a terminal asks, anything else must say --yes.
        if (!prompt) {
          throw new ToilError('INVALID_INPUT', `Moving ${found.length} toil project file${found.length === 1 ? '' : 's'} from ${from} to ${to} needs a yes, and this isn't a terminal.`, {
            fix: 'Run it in a terminal and answer yes, or pass --yes.',
          });
        }
        const answer = await prompt.ask(`Move ${found.length} toil project file${found.length === 1 ? '' : 's'} (${found.map((n) => basename(n, '.json')).join(', ')}) from ${from} to ${to}? Type yes to move them`, undefined, 'confirm');
        if (answer.trim().toLowerCase() !== 'yes') throw new ToilError('CANCELLED', `Nothing was moved: ${from} is as it was.`, { fix: 'Run toil projects migrate again and type yes, or pass --yes.' });
      }
      mkdirSync(user, { recursive: true, mode: 0o700 });
      const moved: Array<{ name: string; file: string }> = [];
      const skipped: Array<{ name: string; reason: string }> = [];
      for (const n of found) {
        const name = basename(n, '.json');
        const target = join(user, n);
        if (existsSync(target)) {
          skipped.push({ name, reason: `${to}/${n} already exists, so ${from}/${n} stays where it is` });
          continue;
        }
        renameSync(join(userOld, n), target);
        moved.push({ name, file: forwardSlashes(target) });
      }
      for (const s of skipped) ctx.warn({ code: 'TOIL_PROJECT_MIGRATE_SKIPPED', message: `${s.name} was not moved: ${s.reason}. Compare the two and remove the one you don't want.` });
      return { from, to, moved, skipped };
    },
  });
  return [migrate];
}

function access(ctx: CommandContext<unknown>) {
  const manage = ctx.manage;
  if (!manage?.toilProjects) throw new ToilError('NOT_CONFIGURED', 'Toil projects are not available here.', { fix: 'Run toil projects migrate from the CLI.' });
  return { catalog: manage.toilProjects, prompt: manage.prompt };
}
