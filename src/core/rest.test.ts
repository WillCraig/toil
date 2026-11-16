import { describe, expect, it } from 'vitest';
import { fakeFetch, type Route } from '../../test/harness/fake-fetch.js';
import { ToilError } from './errors.js';
import { redactUrl } from './http.js';
import { buildUrl, errorMessageFrom, MAX_REDIRECTS, MAX_TEXT_REASON, textReasonFrom, parseRetryAfter, repointUrl, restRequest, restResponse, statusLine } from './rest.js';

const opts = { service: 'Jira', authFix: 'Make a new token.' };
const ctxWith = (routes: Route[], fetchImpl?: typeof fetch) => {
  const http = fakeFetch(routes);
  return { http, ctx: { fetch: fetchImpl ?? http.fetch, signal: new AbortController().signal } };
};
const failure = async (p: Promise<unknown>): Promise<ToilError> => {
  try {
    await p;
  } catch (err) {
    return err as ToilError;
  }
  throw new Error('expected a failure');
};

describe('buildUrl', () => {
  it('keeps a context path on the base and literal commas in the query', () => {
    expect(buildUrl('https://jira.imagile.dev/jira', '/rest/api/2/issue/A-1', { expand: 'a,b', skip: undefined })).toBe(
      'https://jira.imagile.dev/jira/rest/api/2/issue/A-1?expand=a,b',
    );
    expect(buildUrl('https://jira.imagile.dev/', 'rest/x', { n: 1, b: false })).toBe('https://jira.imagile.dev/rest/x?n=1&b=false');
  });

  it('repeats a key once per array element, skipping undefined ones', () => {
    expect(buildUrl('https://jira.imagile.dev', '/x', { state: ['a', undefined, 'b'], n: 1 })).toBe('https://jira.imagile.dev/x?state=a&state=b&n=1');
  });

  it('leaves an encoded comma in the path alone', () => {
    expect(buildUrl('https://jira.imagile.dev', '/a%2Cb')).toBe('https://jira.imagile.dev/a%2Cb');
  });
});

