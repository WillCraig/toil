/**
 * Installing an agent SDK in one press (#344). The maintainer's exception
 * (2026-10-20, docs/decisions/343-ask-up-front.md): Toil UI may run npm for
 * this and nothing else. One `npm install` of one adapter's SDK at the version
 * Toil UI was tested with, beside Toil UI, through the npm that came with the
 * Node running it, with the person's own npm config (so their registry and
 * proxy apply), no shell, `--ignore-scripts`, and only after the person has
 * seen the exact command and pressed Install. This is the one file in the
 * server that imports child_process; scripts/check-package.mjs fails the
 * build if any other does.
 *
 * Where it goes depends on how Toil UI is installed, because npm resolves the
 * SDK from Toil UI's own folder upwards:
 *
 * - **Global** (`npm install -g @imagile-dev/toil-ui`): a global install into
 *   the same prefix, so the SDK sits beside Toil UI in that `node_modules`.
 *   The prefix is read from where Toil UI is, not from npm's config, so a
 *   global install under another prefix still lands beside it. Optional
 *   dependencies are left out: they are each SDK's bundled copy of its CLI,
 *   which Toil UI never starts.
 * - **In a project** (`<project>/node_modules/@imagile-dev/toil-ui`): an
 *   install into the project, saved exactly in its package.json, so the next
 *   `npm install` there keeps it.
 * - **A clone of the repository**: an unsaved install at the clone's root,
 *   naming again every agent SDK already there, since an unsaved install
 *   removes the ones it doesn't name.
 * - **npx**: refused. npx runs Toil UI from its cache, which npm clears when
 *   it likes, so there is no folder to install beside.
 *
 * Installing into Toil UI's own package folder looks like the obvious place
 * and doesn't work: its package.json lists the SDKs as optional peers, so npm
 * reports them "up to date" and installs nothing, and a saving install
 * rewrites Toil UI's own package.json.
 *
 * `--before` holds everything the install resolves, the SDK's own
 * dependencies and peers included, to releases at least MIN_AGE_DAYS old,
 * the rule CLAUDE.md sets for the repository's own pins. A requisition form
 * with one line on it, already filled in, waiting for a signature.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as nodePath from 'node:path';
import type { AdapterName } from './runtime.ts';
import { beforeDate, CLI_PACKAGES, TESTED } from './tested.ts';

export { beforeDate, MIN_AGE_DAYS, TESTED, testedVersion } from './tested.ts';

/** The longest an install may take before Toil UI stops it (Bounds). */
export const INSTALL_TIMEOUT_MS = 10 * 60_000;

export type InstallKind = 'global' | 'project' | 'clone' | 'npx' | 'unknown';

export interface InstallPlan {
  adapter: AdapterName;
  /** How Toil UI is installed, which decides where the SDK goes. */
  kind: InstallKind;
  /** npm's --prefix: the folder the SDK goes into, or null when there is none. */
  folder: string | null;
  /** The vendor's CLI this install also puts beside Toil UI (Copilot), or null. */
  cli?: string | null;
  /** The command as a person would type it, which is what Install runs. */
  command: string;
  /** What runs: node, npm's own CLI script and npm's arguments, with no shell. Null when Install is off. */
  argv: string[] | null;
  /** Why Install is off here, and what to do; both null when it can run. */
  problem: string | null;
  fix: string | null;
}

export interface PlanOptions {
  /** Toil UI's package folder: the one that holds dist/server/toil-ui.js. */
  uiDir: string;
  platform: NodeJS.Platform;
  /** The Node running Toil UI, which runs npm's CLI. */
  execPath: string;
  env: Record<string, string | undefined>;
  /** Now, for --before. */
  now: string;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string | null;
}

const readOr = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

const nameOf = (spec: string) => spec.slice(0, spec.lastIndexOf('@'));

