// What a triage fix may touch, checked by .github/workflows/triage.yml from a
// fresh checkout after the agent has finished, before anything is pushed. The
// agent's own prompt says the same, but a prompt is a request; this is the rule.
//
// The maintainer's call (2026-10-28, superseding #487's narrower scope): triage
// may fix almost anything in the product, so the rule is a short list of what it
// may not, not a long list of what it may. Four kinds of path stay out of a fix:
//
//   Its own constraints (principle 2: agents never loosen the rules that bind
//   them). .github/**, scripts/**, CLAUDE.md, .claude/**, AGENT_DECISIONS.md,
//   docs/decisions/**, dist/**. Triage that could edit its own workflow could
//   edit its own cap.
//
//   Maintainer review first. site/** (the per-area data files the tests generate
//   or check, site/src/data/{integrations,commands,settings}/<area>.json, are
//   ordinary area files and stay fixable), functions/** and infra/**, the Azure
//   Function backend and what provisions it. Triage proposes these in a comment
//   and leaves the issue open (decision `maintainer`); it does not edit them.
//
//   What it mechanically cannot do. package.json and every lockfile, at any
//   depth: the agent has no npm, so it cannot resolve a dependency or check the
//   14-day age rule, and a hand-edited lockfile is a work of fiction.
//
//   Toil UI's tooling. ui/ is open (ui/src, ui/server, ui/test, ui/docs,
//   ui/themes) except ui/server/agents/install.ts, the one file that spawns,
//   and the rest of ui/: its package.json, build and lint configuration and
//   ui/scripts/, the verify and smoke tooling that gates it.
//
// What is left (src/, test/, docs/, skills/, ui/ as above, and README.md) is
// open: core, several areas at once, the skill, the tests. Any other file at the
// repository root, or in a dot-folder, is not a place triage works. Some of the
// open part is a safety layer, the code that decides what toil and Toil UI may
// run or reach. A fix may edit it; the scope doesn't stop that, it makes the
// edit impossible to miss: check() lists every one (isSafetyLayer below), and
// open-pr puts them at the top of the draft PR's description, where the
// maintainer reads first.
//
// Files only: no symlinks, no submodules, nothing outside the tree. A form that
// lists the permitted fields is the one kind of form toil approves of; a form
// that lists the forbidden ones is merely a Tuesday.
//
//   git diff --raw -z --no-renames <base> <head> | node scripts/triage/changes.mjs <area>...
//   → prints the areas changed (comma-separated, `-` when none) and exits 0,
//     or names every refused path and exits 1

import { pathToFileURL } from 'node:url';

const PER_AREA = [
  (a) => (p) => p.startsWith(`src/areas/${a}/`),
  (a) => (p) => p === `test/fixtures/${a}.fixture.ts`,
  (a) => (p) => p === `skills/toil/${a}.md`,
  (a) => (p) => p === `docs/divergences/${a}.json`,
  (a) => (p) => p === `site/src/data/integrations/${a}.json`,
  (a) => (p) => p === `site/src/data/commands/${a}.json`,
  (a) => (p) => p === `site/src/data/settings/${a}.json`,
];

const UI_FOLDERS = ['ui/src/', 'ui/server/', 'ui/test/', 'ui/docs/', 'ui/themes/'];
/** The one Toil UI server file that starts a process (`npm install` of an agent SDK, on a person's press). */
const UI_SPAWNER = 'ui/server/agents/install.ts';

/** Where a fix may go outside ui/ and the per-area site data, which have rules of their own. */
const OPEN_FOLDERS = ['src/', 'test/', 'docs/', 'skills/'];
/** The one file at the repository root a fix may edit. */
const OPEN_ROOT_FILES = new Set(['readme.md']);
/** Files at any depth that need npm to be right, which the agent doesn't have. */
const NEEDS_NPM = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
/** Triage's own rules and release output, refused whoever asks (principle 2). */
const OWN_RULES = ['.github/', 'scripts/', '.claude/', 'dist/', 'docs/decisions/'];
const OWN_RULE_FILES = new Set(['claude.md', 'agent_decisions.md']);
const MAINTAINER_FIRST = ['site/', 'functions/', 'infra/'];

