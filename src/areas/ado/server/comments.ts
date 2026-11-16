import { z } from 'zod';
import { allowWriteField } from '../../../core/run.js';
import { adoArea } from '../area.js';
import { API, ado, enc, repoPath, toInt, where } from './client.js';
import { IN_REPO, prArg } from './repo.js';
import { intText } from './work.js';

/**
 * Pull request comments, which Azure DevOps keeps in threads: list them
 * flattened, start a general or an inline thread, reply, resolve, delete. A
 * thread marked "fixed" is resolved; whether anything was fixed is a matter
 * for the minutes.
 */

const W = { ...IN_REPO, allowWrite: true };
const prInput = intText.describe('Pull request ID');
const threadInput = intText.describe('Thread ID');
const threadArg = { name: 'thread-id', field: 'threadId', description: 'Thread ID' };
const bodyOption = { flags: '--body <text>', field: 'body', description: 'Comment text' };

interface Comment {
  publishedDate: string;
  isDeleted?: boolean;
  [key: string]: unknown;
}

interface Thread {
  id: number;
  isDeleted?: boolean;
  threadContext?: unknown;
  comments: Comment[];
}

/** Every comment of every live thread, with its thread id and context, oldest first. Deleted threads and comments are left out. */
function flatten(threads: Thread[], inlineOnly: boolean, generalOnly: boolean): Array<Comment & { threadId: number; threadContext: unknown }> {
  const flat: Array<Comment & { threadId: number; threadContext: unknown }> = [];
  for (const thread of threads) {
    if (thread.isDeleted) continue;
    if (inlineOnly && !thread.threadContext) continue;
    if (generalOnly && thread.threadContext) continue;
    for (const comment of thread.comments) {
      if (comment.isDeleted) continue;
      flat.push({ ...comment, threadId: thread.id, threadContext: thread.threadContext ?? null });
    }
  }
  return flat.sort((a, b) => a.publishedDate.localeCompare(b.publishedDate));
}

export const repoListCommentsCommand = adoArea.command({
  path: ['ado', 'pr', 'comments'],
  description: 'List all comments on a pull request (general + inline)',
  toolDescription:
    "Lists every comment on a pull request, flattened from its threads and sorted by publishedDate, each with threadId and threadContext (null for a general comment). System comments (votes, status changes) are included. inlineOnly or generalOnly narrows it.",
  input: z.object({ id: prInput, inlineOnly: z.boolean().optional().describe('Return only inline file comments'), generalOnly: z.boolean().optional().describe('Return only general PR comments') }),
  writes: false,
  args: [prArg],
  options: [{ flags: '--inline-only', field: 'inlineOnly', description: 'Return only inline file comments' }, { flags: '--general-only', field: 'generalOnly', description: 'Return only general PR comments' }],
  examples: [
    { ...IN_REPO, id: '42' },
    { ...IN_REPO, id: '42', inlineOnly: true },
    { ...IN_REPO, id: '42', generalOnly: true },
  ],
  run: async (input, ctx) => {
    const result = await ado<{ value?: Thread[] }>(ctx, `${repoPath(where(ctx, true))}/pullrequests/${enc(toInt(input.id))}/threads?api-version=${API}`);
    // Suspected bug (#69 item 22): system comments come through with the rest.
    return flatten(result.value ?? [], input.inlineOnly ?? false, input.generalOnly ?? false);
  },
});

export const repoAddCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'comment'],
  description: 'Add a general comment to a pull request',
  toolDescription: 'Starts an active thread on a pull request with one general comment, and returns the thread.',
  input: z.object({ id: prInput, body: z.string().describe('Comment text'), ...allowWriteField }),
  writes: true,
  args: [prArg],
  options: [bodyOption],
  examples: [{ ...W, id: '42', body: 'Looks good.' }],
  run: async (input, ctx) =>
    ado(ctx, `${repoPath(where(ctx, true))}/pullrequests/${enc(toInt(input.id))}/threads?api-version=${API}`, {
      method: 'POST',
      json: { comments: [{ content: input.body, commentType: 'text' }], status: 'active' },
    }),
});

const LINE_TYPE = 'Line side: left|right (default: right) (default: "right")';

