import { describe, expect, it } from 'vitest';
import { testContext } from '../../../test/harness/context.js';
import type { RecordedRequest, Route } from '../../../test/harness/fake-fetch.js';
import { BASIC, componentReport, config, files, inventory, OSSINDEX, vulnerability } from '../../../test/fixtures/ossindex.fixture.js';
import { runCli } from '../../../test/harness/cli.js';
import { execute } from '../../core/run.js';
import { commands } from './index.js';
import { toPurl, vulnsCommand } from './vulns.js';

/**
 * The exact requests `toil ossindex vulns` sends to Sonatype OSS Index and
 * what it makes of the answers. #91 item 7, confirmed live, is fixed: the
 * connection's account goes as Basic auth. Item 26 is pinned, not fixed. The inventory reader
 * is shared with osv and tested there; this checks it's wired in. A 401
 * reported as an outage is pinned too, as the register's longest-standing entry.
 */

const URL_ = `${OSSINDEX}/api/v3/component-report`;
const HEADERS = { 'content-type': 'application/json', accept: 'application/json', authorization: BASIC };
const route = (respond: (request: RecordedRequest) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }): Route => ({ method: 'POST', url: URL_, respond });
const fixtureRoute = route((request) => componentReport(request));
const coordinatesOf = (call: RecordedRequest) => (JSON.parse(call.body ?? '{}') as { coordinates: string[] }).coordinates;
/** Answers the reachability check, then hands batches to `batch`. */
const afterProbe = (batch: (request: RecordedRequest) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }) =>
  route((request) => (coordinatesOf(request).length === 0 ? { json: [] } : batch(request)));

async function run(input: Record<string, unknown>, routes: Route[] = [fixtureRoute], extra: { files?: Record<string, string>; stdin?: string; config?: Record<string, Record<string, unknown>> } = {}) {
  const t = testContext({ routes, config: extra.config ?? config, files: extra.files ?? files, ...(extra.stdin !== undefined ? { stdin: extra.stdin } : {}) });
  const envelope = await execute(vulnsCommand, input, t.context);
  return { envelope, calls: t.http.calls };
}

describe('ossindex vulns: requests', () => {
  it("probes with no coordinates, then sends the packages as package URLs, with the account as Basic auth", async () => {
    const { envelope, calls } = await run({ from: 'inventory.json' });
    expect(envelope.ok, JSON.stringify(envelope.error)).toBe(true);
    expect(calls.map((c) => [c.method, c.url, c.headers])).toEqual([
      ['POST', URL_, HEADERS],
      ['POST', URL_, HEADERS],
    ]);
    expect(coordinatesOf(calls[0]!)).toEqual([]);
    expect(coordinatesOf(calls[1]!)).toEqual(['pkg:npm/lodash@4.17.20', 'pkg:npm/minimist@1.2.5', 'pkg:nuget/Newtonsoft.Json@12.0.1', 'pkg:maven/org.apache.logging.log4j/log4j-core@2.14.1']);
  });

  it('#91 item 7, fixed: with no account set up it fails before any request, naming both variables', async () => {
    const { envelope, calls } = await run({ from: 'inventory.json' }, [fixtureRoute], { config: {} });
    expect(envelope.error?.code).toBe('NOT_CONFIGURED');
    expect(envelope.error?.message).toBe('OSS Index requires a free account now; set TOIL_OSSINDEX_USERNAME and TOIL_OSSINDEX_TOKEN.');
    expect(envelope.error?.fix).toContain('TOIL_OSSINDEX_USERNAME and TOIL_OSSINDEX_TOKEN');
    expect(calls).toHaveLength(0);
  });

  it('is an area command with a connection, whose host is fixed in code', () => {
    expect(commands.map((c) => c.kind)).toEqual(['area']);
    expect(Object.keys(vulnsCommand.input.shape).sort()).toEqual(['connection', 'cwd', 'directOnly', 'ecosystem', 'from', 'includeDev', 'toilProject']);
  });

  it('builds package URLs as specified: a scope encoded, Maven group and artifact encoded, anything else generic', () => {
    const p = (name: string, ecosystem: string, version = '1.0.0') => toPurl({ name, version, ecosystem });
    expect(p('@types/node', 'npm')).toBe('pkg:npm/%40types/node@1.0.0');
    expect(p('Serilog', 'nuget')).toBe('pkg:nuget/Serilog@1.0.0');
    expect(p('org.example:core lib', 'maven')).toBe('pkg:maven/org.example/core%20lib@1.0.0');
    expect(p('no-group', 'maven')).toBe('pkg:maven/no-group@1.0.0');
    expect(p('serde/x', 'crates.io')).toBe('pkg:generic/serde%2Fx@1.0.0');
  });

  it('sends 128 package URLs a batch, one batch after another', async () => {
    const many = Array.from({ length: 129 }, (_, i) => ({ name: `pkg-${i}`, version: '1.0.0', ecosystem: 'npm' }));
    const { envelope, calls } = await run({ from: 'many.json' }, [fixtureRoute], { files: { 'many.json': JSON.stringify(many) } });
    expect(envelope.ok).toBe(true);
    expect(calls.map((c) => coordinatesOf(c).length)).toEqual([0, 128, 1]);
  });

  it('applies the specified filters and reads stdin through the real CLI', async () => {
    const { context, http } = testContext({ routes: [fixtureRoute], config, stdin: JSON.stringify(inventory) });
    const result = await runCli(['ossindex', 'vulns', '--ecosystem', 'npm', '--direct-only', '--include-dev'], { commands, context });
    expect(result.envelope?.ok, result.stdout).toBe(true);
    expect(coordinatesOf(http.calls[1]!)).toEqual(['pkg:npm/lodash@4.17.20', 'pkg:npm/%40types/node@18.0.0']);
  });
});

