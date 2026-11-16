import { describe, expect, it } from 'vitest';
import { testContext } from '../../../../test/harness/context.js';
import type { Route } from '../../../../test/harness/fake-fetch.js';
import { ACCOUNT, config as fixtureConfig, doc, issue, SITE, sprints } from '../../../../test/fixtures/jira-cloud-data.js';
import type { AnyCommand } from '../../../core/command.js';
import { execute } from '../../../core/run.js';
import { adfToText, textToAdf } from './adf.js';
import { listSprints, setSprint } from './agile.js';
import { addAttachment, downloadAttachment } from './attachments.js';
import { suggestedType } from './custom-fields.js';
import { addComment, addLabel, assign, createIssue, getIssue, linkIssue, listComments, logWork, transitionIssue, updateIssue } from './issues.js';
import { getProject, listProjects, searchUsers } from './projects.js';
import { fields, search } from './search.js';

/**
 * Request building and response reshaping for Jira Cloud, command by command:
 * the exact request toil sends and what it makes of the answer, checked
 * against Atlassian's documented REST API 3 and Agile API, since no live site
 * has been consulted. The parity suite proves both front doors agree; this
 * proves they agree on what the documentation asked for.
 */

const AUTH = `Basic ${Buffer.from('you@example.com:test-token').toString('base64')}`;
const GET_HEADERS = { authorization: AUTH, accept: 'application/json' };
const JSON_HEADERS = { ...GET_HEADERS, 'content-type': 'application/json' };
const API = `${SITE}/rest/api/3`;
const write = { allowWrite: true };

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[], options: { files?: Record<string, string>; config?: Record<string, Record<string, unknown>> } = {}) {
  const t = testContext({ config: options.config ?? fixtureConfig, routes, files: options.files ?? {} });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls, written: t.files.written };
}

const body = (call: { body?: string | undefined }) => JSON.parse(call.body!) as Record<string, unknown>;

describe('ADF conversion', () => {
  it('plain text becomes paragraphs on blank lines, with single line breaks as hard breaks', () => {
    expect(textToAdf('First line\r\nsecond line\n\n\nNext **paragraph**\n')).toEqual({
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }, { type: 'hardBreak' }, { type: 'text', text: 'second line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Next **paragraph**' }] },
      ],
    });
  });

  it('ADF reads back as text: blocks, lists, tables, mentions and breaks keep their words', () => {
    const tree = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Steps' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Ask ' }, { type: 'mention', attrs: { id: ACCOUNT, text: '@J. Smith' } }, { type: 'hardBreak' }, { type: 'text', text: 'then wait', marks: [{ type: 'strong' }] }] },
        { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }, { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] }] },
        { type: 'orderedList', attrs: { order: 3 }, content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'three' }] }] }] },
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'a' }] }] }, { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'b' }] }] }] }] },
        { type: 'paragraph', content: [{ type: 'inlineCard', attrs: { url: 'https://jira-cloud.imagile.dev/browse/PROJ-1' } }, { type: 'emoji', attrs: { shortName: ':tada:' } }] },
      ],
    };
    expect(adfToText(tree)).toBe('Steps\n\nAsk @J. Smith\nthen wait\n\n- one\n- two\n\n3. three\n\na | b\n\nhttps://jira-cloud.imagile.dev/browse/PROJ-1:tada:');
  });

  it('text round-trips, and anything that is not a document is null (or itself, if a string)', () => {
    expect(adfToText(textToAdf('a\nb\n\nc'))).toBe('a\nb\n\nc');
    expect(adfToText(null)).toBeNull();
    expect(adfToText({ type: 'doc' })).toBeNull();
    expect(adfToText('legacy')).toBe('legacy');
  });
});

