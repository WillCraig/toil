import { apiPath } from '../../core/api-path.js';
import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { githubArea } from './area.js';
import { github, target, type GitHubContext } from './client.js';
import { bodyOf, itemNumber, itemNumberArg, parseIntText } from './input.js';
import { repeatedFlag } from '../../core/schema.js';

/**
 * Repositories, issues, and the labels and assignees GitHub shares between
 * issues and pull requests. A label is the cheapest form of governance, and
 * the hardest to remove.
 */

export const createRepoCommand = githubArea.command({
  path: ['github', 'repo', 'create'],
  description: 'Create a new repository (personal or org)',
  input: z.object({
    name: z.string().describe('Repository name'),
    description: z.string().optional().describe('Repository description'),
    private: z.boolean().optional().describe('Create as a private repository'),
    autoInit: z.boolean().optional().describe('Initialize with a README'),
    ...allowWriteField,
  }),
  writes: true,
  options: [
    { flags: '--name <name>', field: 'name', description: 'Repository name' },
    { flags: '--description <desc>', field: 'description', description: 'Repository description' },
    { flags: '--private', field: 'private', description: 'Create as a private repository' },
    { flags: '--auto-init', field: 'autoInit', description: 'Initialize with a README' },
  ],
  examples: [
    { name: 'toil-probe', allowWrite: true },
    { owner: 'imagile', repo: 'unused', name: 'toil-probe', description: 'A probe', private: true, autoInit: true, allowWrite: true },
  ],
  run: async (input, ctx) => {
    // Only an explicit --owner counts, and always as an org (suspected bug,
    // #72 item 6); the git remote and defaults.github are never read, so the
    // report drops whatever core found there.
    const inputs = ctx.resolved.inputs ?? {};
    const org = inputs.owner?.source === 'input' ? ctx.context.owner : undefined;
    if (inputs.owner?.source !== 'input') delete inputs.owner;
    delete inputs.repo;
    return github(ctx, org ? apiPath`/orgs/${org}/repos` : '/user/repos', {
      method: 'POST',
      json: {
        name: input.name,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.private !== undefined ? { private: input.private } : {}),
        ...(input.autoInit !== undefined ? { auto_init: input.autoInit } : {}),
      },
    });
  },
});