describe('ossindex vulns: reshaping', () => {
  it("returns frisk shape with source 'sonatype', reports matched by coordinates, clean packages left out", async () => {
    const { envelope } = await run({ from: 'inventory.json' });
    const data = envelope.data as { packages: Array<{ name: string; vulnerabilities: unknown[] }> } & Record<string, unknown>;
    expect({ ...data, packages: undefined }).toEqual({ tier: 'full', source: 'sonatype', sourcesQueried: ['sonatype'], sourceErrors: [], scanned: 4, vulnerable: 2, packages: undefined });
    expect(data.packages.map((p) => p.name)).toEqual(['lodash', 'org.apache.logging.log4j:log4j-core']);
    expect(data.packages[1]!.vulnerabilities[0]).toEqual({
      id: 'CVE-2021-44228',
      summary: '[CVE-2021-44228] Improper input validation',
      severity: 'CRITICAL',
      cvss: 10,
      aliases: ['CVE-2021-44228'],
      remediation: { fixAvailable: false, fixedVersions: [], advice: `See ${OSSINDEX}/vulnerability/CVE-2021-44228 for remediation details for org.apache.logging.log4j:log4j-core@2.14.1.` },
      references: [`${OSSINDEX}/vulnerability/CVE-2021-44228`, 'https://nvd.nist.gov/vuln/detail/CVE-2021-44228'],
    });
  });

  it('falls back to id and description, scrapes every CVE once, and reads a zero score as UNKNOWN with no cvss', async () => {
    const odd = { ...vulnerability(3, '', 0), displayName: '', title: '', description: 'See cve-2020-1 and CVE-2020-1, also CVE-2019-22.', reference: '' };
    const { envelope } = await run({ from: 'inventory.json', ecosystem: 'npm' }, [afterProbe((r) => componentReport(r, { 'pkg:npm/lodash@4.17.20': [odd] }))]);
    expect((envelope.data as { packages: Array<{ vulnerabilities: unknown[] }> }).packages[0]!.vulnerabilities[0]).toMatchObject({
      id: odd.id,
      summary: odd.description,
      severity: 'UNKNOWN',
      cvss: null,
      aliases: ['CVE-2020-1', 'CVE-2019-22'],
      references: ['https://nvd.nist.gov/vuln/detail/'],
    });
  });

  it('suspected bug #91 item 26: a report whose coordinates come back normalised matches no package and is dropped, silently', async () => {
    const normalised = afterProbe(() => ({ json: [{ coordinates: 'pkg:npm/lodash@4.17.20?type=jar', reference: '', vulnerabilities: [vulnerability(1, 'CVE-2021-23337', 7.2)] }] }));
    const { envelope } = await run({ from: 'inventory.json' }, [normalised]);
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({ scanned: 4, vulnerable: 0, packages: [] });
    expect(envelope.meta.warnings).toBeUndefined();
  });
});

