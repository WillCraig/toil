import type { z } from 'zod';
import type { Connection } from '../../../core/area.js';
import type { CommandContext } from '../../../core/context.js';
import { apiRequest } from '../../../core/api.js';
import { apiPath } from '../../../core/api-path.js';
import { ToilError } from '../../../core/errors.js';
import { paginate } from '../../../core/paginate.js';
import { repointUrl, type QueryValue } from '../../../core/rest.js';
import { confluenceArea } from '../area.js';

/**
 * Every request toil sends to Confluence Data Center, sent exactly as the
 * command contract specifies: the same endpoints, the same headers,
 * the same `expand` lists (commas left literal, which core's URL builder
 * does). Ids, space keys and labels go into the path encoded as one
 * segment each (apiPath), so a label with a / in it is still one label.
 * The paging loop, re-pointing and multipart are core's. A request that works is not
 * reworded; rewording it would need a review, and the review would need a
 * meeting.
 */

export type ConfluenceConnection = Connection<z.output<typeof confluenceArea.connection>>;
export type ConfluenceContext = CommandContext<ConfluenceConnection>;

const API = '/rest/api';
/** The page size the contract specifies for every list. */
const PAGE = 25;
/** The per-request timeouts the contract specifies: JSON calls, and attachment transfers. */
const TIMEOUT_MS = 30_000;
const TRANSFER_TIMEOUT_MS = 60_000;

/** What every JSON call sends besides the hook's token, exactly as the contract specifies. */
const JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json', Connection: 'close' };

export interface ConfluenceAttachment {
  id: string;
  title: string;
  _links: { download?: string; [key: string]: unknown };
  [key: string]: unknown;
}

interface ConfluenceList<T> {
  results?: T[];
  size?: number;
  _links?: { next?: string };
}

interface ConfluenceRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, QueryValue>;
  body?: unknown;
}

export function confluence<T>(ctx: ConfluenceContext, path: string, req: ConfluenceRequest = {}): Promise<T> {
  return apiRequest<T>(confluenceArea, ctx, `${API}${path}`, {
    method: req.method ?? 'GET',
    headers: JSON_HEADERS,
    timeoutMs: TIMEOUT_MS,
    ...(req.params ? { query: req.params } : {}),
    ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
  });
}

/**
 * Every item of a `start`/`limit` list, 25 a page, read as the contract
 * specifies: it stops when a page has no `_links.next`, and with `max` it stops
 * once that many are in hand, asking the last page only for what's left.
 * `max` is used as parseInt left it: 0, a negative number
 * or NaN still pages, and the result is cut with `slice(0, max)`, so NaN
 * returns nothing at all (#78 item 9). `first` offsets every request, as
 * `page list --start` specifies.
 */
async function every<T>(
  what: string,
  fetchPage: (start: number, limit: number) => Promise<ConfluenceList<T>>,
  opts: { max?: number | undefined; first?: number | undefined } = {},
): Promise<T[]> {
  const first = opts.first ?? 0;
  const max = opts.max;
  const { items } = await paginate<T>(
    {
      kind: 'offset',
      startParam: 'start',
      limitParam: 'limit',
      pageSize: PAGE,
      first,
      items: (body) => (body as ConfluenceList<T>).results ?? [],
      // No next link ends the list; so does reaching max. The offset style
      // stops once the next offset reaches what this returns.
      total: (body) => (!(body as ConfluenceList<T>)._links?.next ? -Infinity : max === undefined ? undefined : first + max),
    },
    async (params) => {
      const got = Number(params.start) - first;
      const limit = max === undefined ? PAGE : Math.min(max - got, PAGE);
      return { body: await fetchPage(first + got, limit) };
    },
    { what },
  );
  return max === undefined ? items : items.slice(0, max);
}

/**
 * A `--limit` parseInt couldn't make a positive number of: the result is cut
 * as specified (usually to nothing, #78 items 9 and 10), and a warning says why,
 * so an empty list isn't mistaken for an empty space.
 */