/**
 * Toil's own safety layer: the files that decide what a command may write,
 * read, run, reach or keep. A triage fix may edit them (the maintainer's call,
 * 2026-10-28); every such edit is called out in the PR. src/core files are
 * listed by name, with their tests, so a new file is not flagged by accident
 * and a weakened test is not missed. src/os/, src/shims/ and src/mcp/ are
 * flagged by folder.
 */
export const CORE_SAFETY = [
  // The write gate, execute() and what a call resolves.
  'run', 'call-context', 'context', 'command', 'area', 'connection', 'deployments', 'toil-project', 'check-toil-project',
  // Secrets and the credential store.
  'keychain', 'secret-input', 'secret-shapes', 'prompt', 'token',
  // Files, local paths and git.
  'files', 'local-path', 'gitignore', 'git', 'git-repo', 'git-config', 'git-remote',
  // The network: which hosts, which credentials, which requests.
  'network', 'rest', 'api', 'api-path', 'http', 'passthrough', 'multipart', 'progress',
  // Limits, the audit log and config on disk.
  'bounds', 'audit', 'config', 'errors', 'envelope', 'shell-profile', 'runtime', 'renamed-areas',
  // The bounds' other enforcers: wait's cap and glob matching.
  'wait', 'wildmatch',
];
const CORE_SAFETY_FILES = new Set([
  ...CORE_SAFETY.flatMap((name) => [`src/core/${name}.ts`, `src/core/${name}.test.ts`]),
  'src/core/token-shapes.mjs', 'src/core/token-shapes.d.mts',
]);
export const SAFETY_ELSEWHERE_CORE = new Set([
  'src/api.ts', 'src/node-context.ts', 'src/program.ts', 'docs/bounds.md', 'test/bounds.test.ts',
  'src/core/time-limit.test.ts', 'src/welcome/rogue/save.ts', 'src/core/db/tls.ts',
  // The contract, and the suites that guard it, triage's own rules and the repository's hygiene.
  'docs/command-contract.json', 'docs/command-contract.md', 'test/contract.test.ts', 'test/triage.test.ts', 'test/triage-steps.test.ts',
  'test/workflow-wiring.test.ts', 'test/merge-only.test.ts', 'test/repo-hygiene.test.ts',
]);
export const SAFETY_CORE_FOLDERS = [
  'src/os/', 'src/shims/', 'src/mcp/', 'src/core/query/', 'src/connections/', 'src/skills/', 'src/setup/', 'src/feedback/', 'src/projects/',
  // The CLI-to-MCP parity suite and its shards: what keeps the two front doors 1:1.
  'test/parity/',
  // The shipped skill: every page ships to users' agents as instructions, and most say how a write gate works.
  'skills/toil/',
];

/**
 * Toil UI's safety layer: whatever decides what its server, its agent and
 * Settings may run or reach (the maintainer's call on #487). The whole of
 * ui/server/ is the trust boundary, so it is flagged by folder, not by a list
 * that goes stale when a file is added. Elsewhere: Settings' write allowlist, a
 * theme's theme.json (its `voice` is prompt text for Toil UI's agent), and the
 * suites that check Toil UI's own rules, which a weakening edit would most need seen.
 */
const SAFETY_ELSEWHERE_UI = new Set([
  'ui/src/config.ts', 'ui/test/server.test.ts', 'ui/test/registry.test.ts', 'ui/test/config.test.ts', 'ui/test/themes.test.ts',
  'ui/test/package.test.ts', 'ui/test/install.test.ts', 'ui/test/setup.ts', 'ui/test/harness.ts',
]);
// The same list folded to lowercase for the lookup; the list keeps real names so a test can find each file.
const SAFETY_ELSEWHERE_LOWER = new Set([...SAFETY_ELSEWHERE_CORE].map((path) => path.toLowerCase()));
export const isSafetyLayer = (original) => {
  // Compared lowercase: on Windows and macOS `Src/Core/Run.ts` is run.ts.
  const path = original.toLowerCase();
  return path.startsWith('ui/server/') || SAFETY_ELSEWHERE_UI.has(path) || /^ui\/themes\/[^/]+\/theme\.json$/.test(path)
    || CORE_SAFETY_FILES.has(path) || SAFETY_ELSEWHERE_LOWER.has(path) || SAFETY_CORE_FOLDERS.some((folder) => path.startsWith(folder));
};

