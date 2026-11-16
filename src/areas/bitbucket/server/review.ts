import { z } from 'zod';
import { apiPath, rawPath, segments } from '../../../core/api-path.js';
import { allowWriteField } from '../../../core/run.js';
import { bitbucketArea } from '../area.js';
import { bb, buildStatus, currentUser, getPR, IN_REPO, prBuilds, prPath, toInt, where } from './client.js';

/**
 * Reviewing a pull request: its diff and changed files, approving, withdrawing
 * approval, needs-work, reviewers and default-reviewer conditions, and build
 * statuses. Approval is one POST here, which is the shortest approval chain
 * this organisation has on record.
 */

const intText = z.union([z.number(), z.string()]);
const prInput = intText.describe('Pull request ID');
const prArg = { name: 'id', field: 'id', description: 'Pull request ID' };
const example = { project: 'PROJ', repo: 'imagile-api', id: '42' };

export const diffCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'diff'],
  description: 'Get unified diff for a pull request',
  toolDescription:
    "Returns a pull request's diff as data.diff: Bitbucket's JSON diff structure (diffs, hunks, segments) serialized to a string, not unified diff text. file limits it to one path; contextLines sets the lines of context.",
  input: z.object({
    id: prInput,
    path: z.string().optional().describe('Limit diff to a specific file'),
    contextLines: intText.optional().describe('Lines of context around changes'),
  }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  options: [{ flags: '--path <path>', field: 'path', description: 'Limit diff to a specific file', deprecated: ['--file <path>'] }, { flags: '--context-lines <n>', field: 'contextLines', description: 'Lines of context around changes' }],
  examples: [example, { ...example, path: 'src/retry.ts', contextLines: '5' }],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    // The flag's text is read as the contract specifies: any non-empty value, "0" included.
    const contextLines = input.contextLines !== undefined && String(input.contextLines) !== '' ? toInt(input.contextLines) : undefined;
    // The file is a path, not a parameter: each of its segments is encoded on
    // its own, so a # or ? in a file name stays part of the name. The JSON
    // answer is stringified, not turned into a unified diff (#76 item 5).
    const base = `${prPath(project, repo, toInt(input.id))}/diff`;
    const result = await bb<unknown>(ctx, input.path ? apiPath`${rawPath(base)}/${segments(input.path, 'The --path value')}` : base, { query: contextLines !== undefined ? { contextLines } : {} });
    return { diff: typeof result === 'string' ? result : JSON.stringify(result) };
  },
});

export const listFilesCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'files'],
  description: 'List files changed in a pull request',
  toolDescription:
    "Lists the changes in a pull request, from one request of up to 1000. Each entry is the change's path as Bitbucket returns it: a plain string, or else Bitbucket's path object serialized to a JSON string (its toString field holds the path).",
  input: z.object({ id: prInput }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [example],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    // Suspected bugs (#76 items 3 and 4): path objects come back stringified, and only the first page is read.
    const result = await bb<{ values?: Array<{ path: unknown }> }>(ctx, `${prPath(project, repo, toInt(input.id))}/changes`, { query: { limit: 1000 } });
    return (result.values ?? []).map((v) => (typeof v.path === 'string' ? v.path : JSON.stringify(v.path)));
  },
});

export const approveCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'approve'],
  description: 'Approve a pull request',
  toolDescription: "Approves a pull request as the token's user, adding them as a reviewer if they aren't one, and returns Bitbucket's participant record.",
  input: z.object({ id: prInput, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...example, allowWrite: true }],
  // POST /approve needs no user slug, and Bitbucket promotes the caller to reviewer.
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return bb(ctx, `${prPath(project, repo, toInt(input.id))}/approve`, { method: 'POST' });
  },
});

export const unapproveCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'unapprove'],
  description: 'Remove approval from a pull request',
  toolDescription: "Withdraws the token's user's approval of a pull request and returns Bitbucket's participant record.",
  input: z.object({ id: prInput, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...example, allowWrite: true }],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return bb(ctx, `${prPath(project, repo, toInt(input.id))}/approve`, { method: 'DELETE' });
  },
});

