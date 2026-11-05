// The isolated home Toil UI runs on real data in, shared by dev-real.mjs (by
// hand) and verify.mjs (`npm run verify:ui`). In <home> it sets up, once:
//   - ~/.toil/config.json with one connection, `github`, to https://api.github.com,
//     writes off. It holds no token.
//   - for GitHub (prepareRealHome), the toil project for a repository (named after
//     it; `sandbox` for imagile-dev/toil-sandbox), and `toil-self` for
//     imagile-dev/toil unless asked not to;
//   - or, for an Azure DevOps Services board (prepareAdoHome), the toil project
//     `ado-board` on the ado connection (deployment cloud) toil makes from
//     TOIL_ADO_BASE_URL and TOIL_ADO_PAT, for one project. Nothing
//     about the organization is written to the config file, and writes stay off.
// Toil projects are made through toil's own toil projects commands. The environment it
// hands back points HOME there and carries the GitHub token from `gh auth
// token` (or TOIL_GITHUB_TOKEN, if already set), or the two ADO variables, for
// toil-ui's process only: never written to a file or printed.
// Both run Toil UI, and the toil CLI that makes the toil projects, on toil built
// from this checkout into <clone>/.scratch/toil (buildToil, and the resolve hook
// in local-toil-hook.mjs), never on the published toil Toil UI pins, so a
// command ui/ calls before its release still works here (#332).
// The agent CLIs keep their own sign-ins: Claude Code's access token is read,
// never refreshed (claudeSignIn), and CODEX_HOME is pointed at the real
// ~/.codex unless already set, since Codex on Windows finds its home from the
// OS rather than USERPROFILE. Repo tooling only: nothing here ships. The
// visitor's badge is issued fresh each morning and collected at the door.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { npmCli } from './package-rules.mjs';

export const root = resolve(import.meta.dirname, '..', '..');
export const toilUi = join(root, 'ui', 'dist', 'server', 'toil-ui.js');
/** toil built from this checkout (buildToil), apart from the committed dist/. */
export const toilBuild = join(root, '.scratch', 'toil');
export const toilCli = join(toilBuild, 'toil.js');
/** Node's arguments that make a toil-ui process import toilBuild's API in place of the pinned toil. */
export const toilUiNodeArgs = ['--import', pathToFileURL(join(root, 'ui', 'scripts', 'local-toil-hook.mjs')).href];

/** A problem setting up the home, with the fix to print under it. */
export class RealHomeError extends Error {
  constructor(message, fix) {
    super(message);
    this.fix = fix;
  }
}

/**
 * Builds toil from this checkout into toilBuild (`npm run build` with
 * TOIL_BUILD_DIR), unless `build` is false and a build is already there.
 * Resolves with its version, the commit it was built at, whether src/ had
 * uncommitted changes, whether it built just now, and a line naming it for a report. Throws a
 * RealHomeError when the build fails.
 */
export function buildToil({ build = true } = {}) {
  const built = build || !existsSync(toilCli);
  if (built) {
    const res = spawnSync(process.execPath, [npmCli(), 'run', 'build'], { cwd: root, env: { ...process.env, TOIL_BUILD_DIR: toilBuild }, encoding: 'utf8' });
    if (res.status !== 0) throw new RealHomeError(`building toil from this checkout into .scratch/toil failed:\n${(res.stdout + res.stderr).trim().split('\n').slice(-20).join('\n')}`, 'Fix the build error above (npm run typecheck at the root shows type errors), then run this again.');
  }
  const res = spawnSync(process.execPath, [toilCli, 'version'], { encoding: 'utf8' });
  let data;
  try {
    data = JSON.parse(res.stdout).data;
  } catch {
    throw new RealHomeError(`${toilCli} version printed no envelope: ${res.stderr.trim() || res.stdout.trim()}`, 'Delete .scratch/toil and run this again.');
  }
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=no', '--', 'src'], { cwd: root, encoding: 'utf8' });
  const dirty = status.status === 0 && status.stdout.trim() !== '';
  const at = data.commit ? `${data.commit.slice(0, 8)}${dirty ? ' plus uncommitted changes in src/' : ''}` : 'no commit';
  return { version: data.version, commit: data.commit, dirty, built, describe: `toil ${data.version} built from this checkout at ${at}, in .scratch/toil` };
}

/** The GitHub token for this run: TOIL_GITHUB_TOKEN, else `gh auth token`. `problem` says why there is none. */
export function githubToken(env = process.env) {
  if (env.TOIL_GITHUB_TOKEN) return { token: env.TOIL_GITHUB_TOKEN, from: 'TOIL_GITHUB_TOKEN' };
  const gh = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8' });
  if (gh.error || gh.status !== 0 || !gh.stdout.trim()) return { problem: gh.error ? `the GitHub CLI isn't installed (${gh.error.message})` : `the GitHub CLI isn't signed in (${(gh.stderr || 'gh auth token printed nothing').trim()})` };
  return { token: gh.stdout.trim(), from: 'gh auth token' };
}

