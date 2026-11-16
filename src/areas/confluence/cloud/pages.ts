import { z } from 'zod';
import { ToilError } from '../../../core/errors.js';
import type { FileAccess } from '../../../core/files.js';
import { allowWriteField } from '../../../core/run.js';
import { confluenceArea } from '../area.js';
import * as client from './client.js';
import { storageOf, withBodyText } from './storage.js';

/**
 * Pages: read one by id or title, list a space or a page's children, read
 * the versions, search with CQL, and create, update or delete. Bodies are
 * storage format both ways (see storage.ts). Page ids are numbers in text,
 * and a space key is looked up to the space id v2 wants, which is one more
 * request than strictly necessary and one fewer form than usual.
 */

const id = z.string().min(1).describe('Page ID');
const idArg = { name: 'id', field: 'id', description: 'Page ID' };
const space = z.string().min(1).describe('Space key');
const spaceOption = { flags: '--space <key>', field: 'space', description: 'Space key' };
const limit = (what: string) => z.number().int().positive().optional().describe(`Max total ${what} to return (default: all)`);
const cursor = z.string().min(1).optional().describe('meta.page.nextCursor from the previous page, to carry on from there (with limit)');
const cursorOption = { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous page (with --limit)' };

/** A cursor only makes sense with the page size that produced it. */
export function needLimitForCursor(input: { limit?: number | undefined; cursor?: string | undefined }): void {
  if (input.cursor !== undefined && input.limit === undefined) {
    throw new ToilError('INVALID_INPUT', '--cursor needs --limit', {
      fix: 'Pass --limit with --cursor (the limit of the call that gave you the cursor), or leave out --cursor to read everything.',
    });
  }
}

export const getPage = confluenceArea.command({
  path: ['confluence', 'page', 'get'],
  description: 'Get a Confluence Cloud page by ID, with its storage-format body',
  toolDescription: 'Returns a Confluence Cloud page by id as v2 returns it (title, spaceId, parentId, version, body.storage), plus bodyText, the body as plain text.',
  input: z.object({ id }),
  writes: false,
  args: [idArg],
  examples: [{ id: '12345' }],
  run: async (input, ctx) => withBodyText(await client.getPage(ctx, input.id)),
});

export const getPageByTitle = confluenceArea.command({
  path: ['confluence', 'page', 'find'],
  description: 'Find a Confluence Cloud page by space key and exact title',
  input: z.object({ space, title: z.string().min(1).describe('Page title') }),
  writes: false,
  options: [spaceOption, { flags: '--title <title>', field: 'title', description: 'Page title' }],
  examples: [{ space: 'DOCS', title: 'Release notes' }],
  run: async (input, ctx) => {
    const found = await client.getSpace(ctx, input.space);
    const page = await client.getPageByTitle(ctx, found.id, input.title);
    if (!page) {
      throw new ToilError('NOT_FOUND', `Page not found: "${input.title}" in space ${input.space}`, {
        fix: `Check the title (it must match exactly) and the space key. toil confluence page search --cql 'space=${input.space} AND title~"…"' finds near matches.`,
      });
    }
    return withBodyText(page);
  },
});

export const listPages = confluenceArea.command({
  path: ['confluence', 'page', 'list'],
  description: 'List pages in a Confluence Cloud space (consider --output-file for large results)',
  toolDescription:
    'Lists the pages in a Confluence Cloud space (id, title, parentId, version; no bodies). Without limit it returns every page, which can be large; with limit, pass meta.page.nextCursor as cursor for the next page.',
  input: z.object({ space, limit: limit('pages'), cursor }),
  writes: false,
  options: [spaceOption, { flags: '--limit <n>', field: 'limit', description: 'Max total pages to return (default: all)' }, cursorOption],
  examples: [{ space: 'DOCS' }, { space: 'DOCS', limit: 2 }, { space: 'DOCS', limit: 2, cursor: 'eyJjIjoicGFnZS0yIiwicyI6MH0' }],
  run: async (input, ctx) => {
    needLimitForCursor(input);
    const found = await client.getSpace(ctx, input.space);
    return (await client.listPages(ctx, found.id, { cap: input.limit, cursor: input.cursor })).items;
  },
});

export const getPageChildren = confluenceArea.command({
  path: ['confluence', 'page', 'children'],
  description: 'Get the direct children of a Confluence Cloud page',
  toolDescription: "Returns a page's direct children (id, title, type, status). type is page for child pages; folders, whiteboards, databases and embeds are listed too.",
  input: z.object({ id: z.string().min(1).describe('Parent page ID') }),
  writes: false,
  args: [{ name: 'id', field: 'id', description: 'Parent page ID' }],
  examples: [{ id: '12345' }],
  run: (input, ctx) => client.getPageChildren(ctx, input.id),
});

export const getPageHistory = confluenceArea.command({
  path: ['confluence', 'page', 'history'],
  description: 'Get the versions of a Confluence Cloud page',
  toolDescription: "Returns every version of a page (number, createdAt, authorId, message, minorEdit), newest first as Confluence sorts them. No bodies.",
  input: z.object({ id }),
  writes: false,
  args: [idArg],
  examples: [{ id: '12345' }],
  run: (input, ctx) => client.getPageVersions(ctx, input.id),
});

export const search = confluenceArea.command({
  path: ['confluence', 'page', 'search'],
  description: 'Search Confluence Cloud with CQL',
  toolDescription:
    "Runs a CQL query and returns Confluence Cloud's search result as it came (results, each with content, title and excerpt; size; _links). One page: pass meta.page.nextCursor as cursor for the next.",
  input: z.object({
    cql: z.string().min(1).describe('CQL query string (e.g. "space=PROJ AND type=page")'),
    limit: z.number().int().positive().optional().describe('Maximum number of results (default: 25)'),
    cursor: z.string().min(1).optional().describe('meta.page.nextCursor from the previous search, for the next page'),
    expand: z.string().optional().describe('Comma-separated fields to expand (e.g. content.space,content.version)'),
  }),
  writes: false,
  options: [
    { flags: '--cql <query>', field: 'cql', description: 'CQL query string (e.g. "space=PROJ AND type=page")' },
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of results (default: 25)' },
    { flags: '--cursor <cursor>', field: 'cursor', description: 'meta.page.nextCursor from the previous search' },
    { flags: '--expand <fields>', field: 'expand', description: 'Comma-separated fields to expand' },
  ],
  examples: [{ cql: 'space=DOCS AND type=page' }, { cql: 'text~"runbook"', limit: 10, cursor: 'c2VhcmNoLTI', expand: 'content.space' }],
  run: async (input, ctx) => {
    const limit = input.limit ?? 25;
    const result = await client.search(ctx, input.cql, { limit, cursor: input.cursor, expand: input.expand });
    ctx.setPage({ nextCursor: client.cursorOf(result._links?.next) ?? null, limit });
    return result;
  },
});

const representation = z.enum(['storage', 'wiki']).optional().describe('Body format: storage (default) or wiki, which Confluence converts to storage');
const representationOption = { flags: '--representation <format>', field: 'representation', description: 'Body format: storage (default) or wiki' };

/**
 * `--body` or the text of `--body-file` (`-` is stdin on the CLI), or
 * undefined for neither; both is refused. The file is read as it is.
 */
export async function bodyOf(files: FileAccess, body: string | undefined, bodyFile: string | undefined): Promise<string | undefined> {
  if (body !== undefined && bodyFile !== undefined) {
    throw new ToilError('INVALID_INPUT', 'Cannot specify both --body and --body-file', { fix: 'Pass one of them.' });
  }
  if (bodyFile === undefined) return body;
  try {
    return await files.readText(bodyFile);
  } catch (err) {
    const source = bodyFile === '-' ? 'stdin' : `file "${bodyFile}"`;
    const inner = err instanceof ToilError ? err : undefined;
    throw new ToilError('INVALID_INPUT', `Cannot read body ${source}: ${(err as Error).message}`, { fix: inner?.fix ?? 'Check the path. Relative paths resolve against the workspace.' });
  }
}

export const createPage = confluenceArea.command({
  path: ['confluence', 'page', 'create'],
  description: 'Create a new Confluence Cloud page',
  toolDescription:
    'Creates a published page in a space, optionally under a parent page, and returns the page Confluence created. The body is storage-format XHTML, or wiki markup with representation wiki. Without parentId the page goes under the space homepage.',
  input: z.object({
    space,
    title: z.string().min(1).describe('Page title'),
    body: z.string().optional().describe('Page body (storage-format XHTML, or wiki markup with --representation wiki)'),
    bodyFile: z.string().optional().describe("Path to a file containing the page body ('-' = stdin)"),
    parentId: z.string().min(1).optional().describe('Parent page ID (to nest under a page)'),
    representation,
    ...allowWriteField,
  }),
  writes: true,
  options: [
    spaceOption,
    { flags: '--title <title>', field: 'title', description: 'Page title' },
    { flags: '--body <html>', field: 'body', description: 'Page body (storage-format XHTML, or wiki markup with --representation wiki)' },
    { flags: '--body-file <path>', field: 'bodyFile', description: "Path to a file containing the page body ('-' = stdin)" },
    { flags: '--parent-id <id>', field: 'parentId', description: 'Parent page ID (to nest under a page)' },
    representationOption,
  ],
  examples: [
    { space: 'DOCS', title: 'Release notes', body: '<p>Shipped.</p>', parentId: '12345', allowWrite: true },
    { space: 'DOCS', title: 'Runbook', bodyFile: 'runbook.html', allowWrite: true },
    { space: 'DOCS', title: 'Wiki page', body: 'h1. Heading', representation: 'wiki', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const body = await bodyOf(ctx.files, input.body, input.bodyFile);
    if (body === undefined) throw new ToilError('INVALID_INPUT', 'Must specify --body or --body-file', { fix: 'Pass the page body with --body, or a file with --body-file.' });
    const found = await client.getSpace(ctx, input.space);
    const page = await client.createPage(ctx, { spaceId: found.id, title: input.title, body, parentId: input.parentId, representation: input.representation ?? 'storage' });
    return withBodyText(page);
  },
});

export const updatePage = confluenceArea.command({
  path: ['confluence', 'page', 'update'],
  description: 'Update a Confluence Cloud page (fetches the current version automatically)',
  toolDescription:
    "Updates a page's title, body or status. Reads the page first and sends the next version number, keeping the title unless one is given. Confluence Cloud requires a body on every update, so with no body the current one is sent back unchanged. status draft turns the page into a draft and deletes any draft it already has.",
  input: z.object({
    id,
    title: z.string().min(1).optional().describe('New page title'),
    body: z.string().optional().describe('New page body (storage-format XHTML, or wiki markup with --representation wiki)'),
    bodyFile: z.string().optional().describe("Path to a file containing the new page body ('-' = stdin)"),
    status: z.enum(['current', 'draft']).optional().describe('Page status: current (default) or draft, which deletes any draft the page already has'),
    representation,
    ...allowWriteField,
  }),
  writes: true,
  args: [idArg],
  options: [
    { flags: '--title <title>', field: 'title', description: 'New page title' },
    { flags: '--body <html>', field: 'body', description: 'New page body (storage-format XHTML, or wiki markup with --representation wiki)' },
    { flags: '--body-file <path>', field: 'bodyFile', description: "Path to a file containing the new page body ('-' = stdin)" },
    { flags: '--status <status>', field: 'status', description: 'Page status: current (default) or draft, which deletes any draft the page already has' },
    representationOption,
  ],
  examples: [
    { id: '12345', body: '<p>Updated.</p>', allowWrite: true },
    { id: '12345', title: 'Renamed', allowWrite: true },
    { id: '12345', bodyFile: 'runbook.html', status: 'draft', allowWrite: true },
    { id: '12345', body: 'h1. Heading', representation: 'wiki', allowWrite: true },
  ],
  run: async (input, ctx) => {
    const body = await bodyOf(ctx.files, input.body, input.bodyFile);
    if (body === undefined && input.representation !== undefined) {
      throw new ToilError('INVALID_INPUT', '--representation needs --body or --body-file', { fix: 'Pass the new body, or leave out --representation.' });
    }
    const current = (await client.getPage(ctx, input.id)) as { title: string; version?: { number?: number } };
    const number = current.version?.number;
    if (typeof number !== 'number') {
      throw new ToilError('HTTP', `Confluence Cloud returned page ${input.id} without a version number, so toil can't send the next one.`, { fix: 'Check the id is a page id, then try again.' });
    }
    const kept = storageOf(current);
    if (body === undefined && kept === undefined) {
      throw new ToilError('HTTP', `Confluence Cloud returned page ${input.id} without its storage body, which an update has to resend.`, { fix: 'Pass the body with --body or --body-file.' });
    }
    const status = input.status ?? 'current';
    const page = await client.updatePage(ctx, input.id, {
      // Atlassian: the current number plus one, except a change to draft, which is version 1.
      version: status === 'draft' ? 1 : number + 1,
      title: input.title ?? current.title,
      status,
      body: body ?? kept!,
      representation: body === undefined ? 'storage' : (input.representation ?? 'storage'),
    });
    return withBodyText(page);
  },
});

export const deletePage = confluenceArea.command({
  path: ['confluence', 'page', 'delete'],
  description: 'Delete a Confluence Cloud page (moves it to the trash; does not purge it)',
  input: z.object({ id, ...allowWriteField }),
  writes: true,
  mcp: false,
  args: [idArg],
  examples: [{ id: '12345', allowWrite: true }],
  run: async (input, ctx) => {
    await client.deletePage(ctx, input.id);
    return { deleted: input.id };
  },
});

export const pageCommands = [getPage, getPageByTitle, listPages, getPageChildren, getPageHistory, search, createPage, updatePage, deletePage];