/** One argument as a person would type it in their shell: quoted only when it has to be. */
function shown(arg: string, platform: NodeJS.Platform): string {
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) return arg;
  return platform === 'win32' ? `"${arg.replace(/"/g, '""')}"` : `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * npm's own CLI script, run with the Node that runs Toil UI: under `npm run`
 * it's npm_execpath; otherwise the copy that came with that Node.
 */
export function npmCli(o: Pick<PlanOptions, 'execPath' | 'env' | 'platform'>, exists: (p: string) => boolean): string | null {
  const path = o.platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const fromEnv = o.env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && exists(fromEnv)) return fromEnv;
  const dir = path.dirname(o.execPath);
  return [path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find(exists) ?? null;
}

/** Where Toil UI is, as npm sees it. */
export function locate(o: Pick<PlanOptions, 'uiDir' | 'platform'>, exists: (p: string) => boolean, readText: (p: string) => string | null): { kind: InstallKind; prefix: string | null } {
  const path = o.platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const parts = path.resolve(o.uiDir).split(/[\\/]+/);
  if (parts.includes('_npx')) return { kind: 'npx', prefix: null };
  const scope = path.dirname(o.uiDir);
  const nm = path.dirname(scope);
  if (path.basename(o.uiDir) === 'toil-ui' && path.basename(scope) === '@imagile-dev' && path.basename(nm) === 'node_modules') {
    const above = path.dirname(nm);
    if (exists(path.join(above, 'package.json'))) return { kind: 'project', prefix: above };
    // A global node_modules is <prefix>/node_modules on Windows and <prefix>/lib/node_modules elsewhere.
    if (o.platform === 'win32') return { kind: 'global', prefix: above };
    return path.basename(above) === 'lib' ? { kind: 'global', prefix: path.dirname(above) } : { kind: 'unknown', prefix: null };
  }
  const root = path.dirname(o.uiDir);
  try {
    const pkg = JSON.parse(readText(path.join(root, 'package.json')) ?? 'null') as { name?: string; workspaces?: string[] } | null;
    if (pkg?.name === '@imagile-dev/toil' && pkg.workspaces?.includes(path.basename(o.uiDir))) return { kind: 'clone', prefix: root };
  } catch {
    // Not a clone's package.json; Toil UI says it can't tell, below.
  }
  return { kind: 'unknown', prefix: null };
}

/** The agent SDKs already in a clone's node_modules, which an unsaved install would otherwise remove. */
function alreadyThere(prefix: string, except: AdapterName, path: typeof nodePath.posix, exists: (p: string) => boolean): string[] {
  return (Object.keys(TESTED) as AdapterName[])
    .filter((name) => name !== except && exists(path.join(prefix, 'node_modules', ...nameOf(TESTED[name][0]!).split('/'), 'package.json')))
    .flatMap((name) => [...TESTED[name], ...(CLI_PACKAGES[name] ? [CLI_PACKAGES[name]!] : [])]);
}

/** The one command Install runs for an adapter, or why it can't run here. */
export function installPlan(adapter: AdapterName, o: PlanOptions): InstallPlan {
  const exists = o.exists ?? existsSync;
  const readText = o.readText ?? readOr;
  const path = o.platform === 'win32' ? nodePath.win32 : nodePath.posix;
  const { kind, prefix } = locate(o, exists, readText);
  const cliSpec = CLI_PACKAGES[adapter];
  const specs = [...TESTED[adapter], ...(cliSpec ? [cliSpec] : [])];
  const common = ['--ignore-scripts', `--before=${beforeDate(o.now)}`, '--no-audit', '--no-fund'];
  let args: string[];
  if (kind === 'global') args = ['install', '--global', '--prefix', prefix!, ...common, ...(cliSpec ? [] : ['--omit=optional']), ...specs];
  else if (kind === 'project') args = ['install', '--prefix', prefix!, ...common, '--save-exact', ...specs];
  else if (kind === 'clone') args = ['install', '--prefix', prefix!, ...common, '--no-save', ...new Set([...specs, ...alreadyThere(prefix!, adapter, path as typeof nodePath.posix, exists)])];
  else args = ['install', ...common, ...specs];
  const command = ['npm', ...args].map((a) => shown(a, o.platform)).join(' ');
  const off = (problem: string, fix: string): InstallPlan => ({ adapter, kind, folder: prefix, command, argv: null, problem, fix });
  if (kind === 'npx') {
    return off(
      "Toil UI is running from npx's cache, which npm clears when it likes, so there is no folder to install an SDK beside.",
      'Install Toil UI with npm install -g @imagile-dev/toil-ui, start it as toil-ui, then press Install. Or copy the command and run it where Toil UI is installed.',
    );
  }
  if (kind === 'unknown') {
    return off(
      `Toil UI can't tell how it was installed from where it runs (${o.uiDir}), so it doesn't know where npm would put the SDK for it to find.`,
      'Copy the command and run it in the folder whose node_modules holds @imagile-dev/toil-ui, or install Toil UI with npm install -g @imagile-dev/toil-ui.',
    );
  }
  const cli = npmCli(o, exists);
  if (!cli) return off(`Toil UI found no npm beside the Node running it (${path.dirname(o.execPath)}), so it can't run the install.`, 'Copy the command and run it yourself, with the npm you use.');
  return { adapter, kind, folder: prefix, cli: cliSpec ?? null, command, argv: [o.execPath, cli, ...args], problem: null, fix: null };
}

