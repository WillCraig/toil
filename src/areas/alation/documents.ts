import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { allowWriteField } from '../../core/run.js';
import { alationArea } from './area.js';
import { alation, getOne, given, intText, pageParams, parsePositiveId, type Params } from './client.js';
import { buildDocumentPayload, DOCUMENT_INPUT_FILE_EXAMPLE, DOCUMENT_INPUT_FILE_SCHEMA } from './input.js';

/**
 * Document Hubs: folders and documents under `integration/v2/`, and the bulk
 * job a write leaves behind at `api/v1/bulk_metadata/job/`. Writes are
 * asynchronous: create and update return a job ID and nothing polls it, so
 * the paperwork is filed and the caller checks back later, like everyone else.
 */

const LIMIT = { flags: '--limit <n>', field: 'limit', description: 'Page size (max 1000) (default: "100")' } as const;
const OFFSET = { flags: '--offset <n>', field: 'offset', description: 'Number of results to skip (default: "0")' } as const;
const paging = {
  limit: intText.optional().describe('Page size (max 1000) (default: "100")'),
  offset: intText.optional().describe('Number of results to skip (default: "0")'),
};

interface JobResponse {
  job_id?: unknown;
}

export const folderListCommand = alationArea.command({
  path: ['alation', 'folder', 'list'],
  description: 'List folders in a Document Hub',
  input: z.object({
    hub: intText.optional().describe('Document hub ID'),
    parent: intText.optional().describe('Parent folder ID (list its subfolders)'),
    search: z.string().optional().describe('Filter on textual fields'),
    ...paging,
  }),
  writes: false,
  options: [
    { flags: '--hub <id>', field: 'hub', description: 'Document hub ID' },
    { flags: '--parent <id>', field: 'parent', description: 'Parent folder ID (list its subfolders)' },
    { flags: '--search <text>', field: 'search', description: 'Filter on textual fields' },
    LIMIT,
    OFFSET,
  ],
  examples: [{}, { hub: '1', parent: '42', search: 'onboarding', limit: '10', offset: '20' }],
  run: async (input, ctx) => {
    const params: Params = { ...pageParams(input) };
    if (given(input.hub)) params.document_hub_id = parsePositiveId(input.hub, '--hub');
    if (given(input.parent)) params.parent_folder_id = parsePositiveId(input.parent, '--parent');
    if (input.search) params.search = input.search;
    const data = await alation<unknown[]>(ctx, 'integration/v2/folder/', { params });
    return { count: data.length, limit: params.limit, skip: params.skip, folders: data };
  },
});

export const folderGetCommand = alationArea.command({
  path: ['alation', 'folder', 'get'],
  description: 'Get a Document Hub folder by ID',
  input: z.object({ id: intText.describe('Folder ID') }),
  writes: false,
  args: [{ name: 'id', field: 'id', description: 'Folder ID' }],
  examples: [{ id: '42' }],
  run: async (input, ctx) => getOne(ctx, 'integration/v2/folder/', parsePositiveId(input.id, 'folder ID'), 'Folder'),
});

