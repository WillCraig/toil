import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { attachment, comment, config as fixtureConfig, page, routes as fixtureRoutes, SITE, spacePages, spaces } from '../../../../test/fixtures/confluence-cloud-data.js';
import type { AnyCommand } from '../../../core/command.js';
import { execute } from '../../../core/run.js';
import { attachmentFileName, deleteAttachment, downloadAttachment, listAttachments, uploadAttachment } from './attachments.js';
import { cursorOf, seg } from './client.js';
import { addComment, addLabel, getLabels, listComments, removeLabel } from './discussion.js';
import { createPage, deletePage, getPage, getPageByTitle, getPageChildren, getPageHistory, listPages, search, updatePage } from './pages.js';
import { getSpace, listSpaces } from './spaces.js';
import { storageToText } from './storage.js';

/**
 * Request building and response reshaping for Confluence Cloud, command by
 * command: the exact request toil sends and what it makes of the answer,
 * checked against Atlassian's documented REST API v2 and v1, since no live
 * site has been consulted. The parity suite proves both front doors agree;
 * this proves they agree with the documentation, which has not been asked.
 */

const AUTH = `Basic ${Buffer.from('you@example.com:test-token').toString('base64')}`;
const GET_HEADERS = { authorization: AUTH, accept: 'application/json' };
const JSON_HEADERS = { ...GET_HEADERS, 'content-type': 'application/json' };
const V2 = `${SITE}/wiki/api/v2`;
const V1 = `${SITE}/wiki/rest/api`;
const write = { allowWrite: true };

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[] = fixtureRoutes, options: { files?: Record<string, string>; config?: Record<string, Record<string, unknown>> } = {}) {
  const t = testContext({ config: options.config ?? fixtureConfig, routes, files: options.files ?? {} });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls, written: t.files.written };
}

const body = (call: { body?: string | undefined }) => JSON.parse(call.body!) as Record<string, unknown>;
const SPACE_LOOKUP = `${V2}/spaces?keys=DOCS&description-format=plain`;

describe('storage format as plain text', () => {
  it('blocks on their own lines, list items as dashes, table cells joined, entities decoded', () => {
    const xhtml =
      '<h1>Runbook</h1><p>Restart the <strong>service</strong>&nbsp;&amp; wait.<br/>Then check.</p>' +
      '<ul><li>one</li><li><p>two</p></li></ul>' +
      '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>&#50;</td></tr></tbody></table>' +
      '<ac:structured-macro ac:name="code" ac:macro-id="abc12345"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[systemctl restart a && b < c]]></ac:plain-text-body></ac:structured-macro>';
    expect(storageToText(xhtml)).toBe('Runbook\n\nRestart the service & wait.\nThen check.\n\n- one\n- two\n\na | b\n1 | 2\n\nsystemctl restart a && b < c');
  });

  // Found on a live Cloud site: a page sent with "−" and "’" came back as &minus; and &rsquo;,
  // and bodyText passed them through as written.
  it('decodes the named entities Confluence Cloud saves typography as, case-sensitively, including names with digits', () => {
    const xhtml = '<p>Holds are &minus;$346.15 &mdash; Lumen Games&rsquo; payout, &ldquo;weekly&rdquo;&hellip;</p><p>&frac12; &sup2; &Eacute;mile &eacute;t&eacute; &euro;5 &copy; &trade;</p>';
    expect(storageToText(xhtml)).toBe('Holds are −$346.15 — Lumen Games’ payout, “weekly”…\n\n½ ² Émile été €5 © ™');
  });

  it('keeps what it always did: the first six in any case, nbsp as a plain space, and an unknown name or a literal & in code as written', () => {
    expect(storageToText('<p>&AMP; &Lt; a&nbsp;b &notanentity; &MINUS; &constructor; &toString;</p>')).toBe('& < a b &notanentity; &MINUS; &constructor; &toString;');
    expect(storageToText('<ac:plain-text-body><![CDATA[echo "&minus;"]]></ac:plain-text-body>')).toBe('echo "&minus;"');
  });

  it('anything that is not a string is null; an empty body is empty text', () => {
    expect(storageToText(undefined)).toBeNull();
    expect(storageToText(null)).toBeNull();
    expect(storageToText('')).toBe('');
  });
});