describe('issues', () => {
  it('issue get: GETs REST API 3 with Basic auth from email and token, and adds descriptionText', async () => {
    const { envelope, calls } = await run(getIssue, { key: 'PROJ-123' }, [{ method: 'GET', path: '/rest/api/3/issue/PROJ-123', respond: { json: issue('PROJ-123') } }]);
    expect(calls).toEqual([{ method: 'GET', url: `${API}/issue/PROJ-123`, headers: GET_HEADERS, body: undefined }]);
    expect(envelope.data).toMatchObject({ key: 'PROJ-123', fields: { description: doc('Steps to reproduce are in the attached HAR.', 'Seen on 17.x only.') } });
    expect((envelope.data as { descriptionText: string }).descriptionText).toBe('Steps to reproduce are in the attached HAR.\n\nSeen on 17.x only.');
  });

  it('issue get: an issue with no description has descriptionText null', async () => {
    const bare = { ...issue('PROJ-1'), fields: { summary: 'S', description: null } };
    const { envelope } = await run(getIssue, { key: 'PROJ-1' }, [{ path: '/rest/api/3/issue/PROJ-1', respond: { json: bare } }]);
    expect((envelope.data as { descriptionText: unknown }).descriptionText).toBeNull();
  });

  it('issue get: encodes the key as one path segment and keeps a base URL context path', async () => {
    const config = { 'jira-cloud': { ...fixtureConfig['jira-cloud'], baseUrl: `${SITE}/jira` } };
    const { calls } = await run(getIssue, { key: 'PROJ-1/comment' }, [{ path: /\/jira\/rest\/api\/3\/issue\//, respond: { json: issue('X-1') } }], { config });
    expect(calls[0]!.url).toBe(`${SITE}/jira/rest/api/3/issue/PROJ-1%2Fcomment`);
  });

  it('issue get: a 401 is AUTH, naming the email setting and where to make a token', async () => {
    const { envelope } = await run(getIssue, { key: 'PROJ-1' }, [{ path: /issue/, respond: { status: 401, text: '' } }]);
    expect(envelope.error).toMatchObject({ code: 'AUTH' });
    expect(envelope.error?.fix).toContain('TOIL_JIRA_EMAIL');
    expect(envelope.error?.fix).toContain('https://id.atlassian.com/manage-profile/security/api-tokens');
    expect(envelope.error?.fix).toContain('then set apiToken (TOIL_JIRA_API_TOKEN for the default connection).');
  });

  it('issue create: POSTs the Cloud payload (ADF description, accountId assignee), then reads the issue back', async () => {
    const { envelope, calls } = await run(
      createIssue,
      { project: 'PROJ', issueType: 'Bug', summary: 'S', description: 'Line one\nline two\n\nPara two', priority: 'High', assignee: ACCOUNT, labels: 'a, b,', parent: 'PROJ-1', ...write },
      [
        { method: 'POST', path: '/rest/api/3/issue', respond: { status: 201, json: { id: '1', key: 'PROJ-9' } } },
        { method: 'GET', path: '/rest/api/3/issue/PROJ-9', respond: { json: issue('PROJ-9') } },
      ],
    );
    expect(calls[0]).toEqual({
      method: 'POST',
      url: `${API}/issue`,
      headers: JSON_HEADERS,
      body: JSON.stringify({
        fields: {
          project: { key: 'PROJ' },
          issuetype: { name: 'Bug' },
          summary: 'S',
          description: {
            type: 'doc',
            version: 1,
            content: [
              { type: 'paragraph', content: [{ type: 'text', text: 'Line one' }, { type: 'hardBreak' }, { type: 'text', text: 'line two' }] },
              { type: 'paragraph', content: [{ type: 'text', text: 'Para two' }] },
            ],
          },
          priority: { name: 'High' },
          assignee: { accountId: ACCOUNT },
          labels: ['a', 'b'],
          parent: { key: 'PROJ-1' },
        },
      }),
    });
    expect(calls[1]!.url).toBe(`${API}/issue/PROJ-9`);
    expect(envelope.data).toMatchObject({ key: 'PROJ-9', descriptionText: expect.any(String) });
  });

  it('issue create: project, issue type and priority fall back to the connection, and meta.context says so', async () => {
    const config = { 'jira-cloud': { ...fixtureConfig['jira-cloud'], project: 'DEF', issueType: 'Story', priority: 'Low' } };
    const { envelope, calls } = await run(createIssue, { summary: 'S', ...write }, [
      { method: 'POST', path: '/rest/api/3/issue', respond: { json: { id: '1', key: 'DEF-1' } } },
      { path: '/rest/api/3/issue/DEF-1', respond: { json: issue('DEF-1') } },
    ], { config });
    expect(body(calls[0]!).fields).toEqual({ project: { key: 'DEF' }, issuetype: { name: 'Story' }, summary: 'S', priority: { name: 'Low' } });
    expect(envelope.meta.context?.inputs?.project).toMatchObject({ value: 'DEF', source: 'connection' });
  });

  it('issue create: with no project anywhere, refuses before any request', async () => {
    const noProject: Record<string, unknown> = { ...fixtureConfig['jira-cloud'] };
    delete noProject.project;
    const { envelope, calls } = await run(createIssue, { summary: 'S', ...write }, [], { config: { 'jira-cloud': noProject } });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.fix).toContain('TOIL_JIRA_PROJECT');
    expect(calls).toHaveLength(0);
  });

  it('issue update: PUTs only the fields given, and refuses an update with nothing in it', async () => {
    const { envelope, calls } = await run(updateIssue, { key: 'PROJ-123', description: 'New', assignee: ACCOUNT, ...write }, [{ method: 'PUT', path: '/rest/api/3/issue/PROJ-123', respond: { status: 204 } }]);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: `${API}/issue/PROJ-123`, headers: JSON_HEADERS });
    expect(body(calls[0]!)).toEqual({ fields: { description: textToAdf('New'), assignee: { accountId: ACCOUNT } } });
    expect(envelope.data).toEqual({ updated: 'PROJ-123' });
    const nothing = await run(updateIssue, { key: 'PROJ-123', labels: ' , ', ...write }, []);
    expect(nothing.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('Nothing to update') });
    expect(nothing.calls).toHaveLength(0);
  });

  it('issue transition: a name is looked up case-insensitively; an unknown one lists what is available', async () => {
    const routes: Route[] = [
      { method: 'GET', path: '/rest/api/3/issue/PROJ-123/transitions', respond: { json: { transitions: [{ id: '21', name: 'In Progress' }, { id: '31', name: 'Done' }] } } },
      { method: 'POST', path: '/rest/api/3/issue/PROJ-123/transitions', respond: { status: 204 } },
    ];
    const ok = await run(transitionIssue, { key: 'PROJ-123', transition: 'done', ...write }, routes);
    expect(body(ok.calls[1]!)).toEqual({ transition: { id: '31' } });
    expect(ok.envelope.data).toEqual({ transitioned: 'PROJ-123', transition: 'done' });
    const missing = await run(transitionIssue, { key: 'PROJ-123', transition: 'Shipped', ...write }, routes);
    expect(missing.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('In Progress, Done') });
    // "2nd Review" is a name, not an id: only all digits skip the lookup.
    const digits = await run(transitionIssue, { key: 'PROJ-123', transition: '31', ...write }, routes);
    expect(digits.calls.map((c) => c.method)).toEqual(['POST']);
  });

  it('issue comment: sends the body as ADF and returns the comment with bodyText; a blank body is refused', async () => {
    const { envelope, calls } = await run(addComment, { key: 'PROJ-123', body: 'Hello\n\nWorld', ...write }, [
      { method: 'POST', path: '/rest/api/3/issue/PROJ-123/comment', respond: { status: 201, json: { id: '1', body: doc('Hello', 'World') } } },
    ]);
    expect(body(calls[0]!)).toEqual({ body: doc('Hello', 'World') });
    expect(envelope.data).toEqual({ id: '1', body: doc('Hello', 'World'), bodyText: 'Hello\n\nWorld' });
    const blank = await run(addComment, { key: 'PROJ-123', body: '  \n ', ...write }, []);
    expect(blank.envelope.error?.code).toBe('INVALID_INPUT');
    expect(blank.calls).toHaveLength(0);
  });

  it('issue comments: pages by startAt until total, adding bodyText to each', async () => {
    const page = (startAt: number, comments: unknown[]) => ({ json: { startAt, maxResults: 50, total: 51, comments } });
    const first = Array.from({ length: 50 }, (_, i) => ({ id: String(i), body: doc(`c${i}`) }));
    const { envelope, calls } = await run(listComments, { key: 'PROJ-123' }, [
      { path: '/rest/api/3/issue/PROJ-123/comment', query: { startAt: '0', maxResults: '50' }, respond: page(0, first) },
      { path: '/rest/api/3/issue/PROJ-123/comment', query: { startAt: '50', maxResults: '50' }, respond: page(50, [{ id: '50', body: doc('last') }]) },
    ]);
    expect(calls).toHaveLength(2);
    const data = envelope.data as Array<{ bodyText: string }>;
    expect(data).toHaveLength(51);
    expect(data.at(-1)).toEqual({ id: '50', body: doc('last'), bodyText: 'last' });
  });

  it('issue label: sends label operations, and refuses a list with no label in it', async () => {
    const { calls } = await run(addLabel, { key: 'PROJ-123', labels: 'a,b', ...write }, [{ method: 'PUT', path: '/rest/api/3/issue/PROJ-123', respond: { status: 204 } }]);
    expect(body(calls[0]!)).toEqual({ update: { labels: [{ add: 'a' }, { add: 'b' }] } });
    const none = await run(addLabel, { key: 'PROJ-123', labels: ',', ...write }, []);
    expect(none.envelope.error?.code).toBe('INVALID_INPUT');
    expect(none.calls).toHaveLength(0);
  });

  it('assign: PUTs the accountId', async () => {
    const { envelope, calls } = await run(assign, { key: 'PROJ-123', assignee: ACCOUNT, ...write }, [{ method: 'PUT', path: '/rest/api/3/issue/PROJ-123/assignee', respond: { status: 204 } }]);
    expect(body(calls[0]!)).toEqual({ accountId: ACCOUNT });
    expect(envelope.data).toEqual({ assigned: 'PROJ-123', assignee: ACCOUNT });
  });

  it('issue link: resolves a phrase to its link type id; an unknown one lists the names', async () => {
    const routes: Route[] = [
      { path: '/rest/api/3/issueLinkType', respond: { json: { issueLinkTypes: [{ id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }] } } },
      { method: 'POST', path: '/rest/api/3/issueLink', respond: { status: 201 } },
    ];
    const ok = await run(linkIssue, { key: 'A-1', type: 'is blocked by', target: 'A-2', ...write }, routes);
    expect(body(ok.calls[1]!)).toEqual({ type: { id: '10000' }, inwardIssue: { key: 'A-1' }, outwardIssue: { key: 'A-2' } });
    const bad = await run(linkIssue, { key: 'A-1', type: 'Duplicates', target: 'A-2', ...write }, routes);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('Blocks') });
  });

  it('writes are refused without --allow-write, before any request', async () => {
    const { envelope, calls } = await run(assign, { key: 'PROJ-123', assignee: ACCOUNT }, []);
    expect(envelope.error?.code).toBe('WRITE_DISABLED');
    expect(calls).toHaveLength(0);
  });
});

