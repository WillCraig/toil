import type { z } from 'zod';
import type { Connection } from '../../../core/area.js';
import type { CommandContext } from '../../../core/context.js';
import { apiRequest } from '../../../core/api.js';
import { ToilError } from '../../../core/errors.js';
import { paginate, type Paged } from '../../../core/paginate.js';
import { repointUrl, type QueryParam } from '../../../core/rest.js';
import { confluenceArea } from '../area.js';

/**
 * Every request toil sends to Confluence Cloud, each from Atlassian's REST
 * API v2 reference (https://developer.atlassian.com/cloud/confluence/rest/v2/)
 * or, where v2 has no endpoint, the v1 reference
 * (https://developer.atlassian.com/cloud/confluence/rest/v1/). Commands say
 * what they want; this module knows the endpoints, the cursor paging, and how
 * a space key becomes the numeric space id v2 insists on. The key is still
 * printed on the door; the id is what the building register goes by.
 */

export type ConfluenceCloudConnection = Connection<z.output<typeof confluenceArea.connection>>;
export type ConfluenceCloudContext = CommandContext<ConfluenceCloudConnection>;

const V2 = '/wiki/api/v2';
const V1 = '/wiki/rest/api';
/** Items per v2 list request: the documented maximum, so a full list takes the fewest calls. */
export const PAGE = 250;

/**
 * An id put into a URL path as one segment. Confluence Cloud ids are letters
 * and digits (`12345`, `att98765`), so anything else is refused before a
 * request is sent: a `/`, `\`, `?`, `#`, `;`, `%` or `.` could make the path
 * name a different resource (a page delete becoming something else), and
 * refusing them all is simpler than deciding which spellings a server
 * decodes (principle 2). Labels never go in a path; they're a query value.
 */
export function seg(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ToilError('INVALID_INPUT', `"${value}" isn't a Confluence Cloud id: ids are letters and digits, with no /, \\, ?, #, ;, % or dots.`, {
      fix: 'Pass the plain id: a page id such as 12345, or an attachment id such as att98765.',
    });
  }
  return value;
}

interface Request {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, QueryParam>;
  body?: unknown;
}

export function confluenceCloud<T>(ctx: ConfluenceCloudContext, path: string, req: Request = {}): Promise<T> {
  return apiRequest<T>(confluenceArea, ctx, path, {
    method: req.method ?? 'GET',
    ...(req.query ? { query: req.query } : {}),
    ...(req.body !== undefined ? { json: req.body } : {}),
  });
}

interface V2List<T> {
  results?: T[];
  _links?: { next?: string };
}

/** The `cursor` parameter of a `_links.next` URL (`/wiki/api/v2/pages?cursor=…&limit=25`), if there is one. */
export function cursorOf(next: unknown): string | undefined {
  if (typeof next !== 'string') return undefined;
  const query = next.split('#', 1)[0]!.split('?')[1];
  return new URLSearchParams(query ?? '').get('cursor') || undefined;
}

/**
 * A v2 cursor list: each request carries the query and `limit`, plus the
 * cursor from the previous page's `_links.next`, and the list ends when there
 * is no next link. The cursor is sent as a parameter on the path toil chose,
 * never by following the link, so the request stays on the configured site.
 * With `cap`, it stops at that many and meta.page says where to carry on.
 */
export function list<T>(
  ctx: ConfluenceCloudContext,
  what: string,
  path: string,
  query: Record<string, QueryParam>,
  opts: { cap?: number | undefined; cursor?: string | undefined } = {},
): Promise<Paged<T>> {
  const limit = Math.min(PAGE, opts.cap ?? PAGE);
  return paginate<T>(
    { kind: 'nextPageKey', param: 'cursor', key: (body) => cursorOf((body as V2List<T>)._links?.next), items: (body) => (body as V2List<T>).results ?? [] },
    async (paging) => ({ body: await confluenceCloud(ctx, path, { query: { ...query, limit, ...paging } }) }),
    { what, ...(opts.cap !== undefined ? { cap: opts.cap, setPage: ctx.setPage } : {}), ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}) },
  );
}

/** Every item of a v2 list. */
async function every<T>(ctx: ConfluenceCloudContext, what: string, path: string, query: Record<string, QueryParam> = {}): Promise<T[]> {
  return (await list<T>(ctx, what, path, query)).items;
}

export interface Space {
  id: string;
  key: string;
  [key: string]: unknown;
}

// GET /wiki/api/v2/spaces?keys=KEY: v2 addresses spaces by numeric id, so a key is looked up first.
export async function getSpace(ctx: ConfluenceCloudContext, key: string): Promise<Space> {
  const result = await confluenceCloud<V2List<Space>>(ctx, `${V2}/spaces`, { query: { keys: key, 'description-format': 'plain' } });
  // Only the space with that key, never whatever came first: a wrong space would take the page.
  const space = result.results?.find((s) => s.key === key);
  if (!space) {
    throw new ToilError('NOT_FOUND', `Confluence Cloud space not found: ${key}`, {
      fix: 'Check the space key (it is case-sensitive). toil confluence space list lists the spaces this account can see.',
    });
  }
  return space;
}

