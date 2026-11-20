import type { RecordedRequest, Route } from '../harness/fake-fetch.js';

/**
 * Canned Confluence Cloud responses for every request the Cloud
 * examples send, so the parity suite runs every command offline through both
 * front doors.
 *
 * Provenance: every shape here is invented from Atlassian's documented
 * Confluence Cloud REST API v2 and v1 (the OpenAPI specs behind
 * developer.atlassian.com/cloud/confluence/rest/v2 and /rest/v1), trimmed to
 * the fields that matter. None was captured from a live site. Ids are numeric
 * strings, spaces carry a numeric id beside their key, and lists page by a
 * cursor in `_links.next`, as the docs show. The cursors are this fixture's
 * own invention; the real ones are opaque, which is the point of them.
 */

export const SITE = 'https://confluence-cloud.imagile.dev';
export const V2 = '/wiki/api/v2';
const V1 = '/wiki/rest/api';
export const ACCOUNT = '5b10ac8d82e05b22cc7d4ef5';

const json = (body: unknown, status = 200) => ({ status, json: body });
const empty = { status: 204 };
const base = { base: `${SITE}/wiki` };
const version = (number: number) => ({ createdAt: '2026-01-15T09:00:00.000Z', message: '', number, minorEdit: false, authorId: ACCOUNT });

// Invented from the docs: a page as GET /wiki/api/v2/pages/{id}?body-format=storage returns it.
export const page = (id: string, title = 'Release notes', number = 3, value = '<p>Shipped.</p>') => ({
  id,
  status: 'current',
  title,
  spaceId: '98304',
  parentId: '10000',
  parentType: 'page',
  authorId: ACCOUNT,
  ownerId: ACCOUNT,
  createdAt: '2025-11-02T10:00:00.000Z',
  version: version(number),
  body: { storage: { representation: 'storage', value } },
  _links: { webui: `/spaces/DOCS/pages/${id}`, editui: `/pages/resumedraft.action?draftId=${id}`, tinyui: '/x/AQID', ...base },
});

// Invented from the docs: an attachment as GET /wiki/api/v2/attachments/{id} returns it.
export const attachment = (id = 'att98765', title = 'diagram.png') => ({
  id,
  status: 'current',
  title,
  createdAt: '2026-01-15T09:00:00.000Z',
  pageId: '12345',
  mediaType: 'image/png',
  mediaTypeDescription: 'PNG Image',
  comment: '',
  fileId: 'abc12345-0000-0000-0000-000000000000',
  fileSize: 4,
  webuiLink: `/pages/viewpageattachments.action?pageId=12345&preview=%2F12345%2F${id}%2F${title}`,
  downloadLink: `/download/attachments/12345/${title}?version=1&modificationDate=1700000000000&api=v2`,
  version: version(1),
  _links: { webui: `/pages/viewpageattachments.action?pageId=12345`, download: `/download/attachments/12345/${title}?version=1&api=v2` },
});

/**
 * A v2 cursor list page: `limit` items from the cursor's position, and
 * `_links.next` (a relative URL carrying the next cursor) while more remain.
 * This fixture's cursors read `page-<index>`.
 */
const cursorPage = <T>(all: T[], req: RecordedRequest, path: string) => {
  const url = new URL(req.url);
  const start = Number((url.searchParams.get('cursor') ?? 'page-0').replace('page-', ''));
  const limit = Number(url.searchParams.get('limit') ?? 25);
  const results = all.slice(start, start + limit);
  const next = start + results.length < all.length ? `${path}?cursor=page-${start + results.length}&limit=${limit}` : undefined;
  return json({ results, _links: { ...base, ...(next ? { next } : {}) } });
};

