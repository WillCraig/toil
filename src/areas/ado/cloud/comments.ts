import { z } from 'zod';
import { allowWriteField } from '../../../core/run.js';
import { adoArea } from '../area.js';
import { IN_REPO, adoc, enc } from './client.js';
import { inRepo, prArg, prPath } from './pull-requests.js';

/**
 * Pull request comments, which Azure DevOps keeps in threads: read the
 * threads as they are or flattened into comments, start one, reply, and
 * resolve it. A thread marked "fixed" is resolved; whether anything was
 * fixed is a matter for the minutes.
 */

const W = { ...inRepo, allowWrite: true };
const prId = z.number().int().positive().describe('Pull request ID');
const threadId = z.number().int().positive().describe('Thread ID');
const threadArg = { name: 'thread-id', field: 'threadId', description: 'Thread ID' };

interface Comment {
  publishedDate?: string;
  isDeleted?: boolean;
  commentType?: string;
  [key: string]: unknown;
}

interface Thread {
  id: number;
  isDeleted?: boolean;
  threadContext?: unknown;
  comments?: Comment[];
  [key: string]: unknown;
}

const threadsOf = async (ctx: Parameters<typeof prPath>[0], pr: number) => (await adoc<{ value?: Thread[] }>(ctx, `${prPath(ctx, pr)}/threads`)).value ?? [];

export const repoListThreadsCommand = adoArea.command({
  path: ['ado', 'pr', 'threads'],
  description: 'List comment threads on a pull request',
  toolDescription:
    "Lists a pull request's comment threads as the server returns them (id, status, threadContext with the file and lines for an inline thread, comments), deleted ones left out. System threads (votes, pushes) are included; their comments have commentType system.",
  input: z.object({ id: prId }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  examples: [{ ...inRepo, id: 42 }],
  run: async (input, ctx) => (await threadsOf(ctx, input.id)).filter((t) => !t.isDeleted),
});

export const repoListCommentsCommand = adoArea.command({
  path: ['ado', 'pr', 'comments'],
  description: 'List all comments on a pull request (general + inline)',
  toolDescription:
    'Lists every comment on a pull request, flattened from its threads and sorted by publishedDate, each with threadId and threadContext (null for a general comment). Deleted threads and comments are left out; system comments are left out unless includeSystem. inlineOnly or generalOnly narrows it.',
  input: z.object({
    id: prId,
    inlineOnly: z.boolean().optional().describe('Return only inline file comments'),
    generalOnly: z.boolean().optional().describe('Return only general PR comments'),
    includeSystem: z.boolean().optional().describe('Include system comments (votes, pushes, status changes)'),
  }),
  writes: false,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--inline-only', field: 'inlineOnly', description: 'Return only inline file comments' },
    { flags: '--general-only', field: 'generalOnly', description: 'Return only general PR comments' },
    { flags: '--include-system', field: 'includeSystem', description: 'Include system comments (votes, pushes, status changes)' },
  ],
  examples: [
    { ...inRepo, id: 42 },
    { ...inRepo, id: 42, inlineOnly: true },
    { ...inRepo, id: 42, generalOnly: true, includeSystem: true },
  ],
  run: async (input, ctx) => {
    const flat: Array<Comment & { threadId: number; threadContext: unknown }> = [];
    for (const thread of await threadsOf(ctx, input.id)) {
      if (thread.isDeleted) continue;
      if (input.inlineOnly && !thread.threadContext) continue;
      if (input.generalOnly && thread.threadContext) continue;
      for (const comment of thread.comments ?? []) {
        if (comment.isDeleted) continue;
        if (!input.includeSystem && comment.commentType === 'system') continue;
        flat.push({ ...comment, threadId: thread.id, threadContext: thread.threadContext ?? null });
      }
    }
    return flat.sort((a, b) => (a.publishedDate ?? '').localeCompare(b.publishedDate ?? ''));
  },
});

const LINE_TYPES = ['left', 'right'] as const;
const LINE_TYPE = 'Line side: left|right (default: right)';

/** A new active thread with one comment, general or (with a threadContext) inline. */
const startThread = (ctx: Parameters<typeof prPath>[0], pr: number, body: string, threadContext?: Record<string, unknown>) =>
  adoc(ctx, `${prPath(ctx, pr)}/threads`, {
    method: 'POST',
    json: { comments: [{ parentCommentId: 0, content: body, commentType: 'text' }], status: 'active', ...(threadContext ? { threadContext } : {}) },
  });

