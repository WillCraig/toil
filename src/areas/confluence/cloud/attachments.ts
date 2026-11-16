import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { ATTACHMENT_ID, confluenceArea } from '../area.js';
import * as client from './client.js';
import { downloadFileName } from '../../../core/files.js';

/**
 * Attachments: list a page's, upload one, save one locally, or move one to
 * the trash. Files move through `ctx.files`, so paths stay inside the
 * workspace on both front doors and a download never replaces a file.
 * Emptying the trash is an administrator's job, and stays one.
 */

const attachmentId = z.string().min(1).describe(ATTACHMENT_ID);
const attachmentArg = { name: 'id', field: 'id', description: ATTACHMENT_ID };
const pageArg = { name: 'id', field: 'id', description: 'Page ID' };

/**
 * The last segment of a path or title, splitting on both `/` and `\` whatever
 * the platform, with `.` and `..` dropped, and `attachment` when nothing is
 * left. A title comes from the server, so it never picks the directory.
 */
export function attachmentFileName(title: string): string {
  const segments = title.split(/[\\/]/).filter((s) => s !== '' && s !== '.' && s !== '..');
  return segments.pop() ?? 'attachment';
}

export const listAttachments = confluenceArea.command({
  path: ['confluence', 'page', 'attachments'],
  description: 'List attachments on a Confluence Cloud page',
  toolDescription: 'Returns every attachment on a page (id, title, mediaType, fileSize, downloadLink). Use confluence_attachment_download with an id to save one.',
  input: z.object({ id: z.string().min(1).describe('Page ID') }),
  writes: false,
  args: [pageArg],
  examples: [{ id: '12345' }],
  run: (input, ctx) => client.listAttachments(ctx, input.id),
});

export const uploadAttachment = confluenceArea.command({
  path: ['confluence', 'page', 'attach'],
  description: 'Upload a file as an attachment to a Confluence Cloud page',
  toolDescription:
    'Uploads a local file to a page as a new attachment and returns what Confluence created. inputFile is a path inside the workspace. A file name already on the page is refused by Confluence, not versioned.',
  input: z.object({
    id: z.string().min(1).describe('Page ID'),
    inputFile: z.string().min(1).describe('Path to the file to upload'),
    comment: z.string().optional().describe('Optional comment to attach to the file version'),
    ...allowWriteField,
  }),
  writes: true,
  args: [pageArg],
  options: [
    { flags: '--input-file <path>', field: 'inputFile', description: 'Path to the file to upload', deprecated: ['--file <path>'] },
    { flags: '--comment <text>', field: 'comment', description: 'Optional comment to attach to the file version' },
  ],
  examples: [
    { id: '12345', inputFile: 'diagram.png', allowWrite: true },
    { id: '12345', inputFile: 'notes.txt', comment: 'First draft', allowWrite: true },
  ],
  run: async (input, ctx) => {
    if (!ctx.files.exists(input.inputFile)) {
      throw new ToilError('INVALID_INPUT', `File not found: ${input.inputFile}`, { fix: 'Check the path. Relative paths resolve against the workspace.' });
    }
    const data = await ctx.files.readBytes(input.inputFile);
    // The same file name on every platform: a backslash separates, as on Windows.
    return client.uploadAttachment(ctx, input.id, attachmentFileName(input.inputFile), data, input.comment);
  },
});

export const downloadAttachment = confluenceArea.command({
  path: ['confluence', 'attachment', 'download'],
  description: 'Download a Confluence Cloud attachment to .toil/ (or --dir)',
  toolDescription:
    'Saves one Confluence Cloud attachment to a directory inside the workspace (default .toil) and returns { saved, filename, size }. Never replaces an existing file. Get the id from confluence_page_attachments.',
  input: z.object({
    id: attachmentId,
    dir: z.string().optional().describe('Output directory; defaults to .toil in the workspace'),
  }),
  writes: false,
  writesLocal: true,
  args: [attachmentArg],
  options: [{ flags: '--dir <path>', field: 'dir', description: 'Output directory (default: .toil in the workspace)' }],
  examples: [{ id: 'att98765' }, { id: 'att98765', dir: 'downloads' }],
  run: async (input, ctx) => {
    const attachment = await client.getAttachment(ctx, input.id);
    const data = await client.downloadAttachment(ctx, attachment);
    const saved = ctx.files.writeBytes(`${input.dir ?? '.toil'}/${downloadFileName(attachmentFileName(attachment.title), 'attachment')}`, data);
    return { saved, filename: attachment.title, size: data.length };
  },
});

export const deleteAttachment = confluenceArea.command({
  path: ['confluence', 'attachment', 'delete'],
  description: 'Delete a Confluence Cloud attachment by its ID (moves it to the trash; does not purge it)',
  input: z.object({ id: attachmentId, ...allowWriteField }),
  writes: true,
  mcp: false,
  args: [attachmentArg],
  examples: [{ id: 'att98765', allowWrite: true }],
  run: async (input, ctx) => {
    await client.deleteAttachment(ctx, input.id);
    return { deleted: input.id };
  },
});

export const attachmentCommands = [listAttachments, uploadAttachment, downloadAttachment, deleteAttachment];
