// Decides whether a pull request needs CI's long jobs: Toil UI's gate (most of an
// hour, for its layout check over every view and theme) and the database
// integration job. A PR whose every changed file is on the list below skips
// them; toil's own gate still runs on every PR, so the suites that hold docs to
// code (bounds, the contract, hygiene, the skill) still check it. The
// maintainer's call, 2026-11-16.
//
//   node ci-scope.mjs <file of NUL-separated paths>   prints full=true or full=false
//
// .github/workflows/ci.yml runs main's copy of this file, never the PR's, so a
// PR can't widen the list for itself. Anything unexpected (no list, an empty
// list, an unreadable file) answers full=true: skipping is the one outcome that
// has to be earned, and waiting an hour for a green tick never hurt anyone.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Paths neither job reads. Keep each entry narrow and say why it's safe: a file
// either job reads must never match (Toil UI reads src/, skills/, docs/owi/,
// docs/work-insights-proposal.md, site/src/lib/, the root CHANGELOG.md and its
// own folder; the database job reads src/ and test/). Elsewhere in docs/ only the
// two folders below: other docs are read by tests, and new ones appear.
const SKIPPABLE = [
  /^docs\/decisions\/[^/]+\.md$/, // one file per PR; code cites them only in comments
  /^docs\/briefs\/[^/]+\.md$/, // integration briefs
  /^\.claude\//, // repo-internal skills and settings
  /^CLAUDE\.md$/,
  /^AGENT_DECISIONS\.md$/,
  /^\.github\/dependabot\.yml$/,
  /^functions\//, // the feedback function, its own package
  /^infra\//, // its Bicep
  /^site\/(?!src\/lib\/)/, // the site, which Pages builds; Toil UI imports site/src/lib/
];

/** True when a PR changing these paths needs the long jobs. */
export function needsFullRun(paths) {
  if (paths.length === 0) return true;
  return paths.some((p) => !SKIPPABLE.some((rule) => rule.test(p)));
}

/** The paths that keep the long jobs on, for the log. */
export function keptBy(paths) {
  return paths.filter((p) => !SKIPPABLE.some((rule) => rule.test(p)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  let paths = null;
  try {
    paths = readFileSync(process.argv[2], 'utf8').split('\0').filter(Boolean);
  } catch (err) {
    console.error(`Couldn't read the changed paths (${err.message}); running everything.`);
  }
  const full = paths === null || needsFullRun(paths);
  if (paths !== null) {
    const kept = keptBy(paths);
    console.error(full
      // Each path quoted, so a name with a newline in it can't start a line the runner reads as a command.
      ? `Running everything: ${paths.length === 0 ? 'no changed paths were listed' : `${kept.length} of ${paths.length} changed paths are outside the docs-and-config list, such as ${kept.slice(0, 5).map((p) => JSON.stringify(p)).join(', ')}`}.`
      : `Skipping Toil UI's gate and the database job: all ${paths.length} changed paths are docs or config.`);
  }
  console.log(`full=${full}`);
}