const wellFormed = (path) => !(path.includes('\\') || path.split('/').some((part) => part === '..' || part === '.' || part === '') || path.startsWith('/'));
const basename = (path) => path.slice(path.lastIndexOf('/') + 1).toLowerCase();

/** Whether a path is one of Toil UI's own files that a triage fix may touch. */
export function isUi(path) {
  const lower = path.toLowerCase();
  return wellFormed(path) && lower !== UI_SPAWNER && !NEEDS_NPM.has(basename(path)) && UI_FOLDERS.some((folder) => lower.startsWith(folder));
}

/** The area a path belongs to, or undefined when it isn't one area's own file. */
export function areaOf(path, areas) {
  if (!wellFormed(path)) return undefined;
  return areas.find((area) => PER_AREA.some((rule) => rule(area)(path)));
}

/** Core or shared code: under src/ but not one area's own. */
const isCore = (path) => {
  const lower = path.toLowerCase();
  return lower.startsWith('src/') && !lower.startsWith('src/areas/');
};

/**
 * Why a path is out of bounds for a fix, or undefined when it is open. The
 * reason says which kind of out-of-bounds it is, so a maintainer reading the
 * log knows whether it was policy, review or plumbing.
 */
export function refusal(path, areas) {
  if (!wellFormed(path)) return 'not a plain path inside the repository';
  // Prefixes and file names are compared lowercase, so a differently cased path can't slip past on a case-insensitive disk.
  const lower = path.toLowerCase();
  if (OWN_RULE_FILES.has(lower) || OWN_RULES.some((folder) => lower.startsWith(folder))) return "triage's own rules and release output; agents never loosen the rules that constrain them";
  if (NEEDS_NPM.has(basename(path))) return 'needs npm (a dependency or lockfile); triage cannot run it, so a maintainer makes this change';
  if (areaOf(path, areas)) return undefined;
  if (MAINTAINER_FIRST.some((folder) => lower.startsWith(folder))) return 'the site and the Azure Function backend are for a maintainer to review first';
  if (lower.startsWith('ui/')) return isUi(path) ? undefined : "Toil UI's spawner, packaging and tooling";
  if (OPEN_FOLDERS.some((folder) => lower.startsWith(folder)) || OPEN_ROOT_FILES.has(lower)) return undefined;
  return 'not a place triage works';
}

/** Parses `git diff --raw -z` into { path, newMode } entries. */
export function parseRaw(raw) {
  const fields = raw.split('\0').filter((field, i, all) => field !== '' || i < all.length - 1);
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i];
    const path = fields[i + 1];
    if (!meta.startsWith(':')) throw new Error(`Unexpected git diff --raw output near ${JSON.stringify(meta.slice(0, 40))}.`);
    const [, newMode] = meta.slice(1).split(' ');
    entries.push({ path, newMode });
  }
  return entries;
}

/**
 * Checks a triage branch's changes: regular files only, none on the refused
 * lists. Reports the areas touched (for labels), whether Toil UI or core did,
 * and every safety-layer edit; there is no limit on how many areas.
 */
export function check(entries, areas) {
  const refused = [];
  const touched = new Set();
  let ui = false;
  let core = false;
  for (const { path, newMode } of entries) {
    const why = refusal(path, areas);
    if (why) refused.push(`${path} (${why})`);
    else if (newMode !== '100644' && newMode !== '100755' && newMode !== '000000') refused.push(`${path} (mode ${newMode}: only regular files)`);
    else {
      const area = areaOf(path, areas);
      if (area) touched.add(area);
      else if (path.toLowerCase().startsWith('ui/')) ui = true;
      else if (isCore(path)) core = true;
    }
  }
  if (entries.length === 0) refused.push('no changes');
  return { ok: refused.length === 0, areas: [...touched].sort(), ui, core, safety: entries.map((e) => e.path).filter((p) => isSafetyLayer(p)).sort(), refused };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const areas = process.argv.slice(2);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = check(parseRaw(Buffer.concat(chunks).toString('utf8')), areas);
  if (!result.ok) {
    console.error(`The triage branch changes files triage may not touch:\n${result.refused.map((r) => `  - ${r}`).join('\n')}`);
    process.exit(1);
  }
  console.log(result.areas.join(',') || '-');
}
