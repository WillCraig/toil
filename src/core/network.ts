import * as http from 'node:http';
import * as tls from 'node:tls';
import { ToilError } from './errors.js';

/**
 * Enterprise networking with nothing installed: the OS certificate store and
 * the standard proxy variables, through Node's own APIs (both need Node 24.14:
 * `tls.setDefaultCACertificates` since 24.5, `http.setGlobalProxyFromEnv`
 * since 24.14). An organization's TLS-inspecting proxy re-signs traffic with
 * a CA it installs in the OS store, and Node's bundled list has never heard of
 * it; without this, every request from a managed laptop fails with a
 * certificate error, and the fix offered is a ticket to have the laptop
 * unmanaged.
 *
 * It runs once, on the first request, so commands that never touch the
 * network (`version`) never read the store. Database drivers open their own
 * sockets rather than requests, so a TLS database connection asks
 * `trustedCertificates` for the same list and passes it to the driver, or,
 * for a driver that takes no `ca` option (Oracle's), calls
 * `trustOsStoreByDefault` so its socket gets the same defaults.
 */

/** The proxy variables Node reads, in both cases. */
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'] as const;

/** The proxy settings in `env`, or undefined when no proxy is set (NO_PROXY alone changes nothing). */
export function proxyEnv(env: NodeJS.ProcessEnv): Record<string, string> | undefined {
  const picked: Record<string, string> = {};
  for (const name of PROXY_VARS) {
    const value = env[name];
    if (value !== undefined && value !== '') picked[name] = value;
  }
  const hasProxy = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'].some((name) => name in picked);
  return hasProxy ? picked : undefined;
}

/** The Node APIs this uses, injectable so tests don't change the test runner's own network. */
export interface NetworkApis {
  getCACertificates: typeof tls.getCACertificates;
  setDefaultCACertificates: typeof tls.setDefaultCACertificates;
  setGlobalProxyFromEnv: typeof http.setGlobalProxyFromEnv;
}

// Read through the namespace, not imported by name: a named import of an API an
// older Node lacks fails the whole bundle at load, before even `toil version`.
// On a Node that lacks one (toil runs on those with a warning, src/core/runtime.ts), calling it says which API and which release, not "(void 0) is not a function".
const missing = (name: string, since: string) => new ToilError('UNSUPPORTED_NODE', `This Node (${process.versions.node}) has no ${name}, which arrived in Node ${since}.`, { fix: `Install Node 24.22.1 or later on 24.x, or 26.12.1 or later (also the releases that fix CVE-2026-111497).` });
const node: NetworkApis = {
  getCACertificates: (type) => (typeof tls.getCACertificates === 'function' ? tls.getCACertificates(type) : (() => { throw missing('tls.getCACertificates', '24.5'); })()),
  setDefaultCACertificates: (certs) => (typeof tls.setDefaultCACertificates === 'function' ? tls.setDefaultCACertificates(certs) : (() => { throw missing('tls.setDefaultCACertificates', '24.5'); })()),
  setGlobalProxyFromEnv: (env) => (typeof http.setGlobalProxyFromEnv === 'function' ? http.setGlobalProxyFromEnv(env) : (() => { throw missing('http.setGlobalProxyFromEnv', '24.14'); })()),
};

/**
 * Trusts the OS store on top of Node's defaults (its bundled CAs and
 * NODE_EXTRA_CA_CERTS), and routes requests through the proxy the env names.
 * A store that can't be read leaves the defaults as they were, said under
 * --debug: a request then fails with the usual certificate error and fix. A
 * proxy setting Node can't use is CONFIG_INVALID, naming the variable.
 */
export function configureNetwork(env: NodeJS.ProcessEnv, debug: (message: string) => void, apis: NetworkApis = node): void {
  trustOsStoreByDefault(debug, apis);
  const proxy = proxyEnv(env);
  if (proxy) {
    try {
      apis.setGlobalProxyFromEnv(proxy);
    } catch (err) {
      if (err instanceof ToilError) throw err;
      const names = Object.keys(proxy).filter((name) => !/no_proxy/i.test(name)).join(' / ');
      throw new ToilError('CONFIG_INVALID', `The proxy in ${names} isn't one toil can use: ${(err as Error).message}`, {
        fix: `Set ${names} to a proxy URL such as http://proxy.imagile.dev:8080, or unset it to connect directly.`,
      });
    }
    debug(`using the proxy settings from ${Object.keys(proxy).join(', ')}`);
  }
}

/**
 * Makes Node's default CAs the list toil trusts (its own defaults plus the OS
 * store's), for every TLS socket the process opens. HTTP gets this on its
 * first request; a database driver that builds its own TLS context with no
 * `ca` option calls it before connecting. Nothing changes when the store is
 * empty or can't be read.
 */
export function trustOsStoreByDefault(debug: (message: string) => void, apis: NetworkApis = node): void {
  const trusted = trustedCertificates(debug, apis);
  if (trusted.certificates && trusted.system > 0) {
    try {
      apis.setDefaultCACertificates(trusted.certificates);
    } catch (err) {
      debug(`couldn't trust the OS certificate store: ${(err as Error).message}`);
    }
  }
}

/**
 * The CAs toil trusts: Node's defaults (its bundled CAs and
 * NODE_EXTRA_CA_CERTS) followed by the OS store's. The one place that list is
 * built, for HTTP (`configureNetwork`) and for database drivers that take a
 * `ca` option. A store that can't be read leaves just the defaults, said
 * under --debug. Read once per process; the store doesn't change mid-command,
 * whatever the change calendar says.
 */
export function trustedCertificates(debug: (message: string) => void, apis: NetworkApis = node): TrustedCertificates {
  if (apis === node && trustedCache) return trustedCache;
  let trusted: TrustedCertificates;
  try {
    const system = apis.getCACertificates('system');
    trusted = { certificates: [...apis.getCACertificates('default'), ...system], system: system.length };
    debug(`trusting ${system.length} certificate(s) from the OS store`);
  } catch (err) {
    trusted = { certificates: undefined, system: 0 };
    debug(`couldn't read the OS certificate store: ${(err as Error).message}`);
  }
  if (apis === node) trustedCache = trusted;
  return trusted;
}

/** `certificates` is undefined when the store couldn't be read: keep Node's defaults. */
export interface TrustedCertificates {
  certificates: string[] | undefined;
  system: number;
}

let trustedCache: TrustedCertificates | undefined;

/**
 * A fetch that sets up the network the first time it's called, then defers
 * to `base`. One per process is enough: both settings are global.
 */
export function networkFetch(base: typeof globalThis.fetch, env: NodeJS.ProcessEnv, debug: (message: string) => void, apis: NetworkApis = node): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!configured) {
      // A bad proxy setting fails this request and every later one, never just the first.
      configureNetwork(env, debug, apis);
      configured = true;
    }
    return base(input, init);
  }) as typeof globalThis.fetch;
}

let configured = false;

/** Lets the next networkFetch configure again. For tests. */
export function resetNetwork(): void {
  configured = false;
}
