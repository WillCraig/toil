import { basename } from 'node:path';
import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import { allowWriteField } from '../../../core/run.js';
import { adoArea } from '../area.js';
import { API, PATCH, ado, adoDownload, adoUpload, enc, projectPath, toInt, where, type AdoContext } from './client.js';
import { ADO_WORK_INPUT_FILE_EXAMPLE, ADO_WORK_INPUT_FILE_SCHEMA } from './fields.js';
import { AT, getWorkItem, idArg, idInput, intText } from './work.js';
import { downloadFileName } from '../../../core/files.js';

/**
 * Around the work items: their attachments, the area and iteration trees,
 * and what the process defines (types, states, fields), plus the input-file
 * schema. Discovery describes the process; nobody has yet discovered who
 * designed it.
 */

const W = { ...AT, allowWrite: true };

interface Attachment {
  id: string;
  name: string;
  url: string;
  comment?: string;
  resourceSize?: number;
  resourceCreatedDate?: string;
  resourceModifiedDate?: string;
}

/** A work item's AttachedFile relations, shaped as the contract specifies; the id is the URL's last segment. */
async function listAttachments(ctx: AdoContext, collection: string, id: number): Promise<Attachment[]> {
  const item = await getWorkItem(ctx, collection, id);
  return (item.relations ?? [])
    .filter((r) => r.rel === 'AttachedFile')
    .map((r) => {
      const attrs = r.attributes ?? {};
      return {
        id: new URL(r.url).pathname.split('/').pop() ?? '',
        name: String(attrs['name'] ?? ''),
        url: r.url,
        comment: attrs['comment'] !== undefined ? String(attrs['comment']) : undefined,
        resourceSize: typeof attrs['resourceSize'] === 'number' ? attrs['resourceSize'] : undefined,
        resourceCreatedDate: attrs['resourceCreatedDate'] !== undefined ? String(attrs['resourceCreatedDate']) : undefined,
        resourceModifiedDate: attrs['resourceModifiedDate'] !== undefined ? String(attrs['resourceModifiedDate']) : undefined,
      };
    });
}

export const workListAttachmentsCommand = adoArea.command({
  path: ['ado', 'work-item', 'attachments'],
  description: 'List attachments on a work item',
  toolDescription: 'Lists the files attached to a work item (id, name, url, size, dates). Use ado_work_item_download to save one.',
  input: z.object({ id: idInput }),
  writes: false,
  args: [idArg],
  examples: [{ ...AT, id: '42' }],
  run: async (input, ctx) => listAttachments(ctx, where(ctx).collection, toInt(input.id)),
});

export const workAddAttachmentCommand = adoArea.command({
  path: ['ado', 'work-item', 'attach'],
  description: 'Upload a local file and attach it to a work item',
  toolDescription:
    'Uploads a local file to the attachment store, then links it to the work item, and returns the uploaded attachment (id, url). file is a path in the workspace. If the link fails, the upload stays stored and the error says only why the link failed.',
  input: z.object({ id: idInput, file: z.string().describe('Path to the file to upload'), comment: z.string().optional().describe('Optional comment for the attachment'), ...allowWriteField }),
  writes: true,
  args: [idArg],
  options: [
    { flags: '--file <path>', field: 'file', description: 'Path to the file to upload' },
    { flags: '--comment <text>', field: 'comment', description: 'Optional comment for the attachment' },
  ],
  examples: [
    { ...W, id: '42', file: 'screenshot.png' },
    { ...W, id: '42', file: 'logs/run.txt', comment: 'From the failed run' },
  ],
  run: async (input, ctx) => {
    const { collection } = where(ctx);
    const id = toInt(input.id);
    const data = await ctx.files.readBytes(input.file);
    // Step 1, the upload; step 2, the link. Suspected bug (#69 item 16): a failed link leaves the upload behind.
    const attachment = await adoUpload<Attachment>(ctx, `/${enc(collection)}/_apis/wit/attachments?fileName=${enc(basename(input.file))}&api-version=${API}`, data);
    const relation = { rel: 'AttachedFile', url: attachment.url, ...(input.comment ? { attributes: { comment: input.comment } } : {}) };
    await ado(ctx, `/${enc(collection)}/_apis/wit/workitems/${enc(id)}?api-version=${API}`, { method: 'PATCH', json: [{ op: 'add', path: '/relations/-', value: relation }], headers: PATCH });
    return attachment;
  },
});

