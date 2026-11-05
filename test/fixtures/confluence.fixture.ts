import type { RecordedRequest, Route } from '../harness/fake-fetch.js';
import { defineFixture } from '../harness/fixtures.js';
import * as cloud from './confluence-cloud-data.js';

/**
 * Canned Confluence Data Center responses for every request the confluence
 * examples send, so the parity suite runs every command offline through both
 * front doors.
 *
 * Provenance: the command contract's recorded examples cover only its error hints
 * and attachment-name handling, not response shapes, so every shape here is
 * invented from Atlassian's documented Server REST API (/rest/api content,
 * child content, labels, space, search, attachments),
 * trimmed to the fields that matter. Every page here is at version 3, which
 * is as many revisions as anything gets before it is declared final.
 */

export const CONFLUENCE = 'https://confluence.imagile.dev';
const API = '/rest/api';

const json = (body: unknown, status = 200) => ({ status, json: body });
const empty = { status: 204 };
const links = { base: CONFLUENCE, context: '' };
const user = { type: 'known', username: 'jsmith', userKey: 'abc12345', displayName: 'J. Smith' };
const version = (number: number) => ({ by: user, when: '2026-01-15T09:00:00.000Z', number, minorEdit: false });
const selfLinks = (path: string, webui: string) => ({ webui, self: `${CONFLUENCE}${API}${path}` });

// Invented from the docs: a page as GET /rest/api/content/{id} returns it.
export const page = (id: string, title = 'Release notes', number = 3) => ({
  id,
  type: 'page',
  status: 'current',
  title,
  space: { id: 98304, key: 'DOCS', name: 'Documentation', type: 'global' },
  version: version(number),
  body: { storage: { value: '<p>Shipped.</p>', representation: 'storage' } },
  ancestors: [{ id: '10000', type: 'page', status: 'current', title: 'Home' }],
  _links: { webui: `/display/DOCS/${encodeURIComponent(title)}`, tinyui: '/x/AQID', self: `${CONFLUENCE}${API}/content/${id}` },
  _expandable: { children: `${API}/content/${id}/child`, history: `${API}/content/${id}/history` },
});

// Invented from the docs: an attachment as GET /rest/api/content/{id} returns it.
export const attachment = (id = '98765', title = 'diagram.png') => ({
  id,
  type: 'attachment',
  status: 'current',
  title,
  metadata: { mediaType: 'image/png', fileSize: 4, comment: '' },
  version: version(1),
  _links: {
    webui: `/pages/viewpage.action?pageId=12345&preview=%2F12345%2F${id}%2F${title}`,
    download: `/download/attachments/12345/${title}?version=1&modificationDate=1700000000000&api=v2`,
    self: `${CONFLUENCE}${API}/content/${id}`,
  },
});

/** A start/limit list page: `_links.next` while more remain, as Confluence pages them. */
const listPage = <T>(all: T[], req: RecordedRequest, path: string) => {
  const url = new URL(req.url);
  const start = Number(url.searchParams.get('start') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 25);
  const results = all.slice(start, start + limit);
  const more = start + results.length < all.length;
  return json({
    results,
    start,
    limit,
    size: results.length,
    _links: { ...links, self: `${CONFLUENCE}${path}`, ...(more ? { next: `${path}?start=${start + results.length}&limit=${limit}` } : {}) },
  });
};

const spacePages = Array.from({ length: 40 }, (_, i) => ({ id: String(20000 + i), type: 'page', status: 'current', title: `Page ${i + 1}`, version: version(1), _links: selfLinks(`/content/${20000 + i}`, `/display/DOCS/Page+${i + 1}`) }));
const comments = [
  { id: '30001', type: 'comment', status: 'current', title: 'Re: Release notes', body: { storage: { value: '<p>Looks good.</p>', representation: 'storage' } }, version: version(1), _links: selfLinks('/content/30001', '/display/DOCS/Release+notes?focusedCommentId=30001') },
];
const labels = [
  { prefix: 'global', name: 'runbook', id: '40001' },
  { prefix: 'global', name: 'ops', id: '40002' },
];
const spaces = [
  { id: 98304, key: 'DOCS', name: 'Documentation', type: 'global', _links: selfLinks('/space/DOCS', '/display/DOCS') },
  { id: 98305, key: 'OPS', name: 'Operations', type: 'global', _links: selfLinks('/space/OPS', '/display/OPS') },
  { id: 98306, key: '~jsmith', name: 'J. Smith', type: 'personal', _links: selfLinks('/space/~jsmith', '/display/~jsmith') },
];