// POST /wiki/api/v2/spaces: a key, a name and an optional plain-text description.
export function createSpace(ctx: ConfluenceCloudContext, opts: { key: string; name: string; description?: string | undefined }): Promise<Space> {
  return confluenceCloud(ctx, `${V2}/spaces`, {
    method: 'POST',
    body: { key: opts.key, name: opts.name, ...(opts.description !== undefined ? { description: { value: opts.description, representation: 'plain' } } : {}) },
  });
}

// GET /wiki/api/v2/spaces
export function listSpaces(ctx: ConfluenceCloudContext, opts: { type?: string | undefined; cap?: number | undefined; cursor?: string | undefined }): Promise<Paged<Space>> {
  return list<Space>(ctx, 'Confluence Cloud spaces', `${V2}/spaces`, opts.type ? { type: opts.type } : {}, opts);
}

// GET /wiki/api/v2/pages/{id}?body-format=storage
export function getPage(ctx: ConfluenceCloudContext, id: string): Promise<Record<string, unknown>> {
  return confluenceCloud(ctx, `${V2}/pages/${seg(id)}`, { query: { 'body-format': 'storage' } });
}

// GET /wiki/api/v2/pages?space-id=…&title=…: an exact title match, as the API defines it.
export async function getPageByTitle(ctx: ConfluenceCloudContext, spaceId: string, title: string): Promise<Record<string, unknown> | null> {
  const result = await confluenceCloud<V2List<Record<string, unknown>>>(ctx, `${V2}/pages`, { query: { 'space-id': spaceId, title, 'body-format': 'storage' } });
  return result.results?.[0] ?? null;
}

// GET /wiki/api/v2/spaces/{id}/pages
export function listPages(ctx: ConfluenceCloudContext, spaceId: string, opts: { cap?: number | undefined; cursor?: string | undefined }): Promise<Paged<unknown>> {
  return list(ctx, `Confluence Cloud pages in space ${spaceId}`, `${V2}/spaces/${seg(spaceId)}/pages`, {}, opts);
}

// GET /wiki/api/v2/pages/{id}/direct-children: /children is deprecated, and this one also lists folders, whiteboards, databases and embeds.
export function getPageChildren(ctx: ConfluenceCloudContext, id: string): Promise<unknown[]> {
  return every(ctx, `Confluence Cloud children of page ${id}`, `${V2}/pages/${seg(id)}/direct-children`);
}

// GET /wiki/api/v2/pages/{id}/versions
export function getPageVersions(ctx: ConfluenceCloudContext, id: string): Promise<unknown[]> {
  return every(ctx, `Confluence Cloud versions of page ${id}`, `${V2}/pages/${seg(id)}/versions`);
}

/**
 * GET /wiki/rest/api/search: v1, since v2 has no CQL. One page, as the
 * server returns it; its `_links.next` carries the cursor for the next.
 */
export function search(ctx: ConfluenceCloudContext, cql: string, opts: { limit: number; cursor?: string | undefined; expand?: string | undefined }): Promise<{ _links?: { next?: string } } & Record<string, unknown>> {
  return confluenceCloud(ctx, `${V1}/search`, { query: { cql, limit: opts.limit, ...(opts.cursor ? { cursor: opts.cursor } : {}), ...(opts.expand ? { expand: opts.expand } : {}) } });
}

export type Representation = 'storage' | 'wiki';

// POST /wiki/api/v2/pages
export function createPage(ctx: ConfluenceCloudContext, opts: { spaceId: string; title: string; body: string; parentId?: string | undefined; representation: Representation }): Promise<Record<string, unknown>> {
  return confluenceCloud(ctx, `${V2}/pages`, {
    method: 'POST',
    body: {
      spaceId: opts.spaceId,
      status: 'current',
      title: opts.title,
      ...(opts.parentId ? { parentId: opts.parentId } : {}),
      body: { representation: opts.representation, value: opts.body },
    },
  });
}

// PUT /wiki/api/v2/pages/{id}: id, status, title, body and version are all required.
export function updatePage(
  ctx: ConfluenceCloudContext,
  id: string,
  opts: { version: number; title: string; status: 'current' | 'draft'; body: string; representation: Representation },
): Promise<Record<string, unknown>> {
  return confluenceCloud(ctx, `${V2}/pages/${seg(id)}`, {
    method: 'PUT',
    body: { id, status: opts.status, title: opts.title, body: { representation: opts.representation, value: opts.body }, version: { number: opts.version } },
  });
}

// DELETE /wiki/api/v2/pages/{id}: to the trash, not purged.
export async function deletePage(ctx: ConfluenceCloudContext, id: string): Promise<void> {
  await confluenceCloud<void>(ctx, `${V2}/pages/${seg(id)}`, { method: 'DELETE' });
}

