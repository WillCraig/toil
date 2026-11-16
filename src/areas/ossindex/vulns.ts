import { z } from 'zod';
import { apiResponse, type ApiContext } from '../../core/api.js';
import { ToilError } from '../../core/errors.js';
import { statusLine } from '../../core/rest.js';
import type { InventoryPackage } from '../../core/inventory.js';
import { friskData, inventoryFields, inventoryOptions, readInventory, REQUEST_TIMEOUT_MS, selectPackages, TIME_LIMIT_MS, type Vulnerability, type VulnerablePackage } from '../osv/inventory.js';
import { statusOf } from '../osv/public-api.js';
import { OSSINDEX_URL, ossindexArea } from './area.js';

/**
 * `toil ossindex vulns`: an inventory's packages as package URLs against OSS
 * Index's component report, 128 a request (its stated limit), one request
 * after another, reports matched back by their `coordinates` string. It behaves
 * as the contract specifies for `deps frisk --source sonatype`, with one declared fix:
 * OSS Index refuses anonymous requests, so the connection's username and
 * token go as Basic auth, and a rejected one is AUTH rather than "not
 * reachable" (#91 item 7, confirmed live). Kept, and pinned: a report whose
 * coordinates come back normalised matches no package and is dropped (#91
 * item 26). The component is reported missing from the report, which is the
 * report's fault, per the report.
 */

const BATCH_SIZE = 128;
const PATH = 'api/v3/component-report';
const COMPONENT_REPORT = `${OSSINDEX_URL}/${PATH}`;
const HEADERS = { Accept: 'application/json' };

type OssIndexContext = ApiContext;

/** The component-report POST, through the area's hook: credentials only to ossindex.sonatype.org. */
const post = <T>(ctx: OssIndexContext, coordinates: string[], extra: { accept?: number[]; text?: boolean } = {}) =>
  apiResponse<T>(ossindexArea, ctx, PATH, { method: 'POST', json: { coordinates }, headers: HEADERS, timeoutMs: REQUEST_TIMEOUT_MS, retryRateLimit: false, ...(extra.accept ? { accept: extra.accept } : {}), ...(extra.text ? { as: 'text' as const } : {}) });

interface OssIndexVuln {
  id: string;
  displayName: string;
  title: string;
  description: string;
  cvssScore: number;
  cvssVector?: string;
  cwe?: string;
  reference: string;
  externalReferences?: string[];
}

interface ComponentReport {
  coordinates: string;
  description?: string;
  reference: string;
  vulnerabilities: OssIndexVuln[];
}

/** A package URL: a scope's `@` encoded for npm, Maven's `group:artifact` as `group/artifact`. */
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

function severityFromCvss(score: number): string {
  if (score >= 9.0) return 'CRITICAL';
  if (score >= 7.0) return 'HIGH';
  if (score >= 4.0) return 'MEDIUM';
  if (score > 0) return 'LOW';
  return 'UNKNOWN';
}

/** OSS Index has no fixed versions, so the advice points at the reference; CVE ids are scraped from the name, title and description. */
function mapVuln(v: OssIndexVuln, pkg: InventoryPackage): Vulnerability {
  const searchText = [v.displayName, v.title, v.description].filter(Boolean).join(' ');
  const aliases = [...new Set([...searchText.matchAll(/CVE-\d{4}-\d+/gi)].map((m) => m[0].toUpperCase()))];
  return {
    id: v.displayName || v.id,
    summary: v.title || v.description,
    severity: severityFromCvss(v.cvssScore),
    cvss: v.cvssScore > 0 ? v.cvssScore : null,
    aliases,
    remediation: { fixAvailable: false, fixedVersions: [], advice: `See ${v.reference} for remediation details for ${pkg.name}@${pkg.version}.` },
    references: [v.reference, ...(v.externalReferences ?? [])].filter(Boolean),
  };
}