export const spacePages = Array.from({ length: 3 }, (_, i) => ({ id: String(20000 + i), status: 'current', title: `Page ${i + 1}`, spaceId: '98304', parentId: '12345', parentType: 'page', authorId: ACCOUNT, createdAt: '2026-01-10T09:00:00.000Z', version: version(1), _links: { webui: `/spaces/DOCS/pages/${20000 + i}` } }));
const children = [
  { id: '20000', status: 'current', title: 'Page 1', type: 'page', spaceId: '98304', childPosition: 0 },
  { id: '20100', status: 'current', title: 'Archive', type: 'folder', spaceId: '98304', childPosition: 1 },
];
const versions = [3, 2, 1].map((n) => ({ ...version(n), page: { id: '12345', title: 'Release notes' } }));
export const comment = (id = '30001', value = '<p>Looks <strong>good</strong>.</p>') => ({
  id,
  status: 'current',
  title: 'Re: Release notes',
  pageId: '12345',
  version: version(1),
  body: { storage: { representation: 'storage', value } },
  _links: { webui: `/spaces/DOCS/pages/12345?focusedCommentId=${id}` },
});
const labels = [
  { id: '40001', name: 'runbook', prefix: 'global' },
  { id: '40002', name: 'ops', prefix: 'global' },
];
export const spaces = [
  { id: '98304', key: 'DOCS', name: 'Documentation', type: 'global', status: 'current', authorId: ACCOUNT, createdAt: '2025-01-01T00:00:00.000Z', homepageId: '10000', _links: { webui: '/spaces/DOCS' } },
  { id: '98305', key: 'OPS', name: 'Operations', type: 'global', status: 'current', authorId: ACCOUNT, createdAt: '2025-01-01T00:00:00.000Z', homepageId: '10001', _links: { webui: '/spaces/OPS' } },
  { id: '98306', key: '~5b10ac8d82e05b22cc7d4ef5', name: 'J. Smith', type: 'personal', status: 'current', authorId: ACCOUNT, createdAt: '2025-01-01T00:00:00.000Z', homepageId: '10002', _links: { webui: '/spaces/~5b10ac8d82e05b22cc7d4ef5' } },
];

