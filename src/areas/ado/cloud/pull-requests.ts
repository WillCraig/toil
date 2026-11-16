import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { adoArea } from '../area.js';
import { IN_REPO, adoc, connectionData, cursorField, enc, exampleCursor, headerPages, limitField, nextSkipPages, pageOf, pageOptions, repoPath, skipPages, type AdoCloudContext } from './client.js';
import { wiqlInstant } from './wiql.js';

/**
 * Pull requests: list, read, open, edit, complete and abandon them, and vote
 * on them as the token's own user. Completing a pull request is a request to
 * complete it; policies decide later, the way approvals usually do.
 */

export const inRepo = { project: 'Imagile', repo: 'imagile-api' };
const W = { ...inRepo, allowWrite: true };
const prId = z.number().int().positive().describe('Pull request ID');
export const prArg = { name: 'id', field: 'id', description: 'Pull request ID' };

export interface PullRequest {
  pullRequestId: number;
  sourceRefName?: string;
  lastMergeSourceCommit?: { commitId?: string };
  [key: string]: unknown;
}

export const prPath = (ctx: AdoCloudContext, id: number) => `${repoPath(ctx)}/pullrequests/${enc(id)}`;

export const getPR = (ctx: AdoCloudContext, id: number) => adoc<PullRequest>(ctx, prPath(ctx, id));

/** A branch as a full ref: a short name gets refs/heads/, a full ref is kept as given. */
export const ref = (branch: string) => (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);

const STATES = ['active', 'abandoned', 'completed', 'all'] as const;
const STATE = 'PR state: active|abandoned|completed|all (default: active)';
const PRS_PAGE = 100;
const UPDATED_SINCE =
  'Only PRs still active, or created or closed at or after this ISO 8601 date or zoned date-time (Azure DevOps records no last-updated time on a pull request)';

/**
 * What `--updated-since` keeps. A pull request carries a creationDate and a
 * closedDate and nothing in between, so a vote, a push or a comment leaves no
 * date on it. Every active pull request is kept, since any of those may have
 * happened to it; a closed one is kept when it was created or closed since.
 * The result is a superset of what changed, which a sync merging by id can
 * take without missing an update. A copy of ado's, kept separate as the
 * areas' clients are, so a fix to one variant is a decision about that one.
 */
function updatedSinceKeep(since: string): (pr: { status?: unknown; creationDate?: unknown; closedDate?: unknown }) => boolean {
  const at = Date.parse(since);
  const onOrAfter = (value: unknown) => typeof value === 'string' && Date.parse(value) >= at;
  return (pr) => pr.status === 'active' || onOrAfter(pr.creationDate) || onOrAfter(pr.closedDate);
}

/** What `pr get --include` can add, in the order `included` holds them. */
const PR_INCLUDES = ['reviews', 'checks', 'commits', 'files'] as const;
type PrInclude = (typeof PR_INCLUDES)[number];
const INCLUDE = 'Also read these, comma-separated, into data.included: reviews, checks, commits, files (each costs more requests)';

