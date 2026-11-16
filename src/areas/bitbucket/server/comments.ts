import { z } from 'zod';
import { apiPath, rawPath } from '../../../core/api-path.js';
import { allowWriteField } from '../../../core/run.js';
import { bitbucketArea } from '../area.js';
import { bb, bbAll, IN_REPO, prPath, toInt, where } from './client.js';

/**
 * Pull request comments: list them (replies flattened under their parent),
 * add one, add one on a line of a file, reply, resolve a thread, delete. A
 * thread is resolved by its root comment, much as a complaint is closed by
 * whoever filed it, never by whoever answered.
 */

const intText = z.union([z.number(), z.string()]);
const prInput = intText.describe('Pull request ID');
const prArg = { name: 'id', field: 'id', description: 'Pull request ID' };
const commentIdArg = { name: 'comment-id', field: 'commentId', description: 'Comment ID' };
const versionOption = { flags: '--comment-version <n>', field: 'commentVersion', description: 'Comment version, as reported by pr comments (default: "0")' };
const versionInput = intText.optional().describe('Comment version, as reported by pr comments (default: "0")');

export interface BitbucketComment {
  id: number;
  createdDate: number;
  anchor?: unknown;
  comments?: BitbucketComment[];
  parentId?: number;
  [key: string]: unknown;
}

export const listCommentsCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'comments'],
  description: 'List comments on a pull request (includes threaded replies by default)',
  toolDescription:
    'Lists the comments on a pull request, oldest first, with replies flattened into the list and each reply carrying parentId. withReplies false returns top-level comments only, unsorted, with replies still nested; inlineOnly and generalOnly keep only file-anchored or only general comments.',
  input: z.object({
    id: prInput,
    withReplies: z.boolean().optional().describe('Include replies (default true); false returns top-level comments only'),
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
  examples: [
    { project: 'PROJ', repo: 'imagile-api', id: '42' },
    { project: 'PROJ', repo: 'imagile-api', id: '42', inlineOnly: true },
    { project: 'PROJ', repo: 'imagile-api', id: '42', generalOnly: true },
    { project: 'PROJ', repo: 'imagile-api', id: '42', withReplies: false },
  ],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    const prId = toInt(input.id);
    const withReplies = input.withReplies ?? true;
    const activities = await bbAll<{ action: string; comment?: BitbucketComment }>(ctx, `${prPath(project, repo, prId)}/activities`, {}, `Bitbucket activities on pull request ${prId}`);
    // Suspected bug (#76 item 8): every COMMENTED activity counts, whatever its
    // commentAction, so an edited comment or a reply can appear twice.
    const topLevel = activities.filter((a) => a.action === 'COMMENTED' && a.comment).map((a) => a.comment!);
    const keep = (c: BitbucketComment) => (!input.inlineOnly || !!c.anchor) && (!input.generalOnly || !c.anchor);
    if (!withReplies) return topLevel.filter(keep);

    const flatten = (comment: BitbucketComment, parentId?: number): BitbucketComment[] => {
      const node: BitbucketComment = { ...comment, comments: undefined, ...(parentId !== undefined ? { parentId } : {}) };
      return [node, ...(comment.comments ?? []).flatMap((c) => flatten(c, comment.id))];
    };
    return topLevel
      .flatMap((c) => flatten(c))
      .filter(keep)
      .sort((a, b) => a.createdDate - b.createdDate);
  },
});

export const addCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'comment'],
  description: 'Add a comment to a pull request',
  toolDescription: 'Adds a general comment to a pull request and returns it. Use bitbucket_pr_comment_inline for a comment on a line of a file.',
  input: z.object({ id: prInput, body: z.string().describe('Comment text'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text' }],
  examples: [{ project: 'PROJ', repo: 'imagile-api', id: '42', body: 'Looks good to me.', allowWrite: true }],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return bb(ctx, `${prPath(project, repo, toInt(input.id))}/comments`, { method: 'POST', json: { text: input.body } });
  },
});

