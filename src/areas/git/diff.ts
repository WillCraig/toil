import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { gitArea } from './area.js';
import { execOutput, requireRepo, runGit, swallowGitFailure } from './runner.js';

/**
 * `git diff`, parsed into files and hunks. Parsing stops after 5,000 lines of
 * git's output, at which point the diff is declared truncated, which is
 * further than most change reviews get.
 */

const DIFF_LINE_LIMIT = 5000;

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface DiffFile {
  path: string;
  binary: boolean;
  truncated: boolean;
  hunks: DiffHunk[];
}

export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
}

function parseHunkHeader(header: string): Omit<DiffHunk, 'lines'> {
  const match = header.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return { oldStart: 0, oldCount: 0, newStart: 0, newCount: 0 };
  return {
    oldStart: parseInt(match[1]!, 10),
    oldCount: parseInt(match[2] ?? '1', 10),
    newStart: parseInt(match[3]!, 10),
    newCount: parseInt(match[4] ?? '1', 10),
  };
}

/**
 * The parser the contract specifies, line for line. The path comes from `diff --git
 * a/(.+) b/.+$`, greedy, so a quoted path, `diff.noprefix`, `diff.mnemonicPrefix`
 * or ` b/` inside a name give a wrong or whole-line path (#74 item 5, pinned).
 * Inside a hunk only `+`, `-` and space lines are kept, which drops `\ No
 * newline at end of file`; the `---`/`+++` headers come before the first `@@`.
 */
export function parseDiff(rawDiff: string): DiffResult {
  const files: DiffFile[] = [];
  let truncated = false;
  let lineCount = 0;
  let currentFile: DiffFile | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const line of rawDiff.split('\n')) {
    lineCount++;
    if (lineCount > DIFF_LINE_LIMIT) {
      truncated = true;
      if (currentFile) currentFile.truncated = true;
      break;
    }
    if (line.startsWith('diff --git ')) {
      if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
      currentHunk = null;
      if (currentFile) files.push(currentFile);
      const pathMatch = line.match(/diff --git a\/(.+) b\/.+$/);
      currentFile = { path: pathMatch ? pathMatch[1]! : line, binary: false, truncated: false, hunks: [] };
      continue;
    }
    if (!currentFile) continue;
    if (line.startsWith('Binary files')) {
      currentFile.binary = true;
      continue;
    }
    if (line.startsWith('@@ ')) {
      if (currentHunk) currentFile.hunks.push(currentHunk);
      currentHunk = { ...parseHunkHeader(line), lines: [] };
      continue;
    }
    if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) currentHunk.lines.push(line);
  }
  if (currentHunk && currentFile) currentFile.hunks.push(currentHunk);
  if (currentFile) files.push(currentFile);
  return { files, truncated };
}

const comparable = (path: string) => {
  const forward = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? forward.toLowerCase() : forward;
};

/**
 * `--file` as the contract specifies it: relative to the repository root,
 * where git runs. toil runs git in the workspace, so from a folder below
 * the root a relative path gets git's `:(top)` magic to keep that meaning.
 */
export function rootRelativePathspec(file: string, root: string, workspace: string | undefined): string {
  if (workspace === undefined || isAbsolute(file) || comparable(workspace) === comparable(root)) return file;
  return `:(top)${file}`;
}

export const diffCommand = gitArea.command({
  path: ['git', 'diff'],
  kind: 'area-local',
  description: 'Show diff as structured JSON',
  toolDescription:
    'The uncommitted changes in the git repository in the workspace (working tree against the index, or the index against HEAD with staged), parsed: { files: [{ path, binary, truncated, hunks: [{ oldStart, oldCount, newStart, newCount, lines }] }], truncated }. Optionally one file, relative to the repository root. Parsing stops after 5,000 lines of output. Runs the git on PATH; a failing git gives an empty result.',
  input: z.object({
    staged: z.boolean().optional().describe('Show staged changes only'),
    path: z.string().optional().describe('Limit diff to a specific file'),
  }),
  writes: false,
  options: [
    { flags: '--staged', field: 'staged', description: 'Show staged changes only' },
    { flags: '--path <path>', field: 'path', description: 'Limit diff to a specific file', deprecated: ['--file <path>'] },
  ],
  examples: [{}, { staged: true, path: 'src/retry.ts' }],
  run: async (input, ctx) => {
    const repo = await requireRepo(ctx);
    const command = ['git diff', ...(input.staged ? ['--staged'] : []), ...(input.path ? ['--', input.path] : [])].join(' ');
    const call = {
      subcommand: 'diff' as const,
      options: input.staged ? ['--staged'] : [],
      ...(input.path ? { paths: [rootRelativePathspec(input.path, repo.root, ctx.files.workspace)] } : {}),
    };
    // Any git failure, and a diff past execSync's 1 MB, is an empty diff with truncated false (#74 items 4 and 9).
    return swallowGitFailure(
      async () => {
        const raw = execOutput(command, await runGit(ctx, call));
        return raw ? parseDiff(raw) : { files: [], truncated: false };
      },
      () => ({ files: [], truncated: false }),
    );
  },
});

export const diffCommands = [diffCommand];
