import { describe, expect, it } from 'vitest';
import { openapiSamples } from '../../../test/fixtures/util.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import type { Envelope } from '../../core/envelope.js';
import { execute } from '../../core/run.js';
import { commands } from './index.js';
import { BOUNDED_TIMEOUT_MS } from './kit/bounded.js';
import { parseYaml } from './kit/yaml.js';
import { EXAMPLE_TEXT, openapiExampleCommand, openapiListCommand, openapiShowCommand } from './openapi.js';
import { checkExample, generateExample, MAX_STRING, sampleOfPattern } from './openapi/example.js';

/**
 * `util openapi` end to end through execute(), on the vendors' own documents
 * (trimmed, test/fixtures/openapi/), plus documents broken on purpose to show
 * each self-check catches what it claims to: an invalid document and a broken
 * `$ref` by pointer, a loop reported rather than followed, a generated
 * example that doesn't fit its schema. A check that has never failed is a
 * check nobody has audited.
 */

/** Room past a bounded worker's deadline for its start and teardown on a loaded runner: what a deadline test catches is one that never fires. */
const DEADLINE_ROOM = 8_000;

const JIRA = 'specs/jira-platform.json';
const GITHUB = 'specs/github.yaml';
const BITBUCKET = 'specs/bitbucket.json';

// The envelopes are read loosely here; the shapes are what the assertions check.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;
const run = async (command: typeof openapiListCommand | typeof openapiShowCommand | typeof openapiExampleCommand, input: Record<string, unknown>, files: Record<string, string> = openapiSamples) => {
  const envelope = (await execute(command as never, input, testContext({ files }).context)) as Envelope;
  return { envelope, data: envelope.data as Data, warnings: envelope.meta.warnings ?? [] };
};
const check = (data: Data, name: string) => (data.verified.checks as Data[]).find((c) => c.check === name);
const jira = () => JSON.parse(openapiSamples[JIRA]) as Data;
const asText = (doc: unknown) => JSON.stringify(doc);