describe('connection', () => {
  const own = fixtureConfig['confluence-cloud'];
  const noToken = { area: 'confluence', deployment: 'cloud', baseUrl: own.baseUrl, email: own.email, writes: true };
  const jira = { area: 'jira', deployment: 'cloud', baseUrl: 'https://jira-cloud.imagile.dev', email: 'you@example.com', apiToken: 'jira-token' };
  const JIRA_AUTH = `Basic ${Buffer.from('you@example.com:jira-token').toString('base64')}`;

  it('a baseUrl ending in /wiki is CONFIG_INVALID, saying to drop it, before anything is sent', async () => {
    for (const baseUrl of [`${SITE}/wiki`, `${SITE}/wiki/`, `${SITE}/WIKI`]) {
      const { envelope, calls } = await run(getPage, { id: '12345' }, fixtureRoutes, { config: { 'confluence-cloud': { ...own, baseUrl } } });
      expect(envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('ends in /wiki'), fix: expect.stringContaining('Drop the trailing /wiki') });
      expect(envelope.error?.fix).toContain('TOIL_CONFLUENCE_BASE_URL');
      expect(calls).toHaveLength(0);
    }
  });

  it('a site under a context path that merely contains wiki is left alone', async () => {
    const { calls } = await run(getPage, { id: '12345' }, [{ method: 'GET', path: '/wikis/wiki/api/v2/pages/12345', respond: { json: page('12345') } }], { config: { 'confluence-cloud': { ...own, baseUrl: `${SITE}/wikis` } } });
    expect(calls[0]!.url).toBe(`${SITE}/wikis/wiki/api/v2/pages/12345?body-format=storage`);
  });

  it('with no token of its own, the default connection uses the jira token (from a Cloud connection) from env, and says so', async () => {
    const { envelope, calls } = await run(getPage, { id: '12345' }, fixtureRoutes, { config: { 'confluence-cloud': noToken, 'jira-cloud': jira } });
    expect(calls[0]!.headers.authorization).toBe(JIRA_AUTH);
    expect(envelope.meta.context?.shared).toEqual({ apiToken: { area: 'jira', connection: 'jira-cloud', source: 'env', via: 'env-fallback' } });
  });

  it("never lends a Data Center jira token to Confluence Cloud by the env fallback: a PAT isn't sent to the Atlassian cloud", async () => {
    const dataCenter = { baseUrl: 'https://jira.imagile.dev', apiToken: 'dc-pat' };
    const { envelope, calls } = await run(getPage, { id: '12345' }, fixtureRoutes, { config: { 'confluence-cloud': noToken, jira: dataCenter } });
    expect(envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('apiToken') });
    expect(calls).toHaveLength(0);
  });

  it('apiTokenFrom names the jira connection to borrow from; its own token wins otherwise', async () => {
    const paired = await run(getPage, { id: '12345' }, fixtureRoutes, { config: { 'confluence-cloud': { ...noToken, apiTokenFrom: 'jira-cloud' }, 'jira-cloud': jira } });
    expect(paired.calls[0]!.headers.authorization).toBe(JIRA_AUTH);
    expect(paired.envelope.meta.context?.shared).toMatchObject({ apiToken: { area: 'jira', connection: 'jira-cloud' } });
    const mine = await run(getPage, { id: '12345' }, fixtureRoutes, { config: { 'confluence-cloud': own, 'jira-cloud': jira } });
    expect(mine.calls[0]!.headers.authorization).toBe(AUTH);
  });
});

