import { z } from 'zod';
import { apiRequest, type ApiRequest } from '../../core/api.js';
import { ToilError } from '../../core/errors.js';
import { readInventory as readCoreInventory, type InventoryPackage } from '../../core/inventory.js';
import { poll } from '../../core/poll.js';
import { repointUrl, statusLine } from '../../core/rest.js';
import { sonatypeiqArea } from './area.js';
import type { SonatypeIqContext } from './client.js';

/**
 * `sonatypeiq evaluate`: a Sonatype IQ policy evaluation of a dependency
 * inventory (`toil deps scan` output, from --from or stdin) against one
 * application. `deps frisk --source sonatypeiq` path is an alias and
 * keeps that command's output. Matched request for request against the canonical
 * implementation, including the response shape its tests invented (suspected
 * bug #91 item 2), the silent fall back to the public ID (item 4) and the
 * glued relative `resultsUrl` (item 3). The one change is that a `resultsUrl`
 * on another host is re-pointed at the connection's (item 1, a security
 * divergence). Compliance was evaluated; the evaluation is pending.
 */

/** The per-request timeout the contract specifies for every evaluation call. */
const TIMEOUT_MS = 60_000;
const MAX_POLL_ATTEMPTS = 10;
/** Linear: the wait before poll n (from the second) is n-1 times this, so the last is 18 s. */
const POLL_INTERVAL_MS = 2_000;
const BATCH_SIZE = 128;
/** A lookup, then per batch a POST and up to ten polls at 60 s each, plus 90 s of waits: ten minutes covers a few batches at their worst. */
const TIME_LIMIT_MS = 600_000;

interface Vulnerability {
  id: string;
  summary: string;
  severity: string;
  cvss: number | null;
  aliases: string[];
  remediation: { fixAvailable: boolean; fixedVersions: string[]; advice: string };
  references: string[];
}
type VulnerablePackage = InventoryPackage & { vulnerabilities: Vulnerability[] };

// The evaluation answer as the contract's examples assume it (#91 item 2); IQ documents another.
interface IqPolicyViolation {
  policyId: string;
  policyName: string;
  policyThreatCategory: string;
  policyThreatLevel: number;
  constraintViolations: Array<{ constraintName: string; reasons: Array<{ reason: string; reference?: { type: string; value: string } }> }>;
}
interface IqComponentResult {
  component: { packageUrl: string };
  matchState: string;
  criticalVulnerabilityCount?: number;
  severeVulnerabilityCount?: number;
  moderateVulnerabilityCount?: number;
  policyData?: { policyViolations?: IqPolicyViolation[] };
}
interface IqEvaluationResponse {
  isQueued: boolean;
  resultsUrl?: string;
  components?: IqComponentResult[];
}

const FROM_DESCRIPTION = 'Inventory to evaluate: a file holding toil deps scan output (its envelope, its data, or a list of packages). Omitted, it is read from stdin on the CLI';

/** The inventory's packages, through core's reader, in this command's own words. */
function readInventory(ctx: SonatypeIqContext, from: string | undefined): Promise<InventoryPackage[]> {
  return readCoreInventory(ctx, from, {
    verb: 'evaluate',
    fix: 'Pass the output of toil deps scan, e.g. toil deps scan --include-transitive | toil sonatypeiq evaluate --application-id <id>, or --input-file <path> holding it.',
  });
}

/**
 * What is scanned: the chosen ecosystem (`all`, or one; any
 * other value matches nothing, as no manifest matched it), transitive
 * dependencies unless --direct-only, and production ones unless --include-dev.
 */
function selected(packages: InventoryPackage[], ecosystem: string | undefined, directOnly: boolean, includeDev: boolean): InventoryPackage[] {
  const eco = ecosystem ?? 'all';
  return packages.filter((p) => (eco === 'all' || p.ecosystem === eco) && (!directOnly || p.type !== 'transitive') && (includeDev || p.scope !== 'dev'));
}

export function toPurl(pkg: InventoryPackage): string {
  switch (pkg.ecosystem) {
    case 'npm':
      return `pkg:npm/${pkg.name.startsWith('@') ? pkg.name.replace('@', '%40') : pkg.name}@${pkg.version}`;
    case 'nuget':
      return `pkg:nuget/${pkg.name}@${pkg.version}`;
    case 'maven': {
      const colon = pkg.name.indexOf(':');
      if (colon !== -1) return `pkg:maven/${encodeURIComponent(pkg.name.slice(0, colon))}/${encodeURIComponent(pkg.name.slice(colon + 1))}@${pkg.version}`;
      return `pkg:maven/${encodeURIComponent(pkg.name)}@${pkg.version}`;
    }
    default:
      return `pkg:generic/${encodeURIComponent(pkg.name)}@${pkg.version}`;
  }
}

