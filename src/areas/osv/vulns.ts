import { z } from 'zod';
import { ToilError } from '../../core/errors.js';
import { statusLine } from '../../core/rest.js';
import { OSV_URL, osvArea } from './area.js';
import type { InventoryPackage } from '../../core/inventory.js';
import { friskData, inventoryFields, inventoryOptions, readInventory, selectPackages, TIME_LIMIT_MS, type Vulnerability, type VulnerablePackage } from './inventory.js';
import { probe, requestJson, statusOf, type PublicContext } from './public-api.js';
import { apiPath } from '../../core/api-path.js';

/**
 * `toil osv vulns`: an inventory's packages against OSV.dev's batch query,
 * 500 queries a request, one request after another, results matched back to
 * packages by position. querybatch answers with vulnerability ids only, so
 * each distinct id's full record is then fetched from `/v1/vulns/{id}`, eight
 * at a time. The contract records no such fetch, so every finding comes back
 * empty there (#91 item 5, confirmed against the live API, a declared fix). The
 * rest behaves as the contract specifies for `deps frisk --source osv`, bugs
 * included (#91 item 6). A finding arrives with its paperwork attached, which is more than
 * most findings get.
 */

const BATCH_SIZE = 500;
const SERVICE = 'OSV.dev';
const QUERYBATCH = `${OSV_URL}/v1/querybatch`;
/** Full records fetched at once: enough to be quick, few enough to be polite to a free public API. */
const RECORD_CONCURRENCY = 8;

const OSV_ECOSYSTEM: Record<string, string> = { npm: 'npm', nuget: 'NuGet', maven: 'Maven' };

interface OsvRange {
  type: string;
  events?: Array<{ introduced?: string; fixed?: string; last_affected?: string }>;
}

interface OsvRawVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  references?: Array<{ url?: string }>;
  affected?: Array<{ package?: { name: string; ecosystem: string }; ranges?: OsvRange[] }>;
  severity?: Array<{ type: string; score: string }>;
  database_specific?: Record<string, unknown>;
}

interface OsvBatchResponse {
  results: Array<{ vulns?: OsvRawVuln[] }>;
}

/** Fixed versions from every affected entry's SEMVER and ECOSYSTEM ranges, whichever package they're for (#91 item 6). */
function remediation(vuln: OsvRawVuln, pkg: InventoryPackage): Vulnerability['remediation'] {
  const fixed: string[] = [];
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      if (range.type !== 'SEMVER' && range.type !== 'ECOSYSTEM') continue;
      for (const event of range.events ?? []) if (event.fixed) fixed.push(event.fixed);
    }
  }
  const fixedVersions = [...new Set(fixed)];
  const fixAvailable = fixedVersions.length > 0;
  const advice = fixAvailable ? `Upgrade ${pkg.name} to ${fixedVersions.join(' or ')}` : `No fix available yet for ${pkg.name}. Monitor ${vuln.id} for updates.`;
  return { fixAvailable, fixedVersions, advice };
}

function severityFromCvss(cvss: number | null): string {
  if (cvss === null) return 'UNKNOWN';
  if (cvss >= 9.0) return 'CRITICAL';
  if (cvss >= 7.0) return 'HIGH';
  if (cvss >= 4.0) return 'MEDIUM';
  return 'LOW';
}

/**
 * `database_specific.severity` as given (GHSA's MODERATE included), else from
 * a numeric CVSS. OSV's `severity[].score` is a vector string, which
 * parseFloat never reads, so only `database_specific.cvss` ever supplies one
 * (#91 item 6).
 */
function severity(vuln: OsvRawVuln): { severity: string; cvss: number | null } {
  const db = vuln.database_specific ?? {};
  const dbSeverity = typeof db.severity === 'string' ? db.severity : undefined;
  let cvss: number | null = null;
  const raw = db.cvss;
  if (typeof raw === 'number') cvss = raw;
  else if (raw && typeof raw === 'object' && 'score' in raw && typeof (raw as Record<string, unknown>).score === 'number') cvss = (raw as { score: number }).score;
  for (const s of vuln.severity ?? []) {
    const score = parseFloat(s.score);
    if (!isNaN(score) && score >= 0 && score <= 10) {
      cvss = score;
      break;
    }
  }
  return { severity: dbSeverity ?? severityFromCvss(cvss), cvss };
}

function mapVuln(vuln: OsvRawVuln, pkg: InventoryPackage): Vulnerability {
  return {
    id: vuln.id,
    summary: vuln.summary ?? '',
    ...severity(vuln),
    aliases: vuln.aliases ?? [],
    remediation: remediation(vuln, pkg),
    references: (vuln.references ?? []).map((r) => r.url ?? '').filter(Boolean),
  };
}

