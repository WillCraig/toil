import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { attachment, CONFLUENCE, config as fixtureConfig, page, routes as fixtureRoutes } from '../../../../test/fixtures/confluence.fixture.js';
import type { AnyCommand } from '../../../core/command.js';
import { ToilError } from '../../../core/errors.js';
import { multipart } from '../../../core/multipart.js';
import { execute } from '../../../core/run.js';
import { attachmentFileName, deleteAttachment, downloadAttachment, uploadAttachment } from './attachments.js';
import { addComment, addLabel, listComments, removeLabel } from './discussion.js';
import { storageFormatHint, xmlParseHint } from './hints.js';
import { createPage, deletePage, getPage, getPageByTitle, listPages, search, updatePage } from './pages.js';
import { createSpace, getSpace, listSpaces } from './spaces.js';

/**
 * Request building and response reshaping, command by command: the exact
 * request toil sends to Confluence Data Center and what it makes of the
 * answer. The parity suite proves both front doors agree; this proves what
 * they agree on is what the contract specifies. Items from #78 are pinned
 * as recorded, suspected bugs and all, until a live server rules on them.
 */

const API = `${CONFLUENCE}/rest/api`;
const JSON_HEADERS = { authorization: 'Bearer test-token', 'content-type': 'application/json', accept: 'application/json', connection: 'close' };
const write = { allowWrite: true };