describe('statusLine', () => {
  it("carries the server's reason phrase, else the standard one, else the bare status", () => {
    expect(statusLine(503, 'Down for maintenance')).toBe('HTTP 503 Down for maintenance');
    expect(statusLine(503, '')).toBe('HTTP 503 Service Unavailable');
    expect(statusLine(599)).toBe('HTTP 599');
  });

  it("puts the response's own statusText in an error with no body, and on a response read as an answer", async () => {
    const answer = () => Promise.resolve(new Response('', { status: 503, statusText: 'Down for maintenance' }));
    const { ctx } = ctxWith([], answer);
    expect(await failure(restRequest(ctx, 'https://jira.imagile.dev/x', {}, opts))).toMatchObject({ code: 'HTTP', message: 'HTTP 503 Down for maintenance' });
    expect(await restResponse(ctx, 'https://jira.imagile.dev/x', {}, { ...opts, as: 'text', accept: [503] })).toMatchObject({ status: 503, statusText: 'Down for maintenance' });
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds and HTTP dates, and ignores anything else', () => {
    expect(parseRetryAfter('5')).toBe(5);
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:10 GMT', Date.parse('Wed, 21 Oct 2015 07:28:00 GMT'))).toBe(10);
    expect(parseRetryAfter('-1')).toBeUndefined();
    expect(parseRetryAfter('1.5')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('errorMessageFrom', () => {
  it('reads errorMessages and errors, then message and detail', () => {
    expect(errorMessageFrom(JSON.stringify({ errorMessages: ['Issue does not exist'], errors: { summary: 'required' } }))).toBe('Issue does not exist; summary: required');
    expect(errorMessageFrom(JSON.stringify({ errors: [{ msg: 'bad' }, { message: 'worse' }] }))).toBe('bad; worse');
    expect(errorMessageFrom(JSON.stringify({ message: 'nope' }))).toBe('nope');
    expect(errorMessageFrom(JSON.stringify({ detail: 'why' }))).toBe('why');
    expect(errorMessageFrom('<html>')).toBeUndefined();
  });
});

describe('textReasonFrom', () => {
  it('gives a plain-text body trimmed onto one line, and nothing for an empty, JSON or HTML one', () => {
    expect(textReasonFrom('  Unexpected token at 12:\n  count( \n')).toBe('Unexpected token at 12: count(');
    for (const body of ['', '  ', '<html><body>Sign in</body></html>', '{"broken', '[1,']) expect(textReasonFrom(body), body).toBeUndefined();
  });

  it(`caps it at ${MAX_TEXT_REASON} characters and redacts URLs in it as --verbose does`, () => {
    const long = textReasonFrom('x'.repeat(MAX_TEXT_REASON + 50))!;
    expect(long).toHaveLength(MAX_TEXT_REASON + 1);
    expect(long.endsWith('…')).toBe(true);
    expect(textReasonFrom('Denied for https://logscale.imagile.dev/api?token=abc123 here')).toBe(`Denied for ${redactUrl('https://logscale.imagile.dev/api?token=abc123')} here`);
    expect(textReasonFrom('Denied for https://logscale.imagile.dev/api?token=abc123')).not.toContain('abc123');
  });
});

describe('restRequest', () => {
  const url = 'https://jira.imagile.dev/rest/api/2/issue/A-1';

  it('returns parsed JSON, undefined for 204 and empty bodies, and bytes on request', async () => {
    const { ctx } = ctxWith([
      { url, respond: { json: { key: 'A-1' } } },
      { method: 'PUT', url, respond: { status: 204 } },
      { method: 'POST', url, respond: { status: 201 } },
      { url: `${url}/raw`, respond: { text: 'abc' } },
    ]);
    expect(await restRequest(ctx, url, {}, opts)).toEqual({ key: 'A-1' });
    expect(await restRequest(ctx, url, { method: 'PUT' }, opts)).toBeUndefined();
    expect(await restRequest(ctx, url, { method: 'POST' }, opts)).toBeUndefined();
    expect(await restRequest(ctx, `${url}/raw`, {}, { ...opts, as: 'bytes' })).toEqual(new TextEncoder().encode('abc'));
  });

  it('maps 401/403 to AUTH with the area fix, 404 to NOT_FOUND, others to HTTP, with the server message', async () => {
    const { ctx } = ctxWith([
      { url: `${url}/401`, respond: { status: 401, json: { errorMessages: ['You are not authenticated'] } } },
      { url: `${url}/403`, respond: { status: 403, text: '' } },
      { url: `${url}/404`, respond: { status: 404, json: { errorMessages: ['Issue Does Not Exist'], errors: {} } } },
      { url: `${url}/400`, respond: { status: 400, json: { errorMessages: [], errors: { customfield_10016: 'Number required' } } } },
      { url: `${url}/text`, respond: { status: 400, text: 'Syntax error: unexpected end of query\n' } },
    ]);
    expect(await failure(restRequest(ctx, `${url}/401`, {}, opts))).toMatchObject({
      code: 'AUTH',
      message: 'You are not authenticated',
      fix: 'Make a new token.',
      details: { status: 401 },
    });
    expect(await failure(restRequest(ctx, `${url}/403`, {}, opts))).toMatchObject({ code: 'AUTH', message: 'HTTP 403 Forbidden' });
    // A plain-text body is the message's detail, after the status; code and status don't change.
    expect(await failure(restRequest(ctx, `${url}/text`, {}, opts))).toMatchObject({ code: 'HTTP', message: 'HTTP 400 Bad Request: Syntax error: unexpected end of query', details: { status: 400 } });
    expect(await failure(restRequest(ctx, `${url}/404`, {}, opts))).toMatchObject({ code: 'NOT_FOUND', message: 'Issue Does Not Exist' });
    expect(await failure(restRequest(ctx, `${url}/400`, {}, opts))).toMatchObject({ code: 'HTTP', message: 'customfield_10016: Number required' });
  });

  it("an area's own error shape is read first, and its extra auth statuses are AUTH; without either, nothing changes", async () => {
    const nested = { error: { message: 'Gone for good' } };
    const { ctx } = ctxWith([{ url: `${url}/410`, respond: { status: 410, json: nested } }]);
    const own = { ...opts, errorMessage: (body: string) => (JSON.parse(body) as typeof nested).error.message, authStatuses: [410] };
    expect(await failure(restRequest(ctx, `${url}/410`, {}, own))).toMatchObject({ code: 'AUTH', message: 'Gone for good', fix: 'Make a new token.', details: { status: 410 } });
    expect(await failure(restRequest(ctx, `${url}/410`, {}, opts))).toMatchObject({ code: 'HTTP', message: 'HTTP 410 Gone' });
    // An area reader that finds nothing falls through to the common shapes.
    const { ctx: jira } = ctxWith([{ url: `${url}/400`, respond: { status: 400, json: { errorMessages: ['Bad JQL'] } } }]);
    expect(await failure(restRequest(jira, `${url}/400`, {}, { ...opts, errorMessage: () => undefined }))).toMatchObject({ code: 'HTTP', message: 'Bad JQL' });
  });

  it("a redirect to the service's sign-in domain is AUTH with the area's fix; to any other host it stays HTTP", async () => {
    const signIn = 'https://spsprodcus3.vssps.imagile.dev/_signin?realm=dev.azure.com';
    const { ctx, http } = ctxWith([{ url: `${url}/pat`, respond: { status: 302, headers: { Location: signIn } } }]);
    const own = { ...opts, signInDomains: ['vssps.imagile.dev'] };
    expect(await failure(restRequest(ctx, `${url}/pat`, {}, own))).toMatchObject({
      code: 'AUTH',
      message: expect.stringContaining('sign-in page at https://spsprodcus3.vssps.imagile.dev'),
      fix: 'Make a new token.',
      details: { status: 302, location: expect.stringContaining('vssps.imagile.dev') },
    });
    // Never followed: the credential stays with the connection's host.
    expect(http.calls).toHaveLength(1);
    expect(await failure(restRequest(ctx, `${url}/pat`, {}, opts))).toMatchObject({ code: 'HTTP', fix: expect.stringContaining('baseUrl') });
    // A look-alike that only ends with the same letters is not a subdomain.
    expect(await failure(restRequest(ctx, `${url}/pat`, {}, { ...opts, signInDomains: ['ps.imagile.dev'] }))).toMatchObject({ code: 'HTTP' });
  });

  it('retries a 429 after the wait the server asks for, then succeeds', async () => {
    let calls = 0;
    const { ctx, http } = ctxWith([{ url, respond: () => (++calls < 3 ? { status: 429, headers: { 'Retry-After': '0' } } : { json: { ok: 1 } }) }]);
    expect(await restRequest(ctx, url, {}, opts)).toEqual({ ok: 1 });
    expect(http.calls).toHaveLength(3);
  });

  it('gives up on a 429 after three attempts, or at once when the wait is over the cap', async () => {
    const { ctx, http } = ctxWith([
      { url, respond: { status: 429, headers: { 'Retry-After': '0' } } },
      { url: `${url}/long`, respond: { status: 429, headers: { 'Retry-After': '3600' } } },
    ]);
    expect(await failure(restRequest(ctx, url, {}, opts))).toMatchObject({ code: 'HTTP', message: 'Rate limited', details: { status: 429 } });
    expect(http.calls).toHaveLength(3);
    expect(await failure(restRequest(ctx, `${url}/long`, {}, opts))).toMatchObject({
      code: 'HTTP',
      message: 'Rate limited: server requested a 3600s retry delay, which exceeds the 30s cap',
      details: { retryAfterSeconds: 3600 },
    });
    expect(http.calls).toHaveLength(4);
  });

  it('reports an unreachable host as NETWORK with the cause, and a certificate problem with the CA fix', async () => {
    const dns = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND jira.imagile.dev' } });
    const tls = Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } });
    const reject = (err: Error) =>
      (async () => {
        throw err;
      }) as unknown as typeof fetch;
    expect(await failure(restRequest(ctxWith([], reject(dns)).ctx, url, {}, opts))).toMatchObject({
      code: 'NETWORK',
      message: 'Request failed: fetch failed: getaddrinfo ENOTFOUND jira.imagile.dev',
      fix: expect.stringContaining('https://jira.imagile.dev'),
      details: { cause: 'ENOTFOUND' },
    });
    expect((await failure(restRequest(ctxWith([], reject(tls)).ctx, url, {}, opts))).fix).toContain('NODE_EXTRA_CA_CERTS');
    // The fix names the setting the host came from; with none known, baseUrl.
    expect((await failure(restRequest(ctxWith([], reject(dns)).ctx, url, {}, opts))).fix).toMatch(/^Check baseUrl, and that this machine can reach https:\/\/jira\.imagile\.dev /);
    expect((await failure(restRequest(ctxWith([], reject(dns)).ctx, url, {}, { ...opts, urlKey: 'baseUrl' }))).fix).toMatch(/^Check baseUrl,/);
    const platform = await failure(restRequest(ctxWith([], reject(dns)).ctx, url, {}, { ...opts, urlKey: 'platformUrl' }));
    expect(platform.fix).toMatch(/^Check platformUrl, and that this machine can reach https:\/\/jira\.imagile\.dev /);
    expect(platform).toMatchObject({ code: 'NETWORK', details: { cause: 'ENOTFOUND' } });
    expect((await failure(restRequest(ctxWith([], reject(dns)).ctx, url, {}, { ...opts, urlKey: null }))).fix).toMatch(/^Check the connection's URL,/);
  });

  it('says so when a 200 is not JSON, as a sign-in page would be', async () => {
    const { ctx } = ctxWith([{ url, respond: { text: '<html>Sign in</html>', headers: { 'content-type': 'text/html' } } }]);
    expect(await failure(restRequest(ctx, url, {}, opts))).toMatchObject({ code: 'HTTP', fix: expect.stringContaining('login page'), details: { contentType: 'text/html' } });
  });

  it('lets an abort through for execute() to report', async () => {
    const controller = new AbortController();
    controller.abort(new ToilError('CANCELLED', 'cancelled'));
    const aborting = (async () => {
      throw new DOMException('aborted', 'AbortError');
    }) as unknown as typeof fetch;
    const err = await failure(restRequest({ fetch: aborting, signal: controller.signal }, url, {}, opts));
    expect(err).toBeInstanceOf(DOMException);
  });

  it('exposes the status and every response header', async () => {
    const { ctx } = ctxWith([{ url, respond: { status: 201, json: { id: 1 }, headers: { Location: `${url}/1`, 'x-ms-continuationtoken': 'abc' } } }]);
    const res = await restResponse<{ id: number }>(ctx, url, {}, opts);
    expect(res).toMatchObject({ status: 201, data: { id: 1 }, url });
    expect(res.headers.get('location')).toBe(`${url}/1`);
    expect(res.headers.get('x-ms-continuationtoken')).toBe('abc');
  });

  it('gives up on one slow request after its own timeout, as TIMEOUT naming the URL', async () => {
    const hang = ((_input: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        // An abort that already happened counts too, as it does for real fetch.
        if (init?.signal?.aborted) reject(new DOMException('aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as unknown as typeof fetch;
    const err = await failure(restRequest({ fetch: hang, signal: new AbortController().signal }, url, {}, { ...opts, timeoutMs: 20 }));
    expect(err).toMatchObject({ code: 'TIMEOUT', message: `Jira didn't answer ${url} within 0.02s; toil stopped waiting.` });
    expect(err.fix).not.toContain('Check whether');
    const write = await failure(restRequest({ fetch: hang, signal: new AbortController().signal }, url, { method: 'POST' }, { ...opts, timeoutMs: 20 }));
    expect(write).toMatchObject({ code: 'TIMEOUT', message: expect.stringContaining('The change may already have been applied.'), fix: expect.stringMatching(/^Check whether the change was made before retrying\./) });
  });

  it('sends every request with redirect: manual, and stops a same-origin redirect loop', async () => {
    const { ctx, http } = ctxWith([{ url: /loop/, respond: { status: 307, headers: { Location: '/loop' } } }]);
    let seenRedirect: RequestInit['redirect'];
    const spy = (async (input: string, init?: RequestInit) => {
      seenRedirect = init?.redirect;
      return http.fetch(input, init);
    }) as unknown as typeof fetch;
    expect(await failure(restRequest({ ...ctx, fetch: spy }, 'https://jira.imagile.dev/loop', {}, opts))).toMatchObject({ code: 'HTTP', message: expect.stringContaining(`more than ${MAX_REDIRECTS} times`) });
    expect(seenRedirect).toBe('manual');
    expect(http.calls).toHaveLength(MAX_REDIRECTS + 1);
  });

  it('keeps the method and body across a 307 on the same host', async () => {
    const { ctx, http } = ctxWith([
      { method: 'PUT', url, respond: { status: 307, headers: { Location: `${url}?moved=1` } } },
      { method: 'PUT', url: `${url}?moved=1`, respond: { json: { ok: true } } },
    ]);
    expect(await restRequest(ctx, url, { method: 'PUT', body: '{"a":1}', headers: { 'X-Api-Key': 'k' } }, opts)).toEqual({ ok: true });
    expect(http.calls[1]).toMatchObject({ method: 'PUT', body: '{"a":1}', headers: { 'x-api-key': 'k' } });
  });

  it('refuses a redirect to another origin, even a different port or scheme on the same host', async () => {
    for (const location of ['https://jira.imagile.dev:8443/x', 'http://jira.imagile.dev/x', 'https://evil.imagile.dev/x']) {
      const { ctx, http } = ctxWith([{ url, respond: { status: 301, headers: { Location: location } } }]);
      expect(await failure(restRequest(ctx, url, { headers: { 'X-Figma-Token': 't' } }, opts))).toMatchObject({ code: 'HTTP', details: { status: 301 } });
      expect(http.calls).toHaveLength(1);
    }
  });
});

describe('repointUrl', () => {
  const base = 'https://jira.imagile.dev/jira';
  const opts = { service: 'Jira', subject: 'attachment', code: 'JIRA_ATTACHMENT_HOST', fix: 'Download it from the Jira web interface instead.' };

  it('keeps a same-origin URL, resolves a relative one, and warns only when it re-points', () => {
    const warnings: unknown[] = [];
    const warn = (w: unknown) => warnings.push(w);
    expect(repointUrl('https://jira.imagile.dev/jira/a/1', base, warn, opts)).toBe('https://jira.imagile.dev/jira/a/1');
    expect(repointUrl('/jira/a/2', base, warn, opts)).toBe('https://jira.imagile.dev/jira/a/2');
    expect(warnings).toEqual([]);
    expect(repointUrl('http://10.0.0.1:8080/jira/a/3?x=1', base, warn, opts)).toBe('https://jira.imagile.dev/jira/a/3?x=1');
    expect(warnings).toEqual([{ code: 'JIRA_ATTACHMENT_HOST', message: 'Jira named http://10.0.0.1:8080 for this attachment; toil fetched it from the configured https://jira.imagile.dev instead.' }]);
  });

  it("is an HTTP error with the area's fix when the URL can't be read", () => {
    expect(() => repointUrl('http://[bad', base, () => {}, opts)).toThrow(expect.objectContaining({ code: 'HTTP', message: "Jira returned an attachment URL toil can't read: http://[bad.", fix: opts.fix }));
  });
});