/** Why an ADO run can't start, or null: it needs the organization URL, a token and a project. */
export function adoProblem(env = process.env, project = env.TOIL_ADO_PROJECT) {
  if (!env.TOIL_ADO_BASE_URL || !env.TOIL_ADO_PAT) return "TOIL_ADO_BASE_URL and TOIL_ADO_PAT aren't both set (the organization URL and an organization-scoped token with Work Items (Read))";
  if (!project) return 'no project is named (pass --project "<project>", or set TOIL_ADO_PROJECT)';
  return null;
}

/**
 * toil-ui's environment: HOME in the scratch home, the GitHub token (or, with
 * `ado`, the ado connection's variables), Codex's own sign-in, and
 * no other toil or CI variable.
 */
export function realHomeEnv(home, token, base = process.env, { ado = false } = {}) {
  const env = {
    ...base,
    HOME: home,
    USERPROFILE: home,
    ...(token ? { TOIL_GITHUB_TOKEN: token } : {}),
    CODEX_HOME: base.CODEX_HOME ?? join(homedir(), '.codex'),
  };
  // GITHUB_TOKEN and GITHUB_API_URL would be the github connection's CI fallbacks; this run uses the one above.
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_API_URL;
  // SYSTEM_ACCESSTOKEN is ado's CI fallback; this run is not a pipeline.
  delete env.SYSTEM_ACCESSTOKEN;
  // The Services connection is these two and its deployment, nothing else: no writes, no project, from the shell.
  const keep = new Set(['TOIL_GITHUB_TOKEN', ...(ado ? ['TOIL_ADO_BASE_URL', 'TOIL_ADO_PAT', 'TOIL_ADO_DEPLOYMENT'] : [])]);
  for (const key of Object.keys(env)) if (key.startsWith('TOIL_') && !keep.has(key) && !key.startsWith('TOIL_UI_')) delete env[key];
  // The URL and token are Azure DevOps Services', whatever else the shell has set.
  if (ado) env.TOIL_ADO_DEPLOYMENT = 'cloud';
  const claude = claudeSignIn(base);
  if (claude.token) env.CLAUDE_CODE_OAUTH_TOKEN = claude.token;
  return env;
}

/**
 * Claude Code's sign-in for a run in the scratch home (#318). Claude Code keeps
 * it in ~/.claude, which HOME in the scratch home hides, and refreshing it
 * there would rewrite your credentials file. So this only reads: a
 * CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY already in the shell is used as
 * it is; otherwise the access token in ~/.claude/.credentials.json (or
 * $CLAUDE_CONFIG_DIR's) is passed as CLAUDE_CODE_OAUTH_TOKEN while it has ten
 * minutes left, which Claude Code uses without refreshing it. Nothing is
 * written, and no refresh token leaves the file. `problem` says why there is none.
 */
export function claudeSignIn(base = process.env, now = Date.now()) {
  if (base.CLAUDE_CODE_OAUTH_TOKEN || base.ANTHROPIC_API_KEY) return { from: 'the shell' };
  const file = join(base.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), '.credentials.json');
  let oauth;
  try {
    oauth = JSON.parse(readFileSync(file, 'utf8')).claudeAiOauth;
  } catch {
    return { problem: `no Claude Code sign-in in ${file} (on macOS it is in the keychain)` };
  }
  if (!oauth?.accessToken || !(oauth.expiresAt > now + 10 * 60_000)) return { problem: `the access token in ${file} has expired, and refreshing it would rewrite that file` };
  return { token: oauth.accessToken, from: file };
}

/** The toil project name a repository gets: `sandbox` for the sandbox, else its name made safe. */
export const toilProjectFor = (name) => (name === 'toil-sandbox' ? 'sandbox' : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));

const say = (line) => process.stdout.write(`${line}\n`);

/** toil's config in the home: one read-only GitHub connection, written once. */
function writeConfig(home, log) {
  if (!existsSync(toilCli)) throw new RealHomeError(`toil isn't built at ${toilCli}.`, 'Call buildToil() first; dev-real.mjs and verify.mjs do.');
  const config = join(home, '.toil', 'config.json');
  if (existsSync(config)) return;
  mkdirSync(join(home, '.toil'), { recursive: true });
  const content = { version: 2, connections: { github: { area: 'github', baseUrl: 'https://api.github.com', writes: false } }, defaults: { github: { connection: 'github' } } };
  writeFileSync(config, `${JSON.stringify(content, null, 2)}\n`);
  log(`Wrote ${config}: one GitHub connection, writes off, no token.`);
}

/** One toil command in the home, through the toil Toil UI runs on, as its envelope. */
export function toilIn(home, env) {
  return (...argv) => {
    const res = spawnSync(process.execPath, [toilCli, ...argv], { env, encoding: 'utf8', cwd: home });
    try {
      return JSON.parse(res.stdout);
    } catch {
      throw new RealHomeError(`toil ${argv.join(' ')} printed no envelope: ${res.stderr.trim() || res.stdout.trim()}`, 'Run it by hand with HOME set to the scratch home to see why.');
    }
  };
}