async function run(
  def: AnyCommand,
  input: Record<string, unknown>,
  routes: Route[],
  options: { files?: Record<string, string>; stdin?: string; config?: Record<string, Record<string, unknown>> } = {},
) {
  const t = testContext({ config: options.config ?? fixtureConfig, routes, files: options.files ?? {}, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls, written: t.files.written };
}

/** A start/limit page of `results`, with a next link when `more`. */
const listOf = (results: unknown[], more = false) => ({ json: { results, size: results.length, _links: more ? { next: '/rest/api/next' } : {} } });

describe('auth', () => {
  it('sends the PAT as a Bearer header with the JSON headers the contract specifies, keeping a context path', async () => {
    const config = { confluence: { ...fixtureConfig.confluence, baseUrl: `${CONFLUENCE}/confluence` } };
    const { calls } = await run(getPage, { id: '12345' }, [{ url: /content\/12345/, respond: { json: page('12345') } }], { config });
    expect(calls).toEqual([{ method: 'GET', url: `${CONFLUENCE}/confluence/rest/api/content/12345?expand=body.storage,version,space,ancestors`, headers: JSON_HEADERS, body: undefined }]);
  });

  it('a 401 is AUTH, with where to make a new token and the env var', async () => {
    const { envelope } = await run(getPage, { id: '1' }, [{ url: /content/, respond: { status: 401, text: '' } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH', fix: expect.stringContaining('Settings → Personal Access Tokens') });
    expect(envelope.error?.fix).toContain('TOIL_CONFLUENCE_API_TOKEN for the default connection');
  });

  it("with no token of its own, the default connection uses the Jira token from env, and says so", async () => {
    const config = { confluence: { baseUrl: CONFLUENCE }, jira: { baseUrl: 'https://jira.imagile.dev', apiToken: 'jira-token' } };
    const { envelope, calls } = await run(getPage, { id: '1' }, [{ url: /content\/1/, respond: { json: page('1') } }], { config });
    expect(calls[0]!.headers.authorization).toBe('Bearer jira-token');
    expect(envelope.meta.context?.shared).toEqual({ apiToken: { area: 'jira', connection: 'jira', source: 'env', via: 'env-fallback' } });
  });

  it("never lends a Jira Cloud token to Confluence Data Center by the env fallback: an Atlassian account token isn't sent to a server", async () => {
    const config = { confluence: { baseUrl: CONFLUENCE, writes: true }, jira: { baseUrl: 'https://jira-cloud.imagile.dev', deployment: 'cloud', email: 'you@example.com', apiToken: 'cloud-token' } };
    const { envelope, calls } = await run(getPage, { id: '1' }, [{ url: /content\/1/, respond: { json: page('1') } }], { config });
    expect(envelope.error).toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('apiToken') });
    expect(calls).toHaveLength(0);
  });

  it('its own token wins over the Jira one', async () => {
    const config = { confluence: fixtureConfig.confluence, jira: { baseUrl: 'https://jira.imagile.dev', apiToken: 'jira-token' } };
    const { calls } = await run(getPage, { id: '1' }, [{ url: /content\/1/, respond: { json: page('1') } }], { config });
    expect(calls[0]!.headers.authorization).toBe('Bearer test-token');
  });
});

describe('pages', () => {
  it('page get: --expand replaces the default, with literal commas', async () => {
    const { calls } = await run(getPage, { id: '12345', expand: 'body.view,version' }, [{ url: /content\/12345/, respond: { json: page('12345') } }]);
    expect(calls[0]!.url).toBe(`${API}/content/12345?expand=body.view,version`);
  });

  it('page get: encodes the id as one path segment, so path or query syntax in it is part of the id, not the URL (#78 item 4, now encoded rather than refused)', async () => {
    const cases: Array<[string, string]> = [
      ['abc 1', 'abc%201'],
      ['1/history', '1%2Fhistory'],
      ['a/b?c=d', 'a%2Fb%3Fc%3Dd'],
      ['a\\b', 'a%5Cb'],
      ['p1#hot', 'p1%23hot'],
      ['%2e%2e', '%252e%252e'],
      ['.\t.', '.%09.'],
    ];
    for (const [id, sent] of cases) {
      const { calls } = await run(getPage, { id }, [{ url: /content/, respond: { json: {} } }]);
      expect(calls.map((c) => c.url), id).toEqual([`${API}/content/${sent}?expand=body.storage,version,space,ancestors`]);
    }
    // A bare . or .., one between encoded slashes, or one before ;params (which
    // servlet containers drop, encoded or not), is core's bound (requests.path).
    for (const id of ['..', '.', 'x/../y', '..;x']) {
      const { envelope, calls } = await run(getPage, { id }, []);
      expect(envelope.error, id).toMatchObject({ code: 'INVALID_INPUT' });
      expect(calls).toHaveLength(0);
    }
  });

  it('page delete: an id with dot segments never turns into a space delete', async () => {
    const { envelope, calls } = await run(deletePage, { id: '../space/DOCS', ...write }, []);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('..%2Fspace%2FDOCS') });
    expect(calls).toHaveLength(0);
    for (const id of ['..', '.']) {
      const refused = await run(deletePage, { id, ...write }, []);
      expect(refused.envelope.error, id).toMatchObject({ code: 'INVALID_INPUT' });
      expect(refused.calls).toHaveLength(0);
    }
  });

  it('page delete: an id with a tab after the dots, or ;params after anything but dots, is sent encoded, as one name', async () => {
    for (const [id, sent] of [['.\t', '.%09'], ['.%2e;jsessionid=1', '.%252e%3Bjsessionid%3D1']] as const) {
      const { calls } = await run(deletePage, { id, ...write }, [{ method: 'DELETE', url: /content/, respond: { status: 204 } }]);
      expect(calls.map((c) => [c.method, c.url]), id).toEqual([['DELETE', `${API}/content/${sent}`]]);
    }
  });

  it('page delete and attachment delete are CLI only: never MCP tools', () => {
    expect(deletePage.mcp).toBe(false);
    expect(deleteAttachment.mcp).toBe(false);
  });

  it('page find: asks for pages with that title and returns the first', async () => {
    const { envelope, calls } = await run(getPageByTitle, { space: 'DOCS', title: 'Release notes' }, [{ url: /content\?/, respond: listOf([page('1'), page('2')]) }]);
    expect(calls[0]!.url).toBe(`${API}/content?spaceKey=DOCS&title=Release+notes&expand=body.storage,version,space&type=page`);
    expect(envelope.data).toMatchObject({ id: '1' });
  });

  it("page find: no match is NOT_FOUND with its documented message", async () => {
    const { envelope } = await run(getPageByTitle, { space: 'DOCS', title: 'Nope' }, [{ url: /content\?/, respond: listOf([]) }]);
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Page not found: "Nope" in space DOCS' });
  });

  it('page list: pages 25 at a time from --offset, asking the last page only for what --limit leaves', async () => {
    const twentyFive = Array.from({ length: 25 }, (_, i) => ({ id: String(i) }));
    const { envelope, calls } = await run(listPages, { space: 'DOCS', limit: '30', offset: '5' }, [
      { path: '/rest/api/content', query: { spaceKey: 'DOCS', type: 'page', expand: 'version', start: '5', limit: '25' }, respond: listOf(twentyFive, true) },
      { path: '/rest/api/content', query: { spaceKey: 'DOCS', type: 'page', expand: 'version', start: '30', limit: '5' }, respond: listOf(twentyFive.slice(0, 5), true) },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/content?spaceKey=DOCS&type=page&expand=version&start=5&limit=25`,
      `${API}/content?spaceKey=DOCS&type=page&expand=version&start=30&limit=5`,
    ]);
    expect(envelope.data).toHaveLength(30);
  });

  it('page list: with no --limit, stops when a page has no next link', async () => {
    const { envelope, calls } = await run(listPages, { space: 'DOCS' }, [
      { path: '/rest/api/content', query: { spaceKey: 'DOCS', type: 'page', expand: 'version', start: '0', limit: '25' }, respond: listOf([{ id: '1' }], true) },
      { path: '/rest/api/content', query: { spaceKey: 'DOCS', type: 'page', expand: 'version', start: '1', limit: '25' }, respond: listOf([{ id: '2' }]) },
    ]);
    expect(calls).toHaveLength(2);
    expect(envelope.data).toEqual([{ id: '1' }, { id: '2' }]);
  });

  it('page list: --limit abc sends limit=NaN and returns nothing (#78 item 9)', async () => {
    const { envelope, calls } = await run(listPages, { space: 'DOCS', limit: 'abc' }, [{ path: '/rest/api/content', respond: listOf([{ id: '1' }]) }]);
    expect(calls[0]!.url).toContain('&limit=NaN');
    expect(envelope.data).toEqual([]);
    // Additive: the empty result says why (principle 4).
    expect(envelope.meta.warnings).toEqual([{ code: 'CONFLUENCE_LIMIT_INVALID', message: '--limit must be a positive whole number, not "abc"; the result was cut to 0 item(s).' }]);
  });

  it('space list: --limit 0 sends limit=0 once, returns nothing, and warns (#78 item 10)', async () => {
    const { envelope, calls } = await run(listSpaces, { limit: '0' }, [{ url: /space/, respond: listOf([{ key: 'A' }], true) }]);
    expect(calls.map((c) => c.url)).toEqual([`${API}/space?start=0&limit=0`]);
    expect(envelope.data).toEqual([]);
    expect(envelope.meta.warnings).toEqual([{ code: 'CONFLUENCE_LIMIT_INVALID', message: '--limit must be a positive whole number, not "0"; the result was cut to 0 item(s).' }]);
  });

  it('a valid --limit carries no warning', async () => {
    const { envelope } = await run(listSpaces, { limit: '1' }, [{ url: /space/, respond: listOf([{ key: 'A' }]) }]);
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('page search: one page, 25 from 0 by default, expand only when given, data as it came', async () => {
    const body = { results: [], start: 0, limit: 25, size: 0, totalSize: 0, _links: {} };
    const { envelope, calls } = await run(search, { cql: 'space=DOCS' }, [{ url: /search/, respond: { json: body } }]);
    expect(calls[0]!.url).toBe(`${API}/content/search?cql=space%3DDOCS&start=0&limit=25`);
    expect(envelope.data).toEqual(body);
  });

  it('page search: parseInt, so --limit 10abc is 10 and --limit abc goes out as NaN (#78 item 9)', async () => {
    const r = await run(search, { cql: 'x', limit: '10abc', offset: 'abc', expand: 'space' }, [{ url: /search/, respond: { json: {} } }]);
    expect(r.calls[0]!.url).toBe(`${API}/content/search?cql=x&start=NaN&limit=10&expand=space`);
  });

  it('page create: POSTs the storage body, with ancestors only for a parent', async () => {
    const { calls } = await run(createPage, { space: 'DOCS', title: 'T', body: '<p>B</p>', ...write }, [{ method: 'POST', url: `${API}/content`, respond: { json: page('9') } }]);
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `${API}/content`,
      headers: JSON_HEADERS,
      body: JSON.stringify({ type: 'page', title: 'T', space: { key: 'DOCS' }, ancestors: [], body: { storage: { value: '<p>B</p>', representation: 'storage' } } }),
    });
  });

  it('page create: --representation wiki still goes under body.storage (#78 item 7)', async () => {
    const { calls } = await run(createPage, { space: 'DOCS', title: 'T', body: 'h1. X', parentId: '7', representation: 'wiki', ...write }, [{ method: 'POST', url: `${API}/content`, respond: { json: page('9') } }]);
    expect(JSON.parse(calls[0]!.body!)).toMatchObject({ ancestors: [{ id: '7' }], body: { storage: { value: 'h1. X', representation: 'wiki' } } });
  });

  it('page create: --markdown converts the body file on this machine, and sends storage (#519, #78 items 2 and 10)', async () => {
    const { envelope, calls } = await run(createPage, { space: 'DOCS', title: 'T', bodyFile: 'a.md', markdown: true, representation: 'wiki', ...write }, [
      { method: 'POST', url: `${API}/content`, respond: { json: page('9') } },
    ], { files: { 'a.md': '# A\n\nSee <https://example.com/path>.\n' } });
    expect(envelope.meta.warnings).toBeUndefined();
    expect(calls).toHaveLength(1);
    const { storage } = JSON.parse(calls[0]!.body!).body as { storage: { value: string; representation: string } };
    expect(storage.representation).toBe('storage');
    expect(storage.value).toContain('<h1>A</h1>');
    // The autolink #519 reported: the href ends with the URL, with no escaped > kept in it.
    expect(storage.value).toContain('href="https://example.com/path"');
    expect(storage.value).not.toContain('&gt;');
  });

  it('page create: refuses no body, or both, before any request; reads stdin on the CLI', async () => {
    const none = await run(createPage, { space: 'D', title: 'T', ...write }, []);
    expect(none.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Must specify --body or --body-file' });
    const both = await run(createPage, { space: 'D', title: 'T', body: 'x', bodyFile: 'f', ...write }, []);
    expect(both.envelope.error?.message).toBe('Cannot specify both --body and --body-file');
    const missing = await run(createPage, { space: 'D', title: 'T', bodyFile: 'nope.html', ...write }, []);
    expect(missing.envelope.error?.message).toMatch(/^Cannot read body file "nope.html": /);
    const piped = await run(createPage, { space: 'D', title: 'T', bodyFile: '-', ...write }, [{ method: 'POST', url: `${API}/content`, respond: { json: page('9') } }], { stdin: '<p>S</p>' });
    expect(JSON.parse(piped.calls[0]!.body!).body.storage.value).toBe('<p>S</p>');
  });

  it('page create: an XML parse error gets the offending line appended', async () => {
    const body = '<p>one</p>\n<p>bad & char</p>';
    const { envelope } = await run(createPage, { space: 'D', title: 'T', body, ...write }, [
      { method: 'POST', url: `${API}/content`, respond: { status: 400, json: { statusCode: 400, message: 'Error parsing xhtml: Unexpected character at [row,col]={2,9}' } } },
    ]);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: 'Error parsing xhtml: Unexpected character at [row,col]={2,9}\n\nOffending line 2: <p>bad & char</p>\n        ^' });
  });

  it('page update: reads the version, sends the next one and the current title, status current', async () => {
    const { calls } = await run(updatePage, { id: '12345', body: '<p>N</p>', ...write }, [
      { url: `${API}/content/12345?expand=version`, respond: { json: { title: 'Old', version: { number: 3 } } } },
      { method: 'PUT', url: `${API}/content/12345`, respond: { json: page('12345') } },
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ version: { number: 4 }, type: 'page', title: 'Old', status: 'current', body: { storage: { value: '<p>N</p>', representation: 'storage' } } });
  });

  it('page update: --title alone sends no body (#78 item 6)', async () => {
    const { calls } = await run(updatePage, { id: '12345', title: 'New', status: 'draft', ...write }, [
      { url: `${API}/content/12345?expand=version`, respond: { json: { title: 'Old', version: { number: 1 } } } },
      { method: 'PUT', url: `${API}/content/12345`, respond: { json: page('12345') } },
    ]);
    expect(JSON.parse(calls[1]!.body!)).toEqual({ version: { number: 2 }, type: 'page', title: 'New', status: 'draft' });
  });

  it('page update: --markdown converts with no request of its own, and a failed write keeps Confluence message', async () => {
    const { envelope, calls } = await run(updatePage, { id: '12345', body: '```js\nx();\n```\n', markdown: true, ...write }, [
      { url: `${API}/content/12345?expand=version`, respond: { json: { title: 'Old', version: { number: 1 } } } },
      { method: 'PUT', url: `${API}/content/12345`, respond: { status: 500, json: { message: 'java.lang.NullPointerException' } } },
    ]);
    expect(calls.map((c) => c.method)).toEqual(['GET', 'PUT']);
    // Each code macro gets an ac:macro-id, so the 500 can't be blamed on one the person never wrote.
    expect(JSON.parse(calls[1]!.body!).body.storage.value).toMatch(/<ac:structured-macro ac:macro-id="[0-9a-f-]{36}" ac:name="code"/);
    expect(envelope.error?.message).toContain('java.lang.NullPointerException');
    expect(envelope.error?.message).not.toContain('without ac:macro-id');
  });

  it('page create: --markdown leaves code text alone, even when it reads like a macro', async () => {
    const code = '<ac:structured-macro ac:name="info"></ac:structured-macro>';
    const { calls } = await run(createPage, { space: 'DOCS', title: 'T', body: `\`\`\`xml\n${code}\n\`\`\`\n`, markdown: true, ...write }, [
      { method: 'POST', url: `${API}/content`, respond: { json: page('9') } },
    ]);
    const sent = JSON.parse(calls[0]!.body!).body.storage.value as string;
    expect(sent).toContain(`<![CDATA[${code}]]>`);
    expect(sent.match(/ac:macro-id=/g)).toHaveLength(1);
  });

  it('page create: --markdown says what storage format could not hold, in meta.warnings', async () => {
    const { envelope, calls } = await run(createPage, { space: 'DOCS', title: 'T', body: 'Hi <span>there</span>\n', markdown: true, ...write }, [
      { method: 'POST', url: `${API}/content`, respond: { json: page('9') } },
    ]);
    expect(calls).toHaveLength(1);
    expect(envelope.meta.warnings?.map((w) => w.code)).toContain('MD_LOSSY');
  });
});