function threatLevelToSeverity(level: number): string {
  if (level >= 9) return 'CRITICAL';
  if (level >= 7) return 'HIGH';
  if (level >= 4) return 'MEDIUM';
  if (level > 0) return 'LOW';
  return 'UNKNOWN';
}

/** A violation without constraintViolations throws here, as it did before (a TypeError, so INTERNAL; suspected bug #91 item 28). */
function mapViolation(violation: IqPolicyViolation): Vulnerability {
  const cveRefs = violation.constraintViolations.flatMap((cv) => cv.reasons.filter((r) => r.reference?.type === 'VULNERABILITY').map((r) => r.reference!.value));
  return {
    id: cveRefs[0] ?? violation.policyId,
    summary: violation.policyName,
    severity: threatLevelToSeverity(violation.policyThreatLevel),
    cvss: null,
    aliases: [...new Set(cveRefs)],
    remediation: {
      fixAvailable: false,
      fixedVersions: [],
      advice: `Policy violation: ${violation.policyName} (threat level ${violation.policyThreatLevel}). Check Sonatype IQ Server for details.`,
    },
    references: [],
  };
}

function synthetic(critical: number, severe: number, moderate: number, name: string): Vulnerability[] {
  const entry = (id: string, count: number, word: string, severity: string): Vulnerability => ({
    id: `iq-${id}-${name}`,
    summary: `${count} ${word} vulnerability(ies) detected by Sonatype IQ`,
    severity,
    cvss: null,
    aliases: [],
    remediation: { fixAvailable: false, fixedVersions: [], advice: 'Check Sonatype IQ Server for details.' },
    references: [],
  });
  const out: Vulnerability[] = [];
  if (critical > 0) out.push(entry('critical', critical, 'critical', 'CRITICAL'));
  if (severe > 0) out.push(entry('high', severe, 'severe', 'HIGH'));
  if (moderate > 0) out.push(entry('medium', moderate, 'moderate', 'MEDIUM'));
  return out;
}

const httpStatus = (err: unknown): number | undefined => {
  const status = err instanceof ToilError ? (err.details as { status?: unknown } | undefined)?.status : undefined;
  return typeof status === 'number' && (status < 200 || status >= 300) ? status : undefined;
};

/**
 * One evaluation request. A non-2xx answer keeps core's code and fix but
 * the contract's specified message (`Sonatype IQ Server returned HTTP 404`), with
 * the server's own words in details.
 */
async function call<T>(ctx: SonatypeIqContext, path: string, req: ApiRequest, message: (status: number) => string): Promise<T> {
  let data: T | undefined;
  try {
    data = await apiRequest<T | undefined>(sonatypeiqArea, ctx, path, { headers: { Accept: 'application/json' }, timeoutMs: TIMEOUT_MS, ...req });
  } catch (err) {
    const status = httpStatus(err);
    if (status === undefined || !(err instanceof ToilError)) throw err;
    throw new ToilError(err.code, message(status), { fix: err.fix, details: { ...(err.details as object), serverMessage: err.message } });
  }
  return bodyOf(data, path);
}

/** An empty answer failed to parse before, so it fails here too, rather than reading as "nothing found". */
function bodyOf<T>(data: T | undefined, path: string): T {
  if (data === undefined || data === null) {
    throw new ToilError('HTTP', `Sonatype IQ Server answered ${path} with an empty body.`, {
      fix: 'Check baseUrl points at IQ Server itself, then try again; report it if it keeps happening.',
    });
  }
  return data;
}

/**
 * The internal ID for a public ID. Suspected bug #91 item 4: any non-2xx
 * answer (401 and 403 included), or no match, silently returns the public ID
 * unchanged, so the evaluation that follows 404s instead.
 */
