import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { bitbucketArea } from '../area.js';
import { all, bbc, getPR, IN_REPO, prPath, prSpec, repoPath, seg } from './client.js';

/**
 * Reviewing a pull request: its diff and changed files, approving,
 * withdrawing approval, requesting changes, its reviewers, the repository's
 * default reviewers, and build statuses. Requesting changes is a single POST,
 * which is the only form in the building that takes one step to send back.
 */

const pr = z.number().int().positive().describe('Pull request ID');
const prArg = { name: 'id', field: 'id', description: 'Pull request ID' };
const at = { workspace: 'imagile', repo: 'toil' };
const example = { ...at, id: 42 };

export const diffCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'diff'],
  description: 'Get the unified diff of a pull request or a commit spec',
  toolDescription:
    "Returns { diff }: unified git diff text, for a pull request (id: its changes against the target, as Bitbucket shows them) or a commit spec (one commit against its first parent, or a..b). file limits it to one path; contextLines sets the lines of context.",
  input: z.object({
    id: pr.optional(),
    spec: z.string().min(1).optional().describe('A commit, or two as a..b, instead of a pull request'),
    path: z.string().min(1).optional().describe('Limit diff to a specific file'),
    contextLines: z.number().int().nonnegative().optional().describe('Lines of context around changes'),
  }),
  writes: false,
  context: IN_REPO,
  // The id is optional here: --spec diffs commits instead of a pull request.
  args: [{ ...prArg, required: false }],
  options: [
    { flags: '--spec <a..b>', field: 'spec', description: 'A commit, or two as a..b, instead of a pull request' },
    { flags: '--path <path>', field: 'path', description: 'Limit diff to a specific file', deprecated: ['--file <path>'] },
    { flags: '--context-lines <n>', field: 'contextLines', description: 'Lines of context around changes' },
  ],
  examples: [example, { ...at, spec: 'abc12345def67890abc12345def67890abc12345', path: 'src/retry.ts', contextLines: 0 }],
  run: async (input, ctx) => {
    if ((input.id === undefined) === (input.spec === undefined)) {
      throw new ToilError('INVALID_INPUT', 'Pass exactly one of a pull request id and --spec.', { fix: 'Use pr diff <id> for a pull request, or pr diff --spec <commit> (or <a>..<b>) for commits.' });
    }
    const spec = input.spec ?? prSpec(await getPR(ctx, input.id!));
    const query = { ...(input.id !== undefined ? { topic: true } : {}), ...(input.path ? { path: input.path } : {}), ...(input.contextLines !== undefined ? { context: input.contextLines } : {}) };
    return { diff: await bbc<string>(ctx, `${repoPath(ctx)}/diff/${seg(spec)}`, { query, as: 'text' }) };
  },
});

interface Diffstat {
  status?: string;
  old?: { path?: string } | null;
  new?: { path?: string } | null;
}

export const listFilesCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'files'],
  description: 'List files changed in a pull request',
  toolDescription: "Lists the paths a pull request changes, as strings: each change's new path, or its old path for a deletion. Every page of Bitbucket's diffstat is read.",
  input: z.object({ id: pr }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [example],
  run: async (input, ctx) => {
    const spec = prSpec(await getPR(ctx, input.id));
    const stats = await all<Diffstat>(ctx, `Bitbucket Cloud files changed in pull request ${input.id}`, `${repoPath(ctx)}/diffstat/${seg(spec)}`, { topic: true });
    return stats.flatMap((s) => {
      const path = s.new?.path ?? s.old?.path;
      return path ? [path] : [];
    });
  },
});

export const approveCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'approve'],
  description: 'Approve a pull request',
  toolDescription: "Approves a pull request as the credential's user and returns Bitbucket's participant record.",
  input: z.object({ id: pr, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...example, allowWrite: true }],
  run: (input, ctx) => bbc(ctx, `${prPath(ctx, input.id)}/approve`, { method: 'POST' }),
});

export const unapproveCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'unapprove'],
  description: 'Remove approval from a pull request',
  toolDescription: "Withdraws the credential's user's approval of a pull request. Returns { unapproved: true }.",
  input: z.object({ id: pr, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...example, allowWrite: true }],
  run: async (input, ctx) => {
    await bbc(ctx, `${prPath(ctx, input.id)}/approve`, { method: 'DELETE' });
    return { unapproved: true };
  },
});

export const requestChangesCommand = bitbucketArea.command({
  // Data Center's needs-work: one idea, one path, and the other deployment's word for it is an alias.
  path: ['bitbucket', 'pr', 'needs-work'],
  aliases: ['request-changes'],
  description: 'Request changes on a pull request',
  toolDescription: "Marks a pull request as changes requested by the credential's user (Data Center calls this needs-work) and returns Bitbucket's participant record.",
  input: z.object({ id: pr, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...example, allowWrite: true }],
  run: (input, ctx) => bbc(ctx, `${prPath(ctx, input.id)}/request-changes`, { method: 'POST' }),
});

export const listReviewersCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'reviewers'],
  description: 'List reviewers of a pull request',
  toolDescription: "Lists a pull request's reviewers as participants: each one's user, approved, and state (approved, changes_requested or null).",
  input: z.object({ id: pr }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [example],
  run: async (input, ctx) => ((await getPR(ctx, input.id)).participants ?? []).filter((p) => p.role === 'REVIEWER'),
});

export const listDefaultReviewersCommand = bitbucketArea.command({
  path: ['bitbucket', 'repo', 'default-reviewers'],
  description: "List the repository's default reviewers",
  toolDescription: "Lists the users Bitbucket Cloud adds as reviewers to every new pull request in the repository (the repository's own list, not those inherited from its project).",
  input: z.object({}),
  writes: false,
  context: IN_REPO,
  examples: [at],
  run: (_input, ctx) => all(ctx, `Bitbucket Cloud default reviewers of ${ctx.context.workspace}/${ctx.context.repo}`, `${repoPath(ctx)}/default-reviewers`),
});

export const listBuildsCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'builds'],
  description: 'List build statuses for a pull request',
  toolDescription: "Lists every build status reported on a pull request's commits (key, name, state, url, description, created_on, updated_on).",
  input: z.object({ id: pr }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [example],
  run: (input, ctx) => all(ctx, `Bitbucket Cloud build statuses on pull request ${input.id}`, `${prPath(ctx, input.id)}/statuses`),
});

export const getBuildStatusCommand = bitbucketArea.command({
  path: ['bitbucket', 'commit', 'status'],
  description: 'Get build statuses for a commit SHA',
  toolDescription: 'Lists every build status reported for one commit (key, name, state, url, description, created_on, updated_on).',
  input: z.object({ commit: z.string().min(1).describe('Commit SHA') }),
  writes: false,
  context: IN_REPO,
  args: [{ name: 'commit', field: 'commit', description: 'Commit SHA' }],
  examples: [{ ...at, commit: 'abc12345def67890abc12345def67890abc12345' }],
  run: (input, ctx) => all(ctx, `Bitbucket Cloud build statuses on commit ${input.commit}`, `${repoPath(ctx)}/commit/${seg(input.commit)}/statuses`),
});

export const reviewCommands = [diffCommand, listFilesCommand, approveCommand, unapproveCommand, requestChangesCommand, listReviewersCommand, listDefaultReviewersCommand, listBuildsCommand, getBuildStatusCommand];
