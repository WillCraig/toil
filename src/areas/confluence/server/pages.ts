import { z } from 'zod';
import type { Warning } from '../../../core/envelope.js';
import { ToilError } from '../../../core/errors.js';
import type { FileAccess } from '../../../core/files.js';
import { allowWriteField } from '../../../core/run.js';
import { confluenceArea } from '../area.js';
import * as client from './client.js';
import { withBodyHints } from './hints.js';

/**
 * Pages: read one by id or title, list a space or a parent's children, read
 * the history, search with CQL, and create, update or delete. Bodies are sent
 * in storage format unless `--representation` says otherwise, and `--markdown`
 * converts first, on this machine. Ids are typed as text, because a page id
 * is a number in the way a ticket number is a number.
 */

const id = z.string().describe('Page ID');
const idArg = { name: 'id', field: 'id', description: 'Page ID' };
/** A number read with parseInt: text stays text until then. */
const intText = z.union([z.number(), z.string()]);

const DEFAULT_EXPAND = 'body.storage,version,space,ancestors';

/** `parseInt` of a flag that was only read when set (a non-empty string), as the contract specifies. */
const optionalInt = (value: number | string | undefined) => (value === undefined || value === '' ? undefined : parseInt(String(value), 10));

export const getPage = confluenceArea.command({
  path: ['confluence', 'page', 'get'],
  description: 'Get a Confluence page by ID',
  input: z.object({
    id,
    expand: z.string().optional().describe(`Comma-separated fields to expand (default: "${DEFAULT_EXPAND}")`),
  }),
  writes: false,
  args: [idArg],
  options: [{ flags: '--expand <fields>', field: 'expand', description: `Comma-separated fields to expand (default: "${DEFAULT_EXPAND}")` }],
  examples: [{ id: '12345' }, { id: '12345', expand: 'body.view,version' }],
  run: (input, ctx) => client.getPage(ctx, input.id, input.expand ?? DEFAULT_EXPAND),
});

export const getPageByTitle = confluenceArea.command({
  path: ['confluence', 'page', 'find'],
  description: 'Find a Confluence page by space key and title',
  input: z.object({ space: z.string().describe('Space key'), title: z.string().describe('Page title') }),
  writes: false,
  options: [
    { flags: '--space <key>', field: 'space', description: 'Space key' },
    { flags: '--title <title>', field: 'title', description: 'Page title' },
  ],
  examples: [{ space: 'DOCS', title: 'Release notes' }],
  run: async (input, ctx) => {
    const page = await client.getPageByTitle(ctx, input.space, input.title);
    if (!page) {
      throw new ToilError('NOT_FOUND', `Page not found: "${input.title}" in space ${input.space}`, {
        fix: `Check the title (it must match exactly) and the space key. toil confluence page search --cql 'space=${input.space} AND title~"…"' finds near matches.`,
      });
    }
    return page;
  },
});

export const listPages = confluenceArea.command({
  path: ['confluence', 'page', 'list'],
  description: 'List pages in a Confluence space (consider --output-file for large results)',
  toolDescription: 'Lists the pages in a Confluence space (id, title, version). Without limit it returns every page, which can be large; set limit to bound it.',
  input: z.object({
    space: z.string().describe('Space key'),
    limit: intText.optional().describe('Max total pages to return (default: all)'),
    offset: intText.optional().describe('Offset for first result'),
  }),
  writes: false,
  options: [
    { flags: '--space <key>', field: 'space', description: 'Space key' },
    { flags: '--limit <n>', field: 'limit', description: 'Max total pages to return (default: all)' },
    { flags: '--offset <n>', field: 'offset', description: 'Offset for first result' },
  ],
  examples: [{ space: 'DOCS' }, { space: 'DOCS', limit: '30', offset: '5' }],
  run: async (input, ctx) => {
    const max = optionalInt(input.limit);
    return client.warnBadLimit(ctx, input.limit, max, await client.listPages(ctx, input.space, { max, start: optionalInt(input.offset) }));
  },
});

export const getPageChildren = confluenceArea.command({
  path: ['confluence', 'page', 'children'],
  description: 'Get child pages of a Confluence page',
  input: z.object({ id: z.string().describe('Parent page ID') }),
  writes: false,
  args: [{ name: 'id', field: 'id', description: 'Parent page ID' }],
  examples: [{ id: '12345' }],
  run: (input, ctx) => client.getPageChildren(ctx, input.id),
});

export const getPageHistory = confluenceArea.command({
  path: ['confluence', 'page', 'history'],
  description: 'Get the version history metadata for a Confluence page',
  input: z.object({ id }),
  writes: false,
  args: [idArg],
  examples: [{ id: '12345' }],
  run: (input, ctx) => client.getPageHistory(ctx, input.id),
});