describe('util openapi list', () => {
  it.each([
    [JIRA, 'openapi-3.0', '3.0.1', 'json', 8, ['https://jira.imagile.dev']],
    [GITHUB, 'openapi-3.1', '3.1.0', 'yaml', 5, ['https://api.github.com']],
    [BITBUCKET, 'swagger-2.0', '2.0', 'json', 4, ['https://api.bitbucket.org/2.0']],
  ])('lists every operation in %s and validates it against its version', async (file, spec, version, format, count, servers) => {
    const { envelope, data } = await run(openapiListCommand, { inputFile: file });
    expect(envelope.ok).toBe(true);
    expect(data.document).toMatchObject({ spec, version, format, valid: true, problems: [], problemCount: 0, servers, operations: count });
    expect(data.document.refs.broken).toEqual([]);
    expect(data.count).toBe(count);
    expect(data.verified.passed).toBe(true);
    expect(check(data, 'document.schema')).toMatchObject({ status: 'passed' });
    expect(check(data, 'refs.resolve')).toMatchObject({ status: 'passed', failed: 0 });
    expect(check(data, 'input.complete')).toMatchObject({ status: 'passed' });
  });

  it('shows method, path, operationId, summary and tags, filtered by tag or by part of the path', async () => {
    const { data } = await run(openapiListCommand, { inputFile: JIRA });
    expect(data.operations[0]).toEqual({ method: 'GET', path: '/rest/api/2/issue/{issueIdOrKey}', operationId: 'getIssue', summary: 'Get issue', tags: ['Issues'], deprecated: false });
    const pulls = await run(openapiListCommand, { inputFile: GITHUB, tag: 'PULLS' });
    expect(pulls.data.operations.map((o: Data) => o.operationId)).toEqual(['pulls/list', 'pulls/create', 'pulls/get']);
    const bb = await run(openapiListCommand, { inputFile: BITBUCKET, path: 'pullrequests' });
    expect(bb.data.operations.map((o: Data) => `${o.method} ${o.path}`)).toEqual([
      'GET /repositories/{workspace}/{repo_slug}/pullrequests',
      'POST /repositories/{workspace}/{repo_slug}/pullrequests',
      'GET /repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}',
    ]);
    expect(bb.data.document.operations).toBe(4);
  });

  it('reports the loops among references once, without following them', async () => {
    const { data } = await run(openapiListCommand, { inputFile: BITBUCKET });
    expect(data.document.refs.circular).toContainEqual(['#/definitions/branch', '#/definitions/commit', '#/definitions/ref', '#/definitions/repository']);
  });

  it('checks a document with 200,000 refs and 20,000 operations in linear time', async () => {
    const paths: Data = {};
    for (let i = 0; i < 20_000; i++) paths[`/p${i}`] = { get: { operationId: `op${i}`, responses: Object.fromEntries(Array.from({ length: 10 }, (_, k) => [`${200 + k}`, { $ref: '#/components/responses/R' }])) } };
    const doc = { openapi: '3.0.3', info: { title: 'Many', version: '1' }, paths, components: { responses: { R: { description: 'ok' } } } };
    const started = performance.now();
    const { data } = await run(openapiListCommand, { text: asText(doc), path: '/p19999' });
    expect(performance.now() - started).toBeLessThan(15_000);
    expect(data.document.refs).toMatchObject({ total: 200_000, broken: [] });
    expect(data.count).toBe(1);
  }, 30_000);

  it('refuses a document nested deeper than it reads, as INVALID_INPUT and never a crash', async () => {
    let deep = '"x"';
    for (let i = 0; i < 10_000; i++) deep = `[${deep}]`;
    const started = performance.now();
    const { envelope } = await run(openapiListCommand, { text: `{"openapi":"3.0.3","info":{"title":"Deep","version":"1"},"paths":{},"x-deep":${deep}}` });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/nests far more than 256 levels deep/) });
  });

  it('caps how deep show nests its output, so refs into deeply nested schemas are cut rather than overflowing', async () => {
    // Twenty schemas, each 120 inline levels deep with a ref to the next at the bottom: 4,800 levels expanded.
    const schemas: Data = { S20: { type: 'string' } };
    for (let i = 0; i < 20; i++) {
      let inner: Data = { $ref: `#/components/schemas/S${i + 1}` };
      for (let level = 0; level < 120; level++) inner = { type: 'object', properties: { a: inner } };
      schemas[`S${i}`] = inner;
    }
    const doc = { openapi: '3.0.3', info: { title: 'Nested', version: '1' }, paths: { '/n': { post: { operationId: 'nested', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }, responses: { '200': { description: 'ok' } } } } }, components: { schemas } };
    const { envelope, data, warnings } = await run(openapiShowCommand, { text: asText(doc), operation: 'nested', depth: 20 });
    expect(envelope.ok).toBe(true);
    expect(data.expansion.truncated).toBe(true);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_EXPANSION_TRUNCATED' }));
    expect(() => JSON.stringify(envelope)).not.toThrow();
  });

  it('reports an invalid document by JSON pointer, still lists it, and fails the check', async () => {
    const doc = jira();
    doc.paths['/rest/api/2/myself'].get.responses = 'none';
    delete doc.info.title;
    const { envelope, data, warnings } = await run(openapiListCommand, { text: asText(doc) });
    expect(envelope.ok).toBe(true);
    expect(data.count).toBe(8);
    expect(data.document.valid).toBe(false);
    // Each problem where it starts, not every enclosing keyword that failed because of it.
    expect(data.document.problems.map((p: Data) => `${p.pointer} ${p.keyword}`)).toEqual(['/paths/~1rest~1api~12~1myself/get/responses type', '/info required']);
    expect(data.document.problemCount).toBe(2);
    expect(check(data, 'document.schema')).toMatchObject({ status: 'failed' });
    expect(data.verified.passed).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_INVALID', message: expect.stringMatching(/^The document fails the OpenAPI 3\.0 schema at \//) }));
  });

  it.each([
    ['Swagger 2.0', BITBUCKET, (d: Data) => (d.host = 7), '/host'],
    ['OpenAPI 3.1', GITHUB, (d: Data) => (d.servers = [{}]), '/servers/0'],
    ['OpenAPI 3.2', GITHUB, (d: Data) => ((d.openapi = '3.2.0'), (d.paths['/user'].get.responses = [])), '/paths/~1user/get/responses'],
  ])('reports an invalid %s document by pointer', async (_name, file, breakIt, pointer) => {
    const doc = (file === GITHUB ? parseYaml(openapiSamples[file]) : JSON.parse(openapiSamples[file as typeof BITBUCKET])) as Data;
    breakIt(doc);
    const { data } = await run(openapiListCommand, { text: asText(doc) });
    expect(data.document.valid).toBe(false);
    expect(data.document.problems.map((p: Data) => p.pointer)).toContain(pointer);
  });

  it("cuts a validator message that quotes a huge enum, in the document's problems and in example.valid", async () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    const huge = Array.from({ length: 50_000 }, (_, i) => `value-${i}`);
    doc.paths['/orders'].post.parameters = [{ name: 'mode', in: 'query', schema: { type: 'string' }, style: 'not-a-style', 'x-values': huge }];
    doc.components.schemas.Order.properties.sku = { allOf: [{ enum: huge }, { enum: ['other'] }] };
    const { envelope, data } = await run(openapiExampleCommand, { text: asText(doc), operation: 'createOrder' });
    expect(data.document.problems.every((p: Data) => p.message.length <= 301)).toBe(true);
    expect(check(data, 'example.valid')).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(envelope).length).toBeLessThan(100_000);
  });

  it('reports a broken $ref by the pointer where it sits, and fails refs.resolve', async () => {
    const doc = jira();
    delete doc.components.schemas.IssueUpdateDetails;
    const { data, warnings } = await run(openapiListCommand, { text: asText(doc) });
    const at = '/paths/~1rest~1api~12~1issue/post/requestBody/content/application~1json/schema/$ref';
    expect(data.document.refs.broken).toContainEqual({ at, ref: '#/components/schemas/IssueUpdateDetails' });
    expect(check(data, 'refs.resolve')).toMatchObject({ status: 'failed', failed: 3 });
    expect(check(data, 'refs.resolve')?.failures).toContainEqual(expect.objectContaining({ at }));
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_REF_BROKEN' }));
    expect(data.verified.passed).toBe(false);
  });

  it('counts a $ref to another file as unchecked, never as resolved', async () => {
    const doc = jira();
    doc.paths['/rest/api/2/myself'].get.responses['200'].content['application/json'].schema = { $ref: 'common.yaml#/User' };
    const { data, warnings } = await run(openapiListCommand, { text: asText(doc) });
    expect(data.document.refs.external).toEqual([{ at: '/paths/~1rest~1api~12~1myself/get/responses/200/content/application~1json/schema/$ref', ref: 'common.yaml#/User' }]);
    expect(check(data, 'refs.external')).toMatchObject({ status: 'unchecked' });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED', message: expect.stringContaining('refs.external') }));
  });

  it("doesn't take a $ref key inside an example, a default or an extension for a reference, but does under properties", async () => {
    const doc = jira();
    const user = doc.components.schemas.User;
    user.example = { $ref: '#/nowhere' };
    user['x-note'] = { $ref: '#/nowhere' };
    user.properties.default = { $ref: '#/components/schemas/AvatarUrlsBean' };
    const { data } = await run(openapiListCommand, { text: asText(doc) });
    expect(data.document.refs.broken).toEqual([]);
    expect(data.document.refs.total).toBe(71);
  });

  it('checks that operationIds are unique and that every path placeholder is declared', async () => {
    const doc = jira();
    doc.paths['/rest/api/2/myself'].get.operationId = 'getIssue';
    doc.paths['/rest/api/2/issue/{issueIdOrKey}'].get.parameters = doc.paths['/rest/api/2/issue/{issueIdOrKey}'].get.parameters.filter((p: Data) => p.in !== 'path');
    const { data, warnings } = await run(openapiListCommand, { text: asText(doc) });
    expect(check(data, 'operations.uniqueIds')).toMatchObject({ status: 'failed', failed: 1, failures: [expect.objectContaining({ at: '/paths/~1rest~1api~12~1myself/get' })] });
    expect(check(data, 'operations.pathParameters')).toMatchObject({ status: 'failed', failed: 1, failures: [expect.objectContaining({ at: '/paths/~1rest~1api~12~1issue~1{issueIdOrKey}/get' })] });
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['OPENAPI_DUPLICATE_OPERATION_ID', 'OPENAPI_PATH_PARAMETER_MISSING']));
  });

  it.each([
    ['an array', '[1, 2]', /isn't an OpenAPI or Swagger document: it is not an object\.$/],
    ['a document with neither field', '{"info": {}}', /has no "openapi" or "swagger" field\.$/],
    ['a version this command does not read', '{"openapi": "4.0.0", "info": {}, "paths": {}}', /declares OpenAPI 4\.0\.0, which this command doesn't read\.$/],
    ['YAML that does not parse', 'openapi: 3.0.0\ninfo: [\n', /isn't valid YAML at line \d+, column \d+/],
  ])('refuses %s with INVALID_INPUT', async (_name, text, message) => {
    const { envelope } = await run(openapiListCommand, { text });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(message) });
    expect(envelope.error?.fix).toBeTruthy();
  });

  it('reads stdin on the CLI, and says the read length could not be checked', async () => {
    const result = await runCli(['util', 'openapi', 'list', '-'], { commands, context: testContext({ stdin: openapiSamples[GITHUB] }).context });
    expect(result.envelope?.ok).toBe(true);
    expect((result.envelope?.data as Data).count).toBe(5);
    expect(check(result.envelope?.data as Data, 'input.complete')).toMatchObject({ status: 'unchecked' });
  });
});

