import { apiPath } from '../../core/api-path.js';
import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { githubArea } from './area.js';
import { exampleCursor, github, githubAll, githubList, githubText, target, type GitHubContext } from './client.js';
import { bodyOf, inDateRange, pageFields, pageOptions, parseDateOption, parseIntText, prNumber, prNumberArg, prUpdatedSinceField, prUpdatedSinceOption } from './input.js';
import { checkRunItems } from './status.js';

/**
 * Pull requests themselves: list, read, open, edit, merge, close, reopen, and
 * the diff and file list. `data` is GitHub's answer as it came, apart from
 * `pr list`'s client-side author and date filters, `pr get`'s `included`
 * and `pr diff`'s wrapper.
 * Merging is done by request, like every other approval worth having.
 */

interface PullRequest {
  created_at: string;
  updated_at: string;
  user?: { login?: string };
  head?: { sha?: string };
}

const prPath = (owner: string, repo: string, number: number) => apiPath`/repos/${owner}/${repo}/pulls/${number}`;

export const listPrsCommand = githubArea.command({
  path: ['github', 'pr', 'list'],
  description: 'List pull requests',
  toolDescription:
    'Lists the pull requests in a repository as GitHub returns them. author, createdAfter and createdBefore filter each page as it comes in. updatedSince keeps pull requests updated at or after that instant: toil asks GitHub for the most recently updated first (sort=updated, direction=desc) and stops reading after the page that reaches an older one, for incremental reads. With limit, pass meta.page.nextCursor as cursor for the next page; limit counts the pull requests that pass the filters.',
  input: z.object({
    state: z.enum(['open', 'closed', 'all']).optional().describe('PR state (choices: "open", "closed", "all", default: "open")'),
    head: z.string().optional().describe('Filter by head branch (user:branch)'),
    base: z.string().optional().describe('Filter by base branch'),
    author: z.string().optional().describe('Filter by author login'),
    createdAfter: z.string().optional().describe('Only PRs created on/after this ISO 8601 date (e.g. 2025-01-31)'),
    createdBefore: z.string().optional().describe('Only PRs created before this ISO 8601 date'),
    updatedSince: prUpdatedSinceField,
    ...pageFields('pull requests'),
  }),
  writes: false,
  options: [
    { flags: '--state <state>', field: 'state', description: 'PR state (choices: "open", "closed", "all", default: "open")' },
    { flags: '--head <branch>', field: 'head', description: 'Filter by head branch (user:branch)' },
    { flags: '--base <branch>', field: 'base', description: 'Filter by base branch' },
    { flags: '--author <login>', field: 'author', description: 'Filter by author login' },
    { flags: '--created-after <date>', field: 'createdAfter', description: 'Only PRs created on/after this ISO 8601 date (e.g. 2025-01-31)' },
    { flags: '--created-before <date>', field: 'createdBefore', description: 'Only PRs created before this ISO 8601 date' },
    prUpdatedSinceOption,
    ...pageOptions('pull requests'),
  ],
  examples: [
    { owner: 'imagile', repo: 'toil-probe' },
    { owner: 'imagile', repo: 'toil-probe', state: 'all', head: 'imagile:feature', base: 'main', author: 'OCTO-DEV', createdAfter: '2025-01-01', createdBefore: '2025-02-01T00:00:00Z' },
    { owner: 'imagile', repo: 'toil-probe', limit: 1, cursor: exampleCursor() },
    { owner: 'imagile', repo: 'toil-probe', state: 'all', author: 'octo-dev', updatedSince: '2025-01-16T00:00:00Z', limit: 1 },
  ],
  run: async (input, ctx) => {
    // Dates are checked before anything else, so a bad date fails even with no repo.
    const createdAfter = input.createdAfter ? parseDateOption('--created-after', input.createdAfter) : undefined;
    const createdBefore = input.createdBefore ? parseDateOption('--created-before', input.createdBefore) : undefined;
    const updatedSince = input.updatedSince ? parseDateOption('--updated-since', input.updatedSince).getTime() : undefined;
    const { owner, repo } = target(ctx);
    // The pulls endpoint has no author or date filter, so both apply to each page as it
    // comes in, and --limit counts the pull requests that pass them.
    const author = input.author?.toLowerCase();
    // Nor has it a since. Sorted most recently updated first, the first pull request
    // older than --updated-since means every later page is older too, so paging stops
    // after its page. Without the flag the request stays exactly as it was.
    const newestFirst = updatedSince !== undefined ? { sort: 'updated', direction: 'desc' } : {};
    const fresh = (pr: PullRequest) => updatedSince === undefined || Date.parse(pr.updated_at) >= updatedSince;
    return githubList<PullRequest>(
      ctx,
      apiPath`/repos/${owner}/${repo}/pulls`,
      `GitHub pull requests in ${owner}/${repo}`,
      { state: input.state ?? 'open', ...(input.head ? { head: input.head } : {}), ...(input.base ? { base: input.base } : {}), ...newestFirst },
      {
        limit: input.limit,
        cursor: input.cursor,
        keep: (pr) => (!author || pr.user?.login?.toLowerCase() === author) && inDateRange(Date.parse(pr.created_at), createdAfter, createdBefore) && fresh(pr),
        ...(updatedSince !== undefined ? { stop: (pr: PullRequest) => !fresh(pr) } : {}),
      },
    );
  },
});

