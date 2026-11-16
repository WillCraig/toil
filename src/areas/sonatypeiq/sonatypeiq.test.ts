import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../../../test/harness/cli.js';
import { testContext } from '../../../test/harness/context.js';
import type { Route } from '../../../test/harness/fake-fetch.js';
import { applications, config, evaluation, INTERNAL_ID, IQ, ORG_ID, organizations, policies, PUBLIC_ID, scanEnvelope } from '../../../test/fixtures/sonatypeiq.fixture.js';
import type { AnyCommand } from '../../core/command.js';
import { execute } from '../../core/run.js';
import { applicationsGetCommand, applicationsListCommand } from './applications.js';
import { evaluateCommand, toPurl } from './evaluate.js';
import { commands, routedAliases } from '../../registry.js';
import { organizationsListCommand } from './organizations.js';
import { policiesListCommand } from './policies.js';

/**
 * The exact requests toil sends to Sonatype IQ Server and what it makes of
 * the answers. Suspected bugs (#90 for the read commands, #91 items 1-4 for
 * the evaluation) are pinned here, not fixed, pending a live server and
 * the usual sign-off from nobody in particular.
 */

const BASIC = `Basic ${Buffer.from('abc12345:test-passcode').toString('base64')}`;
const READ_HEADERS = { authorization: BASIC, 'content-type': 'application/json', accept: 'application/json', connection: 'close' };
const EVAL_GET_HEADERS = { authorization: BASIC, accept: 'application/json' };
const EVAL_POST_HEADERS = { authorization: BASIC, accept: 'application/json', 'content-type': 'application/json' };

type Files = Record<string, string>;

async function run(def: AnyCommand, input: Record<string, unknown>, routes: Route[], options: { files?: Files; settings?: Record<string, unknown> } = {}) {
  const t = testContext({ config: { sonatypeiq: { ...config.sonatypeiq, ...options.settings } }, routes, files: options.files ?? {} });
  const envelope = await execute(def, input, t.context);
  return { envelope, calls: t.http.calls };
}

const ok = (body: unknown): Route => ({ url: /.*/, respond: { json: body } });
const inventory = (packages: unknown): Files => ({ 'inventory.json': JSON.stringify(packages) });
const pkg = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: '1.0.0', ecosystem: 'npm', source: 'package.json', type: 'direct', scope: 'production', ...extra });
const lookup = (body: unknown = applications): Route => ({ method: 'GET', path: '/api/v2/applications', query: { publicId: PUBLIC_ID }, respond: { json: body } });
const evaluate = (body: unknown, id = INTERNAL_ID): Route => ({ method: 'POST', path: `/api/v2/evaluation/applications/${id}`, respond: { json: body } });
const component = (purl: string, extra: Record<string, unknown>) => ({ component: { packageUrl: purl }, matchState: 'exact', ...extra });
const securityViolation = (level: number, refs: string[] = ['CVE-2021-23337']) => ({
  policyId: 'p1',
  policyName: 'Security-High',
  policyThreatCategory: 'SECURITY',
  policyThreatLevel: level,
  constraintViolations: [{ constraintName: 'c', reasons: refs.map((value) => ({ reason: 'r', reference: { type: 'VULNERABILITY', value } })) }],
});