describe('comments and labels', () => {
  it('page comments: sends no depth, so replies are left out (#78 item 3)', async () => {
    const { calls } = await run(listComments, { id: '12345' }, [{ url: /child\/comment/, respond: listOf([]) }]);
    expect(calls[0]!.url).toBe(`${API}/content/12345/child/comment?expand=body.storage,version&start=0&limit=25`);
  });

  it('page comment: the container is always a page (#78 item 8)', async () => {
    const { calls } = await run(addComment, { id: '555', body: 'hi', representation: 'wiki', ...write }, [{ method: 'POST', url: `${API}/content`, respond: { json: {} } }]);
    expect(calls[0]!.body).toBe(JSON.stringify({ type: 'comment', container: { id: '555', type: 'page' }, body: { storage: { value: 'hi', representation: 'wiki' } } }));
  });

  it('page label: global labels from a trimmed comma list, returning results', async () => {
    const { envelope, calls } = await run(addLabel, { id: '12345', labels: ' a, b,,', ...write }, [{ method: 'POST', url: `${API}/content/12345/label`, respond: { json: { results: [{ name: 'a' }] } } }]);
    expect(calls[0]!.body).toBe(JSON.stringify([{ prefix: 'global', name: 'a' }, { prefix: 'global', name: 'b' }]));
    expect(envelope.data).toEqual([{ name: 'a' }]);
  });

  it('page unlabel: a plain label goes in the path as it is (#78 item 4)', async () => {
    const { envelope, calls } = await run(removeLabel, { id: '12345', label: 'runbook', ...write }, [{ method: 'DELETE', url: /label/, respond: { status: 204 } }]);
    expect(calls[0]!.url).toBe(`${API}/content/12345/label/runbook`);
    expect(envelope.data).toEqual({ removed: 'runbook', from: '12345' });
  });

  it('page unlabel: a ; in a label is encoded, so the whole label is the name, not a ;param', async () => {
    const { envelope, calls } = await run(removeLabel, { id: '12345', label: 'a;b', ...write }, [{ method: 'DELETE', url: /label/, respond: { status: 204 } }]);
    expect(calls[0]!.url).toBe(`${API}/content/12345/label/a%3Bb`);
    expect(envelope.data).toEqual({ removed: 'a;b', from: '12345' });
  });

  it('page unlabel: a label with path or query syntax is encoded as one segment, where it used to be refused', async () => {
    const cases: Array<[string, string]> = [
      ['a/b', 'a%2Fb'],
      ['a/b?c=d', 'a%2Fb%3Fc%3Dd'],
      ['p1#hot', 'p1%23hot'],
      ['%2e%2e', '%252e%252e'],
      ['.\t.', '.%09.'],
    ];
    for (const [label, sent] of cases) {
      const { calls } = await run(removeLabel, { id: '12345', label, ...write }, [{ method: 'DELETE', url: /label/, respond: { status: 204 } }]);
      expect(calls.map((c) => [c.method, c.url]), label).toEqual([['DELETE', `${API}/content/12345/label/${sent}`]]);
    }
  });

  it('page unlabel: a label that is a dot segment, or climbs out through encoded slashes, is refused before any request', async () => {
    for (const label of ['..', '.', '../../../space/DOCS', 'x/../y']) {
      const { envelope, calls } = await run(removeLabel, { id: '12345', label, ...write }, []);
      expect(envelope.error, label).toMatchObject({ code: 'INVALID_INPUT' });
      expect(calls).toHaveLength(0);
    }
  });
});

