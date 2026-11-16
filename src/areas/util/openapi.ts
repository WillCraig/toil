import { z } from 'zod';
import { defineCommand, type CliOption } from '../../core/command.js';
import { fileArgument, inputFields, openInput, inputFileOption, textOption } from './kit/input.js';

/**
 * `util openapi list | show | example`: reads an OpenAPI 3.x or Swagger 2.0
 * document, in JSON or YAML, so an agent can call an endpoint right the first
 * time, usually through `toil <area> api`. Local only: the document is a file
 * in the workspace, stdin, or text, and the schemas it's checked against are
 * bundled. The definitions are here; the work is in ./openapi/, loaded only
 * when one of these runs (docs/util.md, Lazy loading). The input is opened
 * here, not there: the reader's module brings zod, and zod must never be
 * reached through import() (docs/util.md, Lazy loading).
 *
 * Every command validates the document against the official schema for its
 * version and checks every `$ref` before answering, and says so in
 * `data.verified`. An API description that was never validated is, in the
 * end, only a description.
 */

const SAMPLE_JIRA = 'specs/jira-platform.json';
const SAMPLE_GITHUB = 'specs/github.yaml';
const SAMPLE_BITBUCKET = 'specs/bitbucket.json';

/** A small OpenAPI 3.0 document, for the examples that pass the content as text. */
export const EXAMPLE_TEXT = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Orders', version: '1.0' },
  servers: [{ url: 'https://api.imagile.dev/v1' }],
  paths: {
    '/orders': {
      post: {
        operationId: 'createOrder',
        tags: ['orders'],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
        responses: { '201': { description: 'Created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Order: {
        type: 'object',
        required: ['id', 'sku', 'quantity'],
        properties: { id: { type: 'string', readOnly: true }, sku: { type: 'string', pattern: '^[A-Z]{3}-\\d+$' }, quantity: { type: 'integer', minimum: 1 }, note: { type: 'string', nullable: true } },
      },
    },
  },
});

const select = {
  operation: z.string().min(1).optional().describe("The operation's operationId (from util openapi list)"),
  method: z.string().min(1).optional().describe('The HTTP method, with path, when the operation has no operationId'),
  path: z.string().min(1).optional().describe('The path exactly as the document writes it, placeholders included (/issue/{issueIdOrKey}), with method'),
};
const selectOptions: CliOption[] = [
  { flags: '--operation <operationId>', field: 'operation', description: "The operation's operationId" },
  { flags: '--method <method>', field: 'method', description: 'The HTTP method, with --path, when the operation has no operationId' },
  { flags: '--path <path>', field: 'path', description: 'The path exactly as the document writes it, with --method' },
];

const VERIFIED =
  'data.verified says what was checked: the document against the official OpenAPI or Swagger schema for its version (problems by JSON pointer), every $ref resolving, operationIds unique and path parameters declared';

export const openapiListCommand = defineCommand({
  path: ['util', 'openapi', 'list'],
  description: 'List the operations in an OpenAPI or Swagger document, filtered by tag or path (local only)',
  toolDescription: `Lists the operations in an OpenAPI 3.x or Swagger 2.0 document (JSON or YAML): { document, count, operations[] of { method, path, operationId, summary, tags, deprecated } }. tag keeps operations with that tag; path keeps those whose path contains the text. document says the version, title, servers, whether it is valid and every $ref problem. ${VERIFIED}. Local only. Next: util_openapi_show for one operation's parameters and bodies.`,
  input: z.object({
    ...inputFields,
    tag: z.string().min(1).optional().describe('Only operations with this tag (any case)'),
    path: z.string().min(1).optional().describe('Only operations whose path contains this text (any case)'),
  }),
  writes: false,
  args: [fileArgument],
  options: [
    inputFileOption, textOption,
    { flags: '--tag <tag>', field: 'tag', description: 'Only operations with this tag' },
    { flags: '--path <text>', field: 'path', description: 'Only operations whose path contains this text' },
  ],
  examples: [{ inputFile: SAMPLE_JIRA }, { inputFile: SAMPLE_GITHUB, tag: 'pulls' }, { inputFile: SAMPLE_BITBUCKET, path: 'pullrequests' }, { text: EXAMPLE_TEXT }],
  run: async (input, ctx) => (await import('./openapi/run.js')).listOperations(ctx, await openInput(ctx, input), input),
});