export interface InstallRun {
  /** npm's exit code, or null when it was stopped. */
  code: number | null;
  /** Everything npm printed, both streams, in order. */
  output: string[];
}

/**
 * Runs a plan's argv, with no shell, in its folder, handing each line npm
 * prints to `onLine` as it prints it. The environment is the person's own,
 * so npm reads their config, registry and proxy, less toil's TOIL_*
 * variables, which carry credentials npm has no business with.
 */
export function runInstall(plan: InstallPlan, o: { env: Record<string, string | undefined>; onLine(line: string): void; signal: AbortSignal }): Promise<InstallRun> {
  const argv = plan.argv;
  if (!argv || !plan.folder) return Promise.reject(new Error(plan.problem ?? 'There is nothing to run.'));
  const env = Object.fromEntries(Object.entries(o.env).filter((e): e is [string, string] => typeof e[1] === 'string' && !/^TOIL_/i.test(e[0])));
  return new Promise((resolve, reject) => {
    const output: string[] = [];
    const child = spawn(argv[0]!, argv.slice(1), { cwd: plan.folder!, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => child.kill(), INSTALL_TIMEOUT_MS);
    const stop = () => child.kill();
    o.signal.addEventListener('abort', stop, { once: true });
    const say = (line: string) => {
      output.push(line);
      o.onLine(line);
    };
    const lines = (stream: NodeJS.ReadableStream | null) => {
      let rest = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        rest += chunk;
        const parts = rest.split(/\r?\n/);
        rest = parts.pop() ?? '';
        for (const line of parts) if (line.trim()) say(line);
      });
      stream?.on('end', () => {
        if (rest.trim()) say(rest);
        rest = '';
      });
    };
    lines(child.stdout);
    lines(child.stderr);
    child.on('error', (e) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', stop);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      o.signal.removeEventListener('abort', stop);
      resolve({ code: o.signal.aborted ? null : code, output });
    });
  });
}

/** The version of a package as it resolves from here, or null: what the status says is installed. */
export function installedVersion(specifier: string, resolve: (s: string) => string, readText: (p: string) => string | null = readOr): string | null {
  let entry: string;
  try {
    entry = resolve(specifier);
  } catch {
    return null;
  }
  let dir = nodePath.dirname(entry.startsWith('file:') ? decodeURIComponent(new URL(entry).pathname).replace(/^\/([A-Za-z]:)/, '$1') : entry);
  for (let i = 0; i < 8; i++) {
    const text = readText(nodePath.join(dir, 'package.json'));
    if (text) {
      try {
        const pkg = JSON.parse(text) as { name?: string; version?: string };
        if (pkg.name === specifier) return typeof pkg.version === 'string' ? pkg.version : null;
      } catch {
        // A package.json that doesn't parse isn't the SDK's; keep climbing.
      }
    }
    const up = nodePath.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}