describe('pages', () => {
  it('page get: GETs v2 with body-format=storage and Basic auth from email and token, and adds bodyText', async () => {
    const { envelope, calls } = await run(getPage, { id: '12345' });
    expect(calls).toEqual([{ method: 'GET', url: `${V2}/pages/12345?body-format=storage`, headers: GET_HEADERS, body: undefined }]);
    expect(envelope.data).toEqual({ ...page('12345'), bodyText: 'Shipped.' });
  });

  it('a path id that is not letters and digits is refused before anything is sent', async () => {
    for (const id of ['1/2', '1\\2', '1?x', '1#x', '1;x', '1%2F2', 'a b']) {
      const { envelope, calls } = await run(getPage, { id });
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("isn't a Confluence Cloud id") });
      expect(calls).toHaveLength(0);
    }
    expect(seg('att98765')).toBe('att98765');
  });

  it('an id with path or query syntax is refused before a read or a delete is sent', async () => {
    for (const id of ['x/../y', 'a/b?c=d', 'p1#hot', '%2e%2e']) {
      for (const [def, input] of [[getPage, { id }], [deletePage, { id, ...write }]] as const) {
        const { envelope, calls } = await run(def, input);
        expect(envelope.error, `${def.path.join(' ')} ${id}`).toMatchObject({ code: 'INVALID_INPUT' });
        expect(calls).toHaveLength(0);
      }
    }
  });

  it('a . or .. id, in any spelling, is refused before a delete is sent', async () => {
    for (const id of ['..', '.', '..;x', '%2e%2e', '.\t.']) {
      const { envelope, calls } = await run(deletePage, { id, ...write });
      expect(envelope.error?.code).toBe('INVALID_INPUT');
      expect(calls).toHaveLength(0);
    }
  });

  it('page find: looks the space key up to its id, then asks for the exact title', async () => {
    const { envelope, calls } = await run(getPageByTitle, { space: 'DOCS', title: 'Release notes' });
    expect(calls.map((c) => c.url)).toEqual([SPACE_LOOKUP, `${V2}/pages?space-id=98304&title=Release+notes&body-format=storage`]);
    expect(envelope.data).toMatchObject({ id: '12345', bodyText: 'Shipped.' });
  });

  it('page find: no match is NOT_FOUND naming the title and space; an unknown space is NOT_FOUND naming the key', async () => {
    const none = await run(getPageByTitle, { space: 'DOCS', title: 'Nope' }, [
      { method: 'GET', path: '/wiki/api/v2/spaces', respond: { json: { results: [spaces[0]] } } },
      { method: 'GET', path: '/wiki/api/v2/pages', respond: { json: { results: [] } } },
    ]);
    expect(none.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Page not found: "Nope" in space DOCS' });
    const noSpace = await run(getPageByTitle, { space: 'GONE', title: 'x' }, [{ method: 'GET', path: '/wiki/api/v2/spaces', respond: { json: { results: [] } } }]);
    expect(noSpace.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Confluence Cloud space not found: GONE' });
    expect(noSpace.calls).toHaveLength(1);
    const otherKey = await run(getSpace, { key: 'DOCS' }, [{ method: 'GET', path: '/wiki/api/v2/spaces', respond: { json: { results: [spaces[1]] } } }]);
    expect(otherKey.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Confluence Cloud space not found: DOCS' });
  });

  it('page list: every page, 250 a request, following the cursor in _links.next on the configured site', async () => {
    const routes: Route[] = [
      { method: 'GET', path: '/wiki/api/v2/spaces', respond: { json: { results: [spaces[0]] } } },
      { method: 'GET', path: '/wiki/api/v2/spaces/98304/pages', query: { limit: '250' }, respond: { json: { results: spacePages.slice(0, 2), _links: { next: 'https://elsewhere.imagile.dev/wiki/api/v2/spaces/98304/pages?cursor=abc12345&limit=250' } } } },
      { method: 'GET', path: '/wiki/api/v2/spaces/98304/pages', query: { limit: '250', cursor: 'abc12345' }, respond: { json: { results: spacePages.slice(2), _links: {} } } },
    ];
    const { envelope, calls } = await run(listPages, { space: 'DOCS' }, routes);
    expect(calls.map((c) => c.url)).toEqual([SPACE_LOOKUP, `${V2}/spaces/98304/pages?limit=250`, `${V2}/spaces/98304/pages?limit=250&cursor=abc12345`]);
    expect(envelope.data).toEqual(spacePages);
    expect(envelope.meta.page).toBeUndefined();
  });

  it('page list: --limit asks for that many and reports where to carry on; --cursor carries on', async () => {
    const first = await run(listPages, { space: 'DOCS', limit: 2 });
    expect(first.calls[1]!.url).toBe(`${V2}/spaces/98304/pages?limit=2`);
    expect(first.envelope.data).toEqual(spacePages.slice(0, 2));
    const cursor = first.envelope.meta.page!.nextCursor!;
    expect(first.envelope.meta.page).toEqual({ nextCursor: cursor, limit: 2 });
    const second = await run(listPages, { space: 'DOCS', limit: 2, cursor });
    expect(second.calls[1]!.url).toBe(`${V2}/spaces/98304/pages?limit=2&cursor=page-2`);
    expect(second.envelope.data).toEqual(spacePages.slice(2));
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('page list: --cursor without --limit is INVALID_INPUT, before anything is sent', async () => {
    const { envelope, calls } = await run(listPages, { space: 'DOCS', cursor: 'eyJjIjoicGFnZS0yIiwicyI6MH0' });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--cursor needs --limit' });
    expect(calls).toHaveLength(0);
  });

  it('page children and page history: v2 direct children and versions, read in full', async () => {
    const children = await run(getPageChildren, { id: '12345' });
    expect(children.calls.map((c) => c.url)).toEqual([`${V2}/pages/12345/direct-children?limit=250`]);
    expect((children.envelope.data as Array<{ type: string }>).map((c) => c.type)).toEqual(['page', 'folder']);
    const history = await run(getPageHistory, { id: '12345' });
    expect(history.calls.map((c) => c.url)).toEqual([`${V2}/pages/12345/versions?limit=250`]);
    expect((history.envelope.data as Array<{ number: number }>).map((v) => v.number)).toEqual([3, 2, 1]);
  });

  it('page search: one page of v1 CQL search, as it came, with the next cursor from _links.next in meta.page', async () => {
    const { envelope, calls } = await run(search, { cql: 'space=DOCS AND type=page' });
    expect(calls).toEqual([{ method: 'GET', url: `${V1}/search?cql=space%3DDOCS+AND+type%3Dpage&limit=25`, headers: GET_HEADERS, body: undefined }]);
    expect(envelope.data).toMatchObject({ size: 1, totalSize: 2, results: [{ title: 'Release notes', excerpt: 'Shipped.' }] });
    expect(envelope.meta.page).toEqual({ nextCursor: 'c2VhcmNoLTI', limit: 25 });
    const next = await run(search, { cql: 'space=DOCS AND type=page', limit: 25, cursor: 'c2VhcmNoLTI', expand: 'content.space' });
    expect(next.calls[0]!.url).toBe(`${V1}/search?cql=space%3DDOCS+AND+type%3Dpage&limit=25&cursor=c2VhcmNoLTI&expand=content.space`);
    expect(next.envelope.meta.page).toEqual({ nextCursor: null, limit: 25 });
  });

  it('cursorOf: the cursor parameter of a relative or absolute next link, or nothing', () => {
    expect(cursorOf('/wiki/api/v2/pages?limit=25&cursor=a%2Bb')).toBe('a+b');
    expect(cursorOf('https://confluence-cloud.imagile.dev/wiki/api/v2/pages?cursor=x#frag')).toBe('x');
    expect(cursorOf('/wiki/api/v2/pages?limit=25')).toBeUndefined();
    expect(cursorOf(undefined)).toBeUndefined();
  });

  it('page create: looks up the space id, then POSTs a published page with a storage body under the parent', async () => {
    const { envelope, calls } = await run(createPage, { space: 'DOCS', title: 'Release notes', body: '<p>Shipped.</p>', parentId: '12345', ...write });
    expect(calls[0]!.url).toBe(SPACE_LOOKUP);
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${V2}/pages`, headers: JSON_HEADERS });
    expect(body(calls[1]!)).toEqual({ spaceId: '98304', status: 'current', title: 'Release notes', parentId: '12345', body: { representation: 'storage', value: '<p>Shipped.</p>' } });
    expect(envelope.data).toMatchObject({ id: '12346', bodyText: 'Shipped.' });
  });

  it('page create: --body-file is read as it is; --representation wiki is sent as wiki; no body is INVALID_INPUT', async () => {
    const fromFile = await run(createPage, { space: 'DOCS', title: 'Runbook', bodyFile: 'runbook.html', ...write }, fixtureRoutes, { files: { 'runbook.html': '<h1>Runbook</h1>\n' } });
    expect(body(fromFile.calls[1]!)).toMatchObject({ body: { representation: 'storage', value: '<h1>Runbook</h1>\n' } });
    expect(body(fromFile.calls[1]!)).not.toHaveProperty('parentId');
    const wiki = await run(createPage, { space: 'DOCS', title: 'Wiki', body: 'h1. Heading', representation: 'wiki', ...write });
    expect(body(wiki.calls[1]!)).toMatchObject({ body: { representation: 'wiki', value: 'h1. Heading' } });
    const none = await run(createPage, { space: 'DOCS', title: 'Empty', ...write });
    expect(none.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Must specify --body or --body-file' });
    expect(none.calls).toHaveLength(0);
    const both = await run(createPage, { space: 'DOCS', title: 'Both', body: 'x', bodyFile: 'runbook.html', ...write });
    expect(both.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Cannot specify both --body and --body-file' });
  });

  it('page update: reads the page, then PUTs the next version with the new body and the old title', async () => {
    const { envelope, calls } = await run(updatePage, { id: '12345', body: '<p>Updated.</p>', ...write });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${V2}/pages/12345?body-format=storage`, `PUT ${V2}/pages/12345`]);
    expect(body(calls[1]!)).toEqual({ id: '12345', status: 'current', title: 'Release notes', body: { representation: 'storage', value: '<p>Updated.</p>' }, version: { number: 4 } });
    expect(envelope.data).toMatchObject({ version: { number: 4 }, bodyText: 'Updated.' });
  });

  it('page update: a rename sends the current storage body back, since Cloud requires one; draft is version 1', async () => {
    const rename = await run(updatePage, { id: '12345', title: 'Renamed', ...write });
    expect(body(rename.calls[1]!)).toEqual({ id: '12345', status: 'current', title: 'Renamed', body: { representation: 'storage', value: '<p>Shipped.</p>' }, version: { number: 4 } });
    const draft = await run(updatePage, { id: '12345', body: '<p>WIP</p>', status: 'draft', ...write });
    expect(body(draft.calls[1]!)).toMatchObject({ status: 'draft', version: { number: 1 } });
  });

  it('page update: --representation with no body is INVALID_INPUT; a page read back with no version is an HTTP error', async () => {
    const rep = await run(updatePage, { id: '12345', representation: 'wiki', ...write });
    expect(rep.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: '--representation needs --body or --body-file' });
    expect(rep.calls).toHaveLength(0);
    const odd = await run(updatePage, { id: '12345', body: 'x', ...write }, [{ method: 'GET', path: '/wiki/api/v2/pages/12345', respond: { json: { id: '12345', title: 't' } } }]);
    expect(odd.envelope.error).toMatchObject({ code: 'HTTP', message: expect.stringContaining('without a version number') });
    expect(odd.calls).toHaveLength(1);
  });

  it('page delete: DELETEs the page (to the trash) and is never an MCP tool', async () => {
    const { envelope, calls } = await run(deletePage, { id: '12345', ...write });
    expect(calls).toEqual([{ method: 'DELETE', url: `${V2}/pages/12345`, headers: GET_HEADERS, body: undefined }]);
    expect(envelope.data).toEqual({ deleted: '12345' });
    expect(deletePage.mcp).toBe(false);
    expect(deleteAttachment.mcp).toBe(false);
  });

  it('writes need writes on the connection and --allow-write', async () => {
    const { envelope, calls } = await run(createPage, { space: 'DOCS', title: 'x', body: 'y' });
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toHaveLength(0);
  });

  it('a 401 is AUTH, with a fix naming the email and token settings', async () => {
    const { envelope } = await run(getPage, { id: '12345' }, [{ method: 'GET', path: '/wiki/api/v2/pages/12345', respond: { status: 401, json: { message: 'Unauthorized' } } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH' });
    expect(envelope.error?.fix).toContain('TOIL_CONFLUENCE_EMAIL');
    expect(envelope.error?.fix).toContain('TOIL_CONFLUENCE_API_TOKEN');
  });
});

describe('comments and labels', () => {
  it('page comments: footer comments with storage bodies, each with bodyText', async () => {
    const { envelope, calls } = await run(listComments, { id: '12345' });
    expect(calls.map((c) => c.url)).toEqual([`${V2}/pages/12345/footer-comments?body-format=storage&limit=250`]);
    expect(envelope.data).toEqual([{ ...comment(), bodyText: 'Looks good.' }]);
  });

  it('page comment: POSTs a footer comment on the page', async () => {
    const { envelope, calls } = await run(addComment, { id: '12345', body: '<p>Reviewed.</p>', ...write });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${V2}/footer-comments`, headers: JSON_HEADERS });
    expect(body(calls[0]!)).toEqual({ pageId: '12345', body: { representation: 'storage', value: '<p>Reviewed.</p>' } });
    expect(envelope.data).toMatchObject({ id: '30002', bodyText: 'Reviewed.' });
  });

  it('page labels reads v2; page label POSTs global labels to v1, blanks dropped', async () => {
    const got = await run(getLabels, { id: '12345' });
    expect(got.calls[0]!.url).toBe(`${V2}/pages/12345/labels?limit=250`);
    const added = await run(addLabel, { id: '12345', labels: 'runbook, ops,', ...write });
    expect(added.calls[0]).toMatchObject({ method: 'POST', url: `${V1}/content/12345/label` });
    expect(JSON.parse(added.calls[0]!.body!)).toEqual([
      { prefix: 'global', name: 'runbook' },
      { prefix: 'global', name: 'ops' },
    ]);
    expect(added.envelope.data).toEqual([
      { prefix: 'global', name: 'runbook', id: '40010', label: 'runbook' },
      { prefix: 'global', name: 'ops', id: '40011', label: 'ops' },
    ]);
  });

  it('page unlabel: the label goes in the query, so even one with a slash names only itself', async () => {
    const { envelope, calls } = await run(removeLabel, { id: '12345', label: 'runbook', ...write });
    expect(calls).toEqual([{ method: 'DELETE', url: `${V1}/content/12345/label?name=runbook`, headers: GET_HEADERS, body: undefined }]);
    expect(envelope.data).toEqual({ removed: 'runbook', from: '12345' });
    const odd = await run(removeLabel, { id: '12345', label: '../a/b', ...write }, [{ method: 'DELETE', path: '/wiki/rest/api/content/12345/label', respond: { status: 204 } }]);
    expect(odd.calls[0]!.url).toBe(`${V1}/content/12345/label?name=..%2Fa%2Fb`);
  });
});

describe('spaces', () => {
  it('space get: by key, with its plain-text description', async () => {
    const { envelope, calls } = await run(getSpace, { key: 'DOCS' });
    expect(calls.map((c) => c.url)).toEqual([SPACE_LOOKUP]);
    expect(envelope.data).toMatchObject({ id: '98304', key: 'DOCS', description: { plain: { value: 'Product documentation' } } });
  });

  it('space list: every space, or one type, with --limit paging', async () => {
    const all = await run(listSpaces, {});
    expect(all.calls.map((c) => c.url)).toEqual([`${V2}/spaces?limit=250`]);
    expect((all.envelope.data as unknown[]).length).toBe(3);
    const one = await run(listSpaces, { type: 'global', limit: 1 });
    expect(one.calls[0]!.url).toBe(`${V2}/spaces?type=global&limit=1`);
    expect(one.envelope.data).toEqual([spaces[0]]);
    expect(one.envelope.meta.page?.nextCursor).toEqual(expect.any(String));
  });
});

describe('attachments', () => {
  it('page attachments: v2, every one', async () => {
    const { envelope, calls } = await run(listAttachments, { id: '12345' });
    expect(calls[0]!.url).toBe(`${V2}/pages/12345/attachments?limit=250`);
    expect(envelope.data).toEqual([attachment()]);
  });

  it('page attach: v1 multipart with the XSRF header, named by the last path segment on any platform', async () => {
    const { envelope, calls } = await run(uploadAttachment, { id: '12345', file: 'sub\\diagram.png', comment: 'First draft', ...write }, fixtureRoutes, { files: { 'sub\\diagram.png': 'PNG!' } });
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${V1}/content/12345/child/attachment`, headers: { authorization: AUTH, 'x-atlassian-token': 'nocheck' } });
    expect(calls[0]!.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    expect(calls[0]!.body).toContain('filename="diagram.png"');
    expect(calls[0]!.body).toContain('First draft');
    expect(envelope.data).toMatchObject([{ id: 'att98766', title: 'uploaded.png' }]);
  });

  it('page attach: a missing file is INVALID_INPUT, before anything is sent', async () => {
    const { envelope, calls } = await run(uploadAttachment, { id: '12345', file: 'nope.png', ...write });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'File not found: nope.png' });
    expect(calls).toHaveLength(0);
  });

  it('attachment download: the downloadLink under /wiki with the credential, then the media redirect with no headers at all', async () => {
    const signed = 'https://media.imagile.dev/file/abc12345/binary?token=signed';
    const routes: Route[] = [
      { method: 'GET', path: '/wiki/api/v2/attachments/att98765', respond: { json: attachment() } },
      { method: 'GET', path: '/wiki/download/attachments/12345/diagram.png', respond: { status: 302, headers: { location: signed } } },
      { method: 'GET', url: signed, respond: { text: 'PNG!', headers: { 'content-type': 'image/png' } } },
    ];
    const { envelope, calls, written } = await run(downloadAttachment, { id: 'att98765' }, routes);
    expect(calls.map((c) => c.url)).toEqual([`${V2}/attachments/att98765`, `${SITE}/wiki/download/attachments/12345/diagram.png?version=1&modificationDate=1700000000000&api=v2`, signed]);
    expect(calls[1]!.headers.authorization).toBe(AUTH);
    expect(calls[2]!.headers).not.toHaveProperty('authorization');
    expect(Object.keys(calls[2]!.headers).filter((h) => h !== 'accept')).toEqual([]);
    expect(envelope.data).toMatchObject({ filename: 'diagram.png', size: 4, saved: expect.stringMatching(/\/\.toil\/diagram\.png$/) });
    expect(Object.keys(written)).toHaveLength(1);
  });

  it('attachment download: an absolute link on another host is re-pointed at baseUrl, with a warning', async () => {
    const elsewhere = { ...attachment(), downloadLink: 'https://other.imagile.dev/wiki/download/attachments/1/x.png?api=v2' };
    const { envelope, calls } = await run(downloadAttachment, { id: 'att98765', dir: 'out' }, [
      { method: 'GET', path: '/wiki/api/v2/attachments/att98765', respond: { json: elsewhere } },
      { method: 'GET', url: `${SITE}/wiki/download/attachments/1/x.png?api=v2`, respond: { text: 'x' } },
    ]);
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([SITE, SITE]);
    expect(envelope.meta.warnings).toEqual([{ code: 'CONFLUENCE_CLOUD_ATTACHMENT_HOST', message: expect.stringContaining('https://other.imagile.dev') }]);
  });

  it('attachment download: no download link is NOT_FOUND; an existing file is never replaced', async () => {
    const noLink = await run(downloadAttachment, { id: 'att98765' }, [{ method: 'GET', path: '/wiki/api/v2/attachments/att98765', respond: { json: { id: 'att98765', title: 'x.png' } } }]);
    expect(noLink.envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Attachment att98765 has no download link (title: x.png).' });
    const exists = await run(downloadAttachment, { id: 'att98765' }, fixtureRoutes, { files: { '.toil/diagram.png': 'old' } });
    expect(exists.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('already exists') });
  });

  it('attachment delete: DELETEs it (to the trash)', async () => {
    const { envelope, calls } = await run(deleteAttachment, { id: 'att98765', ...write });
    expect(calls).toEqual([{ method: 'DELETE', url: `${V2}/attachments/att98765`, headers: GET_HEADERS, body: undefined }]);
    expect(envelope.data).toEqual({ deleted: 'att98765' });
  });

  it('attachmentFileName: keeps only the last segment, on either separator', () => {
    for (const title of ['../x', 'a/../../x', '/abs/x', '..\\x', 'C:\\Windows\\x']) expect(attachmentFileName(title)).toBe('x');
    expect(attachmentFileName('../..')).toBe('attachment');
  });
});