export const documentListCommand = alationArea.command({
  path: ['alation', 'document', 'list'],
  description: 'List documents in a Document Hub or folder',
  input: z.object({
    hub: intText.optional().describe('Document hub ID'),
    folder: intText.optional().describe('Parent folder ID'),
    parentDocument: intText.optional().describe('Parent document ID (list sub-documents)'),
    search: z.string().optional().describe('Filter on all textual fields'),
    deleted: z.boolean().optional().describe('Return only deleted documents'),
    ...paging,
  }),
  writes: false,
  options: [
    { flags: '--hub <id>', field: 'hub', description: 'Document hub ID' },
    { flags: '--folder <id>', field: 'folder', description: 'Parent folder ID' },
    { flags: '--parent-document <id>', field: 'parentDocument', description: 'Parent document ID (list sub-documents)' },
    { flags: '--search <text>', field: 'search', description: 'Filter on all textual fields' },
    { flags: '--deleted', field: 'deleted', description: 'Return only deleted documents' },
    LIMIT,
    OFFSET,
  ],
  examples: [{}, { hub: '1', folder: '42', parentDocument: '12', search: 'customer', deleted: true, limit: '25', offset: '25' }],
  run: async (input, ctx) => {
    const params: Params = { ...pageParams(input) };
    if (given(input.hub)) params.document_hub_id = parsePositiveId(input.hub, '--hub');
    if (given(input.folder)) params.parent_folder_id = parsePositiveId(input.folder, '--folder');
    if (given(input.parentDocument)) params.parent_document_id = parsePositiveId(input.parentDocument, '--parent-document');
    if (input.search) params.search = input.search;
    if (input.deleted) params.deleted = true;
    const data = await alation<unknown[]>(ctx, 'integration/v2/document/', { params });
    return { count: data.length, limit: params.limit, skip: params.skip, documents: data };
  },
});

export const documentGetCommand = alationArea.command({
  path: ['alation', 'document', 'get'],
  description: 'Get a document by ID, including its custom field values',
  input: z.object({ id: intText.describe('Document ID') }),
  writes: false,
  args: [{ name: 'id', field: 'id', description: 'Document ID' }],
  examples: [{ id: '12' }],
  run: async (input, ctx) => getOne(ctx, 'integration/v2/document/', parsePositiveId(input.id, 'document ID'), 'Document'),
});

export const documentSchemaCommand = alationArea.command({
  path: ['alation', 'document', 'schema'],
  kind: 'area-local',
  description: 'Print the --input-file JSON schema and an example for document create/update',
  input: z.object({
    exampleOnly: z.boolean().optional().describe('Return only the runnable example as data, ready to save as an input file'),
  }),
  writes: false,
  options: [{ flags: '--example-only', field: 'exampleOnly', description: 'Return only the runnable example as data, ready to save as an input file' }],
  examples: [{}, { exampleOnly: true }],
  run: async (input) => (input.exampleOnly ? DOCUMENT_INPUT_FILE_EXAMPLE : { schema: DOCUMENT_INPUT_FILE_SCHEMA, example: DOCUMENT_INPUT_FILE_EXAMPLE }),
});

const INPUT_FILE_CREATE = 'JSON file with title/description/hub/folder/template/fields (see `alation document schema`); "-" reads stdin';
const INPUT_FILE_UPDATE = 'JSON file with title/description/folder/template/fields (see `alation document schema`); "-" reads stdin';