export function warnBadLimit(ctx: ConfluenceContext, raw: number | string | undefined, max: number | undefined, items: unknown[]): unknown[] {
  if (max !== undefined && !(max >= 1)) {
    ctx.warn({
      code: 'CONFLUENCE_LIMIT_INVALID',
      message: `--limit must be a positive whole number, not "${String(raw)}"; the result was cut to ${items.length} item(s).`,
    });
  }
  return items;
}

export function getPage(ctx: ConfluenceContext, id: string, expand: string): Promise<unknown> {
  return confluence(ctx, apiPath`/content/${id}`, { params: { expand } });
}

export async function getPageByTitle(ctx: ConfluenceContext, spaceKey: string, title: string): Promise<unknown> {
  const result = await confluence<ConfluenceList<unknown>>(ctx, '/content', { params: { spaceKey, title, expand: 'body.storage,version,space', type: 'page' } });
  return result.results?.[0] ?? null;
}

export function listPages(ctx: ConfluenceContext, spaceKey: string, opts: { max?: number | undefined; start?: number | undefined }): Promise<unknown[]> {
  return every(
    `Confluence pages in space ${spaceKey}`,
    (start, limit) => confluence(ctx, '/content', { params: { spaceKey, type: 'page', expand: 'version', start, limit } }),
    { max: opts.max, first: opts.start },
  );
}

export function getPageChildren(ctx: ConfluenceContext, id: string): Promise<unknown[]> {
  return every(`Confluence child pages of ${id}`, (start, limit) => confluence(ctx, apiPath`/content/${id}/child/page`, { params: { expand: 'version', start, limit } }));
}

export function getLabels(ctx: ConfluenceContext, id: string): Promise<unknown[]> {
  return every(`Confluence labels on ${id}`, (start, limit) => confluence(ctx, apiPath`/content/${id}/label`, { params: { start, limit } }));
}

export function search(ctx: ConfluenceContext, cql: string, opts: { start: number; limit: number; expand?: string | undefined }): Promise<unknown> {
  return confluence(ctx, '/content/search', { params: { cql, start: opts.start, limit: opts.limit, ...(opts.expand ? { expand: opts.expand } : {}) } });
}

export function createPage(ctx: ConfluenceContext, opts: { spaceKey: string; title: string; body: string; parentId?: string | undefined; representation: string }): Promise<unknown> {
  return confluence(ctx, '/content', {
    method: 'POST',
    body: {
      type: 'page',
      title: opts.title,
      space: { key: opts.spaceKey },
      ancestors: opts.parentId ? [{ id: opts.parentId }] : [],
      // Every representation goes under `storage`, wiki included (#78 item 7).
      body: { storage: { value: opts.body, representation: opts.representation } },
    },
  });
}

export function updatePage(ctx: ConfluenceContext, id: string, opts: { version: number; title: string; body?: string | undefined; status: string; representation: string }): Promise<unknown> {
  const body: Record<string, unknown> = { version: { number: opts.version }, type: 'page', title: opts.title, status: opts.status };
  // No body given means no body sent, even for a title-only rename (#78 item 6).
  if (opts.body !== undefined) body.body = { storage: { value: opts.body, representation: opts.representation } };
  return confluence(ctx, apiPath`/content/${id}`, { method: 'PUT', body });
}

/** DELETE on any content id: a page, or an attachment, which goes to the trash. */
export async function deleteContent(ctx: ConfluenceContext, id: string): Promise<void> {
  await confluence<void>(ctx, apiPath`/content/${id}`, { method: 'DELETE' });
}

/** Top-level comments only: no `depth` is sent (#78 item 3). */
export function listComments(ctx: ConfluenceContext, pageId: string): Promise<unknown[]> {
  return every(`Confluence comments on ${pageId}`, (start, limit) => confluence(ctx, apiPath`/content/${pageId}/child/comment`, { params: { expand: 'body.storage,version', start, limit } }));
}

/** The container is always a page, whatever the id is (#78 item 8). */
export function addComment(ctx: ConfluenceContext, pageId: string, body: string, representation: string): Promise<unknown> {
  return confluence(ctx, '/content', {
    method: 'POST',
    body: { type: 'comment', container: { id: pageId, type: 'page' }, body: { storage: { value: body, representation } } },
  });
}