/** `--include`, read: comma-separated, any case, blanks and repeats ignored, an unknown name refused before anything is sent. */
function parseIncludes(value: string | undefined): PrInclude[] {
  if (value === undefined) return [];
  const asked = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const unknown = asked.filter((name) => !(PR_INCLUDES as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new ToilError('INVALID_INPUT', `Unknown --include value "${unknown[0]}". Allowed: ${PR_INCLUDES.join(', ')}.`, {
      fix: `Pass --include as a comma-separated list of ${PR_INCLUDES.join(', ')}, e.g. --include reviews,checks.`,
    });
  }
  return PR_INCLUDES.filter((name) => asked.includes(name));
}

/**
 * One list of `pr get --include`, every page of it, as Azure DevOps sent it.
 * Reviews are the comment threads, which carry each vote change as a system
 * comment beside the reviewers' own; files are the changes of the iteration
 * with the highest id, the pull request's latest. Each list is filed in
 * triplicate with the server and returned once.
 */
async function prIncluded(ctx: AdoCloudContext, id: number, name: PrInclude): Promise<unknown[]> {
  const base = prPath(ctx, id);
  // Threads, statuses and iterations come whole in one answer; commits and changes page.
  const whole = async <T>(path: string) => (await adoc<{ value?: T[] }>(ctx, path)).value ?? [];
  switch (name) {
    case 'reviews':
      return whole(`${base}/threads`);
    case 'checks':
      return whole(`${base}/statuses`);
    case 'commits':
      return headerPages(ctx, `${base}/commits`, {}, `Azure DevOps commits of pull request ${id}`);
    case 'files': {
      const iterations = await whole<{ id: number }>(`${base}/iterations`);
      if (iterations.length === 0) return [];
      const latest = Math.max(...iterations.map((it) => it.id));
      const entries = (body: unknown) => (body as { changeEntries?: unknown[] } | undefined)?.changeEntries ?? [];
      return nextSkipPages(ctx, `${base}/iterations/${enc(latest)}/changes`, {}, entries, `Azure DevOps changes of pull request ${id}`);
    }
  }
}

export const repoListPrsCommand = adoArea.command({
  path: ['ado', 'pr', 'list'],
  description: 'List pull requests',
  toolDescription:
    'Lists every pull request in the repository in one state (active by default), optionally by creator or reviewer identity id (a GUID, from ado_whoami) and by creation date. updatedSince keeps the pull requests still active plus those created or closed at or after that instant: Azure DevOps records no last-updated time on a pull request, so this is a superset of what changed, safe for a sync that merges by pullRequestId. With limit, returns at most that many (counting kept ones only); pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({
    state: z.enum(STATES).optional().describe(STATE),
    creator: z.string().min(1).optional().describe('Only PRs created by this identity id'),
    reviewer: z.string().min(1).optional().describe('Only PRs with this reviewer identity id'),
    createdAfter: z.string().optional().describe('Only PRs created at or after this ISO 8601 date or zoned date-time'),
    createdBefore: z.string().optional().describe('Only PRs created before this ISO 8601 date or zoned date-time'),
    updatedSince: z.string().optional().describe(UPDATED_SINCE),
    limit: limitField('pull requests'),
    cursor: cursorField,
  }),
  writes: false,
  context: IN_REPO,
  options: [
    { flags: '--state <state>', field: 'state', description: STATE },
    { flags: '--creator <id>', field: 'creator', description: 'Only PRs created by this identity id' },
    { flags: '--reviewer <id>', field: 'reviewer', description: 'Only PRs with this reviewer identity id' },
    { flags: '--created-after <date>', field: 'createdAfter', description: 'Only PRs created at or after this ISO 8601 date or zoned date-time' },
    { flags: '--created-before <date>', field: 'createdBefore', description: 'Only PRs created before this ISO 8601 date or zoned date-time' },
    { flags: '--updated-since <iso>', field: 'updatedSince', description: UPDATED_SINCE },
    ...pageOptions('pull requests'),
  ],
  examples: [
    inRepo,
    { ...inRepo, state: 'all', updatedSince: '2026-09-01T00:00:00Z', limit: 1 },
    { ...inRepo, state: 'all', creator: 'abc12345-0000-0000-0000-000000000000', reviewer: 'abc12345-0000-0000-0000-000000000001', createdAfter: '2026-09-01', createdBefore: '2026-10-01T00:00:00Z' },
    { ...inRepo, limit: 1 },
    { ...inRepo, limit: 1, cursor: exampleCursor('1', PRS_PAGE) },
  ],
  run: (input, ctx) => {
    const page = pageOf(input);
    const after = input.createdAfter !== undefined ? wiqlInstant(input.createdAfter, '--created-after') : undefined;
    const before = input.createdBefore !== undefined ? wiqlInstant(input.createdBefore, '--created-before') : undefined;
    const since = input.updatedSince !== undefined ? wiqlInstant(input.updatedSince, '--updated-since') : undefined;
    const query: Record<string, string | number> = {
      'searchCriteria.status': input.state ?? 'active',
      ...(input.creator ? { 'searchCriteria.creatorId': input.creator } : {}),
      ...(input.reviewer ? { 'searchCriteria.reviewerId': input.reviewer } : {}),
      // minTime and maxTime only count alongside queryTimeRangeType.
      ...(after || before ? { 'searchCriteria.queryTimeRangeType': 'created' } : {}),
      ...(after ? { 'searchCriteria.minTime': after } : {}),
      ...(before ? { 'searchCriteria.maxTime': before } : {}),
    };
    const keep = since !== undefined ? updatedSinceKeep(since) : undefined;
    return skipPages(ctx, `${repoPath(ctx)}/pullrequests`, query, PRS_PAGE, `Azure DevOps pull requests in ${ctx.context.repo}`, page, keep);
  },
});

