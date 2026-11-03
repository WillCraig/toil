// Starts the Toil UI built from this clone against your own home: your
// ~/.toil config, connections, credential store entries and dossiers, as they
// are. dev-real.mjs is the one to use for a clean, throwaway home; this one is
// for trying unreleased changes on your own work.
//
//   node ui/scripts/dev-mine.mjs                 # builds toil and Toil UI, then starts it
//   node ui/scripts/dev-mine.mjs --no-build      # starts the last build
//   node ui/scripts/dev-mine.mjs --port 4390
//
// It uses ~/.toil the way the published toil-ui does: reads through toil's own
// commands, each recorded in toil's audit log, and changes only what you save in
// Settings. Toil UI's own folder is .scratch/toil-ui, not ~/.toil-ui, so an
// unreleased build never shares a cache or a lock with a released one. The
// environment and HOME are the shell's, so TOIL_* variables apply as they would to
// toil typed by hand, and each agent finds its own sign-in where it keeps it.
//
// Toil UI and the toil it calls both run on toil built from this checkout into
// .scratch/toil (buildToil, local-toil-hook.mjs), never on the published toil
// ui/package.json pins. Repo tooling only: nothing here ships. Visitors are
// asked to sign in at reception, which in this case is their own desk.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RealHomeError, buildToil, root, toilUi, toilUiNodeArgs } from './real-home.mjs';
import { npmCli } from './package-rules.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? Boolean(args.splice(at, 1)) : false;
};
const take = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value.`, 'See the comment at the top of ui/scripts/dev-mine.mjs.');
  return args.splice(at, 2)[1];
};

function fail(message, fix) {
  process.stderr.write(`dev-mine: ${message}\n  Fix: ${fix}\n`);
  process.exit(1);
}

const build = !flag('--no-build');
const port = take('--port', '0');
if (args.length) fail(`Unknown argument: ${args.join(' ')}`, 'Use --no-build and --port <n>.');

let toil;
try {
  toil = buildToil({ build });
} catch (e) {
  if (e instanceof RealHomeError) fail(e.message, e.fix);
  throw e;
}
if (build || !existsSync(toilUi)) {
  let npm;
  try {
    npm = npmCli();
  } catch (e) {
    fail(e.message, 'Run it with the node that npm came with, or through npm run.');
  }
  const res = spawnSync(process.execPath, [npm, 'run', 'build', '-w', 'ui'], { cwd: root, stdio: 'inherit' });
  if (res.error) fail(`npm run build -w ui could not start: ${res.error.message}`, 'Check that node and npm run in this shell, then run this again.');
  if (res.status !== 0) fail('npm run build -w ui failed.', 'Fix the build error above, then run this again.');
}

const dataDir = join(root, '.scratch', 'toil-ui');
process.stdout.write(`Toil UI runs on ${toil.describe}, against your own ~/.toil, with its own data in .scratch/toil-ui.\n\n`);
const child = spawn(process.execPath, [...toilUiNodeArgs, toilUi, '--port', port, '--data-dir', dataDir], { stdio: 'inherit' });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
