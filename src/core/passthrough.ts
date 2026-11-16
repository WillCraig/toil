import { Buffer } from 'node:buffer';
import { z } from 'zod';
import { apiResponse } from './api.js';
import type { Area } from './area.js';
import type { CommandDefinition } from './command.js';
import type { CommandContext } from './context.js';
import { ToilError } from './errors.js';
import { allowWriteField } from './run.js';

/**
 * `<area> api`: one raw REST call to the service an HTTP area already
 * connects to, for the endpoints its own commands don't cover. Auth comes from
 * the area's request hook (`defineArea({ request })`) through `apiRequest`,
 * exactly as every wrapped command's does, so the two can't drift: same base
 * URL, same headers, same token exchange, same error codes and fix text.
 *
 * The path stays on the connection's host. An absolute URL, a scheme, `//host`
 * or a leading backslash is INVALID_INPUT here, and a `.` or `..` segment is
 * refused by `apiRequest` (`requests.path`), so no path climbs above the base
 * URL or leaves it. The method decides the write gate: GET and HEAD read;
 * POST, PUT, PATCH and DELETE need `writes: true` on the connection and
 * `--allow-write`; DELETE is never served over MCP.
 *
 * Previously, reaching an endpoint without a command meant raising a request
 * for a new command. This is the form that makes the form unnecessary.
 */

export const API_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export type ApiMethod = (typeof API_METHODS)[number];

const READS: ReadonlySet<ApiMethod> = new Set(['GET', 'HEAD']);

/** A non-JSON body is returned as text up to this many bytes, with a warning when there was more. */
export const MAX_TEXT_BYTES = 1024 * 1024;

const passthroughInput = z.object({
  method: z.enum(API_METHODS).describe('HTTP method, in capitals. GET and HEAD read; POST, PUT, PATCH and DELETE write'),
  path: z.string().min(1).describe("Path under the connection's base URL, with or without a leading slash; never a full URL"),
  query: z.array(z.string()).optional().describe('Query parameters, each as key=value'),
  bodyFile: z.string().min(1).optional().describe('File holding the request body, inside the workspace'),
  // A header value is one line: a CR, LF or NUL would make fetch refuse it, which would read as a bug in toil.
  contentType: z
    .string()
    .min(1)
    .regex(/^[^\r\n\0]+$/, 'a content type is one line with no control characters, e.g. application/json')
    .optional()
    .describe("The body's content type (default application/json)"),
  ...allowWriteField,
});

type PassthroughInput = z.output<typeof passthroughInput>;

export interface ApiCommandSpec<K extends string = never> {
  /** The service's name in help text: "Jira Data Center". */
  service: string;
  /** A path the area's API answers, for help text: `/rest/api/2/issue/PAY-1042`. */
  examplePath: string;
  /**
   * Real calls for the parity suite: at least one read, and a write (with
   * `allowWrite: true`) so the write gate is proven on both front doors. The
   * area's fixture answers each one.
   */
  examples: Array<z.input<typeof passthroughInput> & Partial<Record<K, string>>>;
  /** The area's own way to save a file, named when a response is binary: `toil jira issue download`. */
  download?: string;
}

/**
 * The `<area> api` command for an HTTP area. The area exports it with its
 * other commands; nothing else is needed, because the request hook already
 * says how to reach the service.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function apiCommand<K extends string>(area: Area<any, K>, spec: ApiCommandSpec<K>): CommandDefinition {
  if (!area.request) throw new Error(`Area ${area.name}: ${area.name} api needs the area's request hook (defineArea({ request })).`);
  const name = `${area.name} api`;
  return area.command({
    path: [area.name, 'api'],
    description: `Call any ${spec.service} REST endpoint on the connection, e.g. toil ${name} GET ${spec.examplePath}`,
    toolDescription:
      `One raw ${spec.service} REST call, for an endpoint no other ${area.name} tool covers; prefer those tools when one fits. ` +
      `Returns the parsed JSON body as data (other bodies as text), with the status and content type in meta.response. ` +
      `GET and HEAD read. POST, PUT and PATCH change data: they need writes on for the connection and allowWrite true. DELETE is not available over MCP.`,
    input: passthroughInput,
    writes: false,
    writesWhen: (input: PassthroughInput) => !READS.has(input.method),
    offMcpWhen: (input: PassthroughInput) => (input.method === 'DELETE' ? 'DELETE is never served over MCP; deletes are made by a person on the CLI.' : undefined),
    args: [
      { name: 'method', field: 'method', description: 'GET, HEAD, POST, PUT, PATCH or DELETE' },
      { name: 'path', field: 'path', description: `Path under the base URL, e.g. ${spec.examplePath}` },
    ],
    options: [
      { flags: '--query <key=value>', field: 'query', description: 'A query parameter; repeat for more' },
      { flags: '--body-file <path>', field: 'bodyFile', description: 'File holding the request body (- for stdin)' },
      { flags: '--content-type <type>', field: 'contentType', description: "The body's content type (default application/json)" },
    ],
    examples: spec.examples,
    run: (input: PassthroughInput, ctx) => passthrough(area, name, input, ctx, spec.download),
  });
}

async function passthrough(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  area: Area<any, any>,
  name: string,
  input: PassthroughInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: CommandContext<any>,
  download: string | undefined,
): Promise<unknown> {
  assertRelativePath(input.path, name);
  if (input.path.includes('#')) {
    throw new ToilError('INVALID_INPUT', `${name}: "${input.path}" has a #, and a fragment is never sent to a server.`, {
      fix: 'Leave out the # and what follows it. A # that is part of a name is sent as %23.',
    });
  }
  // A query typed into the path is sent as typed. With --query as well, the
  // two join into one query, the path's first, as they did before the request
  // layer began refusing a path that carries a query beside query parameters.
  const extra = queryOf(input.query ?? [], name);
  const at = Object.keys(extra).length > 0 ? input.path.indexOf('?') : -1;
  const path = at < 0 ? input.path : input.path.slice(0, at);
  const query: Record<string, string[]> = {};
  if (at >= 0) for (const [key, value] of new URLSearchParams(input.path.slice(at + 1))) (query[key] ??= []).push(value);
  for (const [key, values] of Object.entries(extra)) (query[key] ??= []).push(...values);
  if (input.bodyFile === undefined && input.contentType !== undefined) {
    throw new ToilError('INVALID_INPUT', `${name}: --content-type describes a body, and there is no --body-file.`, { fix: 'Pass --body-file <path> with it, or leave --content-type out.' });
  }
  if (input.bodyFile !== undefined && READS.has(input.method)) {
    throw new ToilError('INVALID_INPUT', `${name}: a ${input.method} request has no body.`, { fix: 'Leave out --body-file, or use POST, PUT or PATCH.' });
  }
  const body = input.bodyFile === undefined ? undefined : await ctx.files.readBytes(input.bodyFile);
  const response = await apiResponse<Uint8Array>(area, ctx, path, {
    method: input.method,
    ...(Object.keys(query).length > 0 ? { query } : {}),
    ...(body !== undefined ? { body, contentType: input.contentType ?? 'application/json' } : {}),
    as: 'bytes',
  });
  const contentType = response.headers.get('content-type');
  ctx.setResponse({ status: response.status, contentType });
  return answer(response.data, contentType, name, ctx.warn, download);
}

/**
 * Refuses a path that names a host or a scheme rather than an endpoint, after
 * the URL parser's own first step (tabs and newlines dropped, the ends
 * trimmed), so a space or a tab can't hide `//host`.
 */