async function queryBatch(ctx: OssIndexContext, chunk: InventoryPackage[]): Promise<VulnerablePackage[]> {
  const purls = chunk.map(toPurl);
  let reports: ComponentReport[];
  try {
    reports = (await post<ComponentReport[]>(ctx, purls)).data;
  } catch (err) {
    const status = statusOf(err);
    // A rejected credential is core's AUTH, with the fix that says where the token lives.
    if (!(err instanceof ToilError) || status === undefined || err.code === 'AUTH') throw err;
    if (status === 429) {
      // The contract's specified message, word for word; toil sends credentials, so its advice holds.
      throw new ToilError(
        'HTTP',
        'Sonatype OSS Index is rate-limiting requests from this IP. Create a free account at ossindex.sonatype.org and add your credentials to your toil config to raise the limit.',
        { fix: 'Wait a while and try again with fewer packages. The limit is per account; check the username and token are your own.', details: err.details },
      );
    }
    throw new ToilError(err.code, `Sonatype OSS Index returned ${statusLine(status)}`, { fix: err.fix ?? `Try again later; check ${OSSINDEX_URL} is up.`, details: { ...(err.details as object), message: err.message } });
  }
  // The contract specifies a failure on anything but a list; toil fails, in words.
  if (!Array.isArray(reports)) {
    throw new ToilError('HTTP', `Sonatype OSS Index answered ${COMPONENT_REPORT} with something other than a list of reports.`, { fix: `Try again later; check ${OSSINDEX_URL} is up.`, details: { url: COMPONENT_REPORT } });
  }
  const byPurl = new Map(purls.map((purl, i) => [purl, chunk[i]!]));
  const vulnerable: VulnerablePackage[] = [];
  for (const report of reports) {
    if (!report?.coordinates) continue;
    // An exact match only: coordinates OSS Index normalised match nothing and the package is dropped.
    const pkg = byPurl.get(report.coordinates);
    if (!pkg) continue;
    const vulns = report.vulnerabilities ?? [];
    if (vulns.length === 0) continue;
    vulnerable.push({ ...pkg, vulnerabilities: vulns.map((v) => mapVuln(v, pkg)) });
  }
  return vulnerable;
}

/**
 * The check the contract specifies before every run: an empty list of
 * coordinates, where a 2xx or a 400 means it's up. A rejected credential is
 * AUTH with its fix (the declared fix); anything else is "not reachable".
 */
async function requireReachable(ctx: OssIndexContext): Promise<void> {
  try {
    await post<string>(ctx, [], { accept: [400], text: true });
  } catch (err) {
    if (ctx.signal.aborted || (err instanceof ToilError && err.code === 'AUTH')) throw err;
    const status = statusOf(err);
    throw new ToilError('NETWORK', 'toil ossindex vulns requires Sonatype OSS Index access but ossindex.sonatype.org is not reachable from this machine.', {
      fix: `Check this machine can reach ${OSSINDEX_URL} (VPN, proxy, DNS); toil uses HTTPS_PROXY, HTTP_PROXY and NO_PROXY when they're set. Run with --verbose to see the request.`,
      details: { status: 503, url: COMPONENT_REPORT, cause: status !== undefined ? statusLine(status) : err instanceof Error ? err.message : String(err) },
    });
  }
}

export const vulnsCommand = ossindexArea.command({
  path: ['ossindex', 'vulns'],
  description: 'Check a dependency inventory for known vulnerabilities in Sonatype OSS Index (needs a free account)',
  toolDescription:
    "Known vulnerabilities from the Sonatype OSS Index API, using the connection's free account, for the packages in an inventory: a JSON list of { name, version, ecosystem } (npm, nuget or maven), in a file passed as inputFile. Returns { tier, source, sourcesQueried, sourceErrors, scanned, vulnerable, packages[] }, each package with vulnerabilities[] of { id, summary, severity, cvss, aliases, remediation, references }; OSS Index gives no fixed versions. For OSV.dev use osv_vulns.",
  input: z.object(inventoryFields),
  writes: false,
  // A batch report request whose body can hold 128 package URLs: a read, sent as POST.
  queryByPost: true,
  timeLimitMs: TIME_LIMIT_MS,
  options: inventoryOptions,
  examples: [{ inputFile: 'inventory.json' }, { inputFile: 'inventory.json', ecosystem: 'maven', directOnly: true, includeDev: true }],
  run: async (input, ctx) => {
    const packages = selectPackages(await readInventory(ctx, input.inputFile, 'ossindex vulns'), input);
    await requireReachable(ctx);
    if (packages.length === 0) return friskData('sonatype', 0, []);
    const vulnerable: VulnerablePackage[] = [];
    for (let i = 0; i < packages.length; i += BATCH_SIZE) vulnerable.push(...(await queryBatch(ctx, packages.slice(i, i + BATCH_SIZE))));
    return friskData('sonatype', packages.length, vulnerable);
  },
});
