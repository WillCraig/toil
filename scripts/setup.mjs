// Sets up toil from a clone in one command, on Windows, macOS and Linux:
//
//   git clone https://github.com/imagile-dev/toil.git && cd toil && node scripts/setup.mjs
//
//   --skip-build   use the committed dist/toil.js (the last release) as it is:
//                  no npm install, no build
//   --no-alias     don't touch the shell profile
//   --profile <f>  the profile file setup alias edits, passed through to it
//                  (otherwise setup alias picks; PowerShell's $PROFILE is
//                  looked up only when setup alias asks for it)
//
// It checks Node, builds what's on this checkout (npm ci --ignore-scripts, then
// npm run build), adds the `toil` alias with `toil setup alias`, and prints
// `toil version`. Running it again is safe: the build is repeatable and the
// alias is updated in place.
//
// Repo tooling only. It spawns npm and node, so it lives in scripts/, which is
// neither in package.json `files` nor in the bundle check:pure inspects. npm
// runs as its own JS entry under this node, never through a shell, the way
// scripts/smoke.mjs runs it. Four onboarding steps, one command: the form has
// been pre-filled on your behalf.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The patched release on each Node line toil accepts, as src/core/runtime.ts
// has them (CVE-2026-111497, #479). Node 25 gets no fix; a newer line is allowed.
const PATCHED = [[24, 22, 1], [26, 12, 1]];
const NEED = 'Node.js 24.22.1 or later on 24.x, or 26.12.1 or later';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = join(root, 'dist', 'toil.js');
const args = process.argv.slice(2);

function fail(message, fix) {
  console.error(`\nsetup failed: ${message}`);
  if (fix) console.error(`Fix: ${fix}`);
  process.exit(1);
}

const profileAt = args.indexOf('--profile');
const profile = profileAt >= 0 ? args.splice(profileAt, 2)[1] : undefined;
if (profileAt >= 0 && !profile) fail('--profile needs a file.', 'Pass the profile to edit, for example --profile $PROFILE in PowerShell.');
const unknown = args.filter((a) => a !== '--skip-build' && a !== '--no-alias');
const skipBuild = args.includes('--skip-build');
const noAlias = args.includes('--no-alias');

if (unknown.length > 0) fail(`unknown option ${unknown.join(' ')}.`, 'Use --skip-build, --no-alias and --profile <file>, or none of them.');

// 1. Node.
const have = process.versions.node.split('.').map(Number);
const line = PATCHED.find((p) => p[0] === have[0]);
const refused = line ? have[1] < line[1] || (have[1] === line[1] && have[2] < line[2]) : have[0] < PATCHED[PATCHED.length - 1][0];
if (refused) {
  // Warns and carries on, as toil itself does (src/core/runtime.ts): the reason stays on screen, the decision is the user's.
  const bar = '!'.repeat(78);
  console.error(`${bar}
WARNING: THIS NODE (${process.versions.node}) HAS A KNOWN REMOTE CODE EXECUTION, CVE-2026-111497, IN ITS BROTLI DECODER. Setup is running anyway. Install ${NEED} from https://nodejs.org.
${bar}`);
}

// Runs npm with its output streamed. npm is npm.cmd on Windows, which only a shell
// runs, so this runs npm's own JS entry under this node instead. npm ships beside
// node: <dir>/node_modules/npm on Windows, <prefix>/lib/node_modules/npm elsewhere.
const npmCli =
  process.env.npm_execpath ??
  (process.platform === 'win32'
    ? join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    : join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));

function npm(npmArgs) {
  const label = `npm ${npmArgs.join(' ')}`;
  if (!existsSync(npmCli)) fail(`npm isn't where this node keeps it (${npmCli}).`, `Reinstall ${NEED} with its bundled npm, or set npm_execpath to npm's bin/npm-cli.js, then run node scripts/setup.mjs again.`);
  console.log(`\n> ${label}`);
  const result = spawnSync(process.execPath, [npmCli, ...npmArgs], { cwd: root, stdio: 'inherit' });
  if (result.error) fail(`${label} didn't start (${result.error.message}).`, `Check that ${npmCli} is npm's bin/npm-cli.js.`);
  if (result.status !== 0) fail(`${label} exited with code ${result.status}.`, 'Read the output above, fix what it names, and run node scripts/setup.mjs again.');
}

// Runs the bundle and returns its parsed envelope (stdout), or fails plainly.
function toil(toilArgs) {
  const result = spawnSync(process.execPath, [bundle, ...toilArgs], { cwd: root, encoding: 'utf8' });
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`node dist/toil.js ${toilArgs.join(' ')} printed no envelope.${result.stderr ? `\n${result.stderr.trim()}` : ''}`, 'Run node scripts/setup.mjs again without --skip-build to rebuild dist/toil.js.');
  }
}

// 2. Build.
if (skipBuild) {
  console.log('Skipping the build: using the committed dist/toil.js, the last released toil.');
} else {
  npm(['ci', '--ignore-scripts']);
  npm(['run', 'build']);
}
if (!existsSync(bundle)) fail('dist/toil.js is missing.', 'Run this from a clone of https://github.com/imagile-dev/toil, without --skip-build.');

// 3. Alias. `setup alias` picks the shell itself (SHELL, else PowerShell on
// Windows); only PowerShell needs its profile path, which it can't work out, so
// ask PowerShell for $PROFILE only when setup alias says that's what's missing.
function powershellProfile() {
  // PowerShell 7 puts its own folder on PSModulePath; otherwise it's Windows PowerShell.
  const pwsh = /[\\/]PowerShell[\\/]7/i.test(process.env.PSModulePath ?? '') ? 'pwsh' : 'powershell';
  const result = spawnSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', '$PROFILE'], { encoding: 'utf8' });
  const path = result.stdout?.trim();
  if (result.status !== 0 || !path) fail(`couldn't ask ${pwsh} for $PROFILE.`, 'In the PowerShell you use, run: node dist/toil.js setup alias --profile $PROFILE');
  return path;
}

if (noAlias) {
  console.log('\nSkipping the alias (--no-alias).');
} else {
  const aliasArgs = profile ? ['setup', 'alias', '--profile', profile] : ['setup', 'alias'];
  console.log(`\n> node dist/toil.js ${aliasArgs.join(' ')}`);
  let out = toil(aliasArgs);
  if (!profile && !out.ok && /PowerShell/.test(out.error?.message ?? '')) {
    const found = powershellProfile();
    console.log(`> node dist/toil.js setup alias --profile ${found}`);
    out = toil(['setup', 'alias', '--profile', found]);
  }
  if (!out.ok) fail(out.error?.message ?? 'setup alias failed.', out.error?.fix);
  console.log(JSON.stringify(out.data, null, 2));
}

// 4. Done.
console.log('\n> node dist/toil.js version');
const version = toil(['version']);
if (!version.ok) fail(version.error?.message ?? 'toil version failed.', version.error?.fix);
console.log(JSON.stringify(version.data, null, 2));
if (!skipBuild) console.log('\ndist/ now holds this checkout\'s build. Run git checkout -- dist/ before git pull, then run this again.');
console.log(noAlias ? '\nNext: run node dist/toil.js skill install --allow-write' : '\nNext: open a new terminal, then run toil skill install --allow-write');