export const documentCreateCommand = alationArea.command({
  path: ['alation', 'document', 'create'],
  description: 'Create a document (async — returns a job ID; check it with `alation job get`)',
  input: z.object({
    title: z.string().optional().describe('Document title'),
    description: z.string().optional().describe('Document summary'),
    hub: intText.optional().describe('Document hub ID'),
    folder: intText.optional().describe('Parent folder ID'),
    template: intText.optional().describe('Template ID (required when custom fields are set)'),
    parentDocument: intText.optional().describe('Parent document ID for a sub-document'),
    inputFile: z.string().optional().describe(INPUT_FILE_CREATE),
    ...allowWriteField,
  }),
  writes: true,
  options: [
    { flags: '--title <title>', field: 'title', description: 'Document title' },
    { flags: '--description <text>', field: 'description', description: 'Document summary' },
    { flags: '--hub <id>', field: 'hub', description: 'Document hub ID' },
    { flags: '--folder <id>', field: 'folder', description: 'Parent folder ID' },
    { flags: '--template <id>', field: 'template', description: 'Template ID (required when custom fields are set)' },
    { flags: '--parent-document <id>', field: 'parentDocument', description: 'Parent document ID for a sub-document' },
    { flags: '--input-file <path>', field: 'inputFile', description: INPUT_FILE_CREATE },
  ],
  examples: [
    { title: 'Notes', description: 'Hi', hub: '1', folder: '42', allowWrite: true },
    { inputFile: 'alation-doc.json', title: 'From flag', template: '9', parentDocument: '12', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const { payload, overrides } = await buildDocumentPayload(input, ctx.files, ctx.warn);
    for (const [key, flag] of [['title', '--title'], ['document_hub_id', '--hub'], ['parent_folder_id', '--folder']] as const) {
      if (payload[key] === undefined) throw new ToilError('INVALID_INPUT', `${flag} is required to create a document (or set it in --input-file)`, { fix: `Pass ${flag}, or set it in --input-file.` });
    }
    const data = await alation<JobResponse>(ctx, 'integration/v2/document/', { method: 'POST', body: [payload] });
    return { jobId: data.job_id, document: payload, ...(overrides.length ? { overrides } : {}) };
  },
});

export const documentUpdateCommand = alationArea.command({
  path: ['alation', 'document', 'update'],
  description: 'Update a document (async — returns a job ID; custom field values replace existing values per field)',
  input: z.object({
    id: intText.describe('Document ID'),
    title: z.string().optional().describe('New title'),
    description: z.string().optional().describe('New summary'),
    folder: intText.optional().describe('Move to this parent folder'),
    template: intText.optional().describe('Template ID (required when custom fields are set)'),
    inputFile: z.string().optional().describe(INPUT_FILE_UPDATE),
    ...allowWriteField,
  }),
  writes: true,
  args: [{ name: 'id', field: 'id', description: 'Document ID' }],
  options: [
    { flags: '--title <title>', field: 'title', description: 'New title' },
    { flags: '--description <text>', field: 'description', description: 'New summary' },
    { flags: '--folder <id>', field: 'folder', description: 'Move to this parent folder' },
    { flags: '--template <id>', field: 'template', description: 'Template ID (required when custom fields are set)' },
    { flags: '--input-file <path>', field: 'inputFile', description: INPUT_FILE_UPDATE },
  ],
  examples: [
    { id: '12', description: 'New', allowWrite: true },
    { id: '12', inputFile: 'alation-update.json', title: 'Renamed', folder: '43', template: '9', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const documentId = parsePositiveId(input.id, 'document ID');
    const { payload, overrides } = await buildDocumentPayload(input, ctx.files, ctx.warn);
    if (payload.document_hub_id !== undefined) {
      throw new ToilError('INVALID_INPUT', 'A document cannot change hubs; remove "hub" from --input-file.', { fix: 'Remove "hub" from --input-file.' });
    }
    if (Object.keys(payload).length === 0) {
      throw new ToilError('INVALID_INPUT', 'Nothing to update. Pass --title, --description, --folder, or --input-file.', { fix: 'Pass at least one of --title, --description, --folder or --input-file.' });
    }
    const body = [{ id: documentId, ...payload }];
    const data = await alation<JobResponse>(ctx, 'integration/v2/document/', { method: 'PUT', body });
    return { jobId: data.job_id, document: body[0], ...(overrides.length ? { overrides } : {}) };
  },
});

export const jobGetCommand = alationArea.command({
  path: ['alation', 'job', 'get'],
  description: 'Get the status of a bulk job (returned by document create/update)',
  input: z.object({ id: intText.describe('Job ID') }),
  writes: false,
  args: [{ name: 'id', field: 'id', description: 'Job ID' }],
  examples: [{ id: '555' }],
  run: async (input, ctx) => {
    const jobId = parsePositiveId(input.id, 'job ID');
    const data = await alation<Record<string, unknown>>(ctx, 'api/v1/bulk_metadata/job/', { params: { id: jobId } });
    return { jobId, ...data };
  },
});

export const documentCommands = [
  folderListCommand,
  folderGetCommand,
  documentListCommand,
  documentGetCommand,
  documentSchemaCommand,
  documentCreateCommand,
  documentUpdateCommand,
  jobGetCommand,
];