export const createIssueCommand = githubArea.command({
  path: ['github', 'issue', 'create'],
  description: 'Create a GitHub issue',
  input: z.object({
    title: z.string().describe('Issue title'),
    body: z.string().optional().describe('Issue body (markdown)'),
    bodyFile: z.string().optional().describe('Read issue body from a file (use - for stdin); overridden by --body'),
    label: repeatedFlag('Label to apply (repeatable) (default: [])'),
    assignee: repeatedFlag('Assignee login (repeatable) (default: [])'),
    ...allowWriteField,
  }),
  writes: true,
  options: [
    { flags: '--title <title>', field: 'title', description: 'Issue title' },
    { flags: '--body <body>', field: 'body', description: 'Issue body (markdown)' },
    { flags: '--body-file <path>', field: 'bodyFile', description: 'Read issue body from a file (use - for stdin); overridden by --body' },
    { flags: '--label <label>', field: 'label', description: 'Label to apply (repeatable) (default: [])' },
    { flags: '--assignee <login>', field: 'assignee', description: 'Assignee login (repeatable) (default: [])' },
  ],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', title: 'Probe failed', body: 'Details.', label: ['bug', 'area/api'], assignee: ['octo-dev'], allowWrite: true },
    { owner: 'imagile', repo: 'toil-probe', title: 'Probe failed', bodyFile: 'issue-body.md', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    const body = await bodyOf(ctx, input.body, input.bodyFile);
    return github(ctx, apiPath`/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      json: {
        title: input.title,
        ...(body !== undefined ? { body } : {}),
        ...(input.label?.length ? { labels: input.label } : {}),
        ...(input.assignee?.length ? { assignees: input.assignee } : {}),
      },
    });
  },
});

export const addLabelsCommand = githubArea.command({
  path: ['github', 'issue', 'label'],
  // It takes a pull request's number or an issue's, so it is reachable from both.
  aliases: [['github', 'pr', 'label']],
  description: 'Add labels to an issue or pull request',
  input: z.object({ number: itemNumber, label: repeatedFlag('Label to add (repeatable) (default: [])'), ...allowWriteField }),
  writes: true,
  args: [itemNumberArg],
  options: [{ flags: '--label <label>', field: 'label', description: 'Label to add (repeatable) (default: [])' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', label: ['bug', 'needs-review'], allowWrite: true }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    if (!input.label?.length) throw new ToilError('INVALID_INPUT', 'At least one --label is required', { fix: 'Pass --label <label>; repeat it for more than one.' });
    return github(ctx, apiPath`/repos/${owner}/${repo}/issues/${parseIntText(input.number)}/labels`, { method: 'POST', json: { labels: input.label } });
  },
});

export const removeLabelCommand = githubArea.command({
  path: ['github', 'issue', 'unlabel'],
  // It takes a pull request's number or an issue's, so it is reachable from both.
  aliases: [['github', 'pr', 'unlabel']],
  description: 'Remove a label from an issue or pull request',
  input: z.object({ number: itemNumber, label: z.string().describe('Label name to remove'), ...allowWriteField }),
  writes: true,
  // A delete: never served over MCP (CLAUDE.md, Writes).
  mcp: false,
  args: [itemNumberArg],
  options: [{ flags: '--label <label>', field: 'label', description: 'Label name to remove' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', label: 'needs review', allowWrite: true }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    // The label is one path segment, encoded, so `area/api` or `needs-info?`
    // names that label (#72 item 4).
    await github(ctx, apiPath`/repos/${owner}/${repo}/issues/${parseIntText(input.number)}/labels/${input.label}`, { method: 'DELETE' });
    return { removed: true, label: input.label };
  },
});

function assignees(ctx: GitHubContext, number: number | string, assignee: string[] | undefined, method: 'POST' | 'DELETE') {
  const { owner, repo } = target(ctx);
  if (!assignee?.length) throw new ToilError('INVALID_INPUT', 'At least one --assignee is required', { fix: 'Pass --assignee <login>; repeat it for more than one.' });
  return github(ctx, apiPath`/repos/${owner}/${repo}/issues/${parseIntText(number)}/assignees`, { method, json: { assignees: assignee } });
}

export const addAssigneesCommand = githubArea.command({
  path: ['github', 'issue', 'assign'],
  // It takes a pull request's number or an issue's, so it is reachable from both.
  aliases: [['github', 'pr', 'assign']],
  description: 'Add assignees to an issue or pull request',
  input: z.object({ number: itemNumber, assignee: repeatedFlag('Assignee login (repeatable) (default: [])'), ...allowWriteField }),
  writes: true,
  args: [itemNumberArg],
  options: [{ flags: '--assignee <login>', field: 'assignee', description: 'Assignee login (repeatable) (default: [])' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', assignee: ['octo-dev', 'octo-ops'], allowWrite: true }],
  run: async (input, ctx) => assignees(ctx, input.number, input.assignee, 'POST'),
});

export const removeAssigneesCommand = githubArea.command({
  path: ['github', 'issue', 'unassign'],
  // It takes a pull request's number or an issue's, so it is reachable from both.
  aliases: [['github', 'pr', 'unassign']],
  description: 'Remove assignees from an issue or pull request',
  input: z.object({ number: itemNumber, assignee: repeatedFlag('Assignee login to remove (repeatable) (default: [])'), ...allowWriteField }),
  writes: true,
  // A delete: never served over MCP (CLAUDE.md, Writes).
  mcp: false,
  args: [itemNumberArg],
  options: [{ flags: '--assignee <login>', field: 'assignee', description: 'Assignee login to remove (repeatable) (default: [])' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', assignee: ['octo-ops'], allowWrite: true }],
  run: async (input, ctx) => assignees(ctx, input.number, input.assignee, 'DELETE'),
});

/**
 * `issue close` and `issue reopen`: the issue endpoint's own PATCH, the one
 * `pr close` and `pr reopen` send to a pull request's number, because GitHub
 * keeps both on one address. GitHub answers with the issue as `issue get`
 * reads it, so that is `data`. A pull request's number is accepted, as
 * `issue label` accepts it, and closes the pull request, which GitHub treats
 * as an issue with ideas above its station. Merging is `pr merge`, never this.
 *
 * Written from https://docs.github.com/en/rest/issues/issues#update-an-issue
 * (state, state_reason). Run against a real GitHub on 12 November 2026, on a
 * sandbox issue: close without --allow-write was refused, then close (with
 * --reason not-planned) and reopen each answered 200 with the state changed.
 */
function setIssueState(ctx: GitHubContext, number: number | string, state: 'open' | 'closed', stateReason?: 'completed' | 'not_planned') {
  const { owner, repo } = target(ctx);
  return github(ctx, apiPath`/repos/${owner}/${repo}/issues/${parseIntText(number)}`, { method: 'PATCH', json: { state, ...(stateReason !== undefined ? { state_reason: stateReason } : {}) } });
}

const closeReasonText = 'Why it is closed (choices: "completed", "not-planned"; default: left to GitHub, which says completed)';

export const closeIssueCommand = githubArea.command({
  path: ['github', 'issue', 'close'],
  description: "Close an issue (a pull request's number closes the pull request)",
  input: z.object({ number: itemNumber, reason: z.enum(['completed', 'not-planned']).optional().describe(closeReasonText), ...allowWriteField }),
  writes: true,
  args: [itemNumberArg],
  options: [{ flags: '--reason <reason>', field: 'reason', description: closeReasonText }],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '9', allowWrite: true },
    { owner: 'imagile', repo: 'toil-probe', number: '9', reason: 'not-planned', allowWrite: true },
  ],
  run: async (input, ctx) => setIssueState(ctx, input.number, 'closed', input.reason === undefined ? undefined : input.reason === 'not-planned' ? 'not_planned' : 'completed'),
});

export const reopenIssueCommand = githubArea.command({
  path: ['github', 'issue', 'reopen'],
  description: "Reopen a closed issue (a pull request's number reopens the pull request)",
  input: z.object({ number: itemNumber, ...allowWriteField }),
  writes: true,
  args: [itemNumberArg],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '9', allowWrite: true }],
  run: async (input, ctx) => setIssueState(ctx, input.number, 'open'),
});

export const issueCommands = [createRepoCommand, createIssueCommand, addLabelsCommand, removeLabelCommand, addAssigneesCommand, removeAssigneesCommand, closeIssueCommand, reopenIssueCommand];