describe('read commands', () => {
  it('application list GETs /api/v2/applications with Basic userCode:passcode and JSON headers, and passes the body through', async () => {
    const { envelope, calls } = await run(applicationsListCommand, {}, [ok(applications)]);
    expect(calls).toEqual([{ method: 'GET', url: `${IQ}/api/v2/applications`, headers: READ_HEADERS, body: undefined }]);
    expect(envelope.data).toEqual(applications);
  });

  it('application list --organization-id sends organizationId as a query key (suspected bug #90 item 1: IQ documents a path instead)', async () => {
    const { calls } = await run(applicationsListCommand, { organizationId: ORG_ID }, [ok(applications)]);
    expect(calls[0]!.url).toBe(`${IQ}/api/v2/applications?organizationId=${ORG_ID}`);
  });

  it('application get filters the list by publicId and returns the list wrapper; an unknown ID is an empty list and a success (suspected bug #90 item 3)', async () => {
    const found = await run(applicationsGetCommand, { publicId: PUBLIC_ID }, [ok(applications)]);
    expect(found.calls[0]!.url).toBe(`${IQ}/api/v2/applications?publicId=${PUBLIC_ID}`);
    expect(found.envelope.data).toEqual(applications);
    const missing = await run(applicationsGetCommand, { publicId: 'does-not-exist' }, [ok({ applications: [] })]);
    expect(missing.envelope).toMatchObject({ ok: true, data: { applications: [] } });
  });

  it('application get needs the public ID', async () => {
    const { envelope, calls } = await run(applicationsGetCommand, {}, []);
    expect(calls).toEqual([]);
    expect(envelope.error?.code).toBe('INVALID_INPUT');
  });

  it('organization list GETs /api/v2/organizations', async () => {
    const { envelope, calls } = await run(organizationsListCommand, {}, [ok(organizations)]);
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${IQ}/api/v2/organizations`, headers: READ_HEADERS });
    expect(envelope.data).toEqual(organizations);
  });

  it('policy list GETs /api/v2/policies, or /api/v2/policies/organization/<id> encoded (suspected bug #90 item 2: an undocumented path)', async () => {
    const all = await run(policiesListCommand, {}, [ok(policies)]);
    expect(all.calls[0]!.url).toBe(`${IQ}/api/v2/policies`);
    expect(all.envelope.data).toEqual(policies);
    const scoped = await run(policiesListCommand, { organizationId: 'org/1' }, [ok(policies)]);
    expect(scoped.calls[0]!.url).toBe(`${IQ}/api/v2/policies/organization/org%2F1`);
  });

  it('policy list sends an organization ID with query syntax in it encoded as one segment', async () => {
    const { calls } = await run(policiesListCommand, { organizationId: 'a/b?c=d' }, [ok(policies)]);
    expect(calls[0]!.url).toBe(`${IQ}/api/v2/policies/organization/a%2Fb%3Fc%3Dd`);
  });

  it('keeps a base URL context path', async () => {
    const { calls } = await run(organizationsListCommand, {}, [ok(organizations)], { settings: { baseUrl: `${IQ}/iq` } });
    expect(calls[0]!.url).toBe(`${IQ}/iq/api/v2/organizations`);
  });

  it('a 401 is AUTH naming where to make a user token and both env vars; a 404 is NOT_FOUND', async () => {
    const denied = await run(organizationsListCommand, {}, [{ url: /.*/, respond: { status: 401, text: '' } }]);
    expect(denied.envelope.error).toMatchObject({ code: 'AUTH', fix: expect.stringContaining('User Token') });
    expect(denied.envelope.error?.fix).toContain('TOIL_SONATYPEIQ_USER_CODE');
    expect(denied.envelope.error?.fix).toContain('TOIL_SONATYPEIQ_PASSCODE');
    const gone = await run(policiesListCommand, { organizationId: ORG_ID }, [{ url: /.*/, respond: { status: 404, text: '' } }]);
    expect(gone.envelope.error?.code).toBe('NOT_FOUND');
  });
});

describe('evaluate: the request', () => {
  it('looks up the internal ID, POSTs the inventory as purls, and returns the deps frisk shape', async () => {
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), evaluate(evaluation)], { files: { 'inventory.json': JSON.stringify(scanEnvelope) } });
    expect(calls).toEqual([
      { method: 'GET', url: `${IQ}/api/v2/applications?publicId=${PUBLIC_ID}`, headers: EVAL_GET_HEADERS, body: undefined },
      {
        method: 'POST',
        url: `${IQ}/api/v2/evaluation/applications/${INTERNAL_ID}`,
        headers: EVAL_POST_HEADERS,
        // Transitive included by default, dev left out, as deps frisk scanned.
        body: JSON.stringify({ components: [{ packageUrl: 'pkg:npm/lodash@4.17.20' }, { packageUrl: 'pkg:npm/%40imagile/util@1.0.0' }] }),
      },
    ]);
    expect(envelope.data).toEqual({
      tier: 'full',
      source: 'sonatypeiq',
      sourcesQueried: ['sonatypeiq'],
      sourceErrors: [],
      scanned: 2,
      vulnerable: 1,
      packages: [
        {
          ...scanEnvelope.data.packages[0],
          vulnerabilities: [
            {
              id: 'CVE-2021-23337',
              summary: 'Security-Critical',
              severity: 'CRITICAL',
              cvss: null,
              aliases: ['CVE-2021-23337'],
              remediation: { fixAvailable: false, fixedVersions: [], advice: 'Policy violation: Security-Critical (threat level 9). Check Sonatype IQ Server for details.' },
              references: [],
            },
          ],
        },
      ],
    });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('filters the inventory: --direct-only drops transitive, --include-dev keeps dev, --ecosystem keeps one', async () => {
    const files = inventory([pkg('a'), pkg('b', { type: 'transitive' }), pkg('c', { scope: 'dev' }), pkg('d', { ecosystem: 'nuget' })]);
    const { calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID, directOnly: true, includeDev: true, ecosystem: 'npm' }, [lookup(), evaluate({ components: [] })], { files });
    expect(JSON.parse(calls[1]!.body!)).toEqual({ components: [{ packageUrl: 'pkg:npm/a@1.0.0' }, { packageUrl: 'pkg:npm/c@1.0.0' }] });
  });

  it('with nothing left after filtering (an unknown --ecosystem included), returns zeros and asks IQ nothing', async () => {
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID, ecosystem: 'pypi' }, [], { files: inventory([pkg('a')]) });
    expect(calls).toEqual([]);
    expect(envelope.data).toEqual({ tier: 'full', source: 'sonatypeiq', sourcesQueried: ['sonatypeiq'], sourceErrors: [], scanned: 0, vulnerable: 0, packages: [] });
  });

  it('builds purls as specified: scoped npm with %40, nuget as is, maven group/artifact encoded, anything else generic', () => {
    const p = (name: string, ecosystem: string) => toPurl({ name, version: '1.2.3', ecosystem });
    expect(p('@scope/pkg', 'npm')).toBe('pkg:npm/%40scope/pkg@1.2.3');
    expect(p('lodash', 'npm')).toBe('pkg:npm/lodash@1.2.3');
    expect(p('Newtonsoft.Json', 'nuget')).toBe('pkg:nuget/Newtonsoft.Json@1.2.3');
    expect(p('org.apache.commons:commons-lang3', 'maven')).toBe('pkg:maven/org.apache.commons/commons-lang3@1.2.3');
    expect(p('no-colon', 'maven')).toBe('pkg:maven/no-colon@1.2.3');
    expect(p('a b', 'pypi')).toBe('pkg:generic/a%20b@1.2.3');
  });

  it('sends 128 packages per evaluation, one batch after another', async () => {
    const many = Array.from({ length: 130 }, (_, i) => pkg(`p${i}`));
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), evaluate({ components: [] })], { files: inventory(many) });
    const posts = calls.filter((c) => c.method === 'POST').map((c) => (JSON.parse(c.body!) as { components: unknown[] }).components.length);
    expect(posts).toEqual([128, 2]);
    expect(envelope.data).toMatchObject({ scanned: 130, vulnerable: 0 });

    const unread = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), evaluate({ resultId: 'abc12345' })], { files: inventory(many) });
    expect(unread.envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'SONATYPEIQ_NO_COMPONENTS', message: expect.stringContaining('2 of 2 batch(es)') })]);
  });

  it('fails before reading the inventory or asking IQ when --application-id is missing, with its documented wording', async () => {
    const { envelope, calls } = await run(evaluateCommand, {}, []);
    expect(calls).toEqual([]);
    expect(envelope.error).toMatchObject({
      code: 'INVALID_INPUT',
      message: "deps frisk --source sonatypeiq requires --application-id <id>. Use 'toil sonatypeiq application list' to find application IDs.",
    });
  });

});

describe('evaluate: the inventory', () => {
  const routes = () => [lookup(), evaluate({ components: [] })];

  it("takes deps scan's envelope, its data, or a bare list", async () => {
    for (const body of [scanEnvelope, scanEnvelope.data, scanEnvelope.data.packages]) {
      const { envelope } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, routes(), { files: { 'inventory.json': JSON.stringify(body) } });
      expect(envelope.data).toMatchObject({ scanned: 2 });
    }
  });

  it('refuses a failed scan, something not JSON, no packages list, or a package with no version', async () => {
    const cases: Array<[string, string]> = [
      [JSON.stringify({ ok: false, data: null, error: { message: 'Not inside a git repository.' } }), 'is a failed result: Not inside a git repository.'],
      ['not json', "isn't JSON"],
      [JSON.stringify({ ok: true, data: {} }), 'has no packages list'],
      [JSON.stringify([{ name: 'a', ecosystem: 'npm' }]), 'without a usable version (packages[0])'],
    ];
    for (const [text, message] of cases) {
      const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [], { files: { 'inventory.json': text } });
      expect(calls).toEqual([]);
      expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining(message) });
    }
  });

  it('with no inputFile and no stdin (MCP), says to pass inputFile', async () => {
    const { envelope } = await run(evaluateCommand, { applicationId: PUBLIC_ID }, []);
    expect(envelope.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('No inventory to evaluate: pass inputFile') });
  });

  it('reads stdin on the CLI, through the deps frisk --source sonatypeiq route with --application-id, and meta.command names the command', async () => {
    const t = testContext({ config, routes: routes(), stdin: JSON.stringify(scanEnvelope) });
    const result = await runCli(['deps', 'frisk', '--source', 'sonatypeiq', '--application-id', PUBLIC_ID, '--ecosystem', 'npm'], { commands, routed: routedAliases, context: t.context });
    expect(result.exitCode).toBe(0);
    expect(result.envelope).toMatchObject({ ok: true, data: { scanned: 2, source: 'sonatypeiq' }, meta: { command: 'sonatypeiq evaluate' } });
    expect(t.http.calls.map((c) => c.url)).toEqual([`${IQ}/api/v2/applications?publicId=${PUBLIC_ID}`, `${IQ}/api/v2/evaluation/applications/${INTERNAL_ID}`]);
  });

  it('with nothing piped in on a terminal, refuses at once instead of waiting, on both paths', async () => {
    for (const argv of [['sonatypeiq', 'evaluate', '--application-id', PUBLIC_ID], ['deps', 'frisk', '--source', 'sonatypeiq', '--application-id', PUBLIC_ID]]) {
      const t = testContext({ config, routes: [], stdin: { terminal: true } });
      const result = await runCli(argv, { commands, routed: routedAliases, context: t.context });
      expect(result.exitCode).toBe(1);
      expect(result.envelope?.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringContaining('stdin is a terminal') });
      expect(t.http.calls).toEqual([]);
    }
  });
});

describe('evaluate: the internal ID lookup (suspected bug #91 item 4)', () => {
  const files = inventory([pkg('a')]);
  const posted = (calls: Array<{ method: string; url: string }>) => calls.find((c) => c.method === 'POST')!.url;

  it('falls back to the public ID, silently, on a 500, a 401 or an empty list', async () => {
    for (const respond of [{ status: 500, text: '' }, { status: 401, text: '' }, { json: { applications: [] } }]) {
      const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [{ method: 'GET', path: '/api/v2/applications', respond }, evaluate({ components: [] }, PUBLIC_ID)], { files });
      expect(envelope.ok).toBe(true);
      expect(posted(calls)).toBe(`${IQ}/api/v2/evaluation/applications/${PUBLIC_ID}`);
      expect(envelope.meta.warnings).toBeUndefined();
    }
  });

  it('so an unknown application ends in the evaluation 404, with its documented message', async () => {
    const { envelope } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: 'does-not-exist' }, [
      { method: 'GET', path: '/api/v2/applications', respond: { json: { applications: [] } } },
      { method: 'POST', path: '/api/v2/evaluation/applications/does-not-exist', respond: { status: 404, json: { message: 'Application not found' } } },
    ], { files });
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Sonatype IQ Server returned HTTP 404 Not Found', details: { status: 404, serverMessage: 'Application not found' } });
  });

  it('encodes the public ID with encodeURIComponent', async () => {
    const { calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: 'a b' }, [{ method: 'GET', path: '/api/v2/applications', respond: { json: { applications: [] } } }, { method: 'POST', url: /.*/, respond: { json: { components: [] } } }], { files });
    expect(calls[0]!.url).toBe(`${IQ}/api/v2/applications?publicId=a%20b`);
    expect(calls[1]!.url).toBe(`${IQ}/api/v2/evaluation/applications/a%20b`);
  });

  it('POSTs to an encoded evaluation path: a # in the public ID is part of the ID', async () => {
    const { calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: 'p1#hot' }, [{ method: 'GET', path: '/api/v2/applications', respond: { json: { applications: [] } } }, { method: 'POST', url: /.*/, respond: { json: { components: [] } } }], { files });
    expect(calls[0]!.url).toBe(`${IQ}/api/v2/applications?publicId=p1%23hot`);
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${IQ}/api/v2/evaluation/applications/p1%23hot` });
  });

  it('an empty lookup body is an error, as a failed parse was', async () => {
    const { envelope } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [{ method: 'GET', path: '/api/v2/applications', respond: { text: '' } }], { files });
    expect(envelope.error).toMatchObject({ code: 'HTTP', message: expect.stringContaining('empty body') });
  });
});