export const search = confluenceArea.command({
  path: ['confluence', 'page', 'search'],
  description: 'Search Confluence with CQL',
  toolDescription: "Runs a CQL query and returns Confluence's search result as it came (results, start, limit, size). One page: raise limit or advance offset for more.",
  input: z.object({
    cql: z.string().describe('CQL query string (e.g. "space=PROJ AND type=page")'),
    limit: intText.optional().describe('Maximum number of results (default: "25")'),
    offset: intText.optional().describe('Offset for first result (default: "0")'),
    expand: z.string().optional().describe('Comma-separated fields to expand'),
  }),
  writes: false,
  options: [
    { flags: '--cql <query>', field: 'cql', description: 'CQL query string (e.g. "space=PROJ AND type=page")' },
    { flags: '--limit <n>', field: 'limit', description: 'Maximum number of results (default: "25")' },
    { flags: '--offset <n>', field: 'offset', description: 'Offset for first result (default: "0")' },
    { flags: '--expand <fields>', field: 'expand', description: 'Comma-separated fields to expand' },
  ],
  examples: [{ cql: 'space=DOCS AND type=page' }, { cql: 'text~"runbook"', limit: '10', offset: '20', expand: 'space,version' }],
  run: (input, ctx) =>
    client.search(ctx, input.cql, {
      limit: parseInt(String(input.limit ?? '25'), 10),
      start: parseInt(String(input.offset ?? '0'), 10),
      expand: input.expand,
    }),
});

const representation = z.string().optional().describe('Body format: storage (default) or wiki (default: "storage")');
const representationOption = { flags: '--representation <format>', field: 'representation', description: 'Body format: storage (default) or wiki (default: "storage")' };
const markdown = z.boolean().optional().describe('Convert body from Markdown to storage format on this machine first (as util md --to storage does)');
const markdownOption = { flags: '--markdown', field: 'markdown', description: 'Convert body from Markdown to storage format on this machine first (as util md --to storage does)' };

/**
 * Markdown to storage format with the converter `util md --to storage` runs,
 * which reads its output back as XML before returning it, so the body sent is
 * well-formed (#519). Confluence's convert endpoint doesn't document Markdown
 * (#78 item 2), and kept the `>` of an autolink in its href (#78 item 10).
 * What storage format can't hold, and any block that didn't survive the round
 * trip, arrives as a warning (MD_LOSSY, MD_ROUNDTRIP_MISMATCH).
 */
async function toStorage(ctx: { warn: (w: Warning) => void; signal?: AbortSignal | undefined }, text: string): Promise<string> {
  const { convertMarkdown } = await import('../../util/md/convert.js');
  // The completeness check (input.complete) compares bytes read with bytes expected; the body was read in full, so both are its length.
  // util md's 4 MB input cap doesn't apply here: MD_LIMITS bound the work in the worker.
  const bytes = Buffer.byteLength(text, 'utf8');
  const source = { source: { kind: 'text' as const }, label: 'the page body', expectedBytes: bytes, bytesRead: bytes, truncated: false };
  const converted = await convertMarkdown({ to: 'storage', text, source }, ctx);
  // Some Confluence versions throw on a macro with no ac:macro-id (hints.ts), and a person who wrote Markdown can't add one.
  // Code text sits raw inside CDATA (storage.ts), so only the markup between CDATA sections is touched: odd parts of the split are CDATA.
  return (converted.output as string)
    .split(/(<!\[CDATA\[[\s\S]*?\]\]>)/)
    .map((part, k) => (k % 2 === 1 ? part : part.replace(/<ac:structured-macro(?![^>]*\bac:macro-id\b)/g, () => `<ac:structured-macro ac:macro-id="${globalThis.crypto.randomUUID()}"`)))
    .join('');
}

/**
 * `--body` or the text of `--body-file` (`-` is stdin on the CLI), or
 * undefined for neither; both is refused. The file is read as it is, with no
 * trimming.
 */
