/**
 * Finding the agent CLI (#206, Constraints; #251). Each SDK starts a binary:
 * Claude Code, the Codex CLI, or the Copilot CLI. Toil UI runs only the one
 * already on this machine, on PATH or at the path set in Settings, and hands
 * that path to the SDK, so the SDK never falls back to a copy of its own and
 * nothing is downloaded. Not found is a plain error that names the CLI, where
 * it looked, and the fix. A search party that only checks the rooms it was
 * told about.
 */

import type { AnswerUsage } from '../../src/model-usage.ts';
import { readFileSync, statSync } from 'node:fs';
import * as nodePath from 'node:path';

export class AgentError extends Error {
  /** What a run used before it failed or was stopped (#295), so the page counts it as the ledger does. */
  usage?: AnswerUsage;
  /** A usage cap stopped or refused the run (#295), rather than the run failing. */
  capped?: boolean;
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

export interface CliLookup {
  /** The adapter's label, for the message: "Claude Code". */
  label: string;
  /** The command name on PATH: `claude`. */
  command: string;
  /** The path set in Settings, if any; it wins over PATH. */
  configured?: string | undefined;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Tests pass their own; a real lookup asks the file system. */
  isFile?: (path: string) => boolean;
  path?: Pick<typeof nodePath, 'delimiter' | 'dirname' | 'join' | 'isAbsolute' | 'relative' | 'resolve'>;
  /** The working directory: a PATH entry in it or under it is skipped. process.cwd() by default. */
  cwd?: string;
  /** The home folder, which stays searchable when the working directory holds it. */
  home?: string;
  /**
   * The SDK starts a `.js` CLI with Node itself (Copilot's does, #344), so an
   * npm shim on Windows resolves to the script it runs rather than being refused.
   */
  scripts?: boolean;
  /** Tests pass their own; a real lookup reads the shim from disk. */
  readText?: (path: string) => string | null;
}

const realReadText = (p: string) => {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
};

/** npm's `.cmd` shim names its script as "%dp0%\node_modules\...\x.js"; its extensionless sh twin as "$basedir/node_modules/.../x.js". */
const CMD_SCRIPT = /"%~?dp0%\\?([^"%]+\.js)"/i;
const SH_SCRIPT = /"\$basedir\/([^"$]+\.js)"/;

/**
 * The script an npm shim on Windows runs, or null when it isn't one npm
 * wrote. The script is relative to the shim's own folder, and one that climbs
 * out of it is not followed. A forwarding address, honoured only within the building.
 */
export function shimScript(shim: string, text: string, path: Pick<typeof nodePath, 'dirname' | 'join' | 'relative' | 'isAbsolute'> = nodePath.win32): string | null {
  const m = CMD_SCRIPT.exec(text) ?? SH_SCRIPT.exec(text);
  if (!m) return null;
  const dir = path.dirname(shim);
  const target = path.join(dir, ...m[1]!.split(/[\\/]+/));
  const rel = path.relative(dir, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? target : null;
}

const realIsFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** A Windows shim the SDKs can't start without a shell (Node refuses to spawn .cmd and .bat directly). */
const SHIM = /\.(cmd|bat)$/i;

/** The CLI's full path, or an AgentError saying where it looked and what to do. */
export function findCli(l: CliLookup): string {
  const isFile = l.isFile ?? realIsFile;
  const path = l.path ?? (l.platform === 'win32' ? nodePath.win32 : nodePath.posix);
  const shimError = (found: string) =>
    new AgentError(
      `${l.label} was found at ${found}, which is a Windows command shim the SDK can't start.`,
      l.scripts
        ? `That is a launcher script, not the CLI itself. Press Install for ${l.label} under Settings, Agent to put the real one beside Toil UI, or set the CLI path in Settings to ${l.command}.exe.`
        : `Set the CLI path in Settings to the ${l.command} executable itself (${l.command}.exe).`,
    );
  if (l.configured) {
    if (!path.isAbsolute(l.configured)) throw new AgentError(`The ${l.label} path in Settings, ${JSON.stringify(l.configured)}, isn't an absolute path.`, 'Set the full path to the CLI, or clear it to use the one on PATH.');
    if (!isFile(l.configured)) throw new AgentError(`${l.label} isn't at ${l.configured}, the path set in Settings.`, `Install ${l.label} there, or change or clear the path in Settings to use the ${l.command} on PATH.`);
    if (l.platform === 'win32' && SHIM.test(l.configured)) throw shimError(l.configured);
    return l.configured;
  }
  // The rule src/core/git.ts follows: a relative PATH entry, or one in the working directory, could hold a CLI a cloned repository planted, so neither is searched.
  const cwd = path.resolve(l.cwd ?? process.cwd());
  const home = l.home ?? l.env.HOME ?? l.env.USERPROFILE;
  const fold = (p: string) => (l.platform === 'win32' ? p.toLowerCase() : p);
  const under = (dir: string, root: string) => {
    const rel = path.relative(fold(root), fold(dir));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  };
  const homeInside = home !== undefined && path.isAbsolute(home) && under(path.resolve(home), cwd);
  const dirs = (l.env.PATH ?? l.env.Path ?? '')
    .split(path.delimiter)
    .map((d) => d.replace(/^"(.*)"$/, '$1'))
    .filter((d) => d !== '' && path.isAbsolute(d) && !(under(path.resolve(d), cwd) && !(homeInside && path.resolve(d) !== cwd)));
  // On Windows a real executable beats a shim in the same folder; PATHEXT order otherwise.
  const exts = l.platform === 'win32' ? ['.exe', '.com', ...(l.env.PATHEXT ?? '.CMD;.BAT').split(';').map((e) => e.toLowerCase()).filter((e) => e === '.cmd' || e === '.bat'), ''] : [''];
  const shims: string[] = [];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, `${l.command}${ext}`);
      if (!isFile(candidate)) continue;
      if (l.platform === 'win32' && (SHIM.test(candidate) || ext === '')) {
        shims.push(candidate);
        continue;
      }
      return candidate;
    }
  }
  // Every shim on PATH is tried, not only the first: an editor's launcher script can shadow the npm shim behind it.
  if (l.scripts) {
    for (const shim of shims) {
      const script = shimScript(shim, (l.readText ?? realReadText)(shim) ?? '', path);
      if (script && isFile(script)) return script;
    }
  }
  if (shims[0]) throw shimError(shims[0]);
  throw new AgentError(
    `Toil UI found no ${l.command} on PATH, so it can't start ${l.label}. It never downloads one.`,
    `Install ${l.label} the way your organization approves, so ${l.command} is on PATH, or set its path in Settings, then ask again.`,
  );
}