export const routes: Route[] = [
  // Pages. The version-only read (update-page) and the others share a path.
  { path: `${API}/content/12345`, query: { expand: 'version' }, respond: json({ id: '12345', type: 'page', status: 'current', title: 'Release notes', version: { number: 3 } }) },
  { path: `${API}/content/12345`, respond: json(page('12345')) },
  { method: 'PUT', path: `${API}/content/12345`, respond: (req: RecordedRequest) => json({ ...page('12345', JSON.parse(req.body!).title, 4), status: JSON.parse(req.body!).status }) },
  { method: 'DELETE', path: `${API}/content/12345`, respond: empty },
  { path: `${API}/content/12345/history`, respond: json({ latest: true, createdBy: user, createdDate: '2025-11-02T10:00:00.000Z', lastUpdated: version(3) }) },
  {
    path: `${API}/content`,
    query: { spaceKey: 'DOCS', title: 'Release notes', expand: 'body.storage,version,space', type: 'page' },
    respond: json({ results: [page('12345')], start: 0, limit: 25, size: 1, _links: links }),
  },
  { path: `${API}/content`, respond: (req: RecordedRequest) => listPage(spacePages, req, `${API}/content`) },
  { path: `${API}/content/12345/child/page`, respond: (req: RecordedRequest) => listPage(spacePages.slice(0, 2), req, `${API}/content/12345/child/page`) },
  { method: 'POST', path: `${API}/content`, respond: (req: RecordedRequest) => {
    const body = JSON.parse(req.body!) as { type: string; title?: string };
    return body.type === 'comment'
      ? json({ ...comments[0], id: '30002', body: (body as { body?: unknown }).body }, 200)
      : json(page('12346', body.title, 1), 200);
  } },

  // Search: one page, as it came.
  {
    path: `${API}/content/search`,
    respond: (req: RecordedRequest) => {
      const url = new URL(req.url);
      const hit = { content: page('12345'), title: 'Release notes', excerpt: 'Shipped.', url: '/display/DOCS/Release+notes', lastModified: '2026-01-15T09:00:00.000Z' };
      return json({ results: [hit], start: Number(url.searchParams.get('start')), limit: Number(url.searchParams.get('limit')), size: 1, totalSize: 1, cqlQuery: url.searchParams.get('cql'), _links: links });
    },
  },

  // Comments and labels.
  { path: `${API}/content/12345/child/comment`, respond: (req: RecordedRequest) => listPage(comments, req, `${API}/content/12345/child/comment`) },
  { path: `${API}/content/12345/label`, respond: (req: RecordedRequest) => listPage(labels, req, `${API}/content/12345/label`) },
  { method: 'POST', path: `${API}/content/12345/label`, respond: (req: RecordedRequest) => json({ results: (JSON.parse(req.body!) as unknown[]).map((l, i) => ({ ...(l as object), id: String(40010 + i) })), start: 0, limit: 200, size: 2 }) },
  { method: 'DELETE', path: `${API}/content/12345/label/runbook`, respond: empty },

  // Spaces.
  { path: `${API}/space`, respond: (req: RecordedRequest) => listPage(spaces, req, `${API}/space`) },
  // check-toil-project's lookup: the space with no expand.
  { path: `${API}/space/DOCS`, query: {}, respond: json(spaces[0]) },
  { path: `${API}/space/DOCS`, query: { expand: 'description.plain' }, respond: json({ ...spaces[0], description: { plain: { value: 'Product documentation', representation: 'plain' } } }) },

  // Attachments.
  { path: `${API}/content/12345/child/attachment`, respond: (req: RecordedRequest) => listPage([attachment()], req, `${API}/content/12345/child/attachment`) },
  { method: 'POST', path: `${API}/content/12345/child/attachment`, respond: json({ results: [attachment('98766', 'uploaded.png')], size: 1 }) },
  { path: `${API}/content/98765`, respond: json(attachment()) },
  { method: 'DELETE', path: `${API}/content/98765`, respond: empty },
  { path: '/download/attachments/12345/diagram.png', respond: { text: 'PNG!', headers: { 'content-type': 'image/png' } } },
];

/** Local files the examples read: a Markdown body, uploads. */
export const files: Record<string, string> = {
  'runbook.md': '# Runbook\n\nRestart the service.\n',
  'diagram.png': 'PNG!',
  'notes.txt': 'notes\n',
};

export const config = { confluence: { baseUrl: CONFLUENCE, apiToken: 'test-token', writes: true } };

/** The toil project the examples run with, for check-toil-project: reference data only, so no other example changes. */
export const toilProject = { name: 'payments', confluence: { spaces: ['DOCS'] } };

/**
 * Both deployments, side by side: Data Center's connection (`confluence`, the area's
 * default) and Cloud's (`confluence-cloud`, deployment cloud), each with the routes
 * and files its examples read. Cloud's routes are pinned to its own origin, so
 * neither deployment's canned answers can reach the other's requests.
 */
export const fixture = defineFixture({
  area: 'confluence',
  routes: [...routes, ...cloud.routes.map((r) => (r.path !== undefined && r.origin === undefined ? { ...r, origin: cloud.SITE } : r))],
  config: { ...config, ...cloud.config },
  deployments: { server: 'confluence', cloud: 'confluence-cloud' },
  files: { ...files, ...cloud.files },
  toilProject,
});
