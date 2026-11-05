/**
 * The install fingerprint, server side (#305). `origin()` is what a session
 * starting now runs on: the toil and Toil UI this server runs, the toil
 * tools it hands the agent, the toil project as toil reads it, and the prompts.
 * `current()` is the same but for the builds, which are read from disk: the
 * toil bundle `@imagile-dev/toil/api` resolves to and Toil UI's own bin. Each
 * of those is read again only when its modification time or size changes,
 * so a check every turn costs a `stat`. `server()` says whether the server
 * itself is out of date, for the header.
 *
 * A build's version and commit come from marked lines at the top of its
 * bundle: toil's `__TOIL_VERSION__` and `__TOIL_COMMIT__` constants
 * (tsup.config.ts), and Toil UI's `// toil-ui-build` line
 * (vite.server.config.ts). A file that can't be read, or has no such line,
 * counts as the running build, so a source run or a test never reads as an
 * upgrade. A file is consulted, never trusted to run.
 */

import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { serverStale, type Build, type Fingerprint, type ServerStatus } from '../src/fingerprint.ts';
import type { Execute } from '../src/toil.ts';
import { LIVE_COMMANDS, neverWrites, type ReadCommand } from './agents/tools.ts';
import { CALLER } from './store.ts';

export const sha256 = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value ?? null)).digest('hex');

/** How much of a bundle's top the marked lines are looked for in. */
const HEAD_BYTES = 4096;

/** toil's version and commit from its bundle's marked lines, or null when they aren't there. */
export function toilBuildOf(head: string): Build | null {
  const version = /^const __TOIL_VERSION__ = ("[^"\r\n]*"); \/\/ x-release-please-version\r?$/m.exec(head)?.[1];
  const commit = /^const __TOIL_COMMIT__ = (null|"[0-9a-f]{40}"); \/\/ toil-build-commit\r?$/m.exec(head)?.[1];
  if (!version || !commit) return null;
  return { version: JSON.parse(version) as string, commit: JSON.parse(commit) as string | null };
}

/** Toil UI's version and commit from its bin's `// toil-ui-build` line, or null. */
export function uiBuildOf(head: string): Build | null {
  const line = /^\/\/ toil-ui-build (\{[^\r\n]*\})\r?$/m.exec(head)?.[1];
  if (!line) return null;
  try {
    const b = JSON.parse(line) as { version?: unknown; commit?: unknown };
    if (typeof b.version !== 'string' || (b.commit !== null && (typeof b.commit !== 'string' || !/^[0-9a-f]{40}$/.test(b.commit)))) return null;
    return { version: b.version, commit: b.commit };
  } catch {
    return null;
  }
}

export interface FileAccess {
  /** A file's modification time and size, or null when it can't be read. */
  stat(path: string): { mtimeMs: number; size: number } | null;
  /** The first bytes of a file, as text. */
  head(path: string, bytes: number): string;
}

export const nodeFiles: FileAccess = {
  stat(path) {
    try {
      const s = statSync(path);
      return { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      return null;
    }
  },
  head(path, bytes) {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n).toString('utf8');
    } finally {
      closeSync(fd);
    }
  },
};

export interface FingerprintOptions {
  running: { toil: Build; toilUi: Build };
  /** toil's bundle on disk (dist/toil-lib.js beside the api it resolves to), or null when there is none to read. */
  toilBundle: string | null;
  /** Toil UI's own bin on disk, or null. */
  uiBundle: string | null;
  registry: readonly ReadCommand[];
  execute: Execute;
  /** The command that starts this server again as it was started, for the header. */
  restart: string;
  files?: FileAccess;
}

/** The skills part: one hash per area of the toil read tools an agent is handed, from the registry this server runs. */
export function skillsOf(registry: readonly ReadCommand[]): Record<string, string> {
  const byArea = new Map<string, Array<Pick<ReadCommand, 'tool' | 'description' | 'inputSchema'>>>();
  for (const name of LIVE_COMMANDS) {
    const c = registry.find((r) => r.name === name);
    if (!c || !neverWrites(c)) continue;
    const area = c.area ?? name.split(' ')[0]!;
    byArea.set(area, [...(byArea.get(area) ?? []), { tool: c.tool, description: c.description, inputSchema: c.inputSchema }]);
  }
  return Object.fromEntries([...byArea].sort(([a], [b]) => a.localeCompare(b)).map(([area, tools]) => [area, sha256(tools)]));
}