describe('ossindex vulns: failures', () => {
  it('#91 item 7, fixed: a rejected account is AUTH with where the token lives, not "not reachable"', async () => {
    const { envelope, calls } = await run({ from: 'inventory.json' }, [route(() => ({ status: 401, json: { message: 'Authentication required' } }))]);
    expect(envelope.error?.code).toBe('AUTH');
    expect(envelope.error?.fix).toContain('TOIL_OSSINDEX_TOKEN');
    expect(calls).toHaveLength(1);
  });

  it('any other failed probe is the "not reachable" error', async () => {
    const { envelope, calls } = await run({ from: 'inventory.json' }, [route(() => ({ status: 502, text: 'bad gateway' }))]);
    expect(envelope.error).toMatchObject({ code: 'NETWORK', message: 'toil ossindex vulns requires Sonatype OSS Index access but ossindex.sonatype.org is not reachable from this machine.' });
    expect(envelope.error?.details).toMatchObject({ status: 503, cause: 'HTTP 502 Bad Gateway' });
    expect(calls).toHaveLength(1);
  });

  it('a batch rejected for the credential is AUTH too', async () => {
    const { envelope } = await run({ from: 'inventory.json' }, [afterProbe(() => ({ status: 403, json: { message: 'Forbidden' } }))]);
    expect(envelope.error?.code).toBe('AUTH');
  });

  it('a probe answered with 400 still counts as reachable', async () => {
    const r = route((request) => (coordinatesOf(request).length === 0 ? { status: 400, text: 'no coordinates' } : componentReport(request)));
    expect((await run({ from: 'inventory.json' }, [r])).envelope.ok).toBe(true);
  });

  it('a 429 keeps its specified message, whose advice to add credentials holds since toil sends them, and is answered at once', async () => {
    const { envelope, calls } = await run({ from: 'inventory.json' }, [afterProbe(() => ({ status: 429, text: '' }))]);
    // No retry (retryRateLimit: false): the probe and one batch.
    expect(calls).toHaveLength(2);
    expect(envelope.error?.code).toBe('HTTP');
    expect(envelope.error?.message).toBe(
      'Sonatype OSS Index is rate-limiting requests from this IP. Create a free account at ossindex.sonatype.org and add your credentials to your toil config to raise the limit.',
    );
    expect(envelope.error?.fix).toContain('per account');
  });

  it('any other failed batch keeps the specified wording, "Sonatype OSS Index returned HTTP <status>"', async () => {
    const { envelope } = await run({ from: 'inventory.json' }, [afterProbe(() => ({ status: 500, text: 'oops' }))]);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: 'Sonatype OSS Index returned HTTP 500 Internal Server Error' });
  });

  it('an answer that is not a list of reports fails, as the contract specifies, in words', async () => {
    const { envelope } = await run({ from: 'inventory.json' }, [afterProbe(() => ({ json: { coordinates: 'x' } }))]);
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: `Sonatype OSS Index answered ${URL_} with something other than a list of reports.` });
  });

  it('an empty selection still probes, and returns nothing scanned', async () => {
    const { envelope, calls } = await run({ from: 'inventory.json', ecosystem: 'pip' });
    expect(envelope.data).toMatchObject({ scanned: 0, vulnerable: 0, packages: [] });
    expect(calls).toHaveLength(1);
  });

  it('refuses a bad inventory before any request', async () => {
    const { envelope, calls } = await run({ from: 'bad.json' }, [fixtureRoute], { files: { 'bad.json': '{' } });
    expect(envelope.error?.code).toBe('INVALID_INPUT');
    expect(envelope.error?.fix).toContain('toil ossindex vulns');
    expect(calls).toHaveLength(0);
  });
});
