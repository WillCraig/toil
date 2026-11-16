import { z } from 'zod';
import { allowWriteField } from '../../../core/run.js';
import { bitbucketArea } from '../area.js';
import { all, bbc, IN_REPO, prPath } from './client.js';

/**
 * Pull request comments: list them, add one, add one on a line of a file,
 * reply, resolve a thread, delete. Cloud lists replies beside their parents
 * with a `parent` pointer, so the thread is already flat, the way a complaint
 * log is once nobody remembers which complaint started it.
 */

const pr = z.number().int().positive().describe('Pull request ID');
const prArg = { name: 'id', field: 'id', description: 'Pull request ID' };
const commentId = z.number().int().positive().describe('Comment ID');
const commentIdArg = { name: 'comment-id', field: 'commentId', description: 'Comment ID' };
const at = { workspace: 'imagile', repo: 'toil', id: 42 };

export interface Comment {
  id: number;
  created_on?: string;
  parent?: { id?: number };
  inline?: { path?: string; from?: number | null; to?: number | null };
  [key: string]: unknown;
}

export const listCommentsCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'comments'],
  description: 'List comments on a pull request (includes threaded replies by default)',
  toolDescription:
    'Lists the comments on a pull request, oldest first, replies included, each reply carrying parent.id and each inline comment carrying inline (path, from, to). withReplies false keeps top-level comments only; inlineOnly and generalOnly keep only file-anchored or only general comments.',
  input: z.object({
    id: pr,
    withReplies: z.boolean().default(true).describe('Include replies (default true); false returns top-level comments only'),
    inlineOnly: z.boolean().optional().describe('Return only inline file comments'),
    generalOnly: z.boolean().optional().describe('Return only general (non-inline) PR comments'),
  }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--no-with-replies', field: 'withReplies', description: 'Exclude replies; return top-level comments only' },
    { flags: '--inline-only', field: 'inlineOnly', description: 'Return only inline file comments' },
    { flags: '--general-only', field: 'generalOnly', description: 'Return only general (non-inline) PR comments' },
  ],
  examples: [at, { ...at, inlineOnly: true }, { ...at, generalOnly: true, withReplies: false }],
  run: async (input, ctx) => {
    const comments = await all<Comment>(ctx, `Bitbucket Cloud comments on pull request ${input.id}`, `${prPath(ctx, input.id)}/comments`, { sort: 'created_on' });
    return comments.filter((c) => (input.withReplies || !c.parent) && (!input.inlineOnly || !!c.inline) && (!input.generalOnly || !c.inline));
  },
});

export const addCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'comment'],
  description: 'Add a comment to a pull request',
  toolDescription: 'Adds a general comment (Markdown) to a pull request and returns it. Use bitbucket_pr_comment_inline for a comment on a line of a file.',
  input: z.object({ id: pr, body: z.string().min(1).describe('Comment text (Markdown)'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text (Markdown)' }],
  examples: [{ ...at, body: 'Looks good to me.', allowWrite: true }],
  run: (input, ctx) => bbc(ctx, `${prPath(ctx, input.id)}/comments`, { method: 'POST', json: { content: { raw: input.body } } }),
});

export const addInlineCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'comment-inline'],
  description: 'Add an inline comment to a file in a pull request',
  toolDescription:
    "Adds a comment on one line of a file in a pull request's diff and returns it. lineType ADDED (default) or CONTEXT numbers the line in the new version of the file; REMOVED numbers it in the old version.",
  input: z.object({
    id: pr,
    path: z.string().min(1).describe('File path'),
    line: z.number().int().positive().describe('Line number'),
    body: z.string().min(1).describe('Comment text (Markdown)'),
    lineType: z.enum(['ADDED', 'REMOVED', 'CONTEXT']).optional().describe('Line type: ADDED|REMOVED|CONTEXT (default: "ADDED")'),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--path <path>', field: 'path', description: 'File path', deprecated: ['--file <path>'] },
    { flags: '--line <n>', field: 'line', description: 'Line number' },
    { flags: '--body <text>', field: 'body', description: 'Comment text (Markdown)' },
    { flags: '--line-type <type>', field: 'lineType', description: 'Line type: ADDED|REMOVED|CONTEXT (default: "ADDED")' },
  ],
  examples: [
    { ...at, path: 'src/retry.ts', line: 12, body: 'Cap the backoff?', allowWrite: true },
    { ...at, path: 'src/old.ts', line: 3, body: 'Why was this removed?', lineType: 'REMOVED', allowWrite: true },
  ],
  run: (input, ctx) => {
    // `to` is a line of the new file, `from` one of the old: a removed line exists only in the old.
    const inline = input.lineType === 'REMOVED' ? { path: input.path, from: input.line } : { path: input.path, to: input.line };
    return bbc(ctx, `${prPath(ctx, input.id)}/comments`, { method: 'POST', json: { content: { raw: input.body }, inline } });
  },
});

export const replyCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'reply'],
  description: 'Reply to a comment on a pull request',
  toolDescription: 'Replies to a comment on a pull request and returns the reply.',
  input: z.object({ id: pr, commentId: commentId.describe('Comment ID to reply to'), body: z.string().min(1).describe('Reply text (Markdown)'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, { name: 'comment-id', field: 'commentId', description: 'Comment ID to reply to' }],
  options: [{ flags: '--body <text>', field: 'body', description: 'Reply text (Markdown)' }],
  examples: [{ ...at, commentId: 1001, body: 'Done.', allowWrite: true }],
  run: (input, ctx) => bbc(ctx, `${prPath(ctx, input.id)}/comments`, { method: 'POST', json: { content: { raw: input.body }, parent: { id: input.commentId } } }),
});

export const resolveCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'resolve'],
  description: 'Resolve a comment thread on a pull request (use the root comment ID, not a reply)',
  toolDescription: "Resolves a comment thread on a pull request, given the thread's root comment ID, and returns Bitbucket's resolution record. A thread that is already resolved is an HTTP 409.",
  input: z.object({ id: pr, commentId, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, commentIdArg],
  examples: [{ ...at, commentId: 1001, allowWrite: true }],
  run: (input, ctx) => bbc(ctx, `${prPath(ctx, input.id)}/comments/${input.commentId}/resolve`, { method: 'POST' }),
});

export const deleteCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'delete-comment'],
  description: 'Delete a comment on a pull request',
  toolDescription: 'Deletes a comment on a pull request. Returns { deleted: true }.',
  // Deletes never go through MCP (CLAUDE.md, Writes): the CLI only, behind the write gate.
  mcp: false,
  input: z.object({ id: pr, commentId, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, commentIdArg],
  examples: [{ ...at, commentId: 1002, allowWrite: true }],
  run: async (input, ctx) => {
    await bbc(ctx, `${prPath(ctx, input.id)}/comments/${input.commentId}`, { method: 'DELETE' });
    return { deleted: true };
  },
});

export const commentCommands = [listCommentsCommand, addCommentCommand, addInlineCommentCommand, replyCommentCommand, resolveCommentCommand, deleteCommentCommand];
