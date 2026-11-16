import { apiPath } from '../../core/api-path.js';
import { z } from 'zod';
import { allowWriteField } from '../../core/run.js';
import { githubArea } from './area.js';
import { exampleCursor, github, githubList, target } from './client.js';
import { intText, itemNumber, itemNumberArg, pageFields, pageOptions, parseIntText, prNumber, prNumberArg } from './input.js';

/**
 * Comments on a pull request: the general ones (issue comments) and the
 * inline ones on the diff (review comments), which GitHub keeps under two
 * different paths. Two filing cabinets for one conversation, each with its
 * own retention policy.
 */

const commentId = intText.describe('Comment ID');

export const listCommentsCommand = githubArea.command({
  path: ['github', 'pr', 'comments'],
  // It takes a pull request's number or an issue's, so it is reachable from both.
  aliases: [['github', 'issue', 'comments']],
  description: 'List general comments on a pull request (or an issue, by its number)',
  input: z.object({ number: itemNumber, ...pageFields('comments') }),
  writes: false,
  args: [itemNumberArg],
  options: [...pageOptions('comments')],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '7' },
    { owner: 'imagile', repo: 'toil-probe', number: '7', limit: 1, cursor: exampleCursor() },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    const number = parseIntText(input.number);
    return githubList(ctx, apiPath`/repos/${owner}/${repo}/issues/${number}/comments`, `comments on GitHub PR #${number}`, {}, { limit: input.limit, cursor: input.cursor });
  },
});

export const addCommentCommand = githubArea.command({
  path: ['github', 'pr', 'comment'],
  // It takes a pull request's number or an issue's, so it is reachable from both.
  aliases: [['github', 'issue', 'comment']],
  description: 'Add a general comment to a pull request (or an issue, by its number)',
  input: z.object({ number: itemNumber, body: z.string().describe('Comment text'), ...allowWriteField }),
  writes: true,
  args: [itemNumberArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', body: 'Looks right.', allowWrite: true }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    return github(ctx, apiPath`/repos/${owner}/${repo}/issues/${parseIntText(input.number)}/comments`, { method: 'POST', json: { body: input.body } });
  },
});

export const listReviewCommentsCommand = githubArea.command({
  path: ['github', 'pr', 'review-comments'],
  description: 'List inline review comments on a pull request',
  input: z.object({ number: prNumber, ...pageFields('review comments') }),
  writes: false,
  args: [prNumberArg],
  options: [...pageOptions('review comments')],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '7' },
    { owner: 'imagile', repo: 'toil-probe', number: '7', limit: 1, cursor: exampleCursor() },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    const number = parseIntText(input.number);
    return githubList(ctx, apiPath`/repos/${owner}/${repo}/pulls/${number}/comments`, `review comments on GitHub PR #${number}`, {}, { limit: input.limit, cursor: input.cursor });
  },
});

export const addInlineCommentCommand = githubArea.command({
  path: ['github', 'pr', 'comment-inline'],
  description: 'Add an inline review comment to a file in a pull request',
  input: z.object({
    number: prNumber,
    commit: z.string().describe('Commit SHA the comment is on'),
    path: z.string().describe('File path'),
    line: intText.describe('Line number'),
    body: z.string().describe('Comment text'),
    side: z.enum(['LEFT', 'RIGHT']).optional().describe('Comment side (choices: "LEFT", "RIGHT", default: "RIGHT")'),
    ...allowWriteField,
  }),
  writes: true,
  args: [prNumberArg],
  options: [
    { flags: '--commit <sha>', field: 'commit', description: 'Commit SHA the comment is on' },
    { flags: '--path <path>', field: 'path', description: 'File path', deprecated: ['--file <path>'] },
    { flags: '--line <n>', field: 'line', description: 'Line number' },
    { flags: '--body <text>', field: 'body', description: 'Comment text' },
    { flags: '--side <side>', field: 'side', description: 'Comment side (choices: "LEFT", "RIGHT", default: "RIGHT")' },
  ],
  examples: [
    { owner: 'imagile', repo: 'toil-probe', number: '7', commit: 'abc1234', path: 'src/probe.ts', line: '12', body: 'Off by one?', allowWrite: true },
    { owner: 'imagile', repo: 'toil-probe', number: '7', commit: 'abc1234', path: 'src/probe.ts', line: 3, body: 'Was this removed on purpose?', side: 'LEFT', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    return github(ctx, apiPath`/repos/${owner}/${repo}/pulls/${parseIntText(input.number)}/comments`, {
      method: 'POST',
      json: { body: input.body, commit_id: input.commit, path: input.path, line: parseIntText(input.line), side: input.side ?? 'RIGHT' },
    });
  },
});

export const replyCommentCommand = githubArea.command({
  path: ['github', 'pr', 'reply'],
  description: 'Reply to a review comment on a pull request',
  input: z.object({ number: prNumber, commentId: intText.describe('Review comment ID to reply to'), body: z.string().describe('Reply text'), ...allowWriteField }),
  writes: true,
  args: [prNumberArg, { name: 'comment-id', field: 'commentId', description: 'Review comment ID to reply to' }],
  options: [{ flags: '--body <text>', field: 'body', description: 'Reply text' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', number: '7', commentId: '501', body: 'Fixed.', allowWrite: true }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    return github(ctx, apiPath`/repos/${owner}/${repo}/pulls/${parseIntText(input.number)}/comments/${parseIntText(input.commentId)}/replies`, { method: 'POST', json: { body: input.body } });
  },
});

export const deleteCommentCommand = githubArea.command({
  path: ['github', 'pr', 'delete-comment'],
  description: 'Delete a general issue comment',
  input: z.object({ commentId: commentId, ...allowWriteField }),
  writes: true,
  // A delete: never served over MCP (CLAUDE.md, Writes).
  mcp: false,
  args: [{ name: 'comment-id', field: 'commentId', description: 'Comment ID' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', commentId: '401', allowWrite: true }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    await github(ctx, apiPath`/repos/${owner}/${repo}/issues/comments/${parseIntText(input.commentId)}`, { method: 'DELETE' });
    return { deleted: true };
  },
});

export const deleteReviewCommentCommand = githubArea.command({
  path: ['github', 'pr', 'delete-review-comment'],
  description: 'Delete an inline review comment',
  input: z.object({ commentId: intText.describe('Review comment ID'), ...allowWriteField }),
  writes: true,
  // A delete: never served over MCP (CLAUDE.md, Writes).
  mcp: false,
  args: [{ name: 'comment-id', field: 'commentId', description: 'Review comment ID' }],
  examples: [{ owner: 'imagile', repo: 'toil-probe', commentId: '501', allowWrite: true }],
  run: async (input, ctx) => {
    const { owner, repo } = target(ctx);
    await github(ctx, apiPath`/repos/${owner}/${repo}/pulls/comments/${parseIntText(input.commentId)}`, { method: 'DELETE' });
    return { deleted: true };
  },
});

export const commentCommands = [listCommentsCommand, addCommentCommand, listReviewCommentsCommand, addInlineCommentCommand, replyCommentCommand, deleteCommentCommand, deleteReviewCommentCommand];