export const workDownloadAttachmentCommand = adoArea.command({
  path: ['ado', 'work-item', 'download'],
  description: 'Download a work item attachment to .toil/ (or --dir)',
  toolDescription:
    'Saves one attachment of a work item to a directory in the workspace (default .toil) and returns { saved, name, size }. Never overwrites a file. Get the attachment id from ado_work_item_attachments.',
  input: z.object({
    id: idInput,
    attachmentId: z.string().describe('Attachment ID from work-item attachments output'),
    dir: z.string().optional().describe('Output directory (default: .toil in the workspace)'),
  }),
  writes: false,
  writesLocal: true,
  args: [idArg, { name: 'attachment-id', field: 'attachmentId', description: 'Attachment ID from work-item attachments output' }],
  options: [
    { flags: '--dir <path>', field: 'dir', description: 'Output directory (default: .toil relative to cwd)' },
  ],
  examples: [
    { ...AT, id: '42', attachmentId: 'abc12345-0000-0000-0000-000000000000' },
    { ...AT, id: '42', attachmentId: 'abc12345-0000-0000-0000-000000000000', dir: 'downloads' },
  ],
  run: async (input, ctx) => {
    const attachments = await listAttachments(ctx, where(ctx).collection, toInt(input.id));
    const attachment = attachments.find((a) => a.id === input.attachmentId);
    if (!attachment) {
      throw new ToilError('INVALID_INPUT', `Attachment not found: ${input.attachmentId}`, { fix: `Run toil ado work-item attachments ${String(input.id)} for the ids it has.` });
    }
    const data = await adoDownload(ctx, attachment.url);
    const saved = ctx.files.writeBytes(`${input.dir ?? '.toil'}/${downloadFileName(attachment.name, 'attachment')}`, data);
    return { saved, name: attachment.name, size: data.length };
  },
});

const DEPTH = 'Depth of the tree to retrieve (default: "10")';
const depthOf = (value: number | string | undefined) => toInt(value, '10');

export const workListAreasCommand = adoArea.command({
  path: ['ado', 'work-item', 'areas'],
  description: 'List classification areas for the team project (tree)',
  toolDescription: "Returns the project's area-path tree, to the given depth (10 by default).",
  input: z.object({ depth: intText.optional().describe(DEPTH) }),
  writes: false,
  options: [{ flags: '--depth <n>', field: 'depth', description: 'Depth of the area tree to retrieve (default: "10")' }],
  examples: [AT, { ...AT, depth: '2' }],
  run: async (input, ctx) => ado(ctx, `${projectPath(where(ctx))}/_apis/wit/classificationnodes/areas?$depth=${depthOf(input.depth)}&api-version=${API}`),
});

export const workListIterationsCommand = adoArea.command({
  path: ['ado', 'work-item', 'iterations'],
  description: 'List classification iterations for the team project (tree), including start/finish dates',
  toolDescription: "Returns the project's iteration tree with start and finish dates, to the given depth (10 by default).",
  input: z.object({ depth: intText.optional().describe(DEPTH) }),
  writes: false,
  options: [{ flags: '--depth <n>', field: 'depth', description: 'Depth of the iteration tree to retrieve (default: "10")' }],
  examples: [AT, { ...AT, depth: '3' }],
  run: async (input, ctx) => ado(ctx, `${projectPath(where(ctx))}/_apis/wit/classificationnodes/iterations?$depth=${depthOf(input.depth)}&api-version=${API}`),
});

// No --save on types or fields (KF6, #68): the aliases it saved were the
// built-in ones toil already applies, and nothing read the saved type or field
// lists. A filing cabinet for photocopies of the rulebook was declined.

const DISCOVER = 'Fetch from server (always true for this command)';

export const workTypesCommand = adoArea.command({
  path: ['ado', 'work-item', 'types'],
  description: 'List work item types in the project',
  toolDescription: "Lists the project's work item types, each with its states and always-required fields. One extra request per type, for its states.",
  input: z.object({
    discover: z.boolean().optional().describe(DISCOVER),
  }),
  writes: false,
  options: [
    { flags: '--discover', field: 'discover', description: DISCOVER },
  ],
  examples: [AT, { ...AT, discover: true }],
  run: async (input, ctx) => {
    const w = where(ctx);
    const types = await ado<{ value?: Array<{ name: string; fields?: Array<{ referenceName: string; alwaysRequired?: boolean }> }> }>(ctx, `${projectPath(w)}/_apis/wit/workitemtypes?api-version=${API}`);
    const result: Array<{ name: string; states: string[]; requiredFields: string[] }> = [];
    for (const t of types.value ?? []) {
      const states = await ado<{ value?: Array<{ name: string }> }>(ctx, `${projectPath(w)}/_apis/wit/workitemtypes/${enc(t.name)}/states?api-version=${API}`);
      result.push({ name: t.name, states: (states.value ?? []).map((s) => s.name), requiredFields: (t.fields ?? []).filter((f) => f.alwaysRequired).map((f) => f.referenceName) });
    }
    return result;
  },
});