/** One querybatch call: each package with the vulnerability ids OSV listed for it. `next_page_token` is never read, so a query past OSV's page of results is cut short (#91 item 5). */
async function queryBatch(ctx: PublicContext, chunk: InventoryPackage[]): Promise<Array<{ pkg: InventoryPackage; ids: string[] }>> {
  const queries = chunk.map((pkg) => ({ package: { name: pkg.name, ecosystem: OSV_ECOSYSTEM[pkg.ecosystem] ?? pkg.ecosystem }, version: pkg.version }));
  let data: OsvBatchResponse;
  try {
    data = (await requestJson<OsvBatchResponse>(ctx, { service: SERVICE, url: QUERYBATCH, body: { queries } })).data;
  } catch (err) {
    throw oldWording(err, '');
  }
  const results = data?.results;
  // The contract specifies reading data.results.length, failing on an answer without one; toil fails, in words.
  if (!Array.isArray(results)) {
    throw new ToilError('HTTP', `OSV.dev answered ${QUERYBATCH} without a results list.`, { fix: `Try again later; check ${OSV_URL} is up.`, details: { url: QUERYBATCH } });
  }
  const found: Array<{ pkg: InventoryPackage; ids: string[] }> = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const pkg = chunk[i];
    if (!result || !pkg) continue;
    const ids = (result.vulns ?? []).map((v) => v.id);
    if (ids.length > 0) found.push({ pkg, ids });
  }
  return found;
}

/** "OSV.dev returned HTTP <status>", the contract's specified wording, with core's code and fix; anything without a status passes through. */
function oldWording(err: unknown, suffix: string): unknown {
  const status = statusOf(err);
  if (!(err instanceof ToilError) || status === undefined) return err;
  return new ToilError(err.code, `OSV.dev returned ${statusLine(status)}${suffix}`, { fix: err.fix ?? `Try again later; check ${OSV_URL} is up.`, details: { ...(err.details as object), message: err.message } });
}

/** Every distinct id's full record, RECORD_CONCURRENCY at a time. One that can't be fetched fails the command, naming the id. */
async function fetchRecords(ctx: PublicContext, ids: string[]): Promise<Map<string, OsvRawVuln>> {
  const records = new Map<string, OsvRawVuln>();
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (next < ids.length && !failed) {
      const id = ids[next++]!;
      const url = `${OSV_URL}${apiPath`/v1/vulns/${id}`}`;
      try {
        const { data } = await requestJson<OsvRawVuln>(ctx, { service: SERVICE, url });
        records.set(id, { ...data, id: typeof data?.id === 'string' ? data.id : id });
      } catch (err) {
        failed = true;
        throw oldWording(err, ` for ${id}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(RECORD_CONCURRENCY, ids.length) }, worker));
  return records;
}

export const vulnsCommand = osvArea.command({
  path: ['osv', 'vulns'],
  // No connection: a public API the command names. It works with no config at all.
  kind: 'area-local',
  description: 'Check a dependency inventory for known vulnerabilities in OSV.dev (public API, no credential)',
  toolDescription:
    'Known vulnerabilities from the public OSV.dev API for the packages in an inventory: a JSON list of { name, version, ecosystem } (npm, nuget or maven), in a file passed as inputFile. Returns { tier, source, sourcesQueried, sourceErrors, scanned, vulnerable, packages[] }, each package with vulnerabilities[] of { id, summary, severity, cvss, aliases, remediation, references }. Each finding is filled from its full OSV record. For Sonatype OSS Index use ossindex_vulns.',
  input: z.object(inventoryFields),
  writes: false,
  // A batch query whose body can hold 500 packages: a read, sent as POST.
  queryByPost: true,
  timeLimitMs: TIME_LIMIT_MS,
  options: inventoryOptions,
  examples: [{ inputFile: 'inventory.json' }, { inputFile: 'inventory.json', ecosystem: 'npm', directOnly: true, includeDev: true }],
  run: async (input, ctx) => {
    const packages = selectPackages(await readInventory(ctx, input.inputFile, 'osv vulns'), input);
    const up = await probe(ctx, { service: SERVICE, url: QUERYBATCH, body: { queries: [] } });
    if (!up.reachable) {
      throw new ToilError('NETWORK', 'toil osv vulns requires OSV.dev access but api.osv.dev is not reachable from this machine.', {
        fix: `Check this machine can reach ${OSV_URL} (VPN, proxy, DNS); toil uses HTTPS_PROXY, HTTP_PROXY and NO_PROXY when they're set. Run with --verbose to see the request.`,
        details: { status: 503, url: QUERYBATCH, cause: up.reason },
      });
    }
    if (packages.length === 0) return friskData('osv', 0, []);
    const found: Array<{ pkg: InventoryPackage; ids: string[] }> = [];
    for (let i = 0; i < packages.length; i += BATCH_SIZE) found.push(...(await queryBatch(ctx, packages.slice(i, i + BATCH_SIZE))));
    const records = await fetchRecords(ctx, [...new Set(found.flatMap((f) => f.ids))]);
    const vulnerable: VulnerablePackage[] = found.map(({ pkg, ids }) => ({ ...pkg, vulnerabilities: ids.map((id) => mapVuln(records.get(id)!, pkg)) }));
    return friskData('osv', packages.length, vulnerable);
  },
});
