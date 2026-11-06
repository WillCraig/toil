// The lockfile check (#299): `npm run check:lockfile -w ui`, after
// `npm ci --ignore-scripts`. It fails when package-lock.json would install a
// toil for Toil UI other than the one ui/package.json pins: the entry's
// version, its tarball URL, and the version of the copy npm actually
// installed must all be the pin (scripts/package-rules.mjs, lockfileProblems).
// CI runs it on every PR, the release PR included. A release leaves one state
// that passes with a warning instead: the pin is the new toil, the entry's
// tarball is the previous one's, and that toil is what npm ci installed, until
// the lockfile PR the release workflow opens once it has published (release.yml,
// the lockfile job) is merged. Repo tooling only.
// Three signatures on one form, checked against each other for once.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { lockfileLag, lockfileProblems } from './package-rules.mjs';

const ui = join(import.meta.dirname, '..');
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const pin = read(join(ui, 'package.json')).dependencies['@imagile-dev/toil'];
const lock = read(join(ui, '..', 'package-lock.json'));
let installed = null;
try {
  installed = read(join(ui, '..', 'node_modules', '@imagile-dev', 'toil', 'package.json')).version;
} catch {
  // Not installed: lockfileProblems says so.
}
const problems = lockfileProblems(lock, pin, installed);
if (problems.length) {
  console.error(`check:lockfile found ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
const lag = lockfileLag(lock, pin, installed);
if (lag !== null) {
  // On Actions the prefix puts it on the run's summary, not only in its log.
  console.warn(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}check:lockfile WARNING: package-lock.json still installs @imagile-dev/toil ${lag} for Toil UI, which pins ${pin}. That is what a release leaves until its lockfile PR merges ("chore(deps): install toil ${pin} for Toil UI"); merge it, or run npm install --package-lock-only --ignore-scripts @imagile-dev/toil@${pin} -w ui --save-exact at the root once npm serves ${pin}, then npm ci --ignore-scripts, and commit package-lock.json.`);
  process.exit(0);
}
console.log(`check:lockfile ok: package-lock.json installs @imagile-dev/toil ${pin} for Toil UI, the version it pins, and npm ci installed exactly that.`);