async function bodyOf(files: FileAccess, body: string | undefined, bodyFile: string | undefined): Promise<string | undefined> {
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
  description: 'Create a new Confluence page',
  toolDescription: 'Creates a page in a space, optionally under a parent page, and returns the page Confluence created. The body is storage-format XHTML unless markdown or representation says otherwise.',
  input: z.object({
    space: z.string().describe('Space key'),
    title: z.string().describe('Page title'),
    body: z.string().optional().describe('Page body (storage format HTML or Markdown when --markdown is set)'),
    bodyFile: z.string().optional().describe("Path to a file containing the page body ('-' = stdin)"),
    markdown,
    parentId: z.string().optional().describe('Parent page ID (to nest under a page)'),
    representation,
    ...allowWriteField,
  }),
  writes: true,
  options: [
    { flags: '--space <key>', field: 'space', description: 'Space key' },
    { flags: '--title <title>', field: 'title', description: 'Page title' },
    { flags: '--body <html>', field: 'body', description: 'Page body (storage format HTML or Markdown when --markdown is set)' },
    { flags: '--body-file <path>', field: 'bodyFile', description: "Path to a file containing the page body ('-' = stdin)" },
    markdownOption,
    { flags: '--parent-id <id>', field: 'parentId', description: 'Parent page ID (to nest under a page)' },
    representationOption,
  ],
  examples: [
    { space: 'DOCS', title: 'Release notes', body: '<p>Shipped.</p>', parentId: '12345', allowWrite: true },
    { space: 'DOCS', title: 'Runbook', bodyFile: 'runbook.md', markdown: true, allowWrite: true },
    { space: 'DOCS', title: 'Wiki page', body: 'h1. Heading', representation: 'wiki', allowWrite: true },
  ],
  run: async (input, ctx) => {
    let sent: string | undefined;
    try {
      const raw = await bodyOf(ctx.files, input.body, input.bodyFile);
      if (raw === undefined) throw new ToilError('INVALID_INPUT', 'Must specify --body or --body-file', { fix: 'Pass the page body with --body, or a file with --body-file.' });
      sent = input.markdown ? await toStorage(ctx, raw) : raw;
      return await client.createPage(ctx, {
        spaceKey: input.space,
        title: input.title,
        body: sent,
        parentId: input.parentId,
        representation: input.markdown ? 'storage' : (input.representation ?? 'storage'),
      });
    } catch (err) {
      throw withBodyHints(err, sent, Boolean(input.markdown));
    }
  },
});

export const updatePage = confluenceArea.command({
  path: ['confluence', 'page', 'update'],
  description: 'Update a Confluence page (fetches current version automatically)',
  toolDescription: "Updates a page's title, body or status. Reads the current version first and sends the next one, keeping the title unless one is given. With no body, none is sent.",
  input: z.object({
    id,
    title: z.string().optional().describe('New page title'),
    body: z.string().optional().describe('New page body (storage format HTML or Markdown when --markdown is set)'),
    bodyFile: z.string().optional().describe("Path to a file containing the new page body ('-' = stdin)"),
    markdown,
    status: z.string().optional().describe('Page status: current (default) or draft (default: "current")'),
    representation,
    ...allowWriteField,
  }),
  writes: true,
  args: [idArg],
  options: [
    { flags: '--title <title>', field: 'title', description: 'New page title' },
    { flags: '--body <html>', field: 'body', description: 'New page body (storage format HTML or Markdown when --markdown is set)' },
    { flags: '--body-file <path>', field: 'bodyFile', description: "Path to a file containing the new page body ('-' = stdin)" },
    markdownOption,
    { flags: '--status <status>', field: 'status', description: 'Page status: current (default) or draft (default: "current")' },
    representationOption,
  ],
  examples: [
    { id: '12345', body: '<p>Updated.</p>', allowWrite: true },
    { id: '12345', title: 'Renamed', status: 'draft', allowWrite: true },
    { id: '12345', bodyFile: 'runbook.md', markdown: true, allowWrite: true },
    { id: '12345', body: 'h1. Heading', representation: 'wiki', allowWrite: true },
  ],
  run: async (input, ctx) => {
    let sent: string | undefined;
    try {
      const raw = await bodyOf(ctx.files, input.body, input.bodyFile);
      sent = raw !== undefined && input.markdown ? await toStorage(ctx, raw) : raw;
      const current = (await client.getPage(ctx, input.id, 'version')) as { title: string; version: { number: number } };
      return await client.updatePage(ctx, input.id, {
        version: current.version.number + 1,
        title: input.title ?? current.title,
        body: sent,
        status: input.status ?? 'current',
        representation: sent !== undefined && input.markdown ? 'storage' : (input.representation ?? 'storage'),
      });
    } catch (err) {
      throw withBodyHints(err, sent, Boolean(input.markdown));
    }
  },
});

export const deletePage = confluenceArea.command({
  path: ['confluence', 'page', 'delete'],
  description: 'Delete a Confluence page',
  input: z.object({ id, ...allowWriteField }),
  writes: true,
  mcp: false,
  args: [idArg],
  examples: [{ id: '12345', allowWrite: true }],
  run: async (input, ctx) => {
    await client.deleteContent(ctx, input.id);
    return { deleted: input.id };
  },
});

export const pageCommands = [getPage, getPageByTitle, listPages, getPageChildren, getPageHistory, search, createPage, updatePage, deletePage];