export class Fingerprints {
  private readonly files: FileAccess;
  private readonly skills: Record<string, string>;
  private readonly seen = new Map<string, { key: string; build: Build | null }>();
  /** Each toil project's hash, by name, with the file it was read from. */
  private readonly toilProjects = new Map<string, { file: string; key: string; hash: string | null }>();

  constructor(private readonly o: FingerprintOptions) {
    this.files = o.files ?? nodeFiles;
    // The registry is the one this process loaded, so its tools are fixed for the life of the server.
    this.skills = skillsOf(o.registry);
  }

  /** A build read from its bundle on disk, again only when the file changed; null when it can't be read. */
  private diskBuild(path: string | null, parse: (head: string) => Build | null): Build | null {
    if (!path) return null;
    const st = this.files.stat(path);
    if (!st) return null;
    const key = `${st.mtimeMs}:${st.size}`;
    const hit = this.seen.get(path);
    if (hit?.key === key) return hit.build;
    let build: Build | null;
    try {
      build = parse(this.files.head(path, HEAD_BYTES));
    } catch {
      build = null;
    }
    this.seen.set(path, { key, build });
    return build;
  }

  /** What is on disk now, part by part, the running build standing in for one that can't be read. */
  disk(): { toil: Build; toilUi: Build } {
    return {
      toil: this.diskBuild(this.o.toilBundle, toilBuildOf) ?? this.o.running.toil,
      toilUi: this.diskBuild(this.o.uiBundle, uiBuildOf) ?? this.o.running.toilUi,
    };
  }

  /**
   * The toil project as toil reads it now, hashed; null when toil can't read it.
   * Kept against the toil project file's modification time and size, so a check
   * every turn asks toil again (and writes an audit line) only when the file
   * changed.
   */
  async toilProject(name: string): Promise<string | null> {
    const hit = this.toilProjects.get(name);
    if (hit) {
      const st = this.files.stat(hit.file);
      if (st && `${st.mtimeMs}:${st.size}` === hit.key) return hit.hash;
    }
    const e = await this.o.execute('projects show', { toilProject: name }, { readOnly: true, caller: CALLER });
    if (!e.ok) return null;
    const data = (e.data ?? {}) as { file?: unknown; toilProject?: unknown };
    const hash = sha256(data.toilProject ?? data);
    const st = typeof data.file === 'string' ? this.files.stat(data.file) : null;
    if (st) this.toilProjects.set(name, { file: data.file as string, key: `${st.mtimeMs}:${st.size}`, hash });
    else this.toilProjects.delete(name);
    return hash;
  }

  /** What a session about this toil project, with these prompts, starts on now. */
  async origin(toilProject: string, prompts: string): Promise<Fingerprint> {
    return { ...this.o.running, skills: this.skills, toilProject: await this.toilProject(toilProject), prompts };
  }

  /** The same, with the builds on disk: what a session is held to at every check. */
  async current(toilProject: string, prompts: string): Promise<Fingerprint> {
    return { ...this.disk(), skills: this.skills, toilProject: await this.toilProject(toilProject), prompts };
  }

  /** Why renewing can't help while the server is out of date, with the command that restarts it; null when it isn't. */
  restartNeeded(): string | null {
    const s = this.server();
    return s.stale ? `Toil UI itself is out of date (${s.stale.replace(/\.$/, '')}), so a session renewed now would start on the old build and be stale at once. Restart it first: ${s.restart}` : null;
  }

  /** The server's own staleness, for the header. */
  server(): ServerStatus {
    const disk = this.disk();
    return { running: this.o.running, disk, stale: serverStale(this.o.running, disk), restart: this.o.restart };
  }
}

/** The command line that starts this process again: node, its own flags (a loader hook), the bin and its arguments, quoted where a shell needs it. */
export function restartCommand(argv: readonly string[], execArgv: readonly string[] = []): string {
  const quote = (a: string) => (/^[\w./:=@\\-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  return ['node', ...execArgv, ...argv.slice(1)].map(quote).join(' ');
}