export const repoAddInlineCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'comment-inline'],
  description: 'Add an inline comment on a file in a pull request',
  toolDescription:
    'Starts an active thread on one line of a file in a pull request (the right, new side unless lineType is left) and returns the thread. Give the path as the server shows it, with a leading /.',
  input: z.object({
    id: prInput,
    path: z.string().describe('File path'),
    line: intText.describe('Line number'),
    body: z.string().describe('Comment text'),
    lineType: z.string().optional().describe(LINE_TYPE),
    ...allowWriteField,
  }),
  writes: true,
  args: [prArg],
  options: [
    { flags: '--path <path>', field: 'path', description: 'File path', deprecated: ['--file <path>'] },
    { flags: '--line <n>', field: 'line', description: 'Line number' },
    bodyOption,
    { flags: '--line-type <side>', field: 'lineType', description: LINE_TYPE },
  ],
  examples: [
    { ...W, id: '42', path: '/src/app.ts', line: '12', body: 'Off by one?' },
    { ...W, id: '42', path: 'src/app.ts', line: '3', body: 'Was this removed on purpose?', lineType: 'left' },
  ],
  run: async (input, ctx) => {
    const w = where(ctx, true);
    const line = toInt(input.line);
    // Suspected bug (#69 item 23): the path isn't rooted, and any side but left is right.
    const range =
      (input.lineType ?? 'right') !== 'left'
        ? { rightFileStart: { line, offset: 1 }, rightFileEnd: { line, offset: 1 } }
        : { leftFileStart: { line, offset: 1 }, leftFileEnd: { line, offset: 1 } };
    return ado(ctx, `${repoPath(w)}/pullrequests/${enc(toInt(input.id))}/threads?api-version=${API}`, {
      method: 'POST',
      json: { comments: [{ content: input.body, commentType: 'text' }], status: 'active', threadContext: { filePath: input.path, ...range } },
    });
  },
});

export const repoReplyCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'reply'],
  description: 'Reply to a comment thread',
  toolDescription: 'Adds a reply to a thread on a pull request and returns the new comment. Thread ids come from ado_pr_comments.',
  input: z.object({ id: prInput, threadId: threadInput, body: z.string().describe('Reply text'), ...allowWriteField }),
  writes: true,
  args: [prArg, threadArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Reply text' }],
  examples: [{ ...W, id: '42', threadId: '7', body: 'Fixed in the next commit.' }],
  run: async (input, ctx) =>
    ado(ctx, `${repoPath(where(ctx, true))}/pullrequests/${enc(toInt(input.id))}/threads/${enc(toInt(input.threadId))}/comments?api-version=${API}`, {
      method: 'POST',
      json: { content: input.body, commentType: 'text' },
    }),
});

export const repoResolveCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'resolve'],
  description: 'Mark a comment thread as resolved (fixed)',
  toolDescription: 'Sets a pull request thread\'s status to fixed (resolved) and returns the thread.',
  input: z.object({ id: prInput, threadId: threadInput, ...allowWriteField }),
  writes: true,
  args: [prArg, threadArg],
  examples: [{ ...W, id: '42', threadId: '7' }],
  run: async (input, ctx) =>
    ado(ctx, `${repoPath(where(ctx, true))}/pullrequests/${enc(toInt(input.id))}/threads/${enc(toInt(input.threadId))}?api-version=${API}`, { method: 'PATCH', json: { status: 'fixed' } }),
});

export const repoDeleteCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'delete-comment'],
  description: 'Delete a comment from a thread',
  input: z.object({ id: prInput, threadId: threadInput, commentId: intText.describe('Comment ID'), ...allowWriteField }),
  writes: true,
  // A delete: CLI only, never an MCP tool (CLAUDE.md, Writes).
  mcp: false,
  args: [prArg, threadArg, { name: 'comment-id', field: 'commentId', description: 'Comment ID' }],
  examples: [{ ...W, id: '42', threadId: '7', commentId: '2' }],
  run: async (input, ctx) => {
    await ado<void>(ctx, `${repoPath(where(ctx, true))}/pullrequests/${enc(toInt(input.id))}/threads/${enc(toInt(input.threadId))}/comments/${enc(toInt(input.commentId))}?api-version=${API}`, { method: 'DELETE' });
    return { deleted: true };
  },
});

export const commentCommands = [repoListCommentsCommand, repoAddCommentCommand, repoAddInlineCommentCommand, repoReplyCommentCommand, repoResolveCommentCommand, repoDeleteCommentCommand];