/** What `pr get --include` can add, in the order they're read. */
const INCLUDES = ['reviews', 'checks', 'commits', 'files'] as const;
type Include = (typeof INCLUDES)[number];

/**
 * The most GitHub serves of a pull request's commits and files, however it
 * is paged: a list that long may have been cut short, and says so.
 */
const LIST_CAPS: Partial<Record<Include, number>> = { commits: 250, files: 3000 };

/** `--include`: comma-separated, any case, blanks and repeats ignored; an unknown name is refused. */
function parseInclude(value: string | undefined): Include[] {
  if (value === undefined) return [];
  const asked = new Set(value.split(',').map((part) => part.trim().toLowerCase()).filter((part) => part !== ''));
  const unknown = [...asked].filter((part) => !(INCLUDES as readonly string[]).includes(part));
  if (unknown.length > 0) {
    throw new ToilError('INVALID_INPUT', `Unknown --include value ${unknown.map((u) => `"${u}"`).join(', ')}. Use any of ${INCLUDES.join(', ')}.`, {
      fix: `Pass --include as a comma-separated list of ${INCLUDES.join(', ')}, e.g. --include reviews,checks.`,
    });
  }
  return INCLUDES.filter((name) => asked.has(name));
}

/** One included list, every page of it, as GitHub returns it. Checks are the head commit's check runs. */
function includedList(ctx: GitHubContext, owner: string, repo: string, number: number, pr: PullRequest, name: Include): Promise<unknown[]> {
  const path = prPath(owner, repo, number);
  switch (name) {
    case 'reviews':
      return githubAll(ctx, `${path}/reviews`, `reviews on GitHub PR #${number}`);
    case 'checks':
      return githubAll(ctx, apiPath`/repos/${owner}/${repo}/commits/${String(pr.head?.sha)}/check-runs`, `GitHub check runs for PR #${number}`, {}, checkRunItems);
    case 'commits':
      return githubAll(ctx, `${path}/commits`, `commits on GitHub PR #${number}`);
    case 'files':
      return githubAll(ctx, `${path}/files`, `files in GitHub PR #${number}`);
  }
}

const includeDescription = 'Also read these lists into included (comma-separated: reviews, checks, commits, files; one more request each, more to page)';

