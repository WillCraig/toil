import { basename } from 'node:path';
import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { jiraArea } from '../area.js';
import * as client from './client.js';
import { downloadFileName } from '../../../core/files.js';

/**
 * Attachments on a Jira Cloud issue: upload one, list them, save one locally.
 * Files move through `ctx.files`, so paths resolve inside the workspace on
 * both front doors. Downloads ask Jira for the bytes directly rather than a
 * redirect to its media service, so the credential stays on the site it was
 * issued for. Attachments are filed in triplicate by tradition; toil files
 * them once.
 */

const key = z.string().min(1).describe('Issue key, e.g. PROJ-123');
const keyArg = { name: 'key', field: 'key', description: 'Issue key (e.g. PROJ-123)' };

export const addAttachment = jiraArea.command({
  path: ['jira', 'issue', 'attach'],
  description: 'Upload a file as an attachment to a Jira issue',
  toolDescription: 'Uploads a local file to a Jira issue and returns the attachments Jira created. file is a path on the machine toil runs on.',
  input: z.object({ key, file: z.string().min(1).describe('Path to the file to upload'), ...allowWriteField }),
  writes: true,
  args: [keyArg],
  options: [{ flags: '--file <path>', field: 'file', description: 'Path to the file to upload' }],
  examples: [{ key: 'PROJ-123', file: 'screenshot.png', allowWrite: true }],
  run: async (input, ctx) => {
    const data = await ctx.files.readBytes(input.file);
    return client.uploadAttachment(ctx, input.key, basename(input.file), data);
  },
});

export const listAttachments = jiraArea.command({
  path: ['jira', 'issue', 'attachments'],
  description: 'List attachments on a Jira issue',
  toolDescription: 'Returns the attachments on a Jira issue (id, filename, size, mimeType, content URL). Use jira_issue_download to save one.',
  input: z.object({ key }),
  writes: false,
  args: [keyArg],
  examples: [{ key: 'PROJ-123' }],
  run: (input, ctx) => client.listAttachments(ctx, input.key),
});

export const downloadAttachment = jiraArea.command({
  path: ['jira', 'issue', 'download'],
  description: 'Download a Jira issue attachment to .toil/ (or --dir)',
  toolDescription:
    'Saves one attachment from a Jira issue to a local directory (default .toil in the working directory) and returns { saved, filename, size }. Get the id from jira_issue_attachments. Never replaces an existing file.',
  input: z.object({
    key,
    attachmentId: z.string().min(1).describe('Attachment id from issue attachments'),
    dir: z.string().optional().describe('Output directory; defaults to .toil in the working directory'),
  }),
  writes: false,
  writesLocal: true,
  args: [keyArg, { name: 'attachment-id', field: 'attachmentId', description: 'Attachment ID from issue attachments output' }],
  options: [
    { flags: '--dir <path>', field: 'dir', description: 'Output directory (default: .toil relative to cwd)' },
  ],
  examples: [
    { key: 'PROJ-123', attachmentId: '10001' },
    { key: 'PROJ-123', attachmentId: '10001', dir: 'downloads' },
  ],
  run: async (input, ctx) => {
    // The issue's list says the attachment is on that issue, and gives its file name.
    const attachment = (await client.listAttachments(ctx, input.key)).find((a) => a.id === input.attachmentId);
    if (!attachment) {
      throw new ToilError('INVALID_INPUT', `Attachment not found on ${input.key}: ${input.attachmentId}`, {
        fix: `Run toil jira issue attachments ${input.key} for the ids it has.`,
      });
    }
    const data = await client.downloadAttachment(ctx, attachment.id);
    const saved = ctx.files.writeBytes(`${input.dir ?? '.toil'}/${downloadFileName(attachment.filename, 'attachment')}`, data);
    return { saved, filename: attachment.filename, size: data.length };
  },
});

export const attachmentCommands = [addAttachment, listAttachments, downloadAttachment];
