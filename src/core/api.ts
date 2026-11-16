import type { AnyArea, Connection } from './area.js';
import type { CommandContext } from './context.js';
import { ToilError } from './errors.js';
import { redactUrl } from './http.js';
import { multipart, type MultipartPart } from './multipart.js';
import { assertNoDotSegments, assertPlainPath, buildUrl, restResponse, type BodyFormat, type QueryParam, type RedirectPolicy, type RestResponse } from './rest.js';
import { exchangeToken, forgetToken, tokenKey, tokenScope, type TokenExchange } from './token.js';

/**
 * The one way an HTTP area talks to its service. The area declares, once, how
 * a resolved connection becomes a base URL and auth headers
 * (`defineArea({ request })`); every command sends through `apiRequest`,
 * which builds the request from that and nothing else. No command assembles
 * its own credentials, and none can point them at a host other than the
 * connection's: a URL outside its origin is refused before anything is sent.
 *
 * Credentials are issued to a host, not to whoever asks for them next. This
 * is the one access policy toil enforces in code instead of in a training
 * module.
 */

/** What an area's request hook returns for one connection. */
export interface AreaEndpoint {
  /** The service root; request paths resolve under it, keeping any context path. */
  baseUrl: string;
  /** Auth headers, sent on every request to `baseUrl` and to nothing else. */
  headers?: Record<string, string>;
  /** The service's name in messages ("Jira"). Defaults to the area's name. */
  service?: string;
  /** What to do when the service rejects the credential (401/403). */
  authFix?: string;
  /**
   * A short-lived token exchanged from a long-lived credential over plain
   * HTTP, cached in memory per connection until shortly before it expires.
   * Its headers join `headers`. A failed exchange is an AUTH error naming the
   * endpoint.
   */
  token?: AreaToken;
  /** The service's own error body shape, tried before the common ones (see RestOptions). */
  errorMessage?: (body: string) => string | undefined;
  /** Statuses besides 401 and 403 that mean the credential was refused (see RestOptions). */
  authStatuses?: readonly number[];
  /** Domains of the service's sign-in pages, where a redirect means the credential was refused (see RestOptions). */
  signInDomains?: readonly string[];
  /** Headers that say a successful-looking answer refused the credential (see RestOptions). */
  refusedWhen?: (headers: Headers) => boolean;
}

export interface AreaToken {
  exchange: TokenExchange;
  /** The headers that carry the access token, e.g. `{ TOKEN: token }` or a Bearer `Authorization`. */
  headers(token: string): Record<string, string>;
  /**
   * The vendor's own domain, written in the area's code, when its token
   * service lives on a sibling host (`checkmarx.net`, for `eu.ast.checkmarx.net`
   * to `eu.iam.checkmarx.net`). Without it the exchange must go to the
   * connection's own origin; any other host is refused.
   */
  vendorDomain?: string;
}

/** What a hook knows about its own area: enough to name an env var in fix text. */
export interface HookArea {
  name: string;
  envName(key: string): string;
}

export type RequestHook<C> = (connection: Connection<C>, area: HookArea) => AreaEndpoint | Promise<AreaEndpoint>;

export interface ApiRequest {
  method?: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Query parameters; an array value repeats the key. */
  query?: Record<string, QueryParam>;
  /** Headers for this call, on top of the hook's. */
  headers?: Record<string, string>;
  /** A JSON body. Sets `Content-Type: application/json` unless `headers` names one. */
  json?: unknown;
  /** A raw body (an upload), sent as given with `contentType`. */
  body?: string | Uint8Array;
  contentType?: string;
  /** A multipart/form-data body. */
  multipart?: readonly MultipartPart[];
  /** How to read the answer. Defaults to JSON. */
  as?: BodyFormat;
  /** Non-OK statuses to return as an answer rather than fail on. */
  accept?: readonly number[];
  /** Per-request timeout; the command's own time limit still applies. */
  timeoutMs?: number;
  /**
   * `'follow-without-auth'` follows a redirect to another origin (a signed
   * download URL on object storage) with every header dropped. The default
   * refuses it.
   */
  redirect?: RedirectPolicy;
  /** `false` returns a 429 at once instead of retrying it (see RestOptions). */
  retryRateLimit?: false;
}

/** The parts of a command's context a request needs. */
export type ApiContext = Pick<CommandContext<Connection>, 'fetch' | 'signal' | 'connection'>;

