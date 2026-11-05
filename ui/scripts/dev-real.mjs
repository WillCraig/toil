// Starts the Toil UI built from this clone against a real GitHub repository, in a
// home folder of its own, so your own ~/.toil and ~/.toil-ui are never read or
// written:
//
//   npm run build -w ui
//   node ui/scripts/dev-real.mjs                         # imagile-dev/toil-sandbox, plus toil-self
//   node ui/scripts/dev-real.mjs --repo you/your-repo --no-self --port 4390
//   node ui/scripts/dev-real.mjs --source ado --project "<project>"   # an Azure DevOps Services board
//
// The home is <clone>/.scratch/home (or --home), set up by real-home.mjs: toil's
// config with one read-only GitHub connection and no token, and the toil projects.
// Then it starts toil-ui on loopback with HOME pointed there and the token from
// `gh auth token` (or TOIL_GITHUB_TOKEN, if already set) in toil-ui's environment
// only.
//
// With --source ado it reads an Azure DevOps Services board instead (one the
// seed in ui/scripts/ado-seed/ filled, or any other): the toil project `ado-board`
// on the ado connection (deployment cloud) toil makes from TOIL_ADO_BASE_URL and
// TOIL_ADO_PAT, which go into toil-ui's environment and nowhere else.
// --project, else TOIL_ADO_PROJECT, names the project; the toil project file
// in the scratch home holds it.
//
// Toil UI, and the toil that makes the toil projects, run on toil built from this
// checkout into .scratch/toil each time it starts, never the published toil
// ui/package.json pins, so commands ui/ calls before their release work here
// (#332, real-home.mjs's buildToil and local-toil-hook.mjs).
//
// `npm run verify:ui` runs the same homes through the layout check and, with
// --ask, one Codex question (scripts/verify.mjs). Repo tooling only: nothing
// here ships. A sandbox inside a sandbox, filed in triplicate under scratch.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CODEX_SDK_INSTALL, RealHomeError, adoProblem, buildToil, claudeSignIn, codexSdkInstalled, githubToken, prepareAdoHome, prepareRealHome, realHomeEnv, root, toilUi, toilUiNodeArgs } from './real-home.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  return at >= 0 ? Boolean(args.splice(at, 1)) : false;
};
const take = (name, fallback) => {
  const at = args.indexOf(name);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (value === undefined || value.startsWith('--')) fail(`${name} needs a value.`, 'See the comment at the top of ui/scripts/dev-real.mjs.');
  return args.splice(at, 2)[1];
};

function fail(message, fix) {
  process.stderr.write(`dev-real: ${message}\n  Fix: ${fix}\n`);
  process.exit(1);
}

const source = take('--source', 'github');
const project = take('--project', process.env.TOIL_ADO_PROJECT);
const repo = take('--repo', 'imagile-dev/toil-sandbox');
const home = resolve(take('--home', join(root, '.scratch', 'home')));
const port = take('--port', '0');
const self = !flag('--no-self');
if (args.length) fail(`Unknown argument: ${args.join(' ')}`, 'Use --source github|ado, --repo <owner/name>, --project <name>, --home <dir>, --port <n> and --no-self.');
if (!['github', 'ado'].includes(source)) fail(`--source ${source} isn't github or ado.`, 'Pass --source github (the default) or --source ado.');
const ado = source === 'ado';
const adoMissing = ado ? adoProblem(process.env, project) : null;
if (adoMissing) fail(`--source ado can't start: ${adoMissing}.`, 'Set TOIL_ADO_BASE_URL and TOIL_ADO_PAT in this shell, and pass --project.');
if (!existsSync(toilUi)) fail(`${toilUi} isn't built.`, 'Run npm run build -w ui first.');

// The token: in this process's memory and toil-ui's environment, nowhere else.
let token = null;
if (!ado) {
  const gh = githubToken();
  if (!gh.token) fail(`couldn't get a GitHub token: ${gh.problem}.`, 'Sign in with gh auth login, or set TOIL_GITHUB_TOKEN for this shell.');
  token = gh.token;
}
const env = realHomeEnv(home, token, process.env, { ado });

let toil;
try {
  toil = buildToil();
  if (ado) prepareAdoHome({ home, project, env });
  else prepareRealHome({ home, repo, self, env });
} catch (e) {
  if (e instanceof RealHomeError) fail(e.message, e.fix);
  throw e;
}
const claude = claudeSignIn();
if (claude.problem) process.stdout.write(`Claude for Ask: ${claude.problem}. Run claude once in a terminal so it refreshes its own sign-in, or set CLAUDE_CODE_OAUTH_TOKEN (from claude setup-token) in this shell, then start this again.\n`);
if (!codexSdkInstalled()) process.stdout.write(`Codex for Ask: @openai/codex-sdk isn't installed in this clone. To try it: ${CODEX_SDK_INSTALL}\n`);

process.stdout.write(`Toil UI runs on ${toil.describe}.\nHome for this run: ${home}\n\n`);
const child = spawn(process.execPath, [...toilUiNodeArgs, toilUi, '--port', port], { env, stdio: 'inherit' });
const stop = () => child.kill('SIGINT');
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