export const workListStatesCommand = adoArea.command({
  path: ['ado', 'work-item', 'states'],
  description: 'List valid states for a work item type',
  toolDescription: 'Lists the states a work item type has (name, color, category).',
  input: z.object({ type: z.string().describe('Work item type name (e.g. Bug)') }),
  writes: false,
  options: [{ flags: '--type <type>', field: 'type', description: 'Work item type name (e.g. Bug)' }],
  examples: [{ ...AT, type: 'Bug' }],
  run: async (input, ctx) => {
    const result = await ado<{ value?: unknown[] }>(ctx, `${projectPath(where(ctx))}/_apis/wit/workitemtypes/${enc(input.type)}/states?api-version=${API}`);
    return result.value ?? [];
  },
});

interface Field {
  referenceName: string;
  name: string;
  type: string;
  readOnly?: boolean;
  picklistId?: string;
}

/** Suspected bug (#69 item 18): type-scoped fields have no `type` or `readOnly`, so those come out undefined. */
const toFieldMeta = (f: Field) => ({ referenceName: f.referenceName, name: f.name, type: f.type, readOnly: f.readOnly, ...(f.picklistId ? { picklistId: f.picklistId } : {}) });

export const workFieldsCommand = adoArea.command({
  path: ['ado', 'work-item', 'fields'],
  description: 'List work item fields available in the collection (consider --output-file for large results)',
  toolDescription:
    "Lists work item fields (referenceName, name, type, readOnly): the collection's, or with type a work item type's. customOnly leaves out System.* and Microsoft.VSTS.* fields.",
  input: z.object({
    type: z.string().optional().describe('Scope to fields for a specific work item type (e.g. Bug)'),
    customOnly: z.boolean().optional().describe('Exclude System.* and Microsoft.VSTS.* fields'),
    discover: z.boolean().optional().describe(DISCOVER),
  }),
  writes: false,
  options: [
    { flags: '--type <type>', field: 'type', description: 'Scope to fields for a specific work item type (e.g. Bug)' },
    { flags: '--custom-only', field: 'customOnly', description: 'Exclude System.* and Microsoft.VSTS.* fields' },
    { flags: '--discover', field: 'discover', description: DISCOVER },
  ],
  examples: [AT, { ...AT, type: 'Bug', customOnly: true }, { ...AT, discover: true }],
  run: async (input, ctx) => {
    const w = where(ctx);
    // Without --type the project is ignored: the collection's fields.
    const path = input.type ? `${projectPath(w)}/_apis/wit/workitemtypes/${enc(input.type)}/fields?api-version=${API}` : `/${enc(w.collection)}/_apis/wit/fields?api-version=${API}`;
    const all = ((await ado<{ value?: Field[] }>(ctx, path)).value ?? []).map(toFieldMeta);
    const fields = input.customOnly ? all.filter((f) => !f.referenceName.startsWith('System.') && !f.referenceName.startsWith('Microsoft.VSTS.')) : all;
    return fields;
  },
});

export const workSchemaCommand = adoArea.command({
  path: ['ado', 'work-item', 'schema'],
  kind: 'area-local',
  description: 'Print the --input-file JSON schema and an example for work-item create/update',
  toolDescription: 'Returns the JSON Schema of the input file work-item create and work-item update accept, and a runnable example. Needs no connection.',
  input: z.object({ exampleOnly: z.boolean().optional().describe('Return only the runnable example as data, ready to save as an input file') }),
  writes: false,
  options: [{ flags: '--example-only', field: 'exampleOnly', description: 'Return only the runnable example JSON as data — save .data and pass it to --input-file' }],
  examples: [{}, { exampleOnly: true }],
  run: async (input) => (input.exampleOnly ? ADO_WORK_INPUT_FILE_EXAMPLE : { schema: ADO_WORK_INPUT_FILE_SCHEMA, example: ADO_WORK_INPUT_FILE_EXAMPLE }),
});

export const workMetaCommands = [
  workListAttachmentsCommand,
  workAddAttachmentCommand,
  workDownloadAttachmentCommand,
  workListAreasCommand,
  workListIterationsCommand,
  workTypesCommand,
  workListStatesCommand,
  workFieldsCommand,
  workSchemaCommand,
];