export const routes: Route[] = [
  // space create: the space as v2 returns it, shaped from the REST v2 docs; the shape (id, key, homepageId) matched a live Cloud site's answer on 16 November 2026.
  {
    method: 'POST',
    path: `${V2}/spaces`,
    respond: (req: RecordedRequest) => {
      const sent = JSON.parse(req.body!) as { key: string; name: string; description?: { value: string } };
      return json({ id: '98310', key: sent.key, name: sent.name, type: 'global', status: 'current', authorId: ACCOUNT, createdAt: '2026-11-16T09:00:00.000Z', homepageId: '10010', ...(sent.description ? { description: { plain: { representation: 'plain', value: sent.description.value } } } : {}), _links: { webui: `/spaces/${sent.key}` } });
    },
  },
  // Spaces: a key is looked up with ?keys= first, since v2 wants the id.
  { method: 'GET', path: `${V2}/spaces`, query: { keys: 'DOCS', 'description-format': 'plain' }, respond: json({ results: [{ ...spaces[0], description: { plain: { representation: 'plain', value: 'Product documentation' } } }], _links: base }) },
  {
    method: 'GET',
    path: `${V2}/spaces`,
    respond: (req: RecordedRequest) => {
      const type = new URL(req.url).searchParams.get('type');
      return cursorPage(type ? spaces.filter((s) => s.type === type) : spaces, req, `${V2}/spaces`);
    },
  },

  // Pages.
  { method: 'GET', path: `${V2}/pages/12345`, query: { 'body-format': 'storage' }, respond: json(page('12345')) },
  {
    method: 'PUT',
    path: `${V2}/pages/12345`,
    respond: (req: RecordedRequest) => {
      const sent = JSON.parse(req.body!) as { title: string; status: string; version: { number: number }; body: { value: string } };
      return json({ ...page('12345', sent.title, sent.version.number, sent.body.value), status: sent.status });
    },
  },
  { method: 'DELETE', path: `${V2}/pages/12345`, respond: empty },
  { method: 'GET', path: `${V2}/pages`, query: { 'space-id': '98304', title: 'Release notes', 'body-format': 'storage' }, respond: json({ results: [page('12345')], _links: base }) },
  { method: 'GET', path: `${V2}/spaces/98304/pages`, respond: (req: RecordedRequest) => cursorPage(spacePages, req, `${V2}/spaces/98304/pages`) },
  { method: 'GET', path: `${V2}/pages/12345/direct-children`, respond: (req: RecordedRequest) => cursorPage(children, req, `${V2}/pages/12345/direct-children`) },
  { method: 'GET', path: `${V2}/pages/12345/versions`, respond: (req: RecordedRequest) => cursorPage(versions, req, `${V2}/pages/12345/versions`) },
  {
    method: 'POST',
    path: `${V2}/pages`,
    respond: (req: RecordedRequest) => {
      const sent = JSON.parse(req.body!) as { title: string; body: { value: string } };
      return json(page('12346', sent.title, 1, sent.body.value));
    },
  },

  // Search (v1): one page, as it came, with a next link while more remain.
  {
    method: 'GET',
    path: `${V1}/search`,
    respond: (req: RecordedRequest) => {
      const url = new URL(req.url);
      const limit = Number(url.searchParams.get('limit'));
      const cql = url.searchParams.get('cql')!;
      const first = !url.searchParams.has('cursor');
      const hit = { content: { id: '12345', type: 'page', status: 'current', title: 'Release notes', _links: { webui: '/spaces/DOCS/pages/12345' } }, title: 'Release notes', excerpt: 'Shipped.', url: '/spaces/DOCS/pages/12345', resultGlobalContainer: { title: 'Documentation', displayUrl: '/spaces/DOCS' }, lastModified: '2026-01-15T09:00:00.000Z', entityType: 'content' };
      return json({
        results: [hit],
        start: 0,
        limit,
        size: 1,
        totalSize: 2,
        cqlQuery: cql,
        searchDuration: 42,
        _links: { ...base, context: '/wiki', ...(first ? { next: `/rest/api/search?cql=${encodeURIComponent(cql)}&limit=${limit}&cursor=c2VhcmNoLTI` } : {}) },
      });
    },
  },

  // Comments and labels.
  { method: 'GET', path: `${V2}/pages/12345/footer-comments`, respond: (req: RecordedRequest) => cursorPage([comment()], req, `${V2}/pages/12345/footer-comments`) },
  {
    method: 'POST',
    path: `${V2}/footer-comments`,
    respond: (req: RecordedRequest) => {
      const sent = JSON.parse(req.body!) as { body: { representation: string; value: string } };
      // Invented: Confluence stores wiki markup as storage; the fixture keeps it simple.
      return json(comment('30002', sent.body.representation === 'storage' ? sent.body.value : `<p>${sent.body.value}</p>`));
    },
  },
  { method: 'GET', path: `${V2}/pages/12345/labels`, respond: (req: RecordedRequest) => cursorPage(labels, req, `${V2}/pages/12345/labels`) },
  {
    method: 'POST',
    path: `${V1}/content/12345/label`,
    respond: (req: RecordedRequest) => json({ results: (JSON.parse(req.body!) as Array<{ prefix: string; name: string }>).map((l, i) => ({ ...l, id: String(40010 + i), label: l.name })), start: 0, limit: 200, size: 2 }),
  },
  { method: 'DELETE', path: `${V1}/content/12345/label`, query: { name: 'runbook' }, respond: empty },

  // Attachments.
  { method: 'GET', path: `${V2}/pages/12345/attachments`, respond: (req: RecordedRequest) => cursorPage([attachment()], req, `${V2}/pages/12345/attachments`) },
  {
    method: 'POST',
    path: `${V1}/content/12345/child/attachment`,
    respond: json({ results: [{ id: 'att98766', type: 'attachment', status: 'current', title: 'uploaded.png', extensions: { mediaType: 'image/png', fileSize: 4 }, _links: { download: '/download/attachments/12345/uploaded.png' } }], size: 1 }),
  },
  { method: 'GET', path: `${V2}/attachments/att98765`, respond: json(attachment()) },
  { method: 'DELETE', path: `${V2}/attachments/att98765`, respond: empty },
  { method: 'GET', path: '/wiki/download/attachments/12345/diagram.png', respond: { text: 'PNG!', headers: { 'content-type': 'image/png' } } },
];

/** Local files the examples read: a page body and uploads. */
export const files: Record<string, string> = {
  'runbook.html': '<h1>Runbook</h1>\n<p>Restart the service.</p>\n',
  'diagram.png': 'PNG!',
  'notes.txt': 'notes\n',
};

/** The Cloud connection, named `confluence-cloud`: an ordinary confluence connection with deployment cloud. */
export const config = { 'confluence-cloud': { area: 'confluence', deployment: 'cloud', baseUrl: SITE, email: 'you@example.com', apiToken: 'test-token', writes: true } };