export async function addLabels(ctx: ConfluenceContext, pageId: string, labels: string[]): Promise<unknown[] | undefined> {
  const result = await confluence<ConfluenceList<unknown>>(ctx, apiPath`/content/${pageId}/label`, { method: 'POST', body: labels.map((name) => ({ prefix: 'global', name })) });
  return result.results;
}

export async function removeLabel(ctx: ConfluenceContext, pageId: string, label: string): Promise<void> {
  await confluence<void>(ctx, apiPath`/content/${pageId}/label/${label}`, { method: 'DELETE' });
}

export function listSpaces(ctx: ConfluenceContext, opts: { type?: string | undefined; max?: number | undefined }): Promise<unknown[]> {
  return every('Confluence spaces', (start, limit) => confluence(ctx, '/space', { params: { start, limit, ...(opts.type ? { type: opts.type } : {}) } }), { max: opts.max });
}

export function getSpace(ctx: ConfluenceContext, key: string): Promise<unknown> {
  return confluence(ctx, apiPath`/space/${key}`, { params: { expand: 'description.plain' } });
}

// POST /rest/api/space: a global space, with an optional plain-text description.
export function createSpace(ctx: ConfluenceContext, opts: { key: string; name: string; description?: string | undefined }): Promise<unknown> {
  return confluence(ctx, '/space', {
    method: 'POST',
    body: { key: opts.key, name: opts.name, ...(opts.description !== undefined ? { description: { plain: { value: opts.description, representation: 'plain' } } } : {}) },
  });
}

export function listAttachments(ctx: ConfluenceContext, pageId: string): Promise<unknown[]> {
  return every(`Confluence attachments on ${pageId}`, (start, limit) => confluence(ctx, apiPath`/content/${pageId}/child/attachment`, { params: { start, limit } }));
}

export async function uploadAttachment(ctx: ConfluenceContext, pageId: string, fileName: string, data: Uint8Array, comment?: string): Promise<unknown[] | undefined> {
  // Always a new attachment: a file name already on the page isn't versioned (#78 item 5).
  const result = await apiRequest<ConfluenceList<unknown>>(confluenceArea, ctx, apiPath`/rest/api/content/${pageId}/child/attachment`, {
    method: 'POST',
    headers: { 'X-Atlassian-Token': 'no-check', Accept: 'application/json', Connection: 'close' },
    multipart: [{ name: 'file', fileName, data }, ...(comment ? [{ name: 'comment', value: comment }] : [])],
    timeoutMs: TRANSFER_TIMEOUT_MS,
  });
  return result.results;
}

export function getAttachment(ctx: ConfluenceContext, id: string): Promise<ConfluenceAttachment> {
  return confluence<ConfluenceAttachment>(ctx, apiPath`/content/${id}`);
}

/**
 * The attachment's bytes, from the `_links.download` path Confluence hands
 * back. A relative one, the usual shape, resolves under baseUrl and keeps its
 * context path. An absolute one names a host of the server's
 * choosing, so its origin is re-pointed at baseUrl's with a warning: the
 * token only ever goes to the host the user configured.
 */
export async function downloadAttachment(ctx: ConfluenceContext, attachment: ConfluenceAttachment): Promise<Uint8Array> {
  const link = attachment._links?.download;
  // /content/{id} answers for any content, so a page id gets here with no link.
  if (!link) {
    throw new ToilError('INVALID_INPUT', `Content ${attachment.id} has no download link — is it an attachment? (title: ${attachment.title})`, {
      fix: 'Pass an attachment id. toil confluence page attachments <page-id> lists them.',
    });
  }
  const target = /^[a-z][a-z0-9+.-]*:/i.test(link)
    ? repointUrl(link, ctx.connection.baseUrl, ctx.warn, {
        service: 'Confluence',
        subject: 'attachment',
        code: 'CONFLUENCE_ATTACHMENT_HOST',
        fix: 'Download it from the Confluence web interface instead.',
      })
    : link;
  return apiRequest<Uint8Array>(confluenceArea, ctx, target, { headers: { Connection: 'close' }, as: 'bytes', timeoutMs: TRANSFER_TIMEOUT_MS });
}

export function getPageHistory(ctx: ConfluenceContext, id: string): Promise<unknown> {
  return confluence(ctx, apiPath`/content/${id}/history`);
}