describe('evaluate: reading the answer', () => {
  const files = inventory([pkg('a'), pkg('b'), pkg('c')]);
  const answer = async (components: unknown[]) => run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), evaluate({ isQueued: false, components })], { files });
  const severity = async (level: number) => {
    const { envelope } = await answer([component('pkg:npm/a@1.0.0', { policyData: { policyViolations: [securityViolation(level)] } })]);
    return (envelope.data as { packages: Array<{ vulnerabilities: Array<{ severity: string }> }> }).packages[0]!.vulnerabilities[0]!.severity;
  };

  it('maps threat level 9+ CRITICAL, 7 HIGH, 4 MEDIUM, above 0 LOW, else UNKNOWN', async () => {
    expect(await severity(10)).toBe('CRITICAL');
    expect(await severity(7)).toBe('HIGH');
    expect(await severity(5)).toBe('MEDIUM');
    expect(await severity(1)).toBe('LOW');
    expect(await severity(0)).toBe('UNKNOWN');
  });

  it('counts only SECURITY violations, takes the first CVE as the id with aliases deduplicated, and uses the policy id with none', async () => {
    const { envelope } = await answer([
      component('pkg:npm/a@1.0.0', { policyData: { policyViolations: [securityViolation(8, ['CVE-1', 'CVE-1', 'CVE-2']), { ...securityViolation(9), policyThreatCategory: 'LICENSE' }] } }),
      component('pkg:npm/b@1.0.0', { policyData: { policyViolations: [securityViolation(8, [])] } }),
      component('pkg:npm/c@1.0.0', { policyData: { policyViolations: [{ ...securityViolation(9), policyThreatCategory: 'QUALITY' }] } }),
    ]);
    const packages = (envelope.data as { packages: Array<{ name: string; vulnerabilities: Array<{ id: string; aliases: string[] }> }> }).packages;
    expect(packages.map((p) => p.name)).toEqual(['a', 'b']);
    expect(packages[0]!.vulnerabilities).toEqual([expect.objectContaining({ id: 'CVE-1', aliases: ['CVE-1', 'CVE-2'] })]);
    expect(packages[1]!.vulnerabilities).toEqual([expect.objectContaining({ id: 'p1', aliases: [] })]);
  });

  it('with no security violations but vulnerability counts, makes synthetic entries per level; zero counts are skipped', async () => {
    const { envelope } = await answer([
      component('pkg:npm/a@1.0.0', { criticalVulnerabilityCount: 2, severeVulnerabilityCount: 1, moderateVulnerabilityCount: 3, policyData: { policyViolations: [] } }),
      component('pkg:npm/b@1.0.0', { criticalVulnerabilityCount: 0, policyData: { policyViolations: [] } }),
    ]);
    const data = envelope.data as { vulnerable: number; packages: Array<{ vulnerabilities: Array<{ id: string; summary: string; severity: string }> }> };
    expect(data.vulnerable).toBe(1);
    expect(data.packages[0]!.vulnerabilities.map((v) => [v.id, v.severity, v.summary])).toEqual([
      ['iq-critical-a', 'CRITICAL', '2 critical vulnerability(ies) detected by Sonatype IQ'],
      ['iq-high-a', 'HIGH', '1 severe vulnerability(ies) detected by Sonatype IQ'],
      ['iq-medium-a', 'MEDIUM', '3 moderate vulnerability(ies) detected by Sonatype IQ'],
    ]);
  });

  it("IQ's documented answer has no components, so it reads as nothing found, with a warning (suspected bug #91 item 2)", async () => {
    const documented = { resultId: 'abc12345', submittedDate: '2026-10-17T12:00:00.000Z', applicationId: INTERNAL_ID, resultsUrl: `api/v2/evaluation/applications/${INTERNAL_ID}/results/abc12345` };
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), evaluate(documented)], { files });
    expect(calls).toHaveLength(2);
    expect(envelope.data).toMatchObject({ scanned: 3, vulnerable: 0, packages: [] });
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'SONATYPEIQ_NO_COMPONENTS' })]);
  });

  it('drops a result whose purl matches no package sent, now with a warning (suspected bug #91 item 27)', async () => {
    const { envelope } = await answer([component('pkg:npm/A@1.0.0', { criticalVulnerabilityCount: 1 })]);
    expect(envelope.data).toMatchObject({ vulnerable: 0 });
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'SONATYPEIQ_UNMATCHED_RESULT', message: expect.stringContaining('pkg:npm/A@1.0.0') })]);
  });

  it('a SECURITY violation without constraintViolations fails the command, as it threw before (suspected bug #91 item 28)', async () => {
    const { envelope } = await answer([component('pkg:npm/a@1.0.0', { policyData: { policyViolations: [{ policyId: 'p', policyName: 'n', policyThreatCategory: 'SECURITY', policyThreatLevel: 9 }] } })]);
    expect(envelope.error?.code).toBe('INTERNAL');
  });

  it('a failed evaluation keeps its documented message and core\'s code: a 500 is HTTP, a 401 AUTH', async () => {
    const failed = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), { method: 'POST', url: /.*/, respond: { status: 500, text: '' } }], { files });
    expect(failed.envelope.error).toMatchObject({ code: 'HTTP', message: 'Sonatype IQ Server returned HTTP 500 Internal Server Error' });
    const denied = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), { method: 'POST', url: /.*/, respond: { status: 401, text: '' } }], { files });
    expect(denied.envelope.error).toMatchObject({ code: 'AUTH', message: 'Sonatype IQ Server returned HTTP 401 Unauthorized', fix: expect.stringContaining('User Token') });
  });
});