export const openapiShowCommand = defineCommand({
  path: ['util', 'openapi', 'show'],
  description: "Show one operation: its parameters and where each goes, its request and response bodies, and how to call it with <area> api (local only)",
  toolDescription: `One operation of an OpenAPI 3.x or Swagger 2.0 document, named by operation (operationId) or by method and path: { document, operation, parameters[] of { name, in, required, schema }, requestBody, responses[] of { status, contentType, schema }, call, expansion }. Schemas have their $refs expanded depth deep (default 3); a ref left in place says why in x-toil-stop (depth, circular, external, broken). call holds the inputs for <area>_api (method, path with {placeholders}, required query as name=<name>, bodyFile, contentType, writes) and the CLI line. ${VERIFIED}. Local only. Next: util_openapi_example for a valid body.`,
  input: z.object({
    ...inputFields,
    ...select,
    depth: z.number().int().min(0).max(20).optional().describe('How many $refs deep to expand schemas (default 3, at most 20)'),
  }),
  writes: false,
  args: [fileArgument],
  options: [inputFileOption, textOption, ...selectOptions, { flags: '--depth <n>', field: 'depth', description: 'How many $refs deep to expand schemas (default 3)' }],
  examples: [
    { inputFile: SAMPLE_JIRA, operation: 'createIssue' },
    { inputFile: SAMPLE_GITHUB, method: 'POST', path: '/repos/{owner}/{repo}/pulls', depth: 1 },
    { inputFile: SAMPLE_BITBUCKET, method: 'GET', path: '/repositories/{workspace}/{repo_slug}/pullrequests' },
    { text: EXAMPLE_TEXT, operation: 'createOrder' },
  ],
  run: async (input, ctx) => (await import('./openapi/run.js')).showOne(ctx, await openInput(ctx, input), input),
});

export const openapiExampleCommand = defineCommand({
  path: ['util', 'openapi', 'example'],
  description: "Generate a minimal valid example body for an operation's request or a response, checked against its schema (local only)",
  toolDescription: `A minimal example body for one operation of an OpenAPI 3.x or Swagger 2.0 document, named by operation (operationId) or by method and path: the request body by default, or the response with status response (200, 201, default). Required properties only, read-only ones left out of a request; placeholder values. contentType picks among the body's content types (default: JSON). Returns { document, operation, body, status, contentType, schemaPointer, example }; the example is validated against its schema before it is returned (data.verified example.valid), along with the document checks. Save it to a file and pass it as bodyFile to <area>_api. Local only.`,
  input: z.object({
    ...inputFields,
    ...select,
    response: z.string().min(1).optional().describe('A response status (200, 201, default) to build that response body instead of the request body'),
    contentType: z.string().min(1).optional().describe("Which of the body's content types (default: the first JSON one)"),
  }),
  writes: false,
  args: [fileArgument],
  options: [
    inputFileOption, textOption,
    ...selectOptions,
    { flags: '--response <status>', field: 'response', description: 'Build that response body instead of the request body' },
    { flags: '--content-type <type>', field: 'contentType', description: "Which of the body's content types (default: the first JSON one)" },
  ],
  examples: [
    { inputFile: SAMPLE_JIRA, operation: 'createIssue' },
    { inputFile: SAMPLE_GITHUB, operation: 'pulls/create' },
    { inputFile: SAMPLE_BITBUCKET, method: 'POST', path: '/repositories/{workspace}/{repo_slug}/pullrequests', response: '201', contentType: 'application/json' },
    { text: EXAMPLE_TEXT, operation: 'createOrder' },
  ],
  run: async (input, ctx) => (await import('./openapi/run.js')).exampleBody(ctx, await openInput(ctx, input), input),
});

export const openapiCommands = [openapiListCommand, openapiShowCommand, openapiExampleCommand];