async function internalId(ctx: SonatypeIqContext, applicationId: string): Promise<string> {
  const path = `/api/v2/applications?publicId=${encodeURIComponent(applicationId)}`;
  let data: { applications?: Array<{ id: string }> } | undefined;
  try {
    data = await apiRequest(sonatypeiqArea, ctx, path, { headers: { Accept: 'application/json' }, timeoutMs: TIMEOUT_MS });
  } catch (err) {
    if (httpStatus(err) !== undefined) return applicationId;
    throw err;
  }
  return bodyOf(data, path).applications?.[0]?.id ?? applicationId;
}

/**
 * Where to poll. A URL starting with `http` is taken whole and
 * anything else is glued onto the base URL as text, so IQ's slash-less
 * relative form loses its separator (suspected bug #91 item 3). Then a
 * URL on another host is re-pointed at the connection's, so the
 * credential never leaves it (#91 item 1).
 */
export function resultsLocation(ctx: SonatypeIqContext, resultsUrl: string): string {
  const base = ctx.connection.baseUrl;
  const raw = resultsUrl.startsWith('http') ? resultsUrl : `${base.replace(/\/$/, '')}${resultsUrl}`;
  return repointUrl(raw, base, ctx.warn, {
    service: 'Sonatype IQ Server',
    subject: 'evaluation results',
    code: 'SONATYPEIQ_RESULTS_HOST',
    fix: 'Check the IQ Server version and report the resultsUrl it returned, with the command you ran.',
  });
}

/**
 * Up to ten polls of `resultsUrl` until `isQueued` is false: the first at
 * once, then after 2 s, 4 s, 6 s and so on. Any non-2xx answer fails the
 * command (IQ's documented "not ready" 404 included, #91 item 3), and the
 * tenth queued answer ends it with the contract's specified timeout message.
 */
async function pollResults(ctx: SonatypeIqContext, resultsUrl: string): Promise<IqEvaluationResponse> {
  const url = resultsLocation(ctx, resultsUrl);
  return poll<IqEvaluationResponse>(
    async (attempt) => {
      const data = await call<IqEvaluationResponse>(ctx, url, {}, (status) => `Sonatype IQ Server returned ${statusLine(status)} polling results`);
      if (!data.isQueued) return data;
      if (attempt >= MAX_POLL_ATTEMPTS) {
        throw new ToilError('TIMEOUT', 'Sonatype IQ Server evaluation timed out waiting for results.', {
          fix: 'The evaluation may still finish in IQ Server. Check it there, or run the command again later.',
          details: { attempts: attempt, resultsUrl: url },
        });
      }
      return undefined;
    },
    { what: 'Sonatype IQ evaluation', deadlineMs: TIME_LIMIT_MS, intervalMs: POLL_INTERVAL_MS, maxIntervalMs: POLL_INTERVAL_MS * (MAX_POLL_ATTEMPTS - 1), backoff: 'linear', signal: ctx.signal },
  );
}

/** One batch's findings, and whether IQ's answer had a components list to read them from. */
async function evaluateBatch(ctx: SonatypeIqContext, chunk: InventoryPackage[], applicationId: string): Promise<{ vulnerable: VulnerablePackage[]; read: boolean }> {
  const purls = chunk.map(toPurl);
  let data = await call<IqEvaluationResponse>(
    ctx,
    `/api/v2/evaluation/applications/${encodeURIComponent(applicationId)}`,
    { method: 'POST', json: { components: purls.map((p) => ({ packageUrl: p })) } },
    (status) => `Sonatype IQ Server returned ${statusLine(status)}`,
  );
  if (data.isQueued && data.resultsUrl) data = await pollResults(ctx, data.resultsUrl);

  const byPurl = new Map<string, InventoryPackage>();
  purls.forEach((purl, i) => byPurl.set(purl, chunk[i]!));

  const vulnerable: VulnerablePackage[] = [];
  for (const result of data.components ?? []) {
    if (!result?.component?.packageUrl) continue;
    const pkg = byPurl.get(result.component.packageUrl);
    if (!pkg) {
      // Suspected bug #91 item 27: a result whose purl IQ normalised is dropped; now with a warning.
      ctx.warn({ code: 'SONATYPEIQ_UNMATCHED_RESULT', message: `Sonatype IQ Server returned a result for ${result.component.packageUrl}, which matches no package sent; it was left out.` });
      continue;
    }
    const critical = result.criticalVulnerabilityCount ?? 0;
    const severe = result.severeVulnerabilityCount ?? 0;
    const moderate = result.moderateVulnerabilityCount ?? 0;
    const security = (result.policyData?.policyViolations ?? []).filter((v) => v.policyThreatCategory === 'SECURITY');
    if (security.length === 0 && critical + severe + moderate === 0) continue;
    vulnerable.push({ ...pkg, vulnerabilities: security.length > 0 ? security.map(mapViolation) : synthetic(critical, severe, moderate, pkg.name) });
  }
  return { vulnerable, read: Array.isArray(data.components) };
}