/** Sends one request through the area's hook and returns the body. */
export async function apiRequest<T>(area: AnyArea, ctx: ApiContext, path: string, req: ApiRequest = {}): Promise<T> {
  return (await send<T>(area, ctx, path, req)).response.data;
}

/** apiRequest, with the status and response headers (a continuation token, `X-AUSERNAME`, `Location`). */
export async function apiResponse<T>(area: AnyArea, ctx: ApiContext, path: string, req: ApiRequest = {}): Promise<RestResponse<T>> {
  return (await send<T>(area, ctx, path, req)).response;
}

export interface GraphqlOperation {
  query: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

/**
 * A GraphQL call: POSTs the operation and returns `data`. GraphQL servers
 * report most failures with a 200, so `errors` in the answer, or a null
 * `data`, is a failure here, with the server's messages.
 */
export async function apiGraphql<T>(area: AnyArea, ctx: ApiContext, path: string, operation: GraphqlOperation, req: Pick<ApiRequest, 'headers' | 'query' | 'timeoutMs'> = {}): Promise<T> {
  const { response, service } = await send<unknown>(area, ctx, path, { ...req, method: 'POST', json: operation });
  return graphqlData<T>(response.data, service, response.url);
}

/** `data` from a GraphQL answer, or a ToilError when it carries `errors` or no data. */
export function graphqlData<T>(body: unknown, service: string, url: string): T {
  const answer = (typeof body === 'object' && body !== null ? body : {}) as { data?: unknown; errors?: unknown };
  const errors = Array.isArray(answer.errors) ? answer.errors : [];
  if (errors.length > 0) {
    const messages = errors.map((e) => (typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : JSON.stringify(e)));
    throw new ToilError('HTTP', `${service} GraphQL error: ${messages.join('; ')}`, {
      fix: `See ${service}'s message above; fix the query or its variables and try again.`,
      details: { url: redactUrl(url), errors },
    });
  }
  if (answer.data === null || answer.data === undefined) {
    throw new ToilError('HTTP', `${service} answered the GraphQL query at ${redactUrl(url)} with no data.`, {
      fix: `Check the query, and that the credential can see what it asks for in ${service}.`,
      details: { url: redactUrl(url) },
    });
  }
  return answer.data as T;
}

async function send<T>(area: AnyArea, ctx: ApiContext, path: string, req: ApiRequest): Promise<{ response: RestResponse<T>; service: string }> {
  if (!area.request) throw new Error(`Area ${area.name} has no request hook; declare defineArea({ request }) to use apiRequest.`);
  // Before the URL parser can collapse a `..` an input put there.
  assertNoDotSegments(path);
  assertPlainPath(path, req.query !== undefined);
  const { body, contentType } = encode(req);
  for (let attempt = 1; ; attempt++) {
    const scope = tokenScope(area, ctx.connection);
    const endpoint = await area.request(ctx.connection, area);
    const service = endpoint.service ?? area.name;
    const authFix = endpoint.authFix ?? `Check the credential on connection "${ctx.connection.name}".`;
    let tokenHeaders: Record<string, string> = {};
    if (endpoint.token) {
      const { exchange } = endpoint.token;
      assertTokenHost(exchange.url, endpoint.baseUrl, endpoint.token.vendorDomain, service, ctx.connection.name);
      const named = { service: exchange.service ?? service, authFix: exchange.authFix ?? authFix };
      tokenHeaders = endpoint.token.headers(await exchangeToken({ fetch: ctx.fetch, signal: ctx.signal, scope, ...named }, exchange));
    }

    // A full URL (one the server handed back, after repointUrl) is sent as it is:
    // buildUrl would rewrite an encoded comma in its query.
    const url = /^[a-z][a-z0-9+.-]*:/i.test(path) && req.query === undefined ? new URL(path).toString() : buildUrl(endpoint.baseUrl, path, req.query);
    const origin = new URL(endpoint.baseUrl).origin;
    if (new URL(url).origin !== origin) {
      throw new ToilError('HTTP', `toil won't send connection "${ctx.connection.name}"'s credentials to ${new URL(url).origin}; its host is ${origin}.`, {
        fix: `Use a path under ${origin}. A URL the server handed back can be re-pointed at it with repointUrl.`,
        details: { url: redactUrl(url) },
      });
    }
    const headers = new Headers(endpoint.headers);
    for (const [name, value] of Object.entries(tokenHeaders)) headers.set(name, value);
    for (const [name, value] of Object.entries(req.headers ?? {})) headers.set(name, value);
    // A multipart body's type carries its boundary, so it always wins; any other can be overridden.
    if (contentType && (req.multipart !== undefined || !headers.has('content-type'))) headers.set('content-type', contentType);
    const init: RequestInit = { method: req.method ?? 'GET', headers };
    if (body !== undefined) init.body = body;

    try {
      const options = {
        service,
        authFix,
        ...(req.as ? { as: req.as } : {}),
        ...(req.accept ? { accept: req.accept } : {}),
        ...(req.timeoutMs !== undefined ? { timeoutMs: req.timeoutMs } : {}),
        ...(req.redirect ? { redirect: req.redirect } : {}),
        ...(req.retryRateLimit === false ? { retryRateLimit: false as const } : {}),
        ...(endpoint.errorMessage ? { errorMessage: endpoint.errorMessage } : {}),
        ...(endpoint.authStatuses ? { authStatuses: endpoint.authStatuses } : {}),
        ...(endpoint.signInDomains ? { signInDomains: endpoint.signInDomains } : {}),
        ...(endpoint.refusedWhen ? { refusedWhen: endpoint.refusedWhen } : {}),
        // So a network error names the setting the host came from, whatever it's called.
        urlKey: urlKeyOf(ctx.connection, origin),
      };
      return { response: await restResponse<T>(ctx, url, init, options), service };
    } catch (err) {
      // A token revoked before its stated expiry: exchange once more, then believe the server.
      const status = err instanceof ToilError ? (err.details as { status?: unknown } | undefined)?.status : undefined;
      if (attempt === 1 && status === 401 && endpoint.token) {
        forgetToken(tokenKey(scope, endpoint.token.exchange));
        continue;
      }
      throw err;
    }
  }
}

/**
 * The connection setting holding `origin`'s host: `baseUrl` when it does,
 * else the first other setting whose value names the host (Dynatrace's
 * `platformUrl`, SDE's `<token>@<host>` `connectionString`), else null.
 * Only the key is ever reported, never the value.
 */
export function urlKeyOf(connection: Connection, origin: string): string | null {
  const host = new URL(origin).host;
  const names = (value: unknown) => {
    if (typeof value !== 'string') return false;
    try {
      if (new URL(value).host === host) return true;
    } catch {
      // not a URL on its own; it may still carry the host (`token@host`)
    }
    return value.toLowerCase().includes(host.toLowerCase());
  };
  if (names(connection.baseUrl)) return 'baseUrl';
  const key = Object.keys(connection).find((k) => k !== 'name' && names(connection[k]));
  return key ?? null;
}

function encode(req: ApiRequest): { body?: string | Uint8Array; contentType?: string } {
  const given = [req.json !== undefined, req.body !== undefined, req.multipart !== undefined].filter(Boolean).length;
  if (given > 1) throw new Error('apiRequest takes one of json, body or multipart.');
  if (req.json !== undefined) return { body: JSON.stringify(req.json), contentType: 'application/json' };
  if (req.multipart !== undefined) return multipart(req.multipart);
  if (req.body !== undefined) return { body: req.body, ...(req.contentType ? { contentType: req.contentType } : {}) };
  return {};
}

/**
 * The long-lived credential goes to the connection's own origin, or over
 * HTTPS to a host under the vendor domain the area names in its code. A
 * connection value can't send it anywhere else.
 */
function assertTokenHost(url: string, baseUrl: string, vendorDomain: string | undefined, service: string, connection: string): void {
  const target = new URL(url);
  if (target.origin === new URL(baseUrl).origin) return;
  const domain = vendorDomain?.replace(/^\.+/, '').toLowerCase();
  const host = target.hostname.toLowerCase();
  if (domain && target.protocol === 'https:' && (host === domain || host.endsWith(`.${domain}`))) return;
  throw new ToilError('AUTH', `toil won't send connection "${connection}"'s ${service} credential to ${target.host} for a token: it isn't the connection's host${domain ? ` or under ${domain}` : ''}.`, {
    fix: `Check the connection's settings for ${service}; the token service has to be on ${new URL(baseUrl).host}${domain ? ` or under ${domain}` : ''}.`,
    details: { url: redactUrl(url) },
  });
}