export const repoAddCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'comment'],
  description: 'Add a general comment to a pull request',
  toolDescription: 'Starts an active thread on a pull request with one general comment, and returns the thread.',
  input: z.object({ id: prId, body: z.string().min(1).describe('Comment text (Markdown)'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Comment text (Markdown)' }],
  examples: [{ ...W, id: 42, body: 'Looks good.' }],
  run: (input, ctx) => startThread(ctx, input.id, input.body),
});

export const repoAddInlineCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'comment-inline'],
  description: 'Add an inline comment on a file in a pull request',
  toolDescription:
    'Starts an active thread on one line of a file in a pull request (the right, new side unless lineType is left) and returns the thread. Give the path from the repository root, with or without a leading / (toil adds it).',
  input: z.object({
    id: prId,
    path: z.string().min(1).describe('File path'),
    line: z.number().int().positive().describe('Line number'),
    body: z.string().min(1).describe('Comment text (Markdown)'),
    lineType: z.enum(LINE_TYPES).optional().describe(LINE_TYPE),
    ...allowWriteField,
  }),
  writes: true,
  context: IN_REPO,
  args: [prArg],
  options: [
    { flags: '--path <path>', field: 'path', description: 'File path', deprecated: ['--file <path>'] },
    { flags: '--line <n>', field: 'line', description: 'Line number' },
    { flags: '--body <text>', field: 'body', description: 'Comment text (Markdown)' },
    { flags: '--line-type <side>', field: 'lineType', description: LINE_TYPE },
  ],
  examples: [
    { ...W, id: 42, path: 'src/app.ts', line: 12, body: 'Off by one?' },
    { ...W, id: 42, path: '/src/app.ts', line: 3, body: 'Was this removed on purpose?', lineType: 'left' },
  ],
  run: (input, ctx) => {
    const position = { line: input.line, offset: 1 };
    const range = (input.lineType ?? 'right') === 'left' ? { leftFileStart: position, leftFileEnd: position } : { rightFileStart: position, rightFileEnd: position };
    return startThread(ctx, input.id, input.body, { filePath: input.path.startsWith('/') ? input.path : `/${input.path}`, ...range });
  },
});

export const repoReplyCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'reply'],
  description: 'Reply to a comment thread',
  toolDescription: 'Adds a reply to a thread on a pull request and returns the new comment. Thread ids come from ado_pr_threads or ado_pr_comments.',
  input: z.object({ id: prId, threadId, body: z.string().min(1).describe('Reply text (Markdown)'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, threadArg],
  options: [{ flags: '--body <text>', field: 'body', description: 'Reply text (Markdown)' }],
  examples: [{ ...W, id: 42, threadId: 7, body: 'Fixed in the next commit.' }],
  // parentCommentId 1 is the thread's first comment, so the reply sits under it.
  run: (input, ctx) => adoc(ctx, `${prPath(ctx, input.id)}/threads/${enc(input.threadId)}/comments`, { method: 'POST', json: { parentCommentId: 1, content: input.body, commentType: 'text' } }),
});

const STATUSES = ['active', 'fixed', 'wontFix', 'closed', 'byDesign', 'pending'] as const;

export const repoResolveCommentCommand = adoArea.command({
  path: ['ado', 'pr', 'resolve'],
  description: 'Mark a comment thread as resolved',
  toolDescription: "Sets a pull request thread's status (fixed, which the web UI shows as resolved, by default; or wontFix, closed, byDesign, pending, or active to reopen it) and returns the thread.",
  input: z.object({ id: prId, threadId, status: z.enum(STATUSES).optional().describe('Thread status: fixed|wontFix|closed|byDesign|pending|active (default: fixed)'), ...allowWriteField }),
  writes: true,
  context: IN_REPO,
  args: [prArg, threadArg],
  options: [{ flags: '--status <status>', field: 'status', description: 'Thread status: fixed|wontFix|closed|byDesign|pending|active (default: fixed)' }],
  examples: [
    { ...W, id: 42, threadId: 7 },
    { ...W, id: 42, threadId: 7, status: 'wontFix' },
  ],
  run: (input, ctx) => adoc(ctx, `${prPath(ctx, input.id)}/threads/${enc(input.threadId)}`, { method: 'PATCH', json: { status: input.status ?? 'fixed' } }),
});

export const commentCommands = [repoListThreadsCommand, repoListCommentsCommand, repoAddCommentCommand, repoAddInlineCommentCommand, repoReplyCommentCommand, repoResolveCommentCommand];
