import { request } from 'node:http';

/**
 * What a browser does when someone opens Toil UI's address: a top-level
 * navigation to the page, which is what earns the cookie (#561). A test, or a
 * script that isn't a browser, gets the cookie the same way: GET the page from
 * loopback with the navigation's own Fetch Metadata headers, and send back the
 * `name=value` half of the Set-Cookie it answers with. A visitor's book, signed
 * at the door by someone who was also the door.
 */
export async function letIn(origin: string, base = '/', headers: Record<string, string> = {}): Promise<string> {
  const url = new URL(base, origin);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port, path: url.pathname, method: 'GET', headers: { host: url.host, 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', 'sec-fetch-site': 'none', ...headers } },
      (res) => {
        res.resume();
        const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0];
        res.on('end', () => (cookie ? resolve(cookie) : reject(new Error(`${url.href} answered ${res.statusCode} with no cookie`))));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** The cookies the tests' browsers hold, by origin: `letInto` earns one, `cookieHeader` sends it. */
const jar = new Map<string, string>();

export async function letInto(origin: string, base = '/'): Promise<void> {
  jar.set(new URL(origin).origin, await letIn(origin, base));
}

export const cookieHeader = (origin: string): Record<string, string> => {
  const cookie = jar.get(new URL(origin).origin);
  return cookie ? { cookie } : {};
};