export const getPrCommand = githubArea.command({
  path: ['github', 'pr', 'get'],
  description: 'Get a pull request by number, optionally with its reviews, checks, commits and files',
  toolDescription:
    "Gets a pull request by number as GitHub returns it. include (comma-separated: reviews, checks, commits, files) adds included, an object holding only the lists asked for, each GitHub's own records with every page read: reviews, checks (the check runs on the head commit, head.sha), commits and files. Each list costs at least one more request. GitHub serves at most 250 commits and 3000 files of a pull request; a list that long gets a GITHUB_LIST_CAPPED warning.",
  input: z.object({ number: prNumber, include: z.string().optional().describe(includeDescription) }),
  writes: false,
  args: [prNumberArg],
  options: [{ flags: '--include <list>', field: 'include', description: includeDescription }],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '7' },
    { owner: 'imagile', repo: 'toil-probe', number: '7', include: 'reviews,checks,commits,files' },
  ],
  run: async (input, ctx) => {
    // Checked before the repo or any request, so a typo costs nothing.
    const include = parseInclude(input.include);
    const { owner, repo } = target(ctx);
    const number = parseIntText(input.number);
    const pr = await github<PullRequest>(ctx, prPath(owner, repo, number));
    if (include.length === 0) return pr;
    // One list after another, so the requests go out in a fixed order.
    const included: Partial<Record<Include, unknown[]>> = {};
    for (const name of include) {
      const list = await includedList(ctx, owner, repo, number, pr, name);
      const cap = LIST_CAPS[name];
      if (cap !== undefined && list.length >= cap) {
        ctx.warn({ code: 'GITHUB_LIST_CAPPED', message: `GitHub serves at most ${cap} ${name} of a pull request, and PR #${number} returned ${list.length}, so included.${name} may be incomplete.` });
      }
      included[name] = list;
    }
    return { ...pr, included };
  },
});

