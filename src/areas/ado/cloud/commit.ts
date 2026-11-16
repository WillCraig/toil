import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { adoArea } from '../area.js';
import { IN_REPO, adoc, repoPath, type AdoCloudContext } from './client.js';
import { inRepo, ref } from './pull-requests.js';

/**
 * `ado commit create`: one commit of workspace files to a branch, through the
 * Pushes API (REST API 7.1, Git - Pushes - Create), so a repository can be
 * filled with no git on the machine. The branch is moved from the commit it
 * points at now; a branch that doesn't exist yet starts from --from (the
 * repository's default branch without it), and in an empty repository from
 * nothing at all. Each file is sent base64-encoded, as an add where the base
 * has no such path and an edit where it has. The server refuses the push if
 * the branch moved since toil read it, which is the one change-control step
 * here that nobody has to attend.
 */

/** The object id a ref update names for "no such ref yet". */
const ZERO = '0000000000000000000000000000000000000000';

interface Repository {
  defaultBranch?: string;
}

interface GitRef {
  name: string;
  objectId: string;
}

interface GitItem {
  path: string;
  isFolder?: boolean;
}

/** A workspace path as the repository path it is committed at: relative, forward slashes, no `.` or `..` parts. */
function repoFilePath(file: string): string {
  const parts = file.replace(/\\/g, '/').split('/');
  const absolute = file.startsWith('/') || file.startsWith('\\') || /^[A-Za-z]:/.test(file);
  const kept = parts.filter((part) => part !== '' && part !== '.');
  if (absolute || kept.length === 0 || kept.includes('..')) {
    throw new ToilError('INVALID_INPUT', `--input-file "${file}" isn't a relative path inside the workspace.`, {
      fix: 'Name each file relative to the workspace, with no .. parts: it is committed at the same path in the repository (--input-file src/index.js).',
    });
  }
  return kept.join('/');
}

/** The deepest folder holding every path (`src` for `src/a.js` and `src/b/c.js`; empty for the root), so the item listing reads no more of the tree than it must. */
function commonFolder(paths: string[]): string {
  const folders = paths.map((p) => p.split('/').slice(0, -1));
  const shared: string[] = [];
  for (let i = 0; folders.every((f) => i < f.length && f[i] === folders[0]![i]); i++) shared.push(folders[0]![i]!);
  return shared.join('/');
}

/** The commit a branch points at, or undefined when it doesn't exist. `filter` is a prefix match, so the exact name is picked out. */
async function branchHead(ctx: AdoCloudContext, branch: string): Promise<string | undefined> {
  const full = ref(branch);
  const refs = await adoc<{ value?: GitRef[] }>(ctx, `${repoPath(ctx)}/refs`, { query: { filter: full.replace(/^refs\//, '') } });
  return (refs.value ?? []).find((r) => r.name === full)?.objectId;
}

const BRANCH = 'Branch to commit to; created when it does not exist';
const FROM = "Branch a new --branch starts from (default: the repository's default branch)";
const FILE = 'Workspace file to commit, at the same path in the repository (repeatable)';

export const commitCreateCommand = adoArea.command({
  path: ['ado', 'commit', 'create'],
  description: 'Commit workspace files to a branch',
  toolDescription:
    "Commits files from the workspace to a branch in one commit and returns the push (pushId, commits, refUpdates). Each file is committed at the same relative path in the repository, added or replaced. A branch that doesn't exist is created from from (the repository's default branch without it), or, in an empty repository, as its first commit. Needs no git.",
  input: z.object({
    branch: z.string().min(1).describe(BRANCH),
    message: z.string().min(1).describe('Commit message'),
    inputFile: z.array(z.string().min(1)).min(1).describe(FILE),
    from: z.string().min(1).optional().describe(FROM),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  options: [
    { flags: '--branch <name>', field: 'branch', description: BRANCH },
    { flags: '--message <text>', field: 'message', description: 'Commit message' },
    { flags: '--input-file <path>', field: 'inputFile', description: FILE },
    { flags: '--from <branch>', field: 'from', description: FROM },
  ],
  examples: [
    { ...inRepo, allowWrite: true, branch: 'main', message: 'Update the readme', inputFile: ['README.md'] },
    { ...inRepo, allowWrite: true, branch: 'feature/retries', from: 'main', message: 'Add retries', inputFile: ['src/retry.js', 'README.md'] },
  ],
  run: async (input, ctx) => {
    const paths = input.inputFile.map(repoFilePath);
    const twice = paths.find((p, i) => paths.indexOf(p) !== i);
    if (twice) throw new ToilError('INVALID_INPUT', `--input-file names ${twice} more than once.`, { fix: 'Name each file once.' });
    // Read every file before anything is sent, so a missing one stops the commit rather than half of it.
    const contents = await Promise.all(input.inputFile.map(async (file) => Buffer.from(await ctx.files.readBytes(file)).toString('base64')));

    const repo = await adoc<Repository>(ctx, repoPath(ctx));
    let base = await branchHead(ctx, input.branch);
    // The ref update names the commit the branch moves from: its own head, or for a new branch the commit it starts at.
    if (base === undefined) {
      const from = input.from ?? repo.defaultBranch;
      if (from !== undefined) {
        base = await branchHead(ctx, from);
        if (base === undefined && input.from !== undefined) {
          throw new ToilError('NOT_FOUND', `Branch ${input.from} doesn't exist in repository ${ctx.context.repo}, so ${input.branch} can't start from it.`, {
            fix: 'Pass --from with an existing branch, or leave it out to start from the default branch.',
          });
        }
      }
    }

    // What the base already holds decides add or edit: the server refuses an add of a path that exists, and an edit of one that doesn't.
    const existing = new Set<string>();
    if (base !== undefined) {
      const scope = commonFolder(paths);
      try {
        const items = await adoc<{ value?: GitItem[] }>(ctx, `${repoPath(ctx)}/items`, {
          query: { scopePath: `/${scope}`, recursionLevel: 'Full', 'versionDescriptor.version': base, 'versionDescriptor.versionType': 'commit' },
        });
        for (const item of items.value ?? []) if (!item.isFolder) existing.add(item.path);
      } catch (error) {
        // A folder the base doesn't have yet answers 404: nothing in it exists, so every file is an add.
        if (!(scope !== '' && error instanceof ToilError && error.code === 'NOT_FOUND')) throw error;
      }
    }

    const changes = paths.map((path, i) => ({
      changeType: existing.has(`/${path}`) ? 'edit' : 'add',
      item: { path: `/${path}` },
      newContent: { content: contents[i], contentType: 'base64encoded' },
    }));
    return adoc(ctx, `${repoPath(ctx)}/pushes`, {
      method: 'POST',
      json: { refUpdates: [{ name: ref(input.branch), oldObjectId: base ?? ZERO }], commits: [{ comment: input.message, changes }] },
    });
  },
});