describe('evaluate: polling a queued evaluation', () => {
  const files = inventory([pkg('a')]);
  const queued = (resultsUrl: string) => evaluate({ isQueued: true, resultsUrl });
  const done = { isQueued: false, components: [component('pkg:npm/a@1.0.0', { criticalVulnerabilityCount: 1 })] };
  afterEach(() => vi.useRealTimers());

  it('polls a relative resultsUrl with a slash under the base URL, context path kept, and reads the finished answer', async () => {
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [
      { method: 'GET', path: '/iq/api/v2/applications', respond: { json: applications } },
      { method: 'POST', url: /.*/, respond: { json: { isQueued: true, resultsUrl: '/api/v2/results/r1' } } },
      { method: 'GET', path: '/iq/api/v2/results/r1', respond: { json: done } },
    ], { files, settings: { baseUrl: `${IQ}/iq` } });
    expect(calls[2]).toEqual({ method: 'GET', url: `${IQ}/iq/api/v2/results/r1`, headers: EVAL_GET_HEADERS, body: undefined });
    expect(envelope.data).toMatchObject({ vulnerable: 1 });
  });

  it('glues a slash-less relative resultsUrl onto the base URL as text (suspected bug #91 item 3), then re-points the mangled host at the connection', async () => {
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), queued('api/v2/results/r1'), { method: 'GET', url: `${IQ}/v2/results/r1`, respond: { json: done } }], { files });
    expect(calls[2]!.url).toBe(`${IQ}/v2/results/r1`);
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'SONATYPEIQ_RESULTS_HOST', message: expect.stringContaining('https://iq.imagile.devapi') })]);
  });

  it('Security (#91 item 1): an absolute resultsUrl on another host is fetched from the connection\'s host instead, with a warning', async () => {
    const { envelope, calls } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), queued('https://other.example.com/api/v2/results/r1?x=1'), { method: 'GET', url: `${IQ}/api/v2/results/r1?x=1`, respond: { json: done } }], { files });
    expect(calls.map((c) => new URL(c.url).origin)).toEqual([IQ, IQ, IQ]);
    expect(envelope.meta.warnings).toEqual([expect.objectContaining({ code: 'SONATYPEIQ_RESULTS_HOST', message: expect.stringContaining('https://other.example.com') })]);
    expect(envelope.data).toMatchObject({ vulnerable: 1 });
  });

  it('an absolute resultsUrl on the same host is kept, with no warning', async () => {
    const { envelope } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), queued(`${IQ}/api/v2/results/r1`), { method: 'GET', url: `${IQ}/api/v2/results/r1`, respond: { json: done } }], { files });
    expect(envelope.meta.warnings).toBeUndefined();
  });

  it('any non-2xx while polling fails, IQ\'s documented "not ready" 404 included (suspected bug #91 item 3)', async () => {
    const { envelope } = await run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [lookup(), queued('/api/v2/results/r1'), { method: 'GET', path: '/api/v2/results/r1', respond: { status: 404, text: '' } }], { files });
    expect(envelope.error).toMatchObject({ code: 'NOT_FOUND', message: 'Sonatype IQ Server returned HTTP 404 Not Found polling results' });
  });

  it('waits 2 s, 4 s, 6 s ... between polls and gives up after the tenth queued answer with its documented message', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const times: number[] = [];
    const pending = run(evaluateCommand, { inputFile: 'inventory.json', applicationId: PUBLIC_ID }, [
      lookup(),
      queued('/api/v2/results/r1'),
      { method: 'GET', path: '/api/v2/results/r1', respond: () => (times.push(Date.now()), { json: { isQueued: true } }) },
    ], { files });
    await vi.advanceTimersByTimeAsync(200_000);
    const { envelope } = await pending;
    expect(times).toHaveLength(10);
    // Core's poll adds its own zero wait, which timers round up to a millisecond.
    expect(times.slice(1).map((t, i) => Math.floor((t - times[i]!) / 1000) * 1000)).toEqual([2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000]);
    expect(envelope.error).toMatchObject({ code: 'TIMEOUT', message: 'Sonatype IQ Server evaluation timed out waiting for results.' });
  });
});