describe('search', () => {
  const pages: Route = {
    method: 'POST',
    path: '/rest/api/3/search/jql',
    respond: (req) => {
      const sent = JSON.parse(req.body!) as { nextPageToken?: string };
      return sent.nextPageToken === 'tok-2'
        ? { json: { issues: [issue('PROJ-3')], isLast: true } }
        : { json: { issues: [issue('PROJ-1'), issue('PROJ-2')], nextPageToken: 'tok-2', isLast: false } };
    },
  };

  it('POSTs the enhanced search, following nextPageToken to the end when no maxResults is given', async () => {
    const { envelope, calls } = await run(search, { jql: ' project = PROJ \n' }, [pages]);
    // The standard set plus every registered custom field, as jira sends it.
    const fields = ['summary', 'status', 'priority', 'assignee', 'issuetype', 'project', 'created', 'updated', 'labels', 'reporter', 'customfield_10016', 'customfield_10300'];
    expect(calls.map((c) => body(c))).toEqual([
      { jql: 'project = PROJ', maxResults: 100, fields },
      { jql: 'project = PROJ', maxResults: 100, fields, nextPageToken: 'tok-2' },
    ]);
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${API}/search/jql`, headers: JSON_HEADERS });
    const data = envelope.data as { issues: Array<{ key: string }>; maxResults: number; isLast: boolean };
    expect(data.issues.map((i) => i.key)).toEqual(['PROJ-1', 'PROJ-2', 'PROJ-3']);
    expect(data).toMatchObject({ maxResults: 3, isLast: true });
    expect(envelope.meta.page).toBeUndefined();
  });

  it('--more-fields adds to the default set or to --fields, de-duplicated, and refuses an unknown name', async () => {
    const plain = await run(search, { jql: 'project = PROJ', limit: 1 }, [pages]);
    const base = body(plain.calls[0]!).fields as string[];
    const more = await run(search, { jql: 'project = PROJ', limit: 1, moreFields: 'fixVersions, summary' }, [pages]);
    expect(body(more.calls[0]!).fields).toEqual([...base, 'fixVersions']);
    const both = await run(search, { jql: 'project = PROJ', limit: 1, fields: 'summary', moreFields: 'customfield_10016,summary' }, [pages]);
    expect(body(both.calls[0]!).fields).toEqual(['summary', 'customfield_10016']);
    const bad = await run(search, { jql: 'x', moreFields: 'Epic Name' }, []);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown field in --more-fields: "Epic Name".' });
  });

  it('stops at maxResults and hands back a cursor that resumes exactly', async () => {
    const first = await run(search, { jql: 'project = PROJ', limit: 1, fields: 'summary, customfield_10016' }, [pages]);
    expect(body(first.calls[0]!)).toEqual({ jql: 'project = PROJ', maxResults: 1, fields: ['summary', 'customfield_10016'] });
    expect(first.envelope.data).toMatchObject({ maxResults: 1, isLast: false });
    const cursor = first.envelope.meta.page?.nextCursor;
    expect(cursor).toEqual(expect.any(String));
    const second = await run(search, { jql: 'project = PROJ', limit: 2, cursor }, [pages]);
    const keys = (second.envelope.data as { issues: Array<{ key: string }> }).issues.map((i) => i.key);
    expect(keys).toEqual(['PROJ-2', 'PROJ-3']);
    expect(second.envelope.meta.page).toEqual({ nextCursor: null, limit: 2 });
  });

  it('refuses a bad cursor, a cursor without maxResults, both --jql and --jql-file, and an empty query', async () => {
    const bad = await run(search, { jql: 'x', limit: 1, cursor: 'nope' }, [pages]);
    expect(bad.envelope.error?.code).toBe('INVALID_INPUT');
    const lone = await run(search, { jql: 'x', cursor: 'eyJjIjpudWxsLCJzIjoyfQ' }, []);
    expect(lone.envelope.error?.message).toBe('--cursor needs --limit');
    const both = await run(search, { jql: 'x', jqlFile: 'q.jql' }, [], { files: { 'q.jql': 'y' } });
    expect(both.envelope.error?.message).toBe('Cannot specify both --jql and --jql-file');
    const blank = await run(search, { jqlFile: 'q.jql' }, [], { files: { 'q.jql': '\n' } });
    expect(blank.envelope.error?.message).toBe('JQL query is empty');
  });

  describe('--changelog', () => {
    const histories = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), created: '2026-10-01T09:30:00.000+0000', items: [] }));
    const withChangelog = (changelogs: Array<{ total: number; sent: number; maxResults?: number }>): Route => ({
      method: 'POST',
      path: '/rest/api/3/search/jql',
      respond: (req) => {
        const sent = body({ body: req.body });
        const issues = changelogs.map((c, i) => ({ ...issue(`PROJ-${i + 1}`), ...(sent.expand === 'changelog' ? { changelog: { startAt: 0, maxResults: c.maxResults ?? 100, total: c.total, histories: histories(c.sent) } } : {}) }));
        return { json: { issues, isLast: true } };
      },
    });

    it('sends expand: "changelog" (a string) in the POST body and returns each changelog as Jira sent it', async () => {
      const { envelope, calls } = await run(search, { jql: 'project = PROJ', changelog: true }, [withChangelog([{ total: 2, sent: 2 }, { total: 1, sent: 1 }])]);
      expect(body(calls[0]!)).toMatchObject({ jql: 'project = PROJ', maxResults: 100, expand: 'changelog' });
      const issues = (envelope.data as { issues: Array<{ key: string; changelog: { total: number; histories: unknown[] } }> }).issues;
      expect(issues.map((i) => [i.key, i.changelog.total, i.changelog.histories.length])).toEqual([['PROJ-1', 2, 2], ['PROJ-2', 1, 1]]);
      expect(envelope.meta.warnings).toBeUndefined();
    });

    it('keeps --fields working alongside it', async () => {
      const { calls } = await run(search, { jql: 'project = PROJ', fields: 'summary, customfield_10016', changelog: true }, [withChangelog([{ total: 1, sent: 1 }])]);
      expect(body(calls[0]!)).toMatchObject({ fields: ['summary', 'customfield_10016'], expand: 'changelog' });
    });

    it('warns once, naming how many issues were cut short and the command that reads it whole', async () => {
      const { envelope } = await run(search, { jql: 'project = PROJ', changelog: true }, [withChangelog([{ total: 250, sent: 100 }, { total: 3, sent: 3 }, { total: 120, sent: 100 }])]);
      expect(envelope.meta.warnings).toEqual([{ code: 'JIRA_CLOUD_CHANGELOG_TRUNCATED', message: expect.stringMatching(/2 of 3 issues.*jira issue history <key>/) }]);
      const issues = (envelope.data as { issues: Array<{ changelog: { histories: unknown[] } }> }).issues;
      expect(issues.map((i) => i.changelog.histories.length)).toEqual([100, 3, 100]);
    });

    // The documented Cloud shape: the page holds at most 20 entries, newest first, and
    // `total` is the number on the page ("the number of results on the page"), so a
    // history cut at 20 reports total 20 and only the full page gives it away.
    it('warns when the page is full: total equals the entries sent, and both equal maxResults', async () => {
      const { envelope } = await run(search, { jql: 'project = PROJ', changelog: true }, [withChangelog([{ total: 20, sent: 20, maxResults: 20 }, { total: 5, sent: 5, maxResults: 20 }])]);
      expect(envelope.meta.warnings).toEqual([{ code: 'JIRA_CLOUD_CHANGELOG_TRUNCATED', message: expect.stringMatching(/1 of 2 issues.*may be cut short.*jira issue history <key>/) }]);
    });

    it('does not warn for 5 entries on a page of 20 with total 5', async () => {
      const { envelope } = await run(search, { jql: 'project = PROJ', changelog: true }, [withChangelog([{ total: 5, sent: 5, maxResults: 20 }])]);
      expect(envelope.meta.warnings).toBeUndefined();
    });

    it('warns when total or maxResults is missing, since nothing then says the history is whole', async () => {
      const route: Route = { method: 'POST', path: '/rest/api/3/search/jql', respond: () => ({ json: { issues: [
        { ...issue('PROJ-1'), changelog: { histories: histories(2) } },
        { ...issue('PROJ-2'), changelog: { maxResults: 20, histories: histories(2) } },
        { ...issue('PROJ-3'), changelog: { total: 2, histories: histories(2) } },
      ], isLast: true } }) };
      const { envelope } = await run(search, { jql: 'project = PROJ', changelog: true }, [route]);
      expect(envelope.meta.warnings).toEqual([{ code: 'JIRA_CLOUD_CHANGELOG_TRUNCATED', message: expect.stringMatching(/3 of 3 issues.*may be cut short/) }]);
    });

    it('sends no expand without the flag', async () => {
      const { envelope, calls } = await run(search, { jql: 'project = PROJ' }, [withChangelog([{ total: 250, sent: 100 }])]);
      expect(body(calls[0]!)).not.toHaveProperty('expand');
      expect((envelope.data as { issues: Array<Record<string, unknown>> }).issues[0]).not.toHaveProperty('changelog');
      expect(envelope.meta.warnings).toBeUndefined();
    });
  });
});

describe('projects and users', () => {
  it('project list: pages /project/search until isLast, passing the query', async () => {
    const values = (n: number, from: number) => Array.from({ length: n }, (_, i) => ({ id: String(from + i), key: `P${from + i}` }));
    const { envelope, calls } = await run(listProjects, { query: 'img' }, [
      { path: '/rest/api/3/project/search', query: { query: 'img', startAt: '0', maxResults: '50' }, respond: { json: { startAt: 0, maxResults: 50, total: 52, isLast: false, values: values(50, 0) } } },
      { path: '/rest/api/3/project/search', query: { query: 'img', startAt: '50', maxResults: '50' }, respond: { json: { startAt: 50, maxResults: 50, total: 52, isLast: true, values: values(2, 50) } } },
    ]);
    expect(calls).toHaveLength(2);
    expect(envelope.data as unknown[]).toHaveLength(52);
  });

  it('user search: one GET with the query and a default of 50', async () => {
    const { calls } = await run(searchUsers, { query: 'smith' }, [{ path: '/rest/api/3/user/search', respond: { json: [] } }]);
    expect(calls[0]!.url).toBe(`${API}/user/search?query=smith&maxResults=50`);
  });
});

describe('custom fields and input files', () => {
  const created: Route[] = [
    { method: 'POST', path: '/rest/api/3/issue', respond: { status: 201, json: { id: '1', key: 'PROJ-9' } } },
    { method: 'GET', path: '/rest/api/3/issue/PROJ-9', respond: { json: { ...issue('PROJ-9'), fields: { ...issue('PROJ-9').fields, customfield_10016: 5 } } } },
  ];

  it('--field shapes registered fields by type: a user is an accountId, a textarea is ADF; output uses friendly names', async () => {
    const config = {
      'jira-cloud': { ...fixtureConfig['jira-cloud'], customFields: [...fixtureConfig['jira-cloud'].customFields, { id: 'customfield_10400', name: 'Notes', type: 'textarea' }] },
    };
    const { envelope, calls } = await run(createIssue, { summary: 'S', field: ['Story Points=5', `Reviewer=${ACCOUNT}`, 'Notes=one\ntwo', 'customfield_10500=raw'], ...write }, created, { config });
    expect(body(calls[0]!).fields).toMatchObject({
      customfield_10016: 5,
      customfield_10300: { accountId: ACCOUNT },
      customfield_10400: textToAdf('one\ntwo'),
      customfield_10500: 'raw',
    });
    expect((envelope.data as { fields: Record<string, unknown> }).fields['Story Points']).toBe(5);
  });

  it('a multi-user picker is suggested as multi-user, not user, and --field sends a list of accountIds', async () => {
    expect(suggestedType({ type: 'array', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:multiuserpicker' })).toBe('multi-user');
    expect(suggestedType({ type: 'user', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:userpicker' })).toBe('user');
    const config = { 'jira-cloud': { ...fixtureConfig['jira-cloud'], customFields: [{ id: 'customfield_10600', name: 'Watchers', type: 'multi-user' }] } };
    const { calls } = await run(createIssue, { summary: 'S', field: [`Watchers=${ACCOUNT}, abc12345`], ...write }, created, { config });
    expect(body(calls[0]!).fields).toMatchObject({ customfield_10600: [{ accountId: ACCOUNT }, { accountId: 'abc12345' }] });
  });

  it('an --input-file supplies the issue and reports its project as source file; @file text becomes ADF; flags override and are reported', async () => {
    const files = { 'issue.json': JSON.stringify({ project: 'FILE', issueType: 'Story', fields: { summary: 'From file', description: '@d.txt', priority: 'High', assignee: ACCOUNT } }), 'd.txt': 'a\n\nb' };
    const { envelope, calls } = await run(createIssue, { inputFile: 'issue.json', priority: 'Low', ...write }, created, { files });
    expect(body(calls[0]!).fields).toEqual({
      project: { key: 'FILE' },
      issuetype: { name: 'Story' },
      summary: 'From file',
      description: textToAdf('a\n\nb'),
      priority: { name: 'Low' },
      assignee: { accountId: ACCOUNT },
    });
    expect(envelope.meta.context?.inputs?.project).toMatchObject({ value: 'FILE', source: 'file' });
    expect(envelope.meta.warnings).toEqual([{ code: 'JIRA_CLOUD_INPUT_OVERRIDDEN', message: '--input-file value(s) overridden by flags: priority' }]);
  });

  it('an ADF description in --input-file is sent as it is; any other object is refused before a request', async () => {
    const adf = doc('Already ADF');
    const ok = await run(updateIssue, { key: 'PROJ-123', inputFile: 'u.json', ...write }, [{ method: 'PUT', path: '/rest/api/3/issue/PROJ-123', respond: { status: 204 } }], {
      files: { 'u.json': JSON.stringify({ fields: { description: adf } }) },
    });
    expect(body(ok.calls[0]!)).toEqual({ fields: { description: adf } });
    const bad = await run(updateIssue, { key: 'PROJ-123', inputFile: 'u.json', ...write }, [], { files: { 'u.json': JSON.stringify({ fields: { summary: { text: 'x' } } }) } });
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'fields.summary in --input-file must be text.' });
    expect(bad.calls).toHaveLength(0);
  });

  it('fields --discover --project merges allowedValues from the paged createmeta, and refuses an unknown issue type', async () => {
    const routes: Route[] = [
      { path: '/rest/api/3/field', respond: { json: [{ id: 'customfield_10200', name: 'Crew', custom: true, schema: { type: 'option', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:select' } }, { id: 'customfield_10401', name: 'Notes', custom: true, schema: { type: 'string', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textfield' } }] } },
      { path: '/rest/api/3/issue/createmeta/PROJ/issuetypes', respond: { json: { startAt: 0, maxResults: 50, total: 2, issueTypes: [{ id: '1', name: 'Bug' }, { id: '2', name: 'Story' }] } } },
      { path: '/rest/api/3/issue/createmeta/PROJ/issuetypes/1', respond: { json: { startAt: 0, total: 1, fields: [{ fieldId: 'customfield_10200', allowedValues: [{ id: '10', value: 'A' }] }] } } },
      { path: '/rest/api/3/issue/createmeta/PROJ/issuetypes/2', respond: { json: { startAt: 0, total: 1, fields: [{ fieldId: 'customfield_10200', allowedValues: [{ id: '10', value: 'A' }, { id: '11', value: 'B' }] }] } } },
    ];
    const { envelope } = await run(fields, { discover: true, project: 'PROJ' }, routes);
    expect(envelope.data).toEqual([
      expect.objectContaining({ id: 'customfield_10200', suggestedType: 'select', allowedValues: [{ id: '10', value: 'A' }, { id: '11', value: 'B' }] }),
      // A single-line text field takes a plain string on Cloud, so it isn't suggested as textarea (ADF).
      expect.objectContaining({ id: 'customfield_10401', suggestedType: 'string' }),
    ]);
    const unknown = await run(fields, { discover: true, project: 'PROJ', issueType: 'Epic' }, routes);
    expect(unknown.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Use one of: Bug, Story.' });
  });
});

describe('worklogs and attachments', () => {
  it('log-work: POSTs timeSpent and started, with the comment as ADF, and adds commentText', async () => {
    const { envelope, calls } = await run(logWork, { key: 'PROJ-123', timeSpent: '1d', started: '2026-01-15T09:00:00.000+0000', comment: 'Done', ...write }, [
      { method: 'POST', path: '/rest/api/3/issue/PROJ-123/worklog', respond: { status: 201, json: { id: '1', comment: doc('Done') } } },
    ]);
    expect(body(calls[0]!)).toEqual({ timeSpent: '1d', started: '2026-01-15T09:00:00.000+0000', comment: textToAdf('Done') });
    expect(envelope.data).toMatchObject({ id: '1', commentText: 'Done' });
  });

  it('issue attach: one multipart part named file, with the no-check header', async () => {
    const { calls } = await run(addAttachment, { key: 'PROJ-123', inputFile: 'dir/shot.png', ...write }, [{ method: 'POST', path: '/rest/api/3/issue/PROJ-123/attachments', respond: { json: [] } }], { files: { 'dir/shot.png': 'PNG!' } });
    expect(calls[0]!.headers).toMatchObject({ authorization: AUTH, 'x-atlassian-token': 'no-check', 'content-type': expect.stringMatching(/^multipart\/form-data; boundary=/) });
    expect(String(calls[0]!.body)).toContain('name="file"; filename="shot.png"');
  });

  it('issue download: asks for the bytes with redirect=false on the configured host, and saves under .toil', async () => {
    const { envelope, calls, written } = await run(downloadAttachment, { key: 'PROJ-123', attachmentId: '10001' }, [
      { path: '/rest/api/3/issue/PROJ-123', query: { fields: 'attachment' }, respond: { json: { fields: { attachment: [{ id: '10001', filename: '../shot.png', content: 'https://elsewhere.imagile.dev/x' }] } } } },
      { path: '/rest/api/3/attachment/content/10001', query: { redirect: 'false' }, respond: { text: 'PNG!' } },
    ]);
    expect(calls[1]).toMatchObject({ url: `${API}/attachment/content/10001?redirect=false`, headers: { authorization: AUTH, accept: '*/*' } });
    expect(envelope.data).toMatchObject({ filename: '../shot.png', size: 4 });
    expect(Object.keys(written)).toEqual([expect.stringMatching(/\.toil\/shot\.png$/)]);
  });

  it('issue download: an id not on the issue is INVALID_INPUT before any download', async () => {
    const { envelope, calls } = await run(downloadAttachment, { key: 'PROJ-123', attachmentId: '9' }, [{ path: '/rest/api/3/issue/PROJ-123', respond: { json: { fields: {} } } }]);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: expect.stringContaining('issue attachments') });
    expect(calls).toHaveLength(1);
  });
});

describe('agile', () => {
  it('sprint list: across a project, only scrum boards, each sprint once, until isLast', async () => {
    const { envelope, calls } = await run(listSprints, { project: 'PROJ', state: 'active, closed' }, [
      { path: '/rest/agile/1.0/board', respond: { json: { startAt: 0, maxResults: 50, total: 3, isLast: true, values: [{ id: 3, type: 'scrum' }, { id: 4, type: 'kanban' }, { id: 5, type: 'scrum' }] } } },
      { path: /^\/rest\/agile\/1\.0\/board\/(3|5)\/sprint$/, respond: { json: { startAt: 0, maxResults: 50, isLast: true, values: sprints } } },
    ]);
    expect(calls.map((c) => c.url)).toEqual([
      `${SITE}/rest/agile/1.0/board?projectKeyOrId=PROJ&startAt=0&maxResults=50`,
      `${SITE}/rest/agile/1.0/board/3/sprint?startAt=0&maxResults=50&state=active,closed`,
      `${SITE}/rest/agile/1.0/board/5/sprint?startAt=0&maxResults=50&state=active,closed`,
    ]);
    expect((envelope.data as Array<{ id: number }>).map((s) => s.id)).toEqual([41, 42]);
  });

  it('sprint list --project: reads team-managed (simple) boards too; one without sprints is skipped with a warning naming it', async () => {
    const { envelope, calls } = await run(listSprints, { project: 'IMG' }, [
      { path: '/rest/agile/1.0/board', respond: { json: { startAt: 0, isLast: true, values: [{ id: 7, name: 'IMG board', type: 'simple' }, { id: 8, name: 'IMG sprints', type: 'simple' }] } } },
      { path: '/rest/agile/1.0/board/7/sprint', respond: { status: 400, json: { errorMessages: ['The board does not support sprints'] } } },
      { path: '/rest/agile/1.0/board/8/sprint', respond: { json: { startAt: 0, isLast: true, values: [sprints[1]] } } },
    ]);
    expect(calls).toHaveLength(3);
    expect((envelope.data as Array<{ id: number }>).map((s) => s.id)).toEqual([42]);
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'JIRA_CLOUD_NO_SPRINTS', message: expect.stringContaining('IMG board (7)') })]);
  });

  it('sprint list --project: a 400 from a scrum board is still an error', async () => {
    const { envelope } = await run(listSprints, { project: 'PROJ' }, [
      { path: '/rest/agile/1.0/board', respond: { json: { startAt: 0, isLast: true, values: [{ id: 3, name: 'PROJ board', type: 'scrum' }] } } },
      { path: '/rest/agile/1.0/board/3/sprint', respond: { status: 400, json: { errorMessages: ['Bad state'] } } },
    ]);
    expect(envelope.error?.code).toBe('HTTP');
  });

  it('sprint list: needs a board or a project, and refuses an unknown state before any request', async () => {
    const neither = await run(listSprints, {}, []);
    expect(neither.envelope.error?.message).toBe('Either --board or --project is required');
    const bad = await run(listSprints, { board: 3, state: 'open' }, []);
    expect(bad.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'Unknown sprint state: open' });
    expect(bad.calls).toHaveLength(0);
  });

  it('set-sprint: POSTs the issue to the sprint and returns the sprint as a string, as jira does', async () => {
    const { envelope, calls } = await run(setSprint, { key: 'PROJ-123', sprint: 42, ...write }, [{ method: 'POST', path: '/rest/agile/1.0/sprint/42/issue', respond: { status: 204 } }]);
    expect(body(calls[0]!)).toEqual({ issues: ['PROJ-123'] });
    expect(envelope.data).toEqual({ updated: 'PROJ-123', sprint: '42' });
  });
});

describe('ids in request paths', () => {
  it('project get: a key with path or query syntax is sent encoded as one segment', async () => {
    const cases: Array<[string, string]> = [
      ['a/b?c=d', 'a%2Fb%3Fc%3Dd'],
      ['p1#hot', 'p1%23hot'],
      ['%2e%2e', '%252e%252e'],
    ];
    for (const [project, sent] of cases) {
      const { calls } = await run(getProject, { project }, [{ url: /\/rest\/api\/3\/project\//, respond: { json: { id: '1', key: 'P' } } }]);
      expect(calls.map((c) => c.url), project).toEqual([`${API}/project/${sent}`]);
    }
  });

  it('issue comment add: the key is sent encoded, and one that would climb out of the issue path is refused', async () => {
    const { calls } = await run(addComment, { key: 'a/b?c=d', body: 'Hi', ...write }, [{ method: 'POST', url: /\/comment$/, respond: { status: 201, json: { id: '1' } } }]);
    expect(calls.map((c) => [c.method, c.url])).toEqual([['POST', `${API}/issue/a%2Fb%3Fc%3Dd/comment`]]);
    const climbing = await run(addComment, { key: 'x/../y', body: 'Hi', ...write }, []);
    expect(climbing.envelope.error).toMatchObject({ code: 'INVALID_INPUT' });
    expect(climbing.calls).toHaveLength(0);
  });

  it('issue create: a project key with path syntax is refused from the flag or the connection setting', async () => {
    const flag = await run(createIssue, { project: 'P/../X', issueType: 'Bug', summary: 'S', ...write }, []);
    expect(flag.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("can't contain") });
    expect(flag.calls).toHaveLength(0);
    const config = { 'jira-cloud': { ...fixtureConfig['jira-cloud'], project: 'P?x=1', issueType: 'Bug' } };
    const setting = await run(createIssue, { summary: 'S', ...write }, [], { config });
    expect(setting.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining("can't contain") });
    expect(setting.calls).toHaveLength(0);
  });
});