export function assertRelativePath(raw: string, name: string): void {
  // eslint-disable-next-line no-control-regex -- matching C0 controls is the point
  const path = raw.replace(/[\t\n\r]/g, '').replace(/^[\u0000- ]+|[\u0000- ]+$/g, '');
  const why = /^[a-z]:[/\\]/i.test(path)
    ? 'it is a local file path (Git Bash on Windows turns a leading / into one; leave the / off)'
    : /^[a-z][a-z0-9+.-]*:/i.test(path)
    ? 'it starts with a scheme'
    : /^[/\\][/\\]/.test(path)
      ? 'it starts with //, which names a host'
      : path.startsWith('\\')
        ? 'it starts with a backslash, which URL parsers read as /'
        : undefined;
  if (why) {
    throw new ToilError('INVALID_INPUT', `${name} takes a path under the connection's base URL, and "${raw}" isn't one: ${why}.`, {
      fix: "Pass only the path, such as /rest/api/2/myself; the host always comes from the connection's baseUrl.",
    });
  }
}

/** `key=value` pairs as a query, a repeated key repeating in order. */
function queryOf(pairs: readonly string[], name: string): Record<string, string[]> {
  const query: Record<string, string[]> = {};
  for (const pair of pairs) {
    const at = pair.indexOf('=');
    if (at <= 0) {
      throw new ToilError('INVALID_INPUT', `${name}: --query "${pair}" isn't key=value.`, { fix: 'Pass each query parameter as --query key=value, e.g. --query maxResults=50.' });
    }
    (query[pair.slice(0, at)] ??= []).push(pair.slice(at + 1));
  }
  return query;
}

const isJson = (contentType: string | null) => contentType !== null && /^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType.trim());

/** Text is `text/*`, XML or JSON, or a body with no content type at all; anything else is bytes. */
const isText = (contentType: string | null) =>
  contentType === null || /^(?:text\/|application\/(?:[\w.+-]+\+)?(?:json|xml)\b)/i.test(contentType.trim());

/**
 * The body as data: JSON parsed, text as text, binary as base64 (as the db
 * layer returns a binary column), each up to the cap, and an empty one as
 * null. Binary decoded as UTF-8 would come back quietly mangled, so it never is.
 */
function answer(bytes: Uint8Array, contentType: string | null, name: string, warn: CommandContext['warn'], download: string | undefined): unknown {
  if (bytes.length === 0) return null;
  if (isJson(contentType)) {
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      warn({ code: 'API_NOT_JSON', message: `${name}: the response said ${contentType} but isn't valid JSON, so data is the body as text.` });
    }
  }
  const binary = !isText(contentType);
  const kept = bytes.length > MAX_TEXT_BYTES ? bytes.subarray(0, MAX_TEXT_BYTES) : bytes;
  if (binary) {
    warn({
      code: 'API_BINARY',
      message: `${name}: the response is ${contentType}, not text, so data is its bytes as base64.${download ? ` To save a file, use ${download}.` : ''}`,
    });
  }
  if (kept !== bytes) {
    warn({
      code: 'API_TRUNCATED',
      message: `${name}: the response body was ${bytes.length} bytes, so data holds only its first ${MAX_TEXT_BYTES}${binary ? ', as base64' : ' as text'}. Narrow the request to get all of it.`,
    });
  }
  return binary ? Buffer.from(kept).toString('base64') : new TextDecoder().decode(kept);
}
