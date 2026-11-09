/**
 * The oldest patched release on each Node line toil runs on, kept in step with
 * "engines" in package.json (`^24.22.1 || >=26.12.1`).
 *
 * 24.14 was the floor first: it's the first release where the OS certificate
 * store and the proxy env vars can be switched on from code
 * (`src/core/network.ts`). The floor now also has to be a release patched for
 * CVE-2026-111497, the Brotli decoder's out-of-bounds write (#479): Node's
 * fetch() Brotli-decodes any response marked `Content-Encoding: br`, so every
 * host toil talks to could reach it. 24.22.1 and 26.12.1 fix it; Node 25 gets
 * no fix, so it's flagged outright, and a line newer than the last one listed
 * here is allowed.
 *
 * npm only warns about "engines", so the CLI checks for itself and warns on every run,
 * the way a form notes the applicant is ineligible and processes it regardless.
 */
export const PATCHED_NODE = ['24.22.1', '26.12.1'] as const;

/** The lowest Node toil accepts, the first entry of PATCHED_NODE. */
export const MIN_NODE = PATCHED_NODE[0];

/** The CVE the floor answers, named in the refusal so the reason is on screen (principle 4). */
export const NODE_CVE = 'CVE-2026-111497';

const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);

/** True when `a` is older than `b`, both `24.22.1`-shaped. */
function older(a: number[], b: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/**
 * True when `version` gets the warning (`24.22.0`, with or without a `v`): older
 * than its line's patched release, on a line between the listed ones with no
 * patched release (25), or older than the lowest line.
 */
export function nodeRefused(version: string, patched: readonly string[] = PATCHED_NODE): boolean {
  const have = parse(version);
  const floors = patched.map(parse);
  const sameLine = floors.find((f) => f[0] === have[0]);
  if (sameLine) return older(have, sameLine);
  const newest = floors[floors.length - 1] ?? [0];
  return (have[0] ?? 0) < (newest[0] ?? 0);
}

/**
 * The warning toil prints, in capitals, on a Node it would not choose to run on, or
 * undefined when the Node is patched. It used to refuse outright; the maintainer
 * loosened that (2026-11-09): toil runs, and says on every call, loudly, why it
 * shouldn't. The reason stays on screen (principle 4); the decision is the user's.
 */
export function nodeWarning(version: string): string | undefined {
  if (!nodeRefused(version)) return undefined;
  const [line24, line26] = PATCHED_NODE;
  return `WARNING: THIS NODE (${version.replace(/^v/, '')}) HAS A KNOWN REMOTE CODE EXECUTION, ${NODE_CVE}, IN ITS BROTLI DECODER, REACHABLE FROM EVERY HOST TOIL TALKS TO. toil is running anyway. Install Node ${line24} or later on 24.x, or ${line26} or later (nodejs.org, or your organization's approved channel). Node 25 gets no fix.`;
}

/** The same warning as a banner for stderr, which keeps stdout to the one JSON envelope. */
export function nodeBanner(version: string): string | undefined {
  const text = nodeWarning(version);
  if (!text) return undefined;
  const bar = '!'.repeat(78);
  return `${bar}
${text}
${bar}
`;
}