export const createPrCommand = githubArea.command({
  path: ['github', 'pr', 'create'],
  description: 'Create a pull request',
  input: z.object({
    title: z.string().describe('PR title'),
    head: z.string().describe('Source branch (or user:branch for forks)'),
    base: z.string().optional().describe('Target branch (defaults to config or main)'),
    body: z.string().optional().describe('PR description'),
    bodyFile: z.string().optional().describe('Read PR description from a file (use - for stdin); overridden by --body'),
    draft: z.boolean().optional().describe('Create as draft PR'),
    ...allowWriteField,
  }),
  writes: true,
  options: [
    { flags: '--title <title>', field: 'title', description: 'PR title' },
    { flags: '--head <branch>', field: 'head', description: 'Source branch (or user:branch for forks)' },
    { flags: '--base <branch>', field: 'base', description: 'Target branch (defaults to config or main)' },
    { flags: '--body <body>', field: 'body', description: 'PR description' },
    { flags: '--body-file <path>', field: 'bodyFile', description: 'Read PR description from a file (use - for stdin); overridden by --body' },
    { flags: '--draft', field: 'draft', description: 'Create as draft PR' },
    // The same inputs as the group's --owner/--repo, also accepted after the leaf, where they win.
    { flags: '--owner <owner>', field: 'owner', description: 'GitHub owner (overrides parent --owner)' },
    { flags: '--repo <repo>', field: 'repo', description: 'GitHub repository name (overrides parent --repo)' },
  ],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', title: 'Add the probe', head: 'feature', body: 'Adds it.', draft: true, base: 'develop', allowWrite: true },
    { owner: 'imagile', repo: 'toil-probe', title: 'Add the probe', head: 'imagile:feature', bodyFile: 'pr-body.md', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    const base = input.base ?? ctx.connection.targetBranch ?? 'main';
    const body = await bodyOf(ctx, input.body, input.bodyFile);
    return github(ctx, apiPath`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      json: { title: input.title, head: input.head, base, ...(body !== undefined ? { body } : {}), ...(input.draft !== undefined ? { draft: input.draft } : {}) },
    });
  },
});

/** A PATCH of the PR with only the fields given; `{}` when none are. */
function updatePr(ctx: GitHubContext, number: number, fields: { title?: string | undefined; body?: string | undefined; state?: 'open' | 'closed'; base?: string | undefined }) {
  const { owner, repo } = target(ctx);
  const json: Record<string, unknown> = {};
  if (fields.title !== undefined) json.title = fields.title;
  if (fields.body !== undefined) json.body = fields.body;
  if (fields.state !== undefined) json.state = fields.state;
  if (fields.base !== undefined) json.base = fields.base;
  return github(ctx, prPath(owner, repo, number), { method: 'PATCH', json });
}

export const updatePrCommand = githubArea.command({
  path: ['github', 'pr', 'update'],
  description: 'Update a pull request',
  input: z.object({
    number: prNumber,
    title: z.string().optional().describe('New title'),
    body: z.string().optional().describe('New description'),
    base: z.string().optional().describe('New base branch'),
    ...allowWriteField,
  }),
  writes: true,
  args: [prNumberArg],
  options: [
    { flags: '--title <title>', field: 'title', description: 'New title' },
    { flags: '--body <body>', field: 'body', description: 'New description' },
    { flags: '--base <branch>', field: 'base', description: 'New base branch' },
  ],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', title: 'Renamed', body: 'Updated.', base: 'develop', allowWrite: true }],
  run: async (input, ctx) => updatePr(ctx, parseIntText(input.number), { title: input.title, body: input.body, base: input.base }),
});

export const closePrCommand = githubArea.command({
  path: ['github', 'pr', 'close'],
  description: 'Close a pull request',
  input: z.object({ number: prNumber, ...allowWriteField }),
  writes: true,
  args: [prNumberArg],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', allowWrite: true }],
  run: async (input, ctx) => updatePr(ctx, parseIntText(input.number), { state: 'closed' }),
});

export const reopenPrCommand = githubArea.command({
  path: ['github', 'pr', 'reopen'],
  description: 'Reopen a closed pull request',
  input: z.object({ number: prNumber, ...allowWriteField }),
  writes: true,
  args: [prNumberArg],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', allowWrite: true }],
  run: async (input, ctx) => updatePr(ctx, parseIntText(input.number), { state: 'open' }),
});

export const mergePrCommand = githubArea.command({
  path: ['github', 'pr', 'merge'],
  description: 'Merge a pull request (immediate merge — use pr enable-auto-merge for auto-merge)',
  input: z.object({
    number: prNumber,
    method: z.enum(['merge', 'squash', 'rebase']).optional().describe('Merge method (choices: "merge", "squash", "rebase", default: "merge")'),
    commitTitle: z.string().optional().describe('Commit title for merge/squash'),
    commitMessage: z.string().optional().describe('Commit message for merge/squash'),
    ...allowWriteField,
  }),
  writes: true,
  args: [prNumberArg],
  options: [
    { flags: '--method <method>', field: 'method', description: 'Merge method (choices: "merge", "squash", "rebase", default: "merge")' },
    { flags: '--commit-title <title>', field: 'commitTitle', description: 'Commit title for merge/squash' },
    { flags: '--commit-message <msg>', field: 'commitMessage', description: 'Commit message for merge/squash' },
  ],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '7', allowWrite: true },
    { owner: 'imagile', repo: 'toil-probe', number: '7', method: 'squash', commitTitle: 'Add the probe (#7)', commitMessage: 'Squashed.', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    const json: Record<string, unknown> = {};
    if (input.commitTitle) json.commit_title = input.commitTitle;
    if (input.commitMessage) json.commit_message = input.commitMessage;
    // Always sent, defaulting to merge, even on a squash-only repository (suspected bug, #72 item 12).
    json.merge_method = input.method ?? 'merge';
    return github(ctx, `${prPath(owner, repo, parseIntText(input.number))}/merge`, { method: 'PUT', json });
  },
});

export const diffCommand = githubArea.command({
  path: ['github', 'pr', 'diff'],
  description: 'Get unified diff for a pull request',
  input: z.object({ number: prNumber }),
  writes: false,
  args: [prNumberArg],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7' }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    // The PR's own path; the diff media type is what turns it into a diff.
    return { diff: await githubText(ctx, prPath(owner, repo, parseIntText(input.number))) };
  },
});

export const listFilesCommand = githubArea.command({
  path: ['github', 'pr', 'files'],
  description: 'List files changed in a pull request',
  input: z.object({ number: prNumber, ...pageFields('files') }),
  writes: false,
  args: [prNumberArg],
  options: [...pageOptions('files')],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '7' },
    { owner: 'imagile', repo: 'toil-probe', number: '7', limit: 1, cursor: exampleCursor() },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    const number = parseIntText(input.number);
    return githubList(ctx, `${prPath(owner, repo, number)}/files`, `files in GitHub PR #${number}`, {}, { limit: input.limit, cursor: input.cursor });
  },
});

export const prCommands = [listPrsCommand, getPrCommand, createPrCommand, updatePrCommand, mergePrCommand, closePrCommand, reopenPrCommand, diffCommand, listFilesCommand];