export const addInlineCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'comment-inline'],
  description: 'Add an inline comment to a file in a pull request',
  toolDescription:
    "Adds a comment on one line of a file in a pull request's diff and returns it. lineType is ADDED (default), REMOVED or CONTEXT; the line is always numbered in the new version of the file.",
  input: z.object({
    id: prInput,
    path: z.string().describe('File path'),
    line: intText.describe('Line number'),
    body: z.string().describe('Comment text'),
    lineType: z.string().optional().describe('Line type: ADDED|REMOVED|CONTEXT (default: "ADDED")'),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--path <path>', field: 'path', description: 'File path', deprecated: ['--file <path>'] },
    { flags: '--line <n>', field: 'line', description: 'Line number' },
    { flags: '--body <text>', field: 'body', description: 'Comment text' },
    { flags: '--line-type <type>', field: 'lineType', description: 'Line type: ADDED|REMOVED|CONTEXT (default: "ADDED")' },
  ],
  examples: [
    { project: 'PROJ', repo: 'imagile-api', id: '42', path: 'src/retry.ts', line: '12', body: 'Cap the backoff?', allowWrite: true },
    { project: 'PROJ', repo: 'imagile-api', id: '42', path: 'src/old.ts', line: 3, body: 'Why was this removed?', lineType: 'REMOVED', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    // Suspected bug (#76 item 7): fileType is TO even for a REMOVED line, which exists only in FROM.
    const anchor = { line: toInt(input.line), lineType: input.lineType ?? 'ADDED', fileType: 'TO', path: input.path };
    return bb(ctx, `${prPath(project, repo, toInt(input.id))}/comments`, { method: 'POST', json: { text: input.body, anchor } });
  },
});

export const replyCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'reply'],
  description: 'Reply to a comment on a pull request',
  toolDescription: 'Replies to a comment on a pull request and returns the reply.',
  input: z.object({ id: prInput, commentId: intText.describe('Comment ID to reply to'), body: z.string().describe('Reply text'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, { name: 'comment-id', field: 'commentId', description: 'Comment ID to reply to' }],
  options: [{ flags: '--body <text>', field: 'body', description: 'Reply text' }],
  examples: [{ project: 'PROJ', repo: 'imagile-api', id: '42', commentId: '1001', body: 'Done.', allowWrite: true }],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    return bb(ctx, `${prPath(project, repo, toInt(input.id))}/comments`, { method: 'POST', json: { text: input.body, parent: { id: toInt(input.commentId) } } });
  },
});

export const resolveCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'resolve'],
  description: 'Resolve a comment thread on a pull request (use the root comment ID, not a reply)',
  toolDescription:
    "Resolves a comment thread on a pull request, given the thread's root comment ID and its current version from bitbucket_pr_comments (default 0). Returns { resolved: true }.",
  input: z.object({ id: prInput, commentId: intText.describe('Comment ID'), commentVersion: versionInput, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, commentIdArg],
  options: [versionOption],
  examples: [
    { project: 'PROJ', repo: 'imagile-api', id: '42', commentId: '1001', allowWrite: true },
    { project: 'PROJ', repo: 'imagile-api', id: '42', commentId: '1001', commentVersion: '2', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    const path = apiPath`${rawPath(prPath(project, repo, toInt(input.id)))}/comments/${toInt(input.commentId)}`;
    await bb(ctx, path, { method: 'PUT', json: { version: toInt(input.commentVersion, '0'), threadResolved: true } });
    return { resolved: true };
  },
});

export const deleteCommentCommand = bitbucketArea.command({
  path: ['bitbucket', 'pr', 'delete-comment'],
  description: 'Delete a comment on a pull request',
  toolDescription: 'Deletes a comment on a pull request at its current version (default 0). Returns { deleted: true }.',
  // Deletes never go through MCP (CLAUDE.md, Writes): the CLI only, behind the write gate.
  mcp: false,
  input: z.object({ id: prInput, commentId: intText.describe('Comment ID'), commentVersion: versionInput, ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, commentIdArg],
  options: [versionOption],
  examples: [
    { project: 'PROJ', repo: 'imagile-api', id: '42', commentId: '1002', allowWrite: true },
    { project: 'PROJ', repo: 'imagile-api', id: '42', commentId: '1002', commentVersion: 1, allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { project, repo } = where(ctx);
    const path = apiPath`${rawPath(prPath(project, repo, toInt(input.id)))}/comments/${toInt(input.commentId)}`;
    await bb(ctx, path, { method: 'DELETE', query: { version: toInt(input.commentVersion, '0') } });
    return { deleted: true };
  },
});

export const commentCommands = [listCommentsCommand, addCommentCommand, addInlineCommentCommand, replyCommentCommand, resolveCommentCommand, deleteCommentCommand];