export const evaluateCommand = sonatypeiqArea.command({
  path: ['sonatypeiq', 'evaluate'],
  description: 'Evaluate a dependency inventory against a Sonatype IQ Server application\'s policies',
  toolDescription:
    "Sonatype IQ policy evaluation of an inventory from toil deps scan, against one application (applicationId is its public ID; see sonatypeiq_application_list). Returns { tier, source, sourcesQueried, sourceErrors, scanned, vulnerable, packages: [{ name, version, ecosystem, ..., vulnerabilities }] }. Only SECURITY policy violations count.",
  input: z.object({
    inputFile: z.string().optional().describe(FROM_DESCRIPTION),
    applicationId: z.string().optional().describe('Sonatype IQ Server application public ID (required)'),
    ecosystem: z.string().optional().describe('Filter to one ecosystem: npm, nuget, maven, all (default: "all")'),
    directOnly: z.boolean().optional().describe('Only scan direct dependencies (default: include transitive) (default: false)'),
    includeDev: z.boolean().optional().describe('Include dev/test dependencies (default: false)'),
  }),
  writes: false,
  // The evaluation is a POST, but it reads: it changes no policy, waiver or application.
  queryByPost: true,
  timeLimitMs: TIME_LIMIT_MS,
  options: [
    { flags: '--input-file <path>', field: 'inputFile', description: FROM_DESCRIPTION, deprecated: ['--from <file>'] },
    { flags: '--application-id <id>', field: 'applicationId', description: 'Sonatype IQ Server application public ID (required)' },
    { flags: '--ecosystem <ecosystem>', field: 'ecosystem', description: 'Filter to one ecosystem: npm, nuget, maven, all (default: "all")' },
    { flags: '--direct-only', field: 'directOnly', description: 'Only scan direct dependencies (default: include transitive) (default: false)' },
    { flags: '--include-dev', field: 'includeDev', description: 'Include dev/test dependencies (default: false)' },
  ],
  examples: [
    { inputFile: 'inventory.json', applicationId: 'imagile-api' },
    { inputFile: 'inventory.json', applicationId: 'imagile-api', ecosystem: 'npm', directOnly: true, includeDev: true },
  ],
  run: async (input, ctx) => {
    if (!input.applicationId) {
      throw new ToilError('INVALID_INPUT', "deps frisk --source sonatypeiq requires --application-id <id>. Use 'toil sonatypeiq application list' to find application IDs.", {
        fix: 'Pass --application-id <public ID>; toil sonatypeiq application list shows each application\'s publicId.',
      });
    }
    const packages = selected(await readInventory(ctx, input.inputFile), input.ecosystem, input.directOnly === true, input.includeDev === true);
    // tier used to come from pinging OSV.dev and Artifactory; this command asks only IQ.
    const result = { tier: 'full', source: 'sonatypeiq', sourcesQueried: ['sonatypeiq'], sourceErrors: [] as Array<{ source: string; error: string }> };
    if (packages.length === 0) return { ...result, scanned: 0, vulnerable: 0, packages: [] };

    const id = await internalId(ctx, input.applicationId);
    const vulnerable: VulnerablePackage[] = [];
    let unread = 0;
    for (let i = 0; i < packages.length; i += BATCH_SIZE) {
      const batch = await evaluateBatch(ctx, packages.slice(i, i + BATCH_SIZE), id);
      vulnerable.push(...batch.vulnerable);
      if (!batch.read) unread++;
    }
    if (unread > 0) {
      ctx.warn({
        code: 'SONATYPEIQ_NO_COMPONENTS',
        message: `Sonatype IQ Server's evaluation answer had no components list for ${unread} of ${Math.ceil(packages.length / BATCH_SIZE)} batch(es), so no findings were read from them. IQ's documented answer has another shape; this result may undercount (suspected bug #91 item 2).`,
      });
    }
    return { ...result, scanned: packages.length, vulnerable: vulnerable.length, packages: vulnerable };
  },
});

export const evaluateCommands = [evaluateCommand];