describe('spaces', () => {
  it('space list: start, limit, then type; --limit caps the total', async () => {
    const { envelope, calls } = await run(listSpaces, { type: 'global', limit: '1' }, [{ url: /space/, respond: listOf([{ key: 'A' }, { key: 'B' }], true) }]);
    expect(calls.map((c) => c.url)).toEqual([`${API}/space?start=0&limit=1&type=global`]);
    expect(envelope.data).toEqual([{ key: 'A' }]);
  });

  it('space get: a personal space key goes in as it is, and one with path or query syntax is encoded as one segment', async () => {
    for (const [key, sent] of [['~jsmith', '~jsmith'], ['a/b?c=d', 'a%2Fb%3Fc%3Dd'], ['p1#hot', 'p1%23hot']] as const) {
      const { calls } = await run(getSpace, { key }, [{ url: /space\//, respond: { json: { key } } }]);
      expect(calls.map((c) => c.url), key).toEqual([`${API}/space/${sent}?expand=description.plain`]);
    }
  });

  it('space create: POSTs the key, name and a plain description to /space, and returns the space', async () => {
    const { envelope, calls } = await run(createSpace, { key: 'KW', name: 'Kettlewell Engineering', description: 'How we build payments.', ...write }, fixtureRoutes);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/space`, headers: JSON_HEADERS });
    expect(JSON.parse(calls[0]!.body!)).toEqual({ key: 'KW', name: 'Kettlewell Engineering', description: { plain: { value: 'How we build payments.', representation: 'plain' } } });
    expect(envelope.data).toMatchObject({ key: 'KW', name: 'Kettlewell Engineering', type: 'global' });
    const bare = await run(createSpace, { key: 'KW', name: 'Kettlewell Engineering', ...write }, fixtureRoutes);
    expect(JSON.parse(bare.calls[0]!.body!)).toEqual({ key: 'KW', name: 'Kettlewell Engineering' });
  });

  it('space create: a key with anything but letters and digits is INVALID_INPUT before any request', async () => {
    for (const key of ['K-W', 'k w', '~jsmith', '']) {
      const { envelope, calls } = await run(createSpace, { key, name: 'X', ...write }, fixtureRoutes);
      expect(envelope.error?.code, key).toBe('INVALID_INPUT');
      expect(calls, key).toEqual([]);
    }
  });
});

describe('attachments', () => {
  it('page attach: multipart with the file then the comment, and the no-check header', async () => {
    const { envelope, calls } = await run(uploadAttachment, { id: '12345', inputFile: 'docs/a.txt', comment: 'v1', ...write }, [
      { method: 'POST', url: `${API}/content/12345/child/attachment`, respond: { json: { results: [{ id: '1' }] } } },
    ], { files: { 'docs/a.txt': 'hello' } });
    const expected = multipart([{ name: 'file', fileName: 'a.txt', data: new TextEncoder().encode('hello') }, { name: 'comment', value: 'v1' }]);
    expect(calls[0]!.headers).toEqual({ authorization: 'Bearer test-token', 'x-atlassian-token': 'no-check', accept: 'application/json', connection: 'close', 'content-type': expected.contentType });
    expect(calls[0]!.body).toBe(new TextDecoder().decode(expected.body));
    expect(envelope.data).toEqual([{ id: '1' }]);
  });

  it("page attach: a missing file is INVALID_INPUT naming the path, before any request", async () => {
    const { envelope, calls } = await run(uploadAttachment, { id: '12345', inputFile: 'gone.txt', ...write }, []);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'File not found: gone.txt' });
    expect(calls).toHaveLength(0);
  });

  it('page attach: always POSTs a new attachment, never a new version (#78 item 5)', async () => {
    const { calls } = await run(uploadAttachment, { id: '12345', inputFile: 'a.txt', ...write }, [{ method: 'POST', url: /attachment$/, respond: { json: { results: [] } } }], { files: { 'a.txt': 'x' } });
    expect(calls[0]!.url).toBe(`${API}/content/12345/child/attachment`);
  });

  it('attachment download: fetches the relative link under baseUrl, context path kept, and saves it to .toil', async () => {
    const config = { confluence: { ...fixtureConfig.confluence, baseUrl: `${CONFLUENCE}/wiki` } };
    const { envelope, calls, written } = await run(downloadAttachment, { id: '98765' }, [
      { url: `${CONFLUENCE}/wiki/rest/api/content/98765`, respond: { json: attachment() } },
      { url: /download/, respond: { text: 'PNG!' } },
    ], { config });
    expect(calls[1]).toMatchObject({ method: 'GET', url: `${CONFLUENCE}/wiki/download/attachments/12345/diagram.png?version=1&modificationDate=1700000000000&api=v2`, headers: { authorization: 'Bearer test-token', connection: 'close' } });
    expect(envelope.data).toMatchObject({ filename: 'diagram.png', size: 4, saved: expect.stringMatching(/\/\.toil\/diagram\.png$/) });
    expect(Object.keys(written)).toHaveLength(1);
  });

  it('attachment download: saved is absolute with forward slashes even when --dir is relative (#233, a listed divergence)', async () => {
    const { envelope } = await run(downloadAttachment, { id: '98765', dir: 'downloads' }, [
      { url: `${API}/content/98765`, respond: { json: attachment() } },
      { url: /download/, respond: { text: 'PNG!' } },
    ]);
    expect(envelope.data).toEqual({ saved: expect.stringMatching(/^(\/|[A-Za-z]:\/).*\/downloads\/diagram\.png$/), filename: 'diagram.png', size: 4 });
    expect((envelope.data as { saved: string }).saved).not.toContain('\\');
  });

  it('attachment download: an absolute link on another host is re-pointed at baseUrl, with a warning (#78 item 1)', async () => {
    const elsewhere = { ...attachment(), _links: { download: 'https://other.imagile.dev/download/attachments/1/x.png?api=v2' } };
    const { envelope, calls } = await run(downloadAttachment, { id: '98765', dir: 'out' }, [
      { url: `${API}/content/98765`, respond: { json: elsewhere } },
      { url: `${CONFLUENCE}/download/attachments/1/x.png?api=v2`, respond: { text: 'x' } },
    ]);
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([CONFLUENCE, CONFLUENCE]);
    expect(envelope.meta.warnings).toEqual([{ code: 'CONFLUENCE_ATTACHMENT_HOST', message: expect.stringContaining('https://other.imagile.dev') }]);
  });

  it('attachment download: content with no download link is refused, naming the id and title', async () => {
    const { envelope, calls } = await run(downloadAttachment, { id: '12345' }, [{ url: /content\/12345/, respond: { json: { id: '12345', title: 'A page', _links: {} } } }]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Content 12345 has no download link — is it an attachment? (title: A page)' });
    expect(calls).toHaveLength(1);
  });

  it('attachment download: never replaces a file already there', async () => {
    const { envelope } = await run(downloadAttachment, { id: '98765' }, [
      { url: /content\/98765/, respond: { json: attachment() } },
      { url: /download/, respond: { text: 'new' } },
    ], { files: { '.toil/diagram.png': 'old' } });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('already exists') });
  });

  it('attachmentFileName: keeps only the last segment of a server-supplied title, on either separator', () => {
    for (const title of ['../x', '../../../../x', './../x', 'a/../../x', '/abs/x', '..\\x', '..\\..\\..\\x', 'C:\\Windows\\x', 'a/b\\c/../x']) expect(attachmentFileName(title)).toBe('x');
    expect(attachmentFileName('diagram.png')).toBe('diagram.png');
    expect(attachmentFileName('../..')).toBe('attachment');
    expect(attachmentFileName('/')).toBe('attachment');
  });
});

describe('body hints, worded as the contract specifies', () => {
  const err500 = new ToilError('HTTP', 'HTTP 500 Internal Server Error', { details: { status: 500 } });

  it('xmlParseHint: null without a position or past the end; a pointer under the column', () => {
    expect(xmlParseHint('string error', '<p/>')).toBeNull();
    expect(xmlParseHint(new Error('HTTP 500'), '<p/>')).toBeNull();
    expect(xmlParseHint(new Error('at [row,col]={5,1}'), '<p/>')).toBeNull();
    expect(xmlParseHint(new Error('at [row,col]={1,1}'), '<bad/>')).toBe('Offending line 1: <bad/>\n^');
    expect(xmlParseHint(new Error('at [row,col]={2,9}'), 'a\n<p>bad & char</p>', true)).toBe('Offending line 2 (converted from Markdown): <p>bad & char</p>\n        ^');
  });

  it('storageFormatHint: only for a 500, flagging bare name= and macros without an id', () => {
    const bare = '<ac:structured-macro ac:name="code" ac:macro-id="a1"><ac:parameter name="language">js</ac:parameter></ac:structured-macro>';
    expect(storageFormatHint('string', bare)).toBeNull();
    expect(storageFormatHint(new ToilError('HTTP', 'x', { details: { status: 400 } }), bare)).toBeNull();
    expect(storageFormatHint(err500, '<p>Hello</p>')).toBeNull();
    expect(storageFormatHint(err500, bare)).toContain('<ac:parameter name="...">');
    expect(storageFormatHint(err500, bare.replace('name="language"', 'ac:name="language"'))).toBeNull();
    const both = storageFormatHint(err500, '<ac:structured-macro ac:name="code"><ac:parameter name="language">js</ac:parameter></ac:structured-macro>');
    expect(both).toContain('<ac:parameter name="...">');
    expect(both).toContain('ac:macro-id');
  });
});