describe('util openapi show', () => {
  it("lays out Jira's createIssue: each parameter and where it goes, the body with refs expanded, and the jira api call", async () => {
    const { data } = await run(openapiShowCommand, { inputFile: JIRA, operation: 'createIssue' });
    expect(data.operation).toMatchObject({ method: 'POST', path: '/rest/api/2/issue', operationId: 'createIssue', pointer: '/paths/~1rest~1api~12~1issue/post' });
    expect(data.parameters).toEqual([expect.objectContaining({ name: 'updateHistory', in: 'query', required: false, schema: { default: false, type: 'boolean' } })]);
    expect(data.requestBody).toMatchObject({ required: true, contentType: 'application/json', schemaPointer: '/paths/~1rest~1api~12~1issue/post/requestBody/content/application~1json/schema' });
    expect(data.requestBody.schema).toMatchObject({ 'x-toil-ref': '#/components/schemas/IssueUpdateDetails', properties: { fields: { type: 'object' } } });
    expect(data.responses.map((r: Data) => r.status)).toEqual(['201', '400', '401', '403', '422']);
    expect(data.responses[0].schema['x-toil-ref']).toBe('#/components/schemas/CreatedIssue');
    expect(data.call).toEqual({
      method: 'POST',
      path: '/rest/api/2/issue',
      pathParameters: [],
      query: [],
      bodyFile: 'body.json',
      contentType: null,
      writes: true,
      unsupported: [],
      cli: 'toil <area> api POST /rest/api/2/issue --body-file body.json --allow-write',
    });
    expect(data.verified.passed).toBe(true);
  });

  it('names an operation by method and path, a leading slash optional, and puts path parameters in the call', async () => {
    const { data } = await run(openapiShowCommand, { inputFile: JIRA, method: 'get', path: 'rest/api/2/issue/{issueIdOrKey}' });
    expect(data.operation.operationId).toBe('getIssue');
    expect(data.parameters.find((p: Data) => p.name === 'issueIdOrKey')).toMatchObject({ in: 'path', required: true, schema: { type: 'string' } });
    expect(data.call).toMatchObject({ method: 'GET', path: '/rest/api/2/issue/{issueIdOrKey}', pathParameters: ['issueIdOrKey'], bodyFile: null, writes: false, cli: 'toil <area> api GET /rest/api/2/issue/{issueIdOrKey}' });
  });

  it('expands $refs to the depth asked for and says why each one left in place stopped', async () => {
    const shallow = await run(openapiShowCommand, { inputFile: GITHUB, method: 'GET', path: '/repos/{owner}/{repo}/pulls', depth: 0 });
    expect(shallow.data.parameters[0]).toMatchObject({ name: 'owner', in: 'path', schema: { type: 'string' } });
    expect(shallow.data.responses[0].schema.items).toEqual({ $ref: '#/components/schemas/pull-request-simple', 'x-toil-stop': 'depth' });
    expect(shallow.data.expansion).toMatchObject({ depth: 0, stopped: { depth: 2, circular: 0 } });
    const deeper = await run(openapiShowCommand, { inputFile: GITHUB, method: 'GET', path: '/repos/{owner}/{repo}/pulls', depth: 2 });
    expect(deeper.data.responses[0].schema.items['x-toil-ref']).toBe('#/components/schemas/pull-request-simple');
  });

  it('stops at a loop with x-toil-stop circular, whatever the depth', async () => {
    const { data } = await run(openapiShowCommand, { inputFile: BITBUCKET, method: 'GET', path: '/repositories/{workspace}/{repo_slug}/pullrequests/{pull_request_id}', depth: 20 });
    expect(data.expansion.stopped.circular).toBeGreaterThan(0);
    expect(JSON.stringify(data.responses)).toContain('"x-toil-stop":"circular"');
  });

  it('stops expanding a fan-out of wide schemas at a node budget, quickly, and warns that it did', async () => {
    // The diamond: S0 to S21, each with three properties that all refer to the next, so depth 20 is 3^20
    // expansions, and 200 inline properties besides, so each copy is wide.
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`p${i}`, { type: 'string', description: 'filler' }]));
    const schemas: Data = {};
    for (let i = 0; i <= 21; i++) {
      const next = { $ref: `#/components/schemas/S${i + 1}` };
      schemas[`S${i}`] = i === 21 ? { type: 'string' } : { type: 'object', required: ['a', 'b', 'c'], properties: { ...wide, a: next, b: next, c: next } };
    }
    const doc = { openapi: '3.0.3', info: { title: 'Diamond', version: '1' }, paths: { '/d': { post: { operationId: 'diamond', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }, responses: { '200': { description: 'ok' } } } } }, components: { schemas } };
    const started = performance.now();
    const shown = await run(openapiShowCommand, { text: asText(doc), operation: 'diamond', depth: 20 });
    expect(performance.now() - started).toBeLessThan(10_000);
    expect(shown.data.expansion).toMatchObject({ truncated: true });
    // One target's worth past the budget at most, never the whole fan-out.
    expect(shown.data.expansion.nodes).toBeLessThan(250_000 + 1_000);
    expect(shown.warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_EXPANSION_TRUNCATED' }));
    expect(JSON.stringify(shown.envelope).length).toBeLessThan(100_000_000);
    expect(performance.now() - started).toBeLessThan(10_000);
    const example = await run(openapiExampleCommand, { text: asText(doc), operation: 'diamond' });
    expect(example.warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_EXAMPLE_TRUNCATED' }));
    expect(check(example.data, 'example.valid')).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(example.envelope).length).toBeLessThan(100_000_000);
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it.each([
    ['long descriptions', { description: 'x'.repeat(5_000) }],
    ['a long example, default and enum', { example: 'x'.repeat(5_000), default: 'y'.repeat(5_000), enum: ['z'.repeat(5_000)] }],
  ])('caps the characters show copies from a fan-out of schemas with %s, and warns', async (_name, extra) => {
    // Three properties each referring to the next, twenty deep, each schema carrying long document text.
    const schemas: Data = {};
    for (let i = 0; i <= 21; i++) {
      const next = { $ref: `#/components/schemas/S${i + 1}` };
      schemas[`S${i}`] = i === 21 ? { type: 'string', ...extra } : { type: 'object', ...extra, properties: { a: next, b: next, c: next } };
    }
    const doc = { openapi: '3.0.3', info: { title: 'Fan', version: '1' }, paths: { '/f': { post: { operationId: 'fan', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }, responses: { '200': { description: 'ok' } } } } }, components: { schemas } };
    const started = performance.now();
    const shown = await run(openapiShowCommand, { text: asText(doc), operation: 'fan', depth: 20 });
    expect(shown.data.expansion.truncated).toBe(true);
    expect(shown.warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_EXPANSION_TRUNCATED' }));
    expect(JSON.stringify(shown.envelope).length).toBeLessThan(5_000_000);
    expect(performance.now() - started).toBeLessThan(10_000);
  });

  it("turns Swagger 2.0's body parameter into a request body and puts basePath in the call's path", async () => {
    const { data } = await run(openapiShowCommand, { inputFile: BITBUCKET, method: 'POST', path: '/repositories/{workspace}/{repo_slug}/pullrequests' });
    expect(data.parameters.map((p: Data) => `${p.in} ${p.name}`)).toEqual(['path repo_slug', 'path workspace']);
    expect(data.requestBody).toMatchObject({ required: false, contentTypes: ['application/json'], contentType: 'application/json', schemaPointer: expect.stringMatching(/\/parameters\/0\/schema$/) });
    expect(data.call).toMatchObject({ path: '/2.0/repositories/{workspace}/{repo_slug}/pullrequests', pathParameters: ['repo_slug', 'workspace'], cli: 'toil <area> api POST /2.0/repositories/{workspace}/{repo_slug}/pullrequests --body-file body.json --allow-write' });
  });

  it('lists required query parameters and a non-JSON body type in the call, and the headers it cannot send', async () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    doc.paths['/orders'].post.parameters = [
      { name: 'dryRun', in: 'query', required: true, schema: { type: 'boolean' } },
      { name: 'X-Request-Id', in: 'header', required: true, schema: { type: 'string' } },
    ];
    doc.paths['/orders'].post.requestBody.content = { 'application/xml': doc.paths['/orders'].post.requestBody.content['application/json'] };
    const { data } = await run(openapiShowCommand, { text: asText(doc), operation: 'createOrder' });
    expect(data.call).toMatchObject({ path: '/v1/orders', query: ['dryRun=<dryRun>'], contentType: 'application/xml', unsupported: ['header X-Request-Id'] });
    expect(data.call.cli).toBe("toil <area> api POST /v1/orders --query dryRun=<dryRun> --body-file body.json --content-type application/xml --allow-write");
  });

  it.each([
    [{ operation: 'createissue' }, /^No operation has operationId "createissue"\.$/, /Did you mean one of: createIssue\?/],
    [{ method: 'DELETE', path: '/rest/api/2/issue' }, /^No DELETE operation on path "\/rest\/api\/2\/issue"\.$/, /That path has POST\./],
    [{}, /^Name the operation/, /util openapi list/],
    [{ operation: 'createIssue', method: 'POST' }, /not both\.$/, /--operation/],
  ])('refuses %o with a fix', async (select, message, fix) => {
    const { envelope } = await run(openapiShowCommand, { inputFile: JIRA, ...select });
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(message), fix: expect.stringMatching(fix) });
  });
});