export const needsWorkCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'needs-work'],
  // Cloud's word for it.
  aliases: ['request-changes'],
  description: 'Mark a pull request as needs-work',
  toolDescription:
    "Marks a pull request as needs-work for the token's user. Bitbucket allows that only for reviewers, so a user who isn't one is first added as a reviewer; that addition stays even if the status change then fails.",
  input: z.object({ id: prInput, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [
    { ...example, allowWrite: true },
    { ...example, id: '43', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    const prId = toInt(input.id);
    const [user, pr] = await Promise.all([currentUser(ctx), getPR(ctx, project, repo, prId)]);
    // Unlike APPROVED, NEEDS_WORK is refused for a non-reviewer. Suspected bug
    // (#76 item 14): the reviewer added here stays if the PUT then fails.
    if (!(pr.reviewers ?? []).some((r) => r.user.slug === user.slug)) {
      await bb(ctx, `${prPath(project, repo, prId)}/participants`, { method: 'POST', json: { user: { name: user.name }, role: 'REVIEWER' } });
    }
    return bb(ctx, apiPath`${rawPath(prPath(project, repo, prId))}/participants/${user.slug}`, { method: 'PUT', json: { status: 'NEEDS_WORK' } });
  },
});

export const listReviewersCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'reviewers'],
  description: 'List reviewers of a pull request',
  toolDescription: "Lists a pull request's reviewers: each one's user, whether they approved, and their status (APPROVED, NEEDS_WORK or UNAPPROVED).",
  input: z.object({ id: prInput }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [example],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return (await getPR(ctx, project, repo, toInt(input.id))).reviewers;
  },
});

export const listDefaultReviewersCommand = bitbucketArea.command({
  path: ['bitbucket', 'repo', 'default-reviewers'],
  description: 'List the default-reviewer conditions configured for a repository',
  toolDescription: "Lists a repository's default-reviewer conditions: which reviewers Bitbucket adds to pull requests between which branches, and how many approvals each condition needs.",
  input: z.object({}),
  writes: false,
  context: IN_REPO,
  examples: [{ project: 'PROJ', repo: 'imagile-api' }],
  run: async (_input, ctx) => {
    const { project, repo } = where(ctx);
    // A bundled plugin's REST root, beside the core API rather than under it.
    const result = await bb<unknown>(ctx, apiPath`/rest/default-reviewers/1.0/projects/${project}/repos/${repo}/conditions`);
    return Array.isArray(result) ? result : [];
  },
});

export const addReviewerCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'add-reviewer'],
  description: 'Add a reviewer to a pull request',
  toolDescription: "Adds a user, by username, as a reviewer of a pull request and returns Bitbucket's participant record.",
  input: z.object({ id: prInput, user: z.string().describe('Username to add as a reviewer'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [{ flags: '--user <username>', field: 'user', description: 'Username to add as a reviewer' }],
  examples: [{ ...example, user: 'asmith', allowWrite: true }],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return bb(ctx, `${prPath(project, repo, toInt(input.id))}/participants`, { method: 'POST', json: { user: { name: input.user }, role: 'REVIEWER' } });
  },
});

export const listBuildsCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'builds'],
  description: 'List build statuses for a pull request',
  toolDescription: "Lists the build statuses of a pull request's newest commit (one page, at Bitbucket's default size), or [] when it has no commits.",
  input: z.object({ id: prInput }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [example, { ...example, id: '7' }],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return prBuilds(ctx, project, repo, toInt(input.id));
  },
});

export const getBuildStatusCommand = bitbucketArea.command({
  path: ['bitbucket', 'commit', 'status'],
  description: 'Get build status for a commit SHA',
  toolDescription: "Lists the build statuses reported for one commit (one page, at Bitbucket's default size). Still needs a project and repo, though the lookup doesn't use them.",
  input: z.object({ commit: z.string().describe('Commit SHA') }),
  writes: false,
  // Suspected bug (#76 item 11): required, though the endpoint is global.
  context: IN_REPO,
  args: [{ name: 'commit', field: 'commit', description: 'Commit SHA' }],
  examples: [{ project: 'PROJ', repo: 'imagile-api', commit: 'abc12345def67890abc12345def67890abc12345' }],
  run: async (input, ctx) => buildStatus(ctx, input.commit),
});

export const reviewCommands = [
  diffCommand,
  listFilesCommand,
  approveCommand,
  unapproveCommand,
  needsWorkCommand,
  listReviewersCommand,
  listDefaultReviewersCommand,
  addReviewerCommand,
  listBuildsCommand,
  getBuildStatusCommand,
];