/** A toil project made or updated with toil's own commands (`link` takes `linkArgs`), then checked. */
function ensureToilProject(toil, name, description, linkArgs) {
  if (!toil('projects', 'show', name).ok) {
    const init = toil('projects', 'init', name, '--description', description);
    if (!init.ok) throw new RealHomeError(`toil projects init ${name}: ${init.error.message}`, init.error.fix ?? 'See toil projects init --help.');
  }
  const link = toil('projects', 'link', name, ...linkArgs, '--replace');
  if (!link.ok) throw new RealHomeError(`toil projects link ${name}: ${link.error.message}`, link.error.fix ?? 'See toil projects link --help.');
  const check = toil('projects', 'check', name);
  if (!check.ok || !check.data.ok) throw new RealHomeError(`toil projects check ${name} found problems: ${JSON.stringify(check.data?.problems ?? check.error)}`, 'Fix the Toil project in the scratch home, or delete it and run this again.');
}

/**
 * Writes toil's config and a GitHub repository's toil projects into the home.
 * Resolves with the repository's toil project name. Throws a RealHomeError when a
 * step fails.
 */
export function prepareRealHome({ home, repo, self = true, env, log = say }) {
  const [owner, name] = repo.split('/');
  if (!owner || !name || repo.split('/').length !== 2) throw new RealHomeError(`--repo ${repo} isn't owner/name.`, 'Pass it as --repo imagile-dev/toil-sandbox.');
  writeConfig(home, log);
  const toil = toilIn(home, env);
  const toilProject = (toilProjectName, description, repoOwner, repoName) => {
    ensureToilProject(toil, toilProjectName, description, ['github', '--connection', 'github', '--set', `owner=${repoOwner}`, '--set', `repo=${repoName}`]);
    log(`Toil project ${toilProjectName}: ${repoOwner}/${repoName} on GitHub, checked.`);
  };
  const main = toilProjectFor(name);
  toilProject(main, `${owner}/${name} on GitHub`, owner, name);
  if (self && repo !== 'imagile-dev/toil') toilProject('toil-self', 'Toil itself: imagile-dev/toil on GitHub', 'imagile-dev', 'toil');
  return main;
}

/**
 * The board's toil project, `ado-board`, on the ado connection the env makes (deployment cloud),
 * for one project, after `toil connections test` proves the token. Resolves
 * with the toil project name.
 */
export function prepareAdoHome({ home, project, env, log = say }) {
  writeConfig(home, log);
  const toil = toilIn(home, env);
  const test = toil('connections', 'test', 'ado');
  if (!test.ok || !test.data.authenticated) throw new RealHomeError(`toil couldn't reach the ado connection: ${test.error?.message ?? 'the token was refused'}`, test.error?.fix ?? 'Check TOIL_ADO_BASE_URL and TOIL_ADO_PAT.');
  ensureToilProject(toil, 'ado-board', 'An Azure DevOps Services board, read-only', ['ado', '--connection', 'ado', '--set', `project=${project}`]);
  log('Toil project ado-board: the project on Azure DevOps Services, checked.');
  return 'ado-board';
}

/**
 * Each adapter's SDK, its label and the unsaved install that puts it in this
 * clone, at the versions ui/server/agents/tested.ts names. An unsaved install
 * removes the SDKs it doesn't name, so each line names the others too.
 */
const SDK_SPECS = { codex: '@openai/codex-sdk@0.160.0', copilot: '@github/copilot-sdk@1.0.16', claude: '@anthropic-ai/claude-agent-sdk@0.3.289 zod@4.6.5' };
export const ADAPTERS = {
  codex: { label: 'Codex', package: '@openai/codex-sdk' },
  copilot: { label: 'GitHub Copilot', package: '@github/copilot-sdk' },
  claude: { label: 'Claude', package: '@anthropic-ai/claude-agent-sdk' },
};
export const sdkInstall = (adapter) => `npm install --no-save --ignore-scripts ${[SDK_SPECS[adapter], ...Object.entries(SDK_SPECS).filter(([a]) => a !== adapter && sdkInstalled(a)).map(([, s]) => s)].join(' ')}`;

/**
 * Whether an adapter's SDK is installed where ui/ resolves it (ui/node_modules,
 * then the clone's), without loading it: Copilot's SDK can't be imported from
 * `node -e`, whose module has no file name.
 */
export function sdkInstalled(adapter) {
  return ['ui', '.'].some((dir) => existsSync(join(root, dir, 'node_modules', ...ADAPTERS[adapter].package.split('/'), 'package.json')));
}

/** Whether the Codex SDK resolves from ui/, without loading it. */
export const codexSdkInstalled = () => sdkInstalled('codex');

export const CODEX_SDK_INSTALL = 'npm install --no-save --ignore-scripts @openai/codex-sdk@0.160.0';