export const repoGetPrCommand = adoArea.command({
  path: ['ado', 'pr', 'get'],
  description: 'Get a pull request by ID',
  toolDescription:
    "Returns one pull request by id: title, description, status, refs, reviewers and votes, merge commits. include (comma-separated reviews, checks, commits, files) adds data.included holding only the lists asked for, each every page of Azure DevOps' own records: reviews are the comment threads (a vote change is a system comment in a thread whose properties.CodeReviewThreadType is VoteUpdate, beside each reviewer's comments with publishedDate), checks the pull request's statuses, commits its commits, files the changeEntries of its latest iteration. Each list costs one or more extra requests.",
  input: z.object({ id: prId, include: z.string().optional().describe(INCLUDE) }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  options: [{ flags: '--include <list>', field: 'include', description: INCLUDE }],
  examples: [
    { ...inRepo, id: 42 },
    { ...inRepo, id: 42, include: 'reviews,checks,commits,files' },
  ],
  run: async (input, ctx) => {
    const includes = parseIncludes(input.include);
    const pr = await getPR(ctx, input.id);
    if (includes.length === 0) return pr;
    // One list at a time, in a fixed order, so every call sends the same requests in the same order.
    const included: Partial<Record<PrInclude, unknown[]>> = {};
    for (const name of includes) included[name] = await prIncluded(ctx, input.id, name);
    return { ...pr, included };
  },
});

const TARGET = 'Target branch (default: main)';
const WORK_ITEM = 'Work item to link to the pull request (repeatable)';

export const repoCreatePrCommand = adoArea.command({
  path: ['ado', 'pr', 'create'],
  description: 'Create a pull request',
  toolDescription:
    'Opens a pull request from a source branch to a target (main by default) and returns it. A branch name gets refs/heads/; a full ref (refs/...) is sent as given. reviewers are identity ids, comma-separated.',
  input: z.object({
    title: z.string().min(1).describe('PR title'),
    source: z.string().min(1).describe('Source branch'),
    target: z.string().min(1).optional().describe(TARGET),
    description: z.string().optional().describe('PR description (Markdown)'),
    reviewers: z.string().optional().describe('Comma-separated reviewer identity ids'),
    draft: z.boolean().optional().describe('Create as a draft pull request'),
    workItem: z.array(z.number().int().positive()).optional().describe(WORK_ITEM),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  options: [
    { flags: '--title <title>', field: 'title', description: 'PR title' },
    { flags: '--source <branch>', field: 'source', description: 'Source branch' },
    { flags: '--target <branch>', field: 'target', description: TARGET },
    { flags: '--description <text>', field: 'description', description: 'PR description (Markdown)' },
    { flags: '--reviewers <ids>', field: 'reviewers', description: 'Comma-separated reviewer identity ids' },
    { flags: '--draft', field: 'draft', description: 'Create as a draft pull request' },
    { flags: '--work-item <id>', field: 'workItem', description: WORK_ITEM },
  ],
  examples: [
    { ...W, title: 'Add retries', source: 'feature/retries', workItem: [42, 7] },
    { ...W, title: 'Tidy up', source: 'refs/heads/tidy', target: 'develop', description: 'Small things', reviewers: 'abc12345-0000-0000-0000-000000000000, abc12345-0000-0000-0000-000000000001', draft: true },
  ],
  run: (input, ctx) => {
    const reviewers = (input.reviewers ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => ({ id }));
    const body = {
      title: input.title,
      ...(input.description !== undefined ? { description: input.description } : {}),
      sourceRefName: ref(input.source),
      targetRefName: ref(input.target ?? 'main'),
      ...(reviewers.length > 0 ? { reviewers } : {}),
      ...(input.draft !== undefined ? { isDraft: input.draft } : {}),
      // The server links each one to the pull request as it opens it, the same link work-item link --pr adds later.
      ...(input.workItem?.length ? { workItemRefs: input.workItem.map((id) => ({ id: String(id) })) } : {}),
    };
    return adoc(ctx, `${repoPath(ctx)}/pullrequests`, { method: 'POST', json: body });
  },
});

export const repoUpdatePrCommand = adoArea.command({
  path: ['ado', 'pr', 'update'],
  description: 'Update a pull request',
  toolDescription: "Changes a pull request's title, description, target branch or draft state in one PATCH and returns it. Reviewers aren't changed this way; the vote commands set the token's own vote.",
  input: z.object({
    id: prId,
    title: z.string().min(1).optional().describe('New title'),
    description: z.string().optional().describe('New description'),
    target: z.string().min(1).optional().describe('New target branch'),
    draft: z.boolean().optional().describe('Set draft status: true|false'),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--title <title>', field: 'title', description: 'New title' },
    { flags: '--description <text>', field: 'description', description: 'New description' },
    { flags: '--target <branch>', field: 'target', description: 'New target branch' },
    { flags: '--draft <bool>', field: 'draft', description: 'Set draft status: true|false' },
  ],
  examples: [
    { ...W, id: 42, title: 'Add retries, properly' },
    { ...W, id: 42, description: '', target: 'release/1.2', draft: false },
  ],
  run: (input, ctx) => {
    const body = {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.target !== undefined ? { targetRefName: ref(input.target) } : {}),
      ...(input.draft !== undefined ? { isDraft: input.draft } : {}),
    };
    return adoc(ctx, prPath(ctx, input.id), { method: 'PATCH', json: body });
  },
});

const STRATEGIES = ['noFastForward', 'squash', 'rebase', 'rebaseMerge'] as const;
const STRATEGY = 'Merge strategy: noFastForward|squash|rebase|rebaseMerge (default: noFastForward)';

export const repoMergePrCommand = adoArea.command({
  path: ['ado', 'pr', 'merge'],
  description: 'Complete (merge) a pull request',
  toolDescription:
    'Asks the server to complete a pull request with a merge strategy (noFastForward by default), optionally deleting the source branch, and returns the pull request. It reads the pull request first, to send the source commit the completion is for. Completion is asynchronous: check data.status and data.mergeStatus, which stay active and queued while policies or conflicts hold it.',
  input: z.object({
    id: prId,
    strategy: z.enum(STRATEGIES).optional().describe(STRATEGY),
    deleteSource: z.boolean().optional().describe('Delete source branch after merge'),
    message: z.string().optional().describe('Merge commit message'),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--strategy <s>', field: 'strategy', description: STRATEGY },
    { flags: '--delete-source', field: 'deleteSource', description: 'Delete source branch after merge' },
    { flags: '--message <text>', field: 'message', description: 'Merge commit message' },
  ],
  examples: [
    { ...W, id: 42 },
    { ...W, id: 42, strategy: 'squash', deleteSource: true, message: 'Add retries (#42)' },
  ],
  run: async (input, ctx) => {
    const pr = await getPR(ctx, input.id);
    const commitId = pr.lastMergeSourceCommit?.commitId;
    if (!commitId) {
      throw new ToilError('INVALID_INPUT', `Pull request ${input.id} has no source commit to complete yet.`, {
        fix: 'Check data.mergeStatus with ado pr get, and retry once the server has merged the source branch.',
      });
    }
    const body = {
      status: 'completed',
      lastMergeSourceCommit: { commitId },
      completionOptions: { mergeStrategy: input.strategy ?? 'noFastForward', deleteSourceBranch: input.deleteSource ?? false, ...(input.message !== undefined ? { mergeCommitMessage: input.message } : {}) },
    };
    return adoc(ctx, prPath(ctx, input.id), { method: 'PATCH', json: body });
  },
});

export const repoAbandonPrCommand = adoArea.command({
  path: ['ado', 'pr', 'abandon'],
  description: 'Abandon a pull request',
  toolDescription: 'Abandons a pull request and returns it.',
  input: z.object({ id: prId, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...W, id: 42 }],
  run: (input, ctx) => adoc(ctx, prPath(ctx, input.id), { method: 'PATCH', json: { status: 'abandoned' } }),
});

/** A vote cast as the token's own identity, read from connectionData first. */
function voteCommand(name: 'approve' | 'unapprove' | 'wait-for-author', description: string, vote: number, toolDescription: string) {
  return adoArea.command({
    path: ['ado', 'pr', name],
    description,
    toolDescription,
    input: z.object({ id: prId, ...allowWriteField }),
    writes: true,
    context: IN_REPO,
    args: [prArg],
    examples: [{ ...W, id: 42 }],
    run: async (input, ctx) => {
      const me = await connectionData(ctx);
      return adoc(ctx, `${prPath(ctx, input.id)}/reviewers/${enc(me.authenticatedUser.id)}`, { method: 'PUT', json: { vote } });
    },
  });
}

export const repoApproveCommand = voteCommand('approve', 'Approve a pull request', 10, "Votes 10 (approve) on a pull request as the token's own user, and returns the reviewer entry.");
export const repoUnapproveCommand = voteCommand('unapprove', 'Remove your vote from a pull request', 0, "Resets the token's own vote on a pull request to 0 (no vote), and returns the reviewer entry.");
export const repoWaitForAuthorCommand = voteCommand('wait-for-author', 'Mark a pull request as waiting for author', -5, "Votes -5 (waiting for author) on a pull request as the token's own user, and returns the reviewer entry.");

export const repoListReviewersCommand = adoArea.command({
  path: ['ado', 'pr', 'reviewers'],
  description: 'List reviewers on a pull request',
  toolDescription: 'Lists the reviewers on a pull request with their votes (10 approved, 5 with suggestions, 0 none, -5 waiting for author, -10 rejected).',
  input: z.object({ id: prId }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...inRepo, id: 42 }],
  run: async (input, ctx) => (await adoc<{ value?: unknown[] }>(ctx, `${prPath(ctx, input.id)}/reviewers`)).value ?? [],
});

export const pullRequestCommands = [
  repoListPrsCommand,
  repoGetPrCommand,
  repoCreatePrCommand,
  repoUpdatePrCommand,
  repoMergePrCommand,
  repoAbandonPrCommand,
  repoListReviewersCommand,
  repoApproveCommand,
  repoUnapproveCommand,
  repoWaitForAuthorCommand,
];
