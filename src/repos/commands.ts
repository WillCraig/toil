import { z } from 'zod';
import { defineConfigCommand, type AnyCommand } from '../core/command.js';
import { ToilError } from '../core/errors.js';

/**
 * `toil repos scan`: the git repositories under a folder, with each one's
 * branch and remotes, read from `.git` with no git installed. It's discovery
 * for a toil project: an agent scans a product's folder, then adds each repository
 * with `toil projects add-repo`. Local and read only; it contacts nothing and
 * stays inside the workspace. A census of the filing cabinets, taken without
 * opening a single drawer.
 */
export function reposCommands(): AnyCommand[] {
  const scan = defineConfigCommand({
    path: ['repos', 'scan'],
    description: 'List the git repositories under a folder, with their branches and remotes',
    toolDescription:
      "Lists the git repositories under a folder (default: the workspace), each with its root, current branch and remotes (credentials stripped), read from .git with no git installed. Use it to find a product's repositories before adding them to a toil project with projects_add_repo. Walks depth levels of folders (default 3), never follows links, and stays inside the workspace.",
    input: z.object({
      folder: z.string().min(1).optional().describe('The folder to scan; defaults to the workspace'),
      depth: z.number().int().min(0).max(10).optional().describe('How many folder levels below it to look (default 3)'),
    }),
    writes: false,
    writesLocal: false,
    args: [{ name: 'folder', field: 'folder', description: 'The folder to scan (default: the workspace)', required: false }],
    options: [{ flags: '--depth <n>', field: 'depth', description: 'How many folder levels below it to look (default 3)' }],
    examples: [{}, { folder: '.', depth: 1 }],
    run: async (input, ctx) => {
      const catalog = ctx.manage?.toilProjects;
      if (!catalog) throw new ToilError('NOT_CONFIGURED', 'Scanning is not available here.', { fix: 'Run toil repos scan from the CLI or toil mcp.' });
      return catalog.scanRepos(input.folder, input.depth ?? 3);
    },
  });
  return [scan];
}