// GET /wiki/api/v2/pages/{id}/footer-comments: top-level footer comments, as Data Center's list has them.
export function listComments(ctx: ConfluenceCloudContext, pageId: string): Promise<unknown[]> {
  return every(ctx, `Confluence Cloud comments on page ${pageId}`, `${V2}/pages/${seg(pageId)}/footer-comments`, { 'body-format': 'storage' });
}

// POST /wiki/api/v2/footer-comments
export function addComment(ctx: ConfluenceCloudContext, pageId: string, body: string, representation: Representation): Promise<Record<string, unknown>> {
  return confluenceCloud(ctx, `${V2}/footer-comments`, { method: 'POST', body: { pageId, body: { representation, value: body } } });
}

// GET /wiki/api/v2/pages/{id}/labels
export function getLabels(ctx: ConfluenceCloudContext, pageId: string): Promise<unknown[]> {
  return every(ctx, `Confluence Cloud labels on page ${pageId}`, `${V2}/pages/${seg(pageId)}/labels`);
}

// POST /wiki/rest/api/content/{id}/label: v1, since v2 only reads labels.
export async function addLabels(ctx: ConfluenceCloudContext, pageId: string, labels: string[]): Promise<unknown[] | undefined> {
  const result = await confluenceCloud<{ results?: unknown[] }>(ctx, `${V1}/content/${seg(pageId)}/label`, { method: 'POST', body: labels.map((name) => ({ prefix: 'global', name })) });
  return result.results;
}

// DELETE /wiki/rest/api/content/{id}/label?name=…: the query form, so a label is never a path segment.
export async function removeLabel(ctx: ConfluenceCloudContext, pageId: string, label: string): Promise<void> {
  await confluenceCloud<void>(ctx, `${V1}/content/${seg(pageId)}/label`, { method: 'DELETE', query: { name: label } });
}

// GET /wiki/api/v2/pages/{id}/attachments
export function listAttachments(ctx: ConfluenceCloudContext, pageId: string): Promise<unknown[]> {
  return every(ctx, `Confluence Cloud attachments on page ${pageId}`, `${V2}/pages/${seg(pageId)}/attachments`);
}

/** POST /wiki/rest/api/content/{id}/child/attachment: v1, since v2 can't upload. Always a new attachment. */
export async function uploadAttachment(ctx: ConfluenceCloudContext, pageId: string, fileName: string, data: Uint8Array, comment?: string): Promise<unknown[] | undefined> {
  const result = await apiRequest<{ results?: unknown[] }>(confluenceArea, ctx, `${V1}/content/${seg(pageId)}/child/attachment`, {
    method: 'POST',
    // The XSRF check Confluence documents for multipart uploads.
    headers: { 'X-Atlassian-Token': 'nocheck' },
    multipart: [{ name: 'file', fileName, data }, ...(comment ? [{ name: 'comment', value: comment }] : [])],
  });
  return result.results;
}

export interface Attachment {
  id: string;
  title: string;
  downloadLink?: string;
  [key: string]: unknown;
}

// GET /wiki/api/v2/attachments/{id}
export function getAttachment(ctx: ConfluenceCloudContext, id: string): Promise<Attachment> {
  return confluenceCloud<Attachment>(ctx, `${V2}/attachments/${seg(id)}`);
}

/**
 * The attachment's bytes, from its `downloadLink`, which v2 gives relative to
 * the site's `/wiki`. The request goes to the configured site with the
 * credential; Confluence answers with a redirect to a signed URL on
 * Atlassian's media host, which toil follows with every header dropped, so
 * the credential never leaves the site. An absolute link on another host is
 * re-pointed at baseUrl with a warning.
 */
export async function downloadAttachment(ctx: ConfluenceCloudContext, attachment: Attachment): Promise<Uint8Array> {
  const link = attachment.downloadLink;
  if (!link) {
    throw new ToilError('NOT_FOUND', `Attachment ${attachment.id} has no download link (title: ${attachment.title}).`, {
      fix: 'Check the id is an attachment id from toil confluence page attachments <page-id>.',
    });
  }
  const target = /^[a-z][a-z0-9+.-]*:/i.test(link)
    ? repointUrl(link, ctx.connection.baseUrl, ctx.warn, {
        service: 'Confluence Cloud',
        subject: 'attachment',
        code: 'CONFLUENCE_CLOUD_ATTACHMENT_HOST',
        fix: 'Download it from the Confluence web interface instead.',
      })
    : `/wiki${link.startsWith('/') ? '' : '/'}${link}`;
  return apiRequest<Uint8Array>(confluenceArea, ctx, target, { as: 'bytes', redirect: 'follow-without-auth' });
}

// DELETE /wiki/api/v2/attachments/{id}: to the trash, not purged.
export async function deleteAttachment(ctx: ConfluenceCloudContext, id: string): Promise<void> {
  await confluenceCloud<void>(ctx, `${V2}/attachments/${seg(id)}`, { method: 'DELETE' });
}