/** S0 to S30, each `allOf: [S{i+1}, S{i+1}, Big]`, with Big a const of a million characters: 2^30 paths to Big. */
function diamondOfConsts(): Data {
  const schemas: Data = { Big: { const: 'x'.repeat(1_000_000) }, S31: { type: 'string' } };
  for (let i = 0; i <= 30; i++) {
    const next = { $ref: `#/components/schemas/S${i + 1}` };
    schemas[`S${i}`] = { allOf: [next, next, { $ref: '#/components/schemas/Big' }] };
  }
  return { components: { schemas } };
}

describe('util openapi example', () => {
  it.each([
    [{ inputFile: JIRA, operation: 'createIssue' }, {}],
    [{ inputFile: JIRA, operation: 'addComment' }, {}],
    [{ inputFile: GITHUB, operation: 'pulls/create' }, { head: 'string', base: 'string' }],
    [{ inputFile: GITHUB, operation: 'issues/create-comment' }, { body: 'string' }],
    [{ text: EXAMPLE_TEXT, operation: 'createOrder' }, { sku: 'AAA-0', quantity: 1 }],
  ])('builds the minimal request body for %o and validates it against its schema', async (input, example) => {
    const { data } = await run(openapiExampleCommand, input);
    expect(data).toMatchObject({ body: 'request', status: null, contentType: 'application/json', example });
    expect(check(data, 'example.valid')).toMatchObject({ status: 'passed', checked: 1 });
    expect(data.verified.passed).toBe(true);
  });

  it.each([
    [JIRA, (o: Data) => o.operationId, '200', 'getIssue'],
    [JIRA, (o: Data) => o.operationId, '201', 'createVersion'],
    [GITHUB, (o: Data) => o.operationId, '200', 'pulls/get'],
    [GITHUB, (o: Data) => o.operationId, '200', 'users/get-authenticated'],
  ])('builds a valid response body in %s', async (file, _id, response, operation) => {
    const { data } = await run(openapiExampleCommand, { inputFile: file, operation, response });
    expect(data).toMatchObject({ body: 'response', status: response });
    expect(check(data, 'example.valid')).toMatchObject({ status: 'passed' });
  });

  it('builds every Bitbucket (Swagger 2.0) body, request and response, valid', async () => {
    for (const [method, path, response] of [
      ['POST', '/repositories/{workspace}/{repo_slug}/pullrequests', undefined],
      ['POST', '/repositories/{workspace}/{repo_slug}/pullrequests', '201'],
      ['GET', '/repositories/{workspace}/{repo_slug}/pullrequests', '200'],
      ['GET', '/user', '200'],
    ]) {
      const { data } = await run(openapiExampleCommand, { inputFile: BITBUCKET, method, path, ...(response ? { response } : {}) });
      expect(check(data, 'example.valid'), `${method} ${path} ${response}`).toMatchObject({ status: 'passed' });
    }
  });

  it("leaves read-only properties out of a request and puts a nullable's real type first", async () => {
    const { data } = await run(openapiExampleCommand, { text: EXAMPLE_TEXT, operation: 'createOrder' });
    expect(data.example).not.toHaveProperty('id');
    const response = await run(openapiExampleCommand, { text: EXAMPLE_TEXT, operation: 'createOrder', response: '201' });
    expect(response.data.example).toEqual({ id: 'string', sku: 'AAA-0', quantity: 1 });
    expect(check(response.data, 'example.valid')).toMatchObject({ status: 'passed' });
  });

  it("fails example.valid, by pointer, when the example can't fit its schema, and still returns it", async () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    // Two allOf branches that disagree on the type: no value satisfies both.
    doc.components.schemas.Order.properties.sku = { allOf: [{ type: 'string' }, { type: 'integer' }] };
    const { envelope, data, warnings } = await run(openapiExampleCommand, { text: asText(doc), operation: 'createOrder' });
    expect(envelope.ok).toBe(true);
    expect(data.example).toHaveProperty('sku');
    expect(check(data, 'example.valid')).toMatchObject({ status: 'failed', failures: expect.arrayContaining([expect.objectContaining({ at: '/sku' })]) });
    expect(data.verified.passed).toBe(false);
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_EXAMPLE_INVALID', message: expect.stringMatching(/^The generated example fails its own schema at \/sku: /) }));
  });

  it('the check bites: a deliberately wrong body fails against the schema the generator used', async () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    const pointer = '/paths/~1orders/post/requestBody/content/application~1json/schema';
    expect((await checkExample(doc, 'openapi-3.0', 'request', { sku: 'AAA-1', quantity: 1 }, { pointer })).result?.valid).toBe(true);
    const wrong = await checkExample(doc, 'openapi-3.0', 'request', { sku: 'lower-1', quantity: 0, note: null }, { pointer });
    expect(wrong.result?.valid).toBe(false);
    expect(wrong.result?.problems.map((p) => `${p.pointer} ${p.keyword}`)).toEqual(expect.arrayContaining(['/sku pattern', '/quantity minimum']));
    // nullable: null is accepted for note, which OpenAPI 3.0 allows and draft-04 alone would not.
    expect(wrong.result?.problems.some((p) => p.pointer === '/note')).toBe(false);
  });

  it.each([
    ['a billion items', { type: 'array', minItems: 1_000_000_000, items: { type: 'string' } }],
    ['a 300-million-character string', { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string', minLength: 300_000_000 }, b: { type: 'string', minLength: 300_000_000 } } }],
    ['a pattern that repeats 300 million times', { type: 'string', pattern: '^a{300000000}$' }],
    ['nested arrays of long strings', { type: 'array', minItems: 300_000, items: { type: 'array', minItems: 300_000, items: { type: 'string', minLength: 10_000 } } }],
    ['a million copies of a long const', { type: 'array', minItems: 1_000_000, items: { const: 'x'.repeat(4_000) } }],
    ['a million copies of a long enum value', { type: 'array', minItems: 1_000_000, items: { enum: ['x'.repeat(4_000)] } }],
    ['a million copies of an object-valued const', { type: 'array', minItems: 1_000_000, items: { const: { note: 'x'.repeat(4_000), tags: ['y'.repeat(1_000)] } } }],
    ['a million items with a long default and example', { type: 'array', minItems: 1_000_000, items: { type: 'string', default: 'x'.repeat(4_000), example: 'y'.repeat(4_000), examples: ['z'.repeat(4_000)] } }],
    ['a flat array of unique long strings', { type: 'array', minItems: 200_000, uniqueItems: true, items: { type: 'string', minLength: 10_000 } }],
    ['an allOf diamond reaching a million-character const at every step', { $ref: '#/components/schemas/S0' }, diamondOfConsts()],
  ])('cuts an example short instead of building %s, and says so', async (_name, schema, doc: Data = {}) => {
    const started = performance.now();
    const { example, truncated } = await generateExample(doc, 'openapi-3.0', schema, 'request');
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(JSON.stringify(example).length).toBeLessThan(5_000_000);
    // The pattern's own count is refused, so the example is a short string validation then rejects.
    if (!('pattern' in schema)) expect(truncated).toBe(true);
  });

  it('fails example.valid with OPENAPI_EXAMPLE_TRUNCATED when a body asks for more than an example holds', async () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    doc.components.schemas.Order.properties.sku = { type: 'string', minLength: MAX_STRING + 1 };
    const { envelope, data, warnings } = await run(openapiExampleCommand, { text: asText(doc), operation: 'createOrder' });
    expect(envelope.ok).toBe(true);
    expect(data.example.sku).toHaveLength(MAX_STRING);
    expect(check(data, 'example.valid')).toMatchObject({ status: 'failed' });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'OPENAPI_EXAMPLE_TRUNCATED' }));
  });

  it.each(['x*x*x*x*x*x*x*x*x*x*y', '(x+)+y', '(x|xx)+y', '(.*x){12}y'])('stops the backtracking pattern %s at the deadline, building and checking alike, and says so', async (pattern) => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    // The plain string is "string" padded with x to 41 characters: a long run of x and no y, the shape these backtrack on.
    doc.components.schemas.Order.properties.sku = { type: 'string', minLength: 41, maxLength: 41, pattern };
    const started = performance.now();
    const { envelope, data, warnings } = await run(openapiExampleCommand, { text: asText(doc), operation: 'createOrder' });
    // Two deadlines at most (choosing the string, then validating it), with generous room for a loaded runner and well under this test's 30 s.
    expect(performance.now() - started).toBeLessThan(2 * BOUNDED_TIMEOUT_MS + DEADLINE_ROOM);
    expect(envelope.ok).toBe(true);
    expect(check(data, 'example.patterns')).toMatchObject({ status: 'unchecked', detail: expect.stringMatching(/took longer than 2 s/) });
    expect(check(data, 'example.valid')).toMatchObject({ status: 'unchecked', detail: expect.stringMatching(/took longer than 2 s/) });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED', message: expect.stringContaining('example.patterns') }));
  }, 30_000);

  it('still chooses a string an ordinary pattern accepts, in the worker, and validates it', async () => {
    const { data } = await run(openapiExampleCommand, { text: EXAMPLE_TEXT, operation: 'createOrder' });
    expect(data.example.sku).toBe('AAA-0');
    expect(check(data, 'example.valid')).toMatchObject({ status: 'passed' });
    expect(check(data, 'example.patterns')).toBeUndefined();
  });

  it('reports example.valid as unchecked, at the deadline, when its schema branches too much to validate', async () => {
    // S0 to S21, each with property a: anyOf two refs to the next, so the example nests 22 deep and validating it takes 2^22 checks.
    const schemas: Data = { S22: { type: 'string' } };
    for (let i = 0; i < 22; i++) schemas[`S${i}`] = { type: 'object', required: ['a'], properties: { a: { anyOf: [{ $ref: `#/components/schemas/S${i + 1}` }, { $ref: `#/components/schemas/S${i + 1}` }] } } };
    const doc = { openapi: '3.0.3', info: { title: 'Branches', version: '1' }, paths: { '/b': { post: { operationId: 'branches', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }, responses: { '200': { description: 'ok' } } } } }, components: { schemas } };
    const started = performance.now();
    const { envelope, data, warnings } = await run(openapiExampleCommand, { text: asText(doc), operation: 'branches' });
    // One deadline, with generous room for a loaded runner and well under this test's 30 s.
    expect(performance.now() - started).toBeLessThan(BOUNDED_TIMEOUT_MS + DEADLINE_ROOM);
    expect(envelope.ok).toBe(true);
    expect(check(data, 'example.valid')).toMatchObject({ status: 'unchecked', detail: expect.stringMatching(/took longer than 2 s|stack/) });
    expect(warnings).toContainEqual(expect.objectContaining({ code: 'UNVERIFIED', message: expect.stringContaining('example.valid') }));
  }, 30_000);

  it('cuts an example short at the nesting limit instead of overflowing the stack', async () => {
    // A chain of 3,000 schemas, each requiring the next: 3,000 levels deep if followed to the end.
    const schemas: Data = { S3000: { type: 'string' } };
    for (let i = 0; i < 3000; i++) schemas[`S${i}`] = { type: 'object', required: ['next'], properties: { next: { $ref: `#/components/schemas/S${i + 1}` } } };
    const { example, truncated } = await generateExample({ components: { schemas } }, 'openapi-3.0', { $ref: '#/components/schemas/S0' }, 'request');
    expect(truncated).toBe(true);
    expect(() => JSON.stringify(example)).not.toThrow();
  });

  it('terminates on a schema that requires itself, and reports that no finite example fits', async () => {
    const doc = JSON.parse(EXAMPLE_TEXT) as Data;
    doc.components.schemas.Order.required.push('parent');
    doc.components.schemas.Order.properties.parent = { $ref: '#/components/schemas/Order' };
    const listed = await run(openapiListCommand, { text: asText(doc) });
    expect(listed.data.document.refs.circular).toEqual([['#/components/schemas/Order']]);
    const { data } = await run(openapiExampleCommand, { text: asText(doc), operation: 'createOrder' });
    expect(check(data, 'example.valid')).toMatchObject({ status: 'failed' });
  });

  it('refuses an operation with no request body, a status it lacks, and a content type it does not list', async () => {
    const none = await run(openapiExampleCommand, { inputFile: JIRA, operation: 'getIssue' });
    expect(none.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: 'GET /rest/api/2/issue/{issueIdOrKey} has no request body.' });
    const status = await run(openapiExampleCommand, { inputFile: JIRA, operation: 'getIssue', response: '418' });
    expect(status.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'Its responses are: 200, 401, 404.' });
    const type = await run(openapiExampleCommand, { inputFile: JIRA, operation: 'createIssue', contentType: 'text/csv' });
    expect(type.envelope.error).toMatchObject({ code: 'INVALID_INPUT', fix: 'It lists: application/json.' });
    const empty = await run(openapiExampleCommand, { inputFile: JIRA, operation: 'getIssue', response: '401' });
    expect(empty.envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('has no schema') });
  });
});

describe('sampleOfPattern', () => {
  it.each([
    ['^[A-Z]{3}-\\d+$', 'AAA-0'],
    ['^sha256:[a-f0-9]{64}$', `sha256:${'a'.repeat(64)}`],
    ['^[0-9a-fA-F]{40}$', 'a'.repeat(40)],
    ['^(?:v|release-)\\d+\\.\\d+$', 'v0.0'],
    ['^[^\\s]+@[^\\s]+$', 'a@a'],
    ['^\\w+(\\.\\w+)*$', 'a'],
  ])('reads %s as %s, which the pattern matches', (pattern, sample) => {
    expect(sampleOfPattern(pattern)).toBe(sample);
    expect(new RegExp(pattern, 'u').test(sample)).toBe(true);
  });

  it.each(['^(?=x).+$', '^(a)\\1$', '\\bword', '^a{300000000}$', '^(a{9999}){9999}$'])('gives up on %s rather than guess', (pattern) => {
    expect(sampleOfPattern(pattern)).toBeUndefined();
  });
});
