import { on } from 'node:events';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import type { Readable } from 'node:stream';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToilError } from './errors.js';
import { gitBool, lastValue, refusedGitRead } from './git-config.js';
import { findGitRepo, readGitConfig, readGitIndex } from './git-repo.js';
import { ignoredFolderWarning, isIgnored, parseIgnore, skippedLineWarning, undecodableIgnoreWarning, unreadableIgnoreWarning, type IgnoreRule } from './gitignore.js';
import { assertLocalPath } from './local-path.js';
import { readAll } from './stdin.js';

/**
 * The local files a command may read or write: an `--input-file`, a file to
 * upload, a directory to save a download into, a CSV report. Commands go
 * through this rather than `node:fs` so that both front doors resolve paths
 * the same way, tests run against an in-memory copy, and `-` (stdin) means
 * something only where stdin is actually free. Over MCP, stdin is the
 * protocol, so it isn't.
 *
 * Every path resolves inside one **workspace** folder, checked after realpath
 * so `..`, symlinks and junctions can't leave it (docs/bounds.md). Relative
 * paths resolve against the workspace. A config setting, `"bounds": {
 * "files": "unbounded" }`, lifts that, but never the refusals of toil's own
 * files and of `/proc` and `/sys`, and never the refusal to overwrite.
 *
 * Paths a command returns are absolute, with forward slashes on every
 * platform (CLAUDE.md, Cross-Platform). The filing system accepts either
 * slash; the filing cabinet, historically, only one.
 */
export interface ReadOptions {
  /** Ends the read, `-` included, when it fires. execute() passes the command's own signal; a command never does. */
  signal?: AbortSignal;
}

export interface FileAccess {
  /** The workspace folder, absolute with forward slashes; undefined when none is set (MCP with no single root). */
  readonly workspace: string | undefined;
  /** Absolute path on disk for `path`, resolved against the workspace. A relative path with no workspace is NOT_CONFIGURED. */
  resolve(path: string): string;
  /**
   * A file's text, as UTF-8. `-` reads stdin where the front door allows it,
   * asynchronously until the writer closes the pipe, so the command's time
   * limit and Ctrl+C still end the wait (execute() hands the read its signal).
   */
  readText(path: string, options?: ReadOptions): Promise<string>;
  /** A file's bytes; `-` and the signal as for readText. */
  readBytes(path: string, options?: ReadOptions): Promise<Uint8Array>;
  /**
   * A file's bytes in chunks as they are read, so a command can work through a
   * file of any size in constant memory. `-` streams stdin, in the chunks it arrives in rather than `chunkSize`, where the front door
   * allows it. The bounds are checked when it's called, before any chunk, so a
   * refused path throws at once; a read that fails later throws from the loop.
   */
  readStream(path: string, options?: { signal?: AbortSignal; chunkSize?: number }): AsyncIterable<Uint8Array>;
  /** Writes `data`, creating parent directories. Refuses with INVALID_INPUT if a file is already there. Returns the absolute path written, with forward slashes. */
  writeBytes(path: string, data: Uint8Array): string;
  /** Whether anything is at `path`. A path outside the bounds is refused, not answered. */
  exists(path: string): boolean;
  /** What is at `path`; INVALID_INPUT when nothing is. */
  stat(path: string): FileStat;
  /**
   * Every file under `dir` (default: the workspace), relative to it, with
   * forward slashes, sorted. `.git` is always skipped. With `gitignore` (the
   * default) inside a repository, it's what `git ls-files --cached --others
   * --exclude-standard` lists: tracked files, ignored or not, plus untracked
   * ones no ignore rule covers, and a nested repository as `name/`. Symlinks
   * are listed, never followed. More than `limit` files (default 100,000) is
   * INVALID_INPUT. A git config include it refuses to read, a `.gitignore`
   * line it can't compile (skipped alone, the rest of that file still applying),
   * and an ignore file that exists but can't be read or isn't UTF-8, are
   * reported through `warn`, which execute() points at meta.warnings.
   */
  list(dir?: string, options?: { gitignore?: boolean; limit?: number; warn?: (warning: { code: string; message: string }) => void }): string[];
  /**
   * The nearest `name`, looking in `from` (default: the workspace) and then
   * each parent, stopping at the workspace's top (or the filesystem's, when
   * unbounded). Absolute, forward slashes; undefined when there's none.
   */
  findUp(name: string, from?: string): string | undefined;
  /** Writes a CSV file (decision 4: CSV goes to a file, never stdout). Never overwrites. Returns the absolute path. */
  writeCsv(path: string, header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string;
}

export interface FileStat {
  type: 'file' | 'directory' | 'other';
  size: number;
  /** Last modified, ISO 8601. */
  modified: string;
}

/** `C:\work\a.txt` -> `C:/work/a.txt`, for JSON output. */
export function forwardSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

/** The error for a file that couldn't be read, shared by every FileAccess. */
export function readFailed(path: string, err: unknown): ToilError {
  const reason = (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'it does not exist' : (err as Error).message;
  return new ToilError('INVALID_INPUT', `Cannot read ${path === '-' ? 'stdin' : `file "${path}"`}: ${reason}.`, {
    fix: path === '-' ? 'Pipe the content into toil, or pass a file path instead of "-".' : 'Check the path. Relative paths resolve against the workspace.',
  });
}

/** Where `-` can't mean stdin. */
export const STDIN_OVER_MCP = new ToilError('INVALID_INPUT', '"-" (stdin) is not available over MCP: stdin carries the protocol.', {
  fix: 'Pass the content inline, or write it to a file and pass the file path.',
});

/**
 * `-` on a terminal: nobody piped anything in, so reading would sit waiting for
 * someone to type and press Ctrl+D, and look like a hang (principle 4).
 */
export const STDIN_IS_TERMINAL = new ToilError('INVALID_INPUT', 'Nothing was piped in, and stdin is a terminal, so toil did not wait for input.', {
  fix: 'Pass --input-file <path> or pipe the input. Where a flag was given "-", give it a file path instead.',
});

/** The error for a write that would replace a file already there. */
export function alreadyExists(path: string): ToilError {
  return new ToilError('INVALID_INPUT', `"${forwardSlashes(path)}" already exists.`, {
    fix: 'Delete it or write somewhere else. toil never overwrites a file.',
  });
}

/**
 * Names Windows keeps for devices, whatever the extension (`CON.txt` is the
 * console too), and in any case. The digits include the superscripts Windows
 * also accepts (`COM¹`). Refused on every platform, so a file name works or
 * fails the same way everywhere (principle 8).
 */
const DEVICE_NAME = /^(?:con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/**
 * Why one segment of a path can't be a file name toil writes, or undefined
 * when it can: a device name, a `:` (an NTFS stream, which writes into a file
 * that already exists without the no-overwrite check ever seeing it), or a
 * trailing dot or space (which Windows drops, so `notes.txt.` is `notes.txt`).
 */
export function unsafeFileName(segment: string): string | undefined {
  if (segment.includes(':')) return 'it has a ":", which on Windows names a stream inside another file';
  if (/[. ]$/.test(segment) && segment !== '.' && segment !== '..') return 'it ends in a dot or a space, which Windows drops, so it would name a different file';
  const stem = segment.split('.')[0]!.replace(/ +$/, '');
  if (DEVICE_NAME.test(stem)) return `"${stem}" is a name Windows reserves for a device`;
  return undefined;
}

/**
 * A file name a server supplied (an attachment's), made safe to save on any
 * platform: only its last path segment, with any `:` suffix, Windows'
 * forbidden characters, trailing dots and spaces dropped, and a device name
 * prefixed with `_`. What's left is checked by `unsafeFileName` when written,
 * and the no-overwrite check sees the name the file really gets.
 */
export function downloadFileName(name: string, fallback = 'download'): string {
  let out = name.split(/[\\/]/).filter((s) => s !== '').pop() ?? '';
  const colon = out.indexOf(':');
  if (colon !== -1) out = out.slice(0, colon);
  // eslint-disable-next-line no-control-regex
  out = out.replace(/[<>"|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  if (out === '' || out === '.' || out === '..') return fallback;
  return unsafeFileName(out) ? `_${out}` : out;
}

/**
 * Refuses a path to write whose segments `unsafeFileName` turns down. Only the
 * segments the call named, not the folders above them, and a leading drive
 * letter is a drive.
 */
export function refuseUnsafeName(path: string): void {
  for (const [i, segment] of forwardSlashes(path).split('/').entries()) {
    if (segment === '' || (i === 0 && /^[a-z]:$/i.test(segment))) continue;
    const unsafe = unsafeFileName(segment);
    if (unsafe) {
      throw new ToilError('INVALID_INPUT', `"${forwardSlashes(path)}" can't be written: ${unsafe}.`, {
        fix: 'Choose another file or folder name.',
      });
    }
  }
}

/** The error for a path inside toil's own config. It names the path, never what is in it. */
export function protectedPath(path: string): ToilError {
  return new ToilError('INVALID_INPUT', `"${forwardSlashes(path)}" is toil's own configuration, which commands may not read or write.`, {
    fix: 'Pass a file outside ~/.toil and the --config file. Credentials reach a command only through its connection.',
  });
}

/** The error for a path under /proc or /sys. */
export function systemPath(path: string): ToilError {
  return new ToilError('INVALID_INPUT', `"${forwardSlashes(path)}" is under /proc or /sys, which commands may not read.`, {
    fix: 'Pass an ordinary file. Process and kernel files can hold the environment, and with it credentials.',
  });
}

/** The relaxation named in every workspace refusal. */
export const UNBOUNDED_SETTING = '"bounds": { "files": "unbounded" }';

/** The error for a path outside the workspace. */
export function outsideWorkspace(path: string, workspace: string): ToilError {
  return new ToilError('INVALID_INPUT', `"${forwardSlashes(path)}" is outside the workspace, ${forwardSlashes(workspace)}. Commands read and write files only inside it.`, {
    fix: `Pass a path inside ${forwardSlashes(workspace)}, or choose another workspace with --workspace <dir> or TOIL_WORKSPACE. To let commands reach any path, set ${UNBOUNDED_SETTING} in your toil config.`,
  });
}

/** Which folder is the workspace, and why. */
export interface Workspace {
  /** The folder, absolute, when there is one. Containment is checked against its real path. */
  dir?: string;
  /** Why there isn't one; thrown by the first file operation, so commands that touch no files are unaffected. */
  error?: ToilError;
  source: 'flag' | 'env' | 'cwd' | 'mcp-root' | 'none';
}

const HOW_TO_SET = 'Pass --workspace <dir> (in the MCP server\'s args for toil mcp), set TOIL_WORKSPACE, or use an MCP client that shares exactly one root.';

/**
 * The workspace, in order: `--workspace`, then TOIL_WORKSPACE, then the CLI's
 * working directory, then the MCP client's root when it shares exactly one.
 * `toil mcp` doesn't fall back to its own working directory: an MCP client
 * starts the server wherever it likes, often the user's home, and that is not
 * a decision anyone made about which files an agent may touch.
 */
export function resolveWorkspace(options: { flag?: string | undefined; env: NodeJS.ProcessEnv; cwd: string; mcp: boolean; roots?: readonly string[] | undefined }): Workspace {
  const pick = (raw: string, source: Workspace['source'], named: string): Workspace => {
    const dir = resolve(options.cwd, raw);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      // reported below
    }
    if (!isDir) {
      return {
        source,
        error: new ToilError('INVALID_INPUT', `The workspace ${forwardSlashes(dir)} (from ${named}) isn't a folder that exists.`, {
          fix: 'Point --workspace or TOIL_WORKSPACE at an existing folder.',
        }),
      };
    }
    return { dir, source };
  };
  if (options.flag) return pick(options.flag, 'flag', '--workspace');
  const env = options.env.TOIL_WORKSPACE;
  if (env) return pick(env, 'env', 'TOIL_WORKSPACE');
  if (!options.mcp) return pick(options.cwd, 'cwd', 'the working directory');
  const roots = options.roots ?? [];
  if (roots.length === 1) return pick(roots[0]!, 'mcp-root', "the MCP client's root");
  return {
    source: 'none',
    error: new ToilError(
      'NOT_CONFIGURED',
      roots.length > 1
        ? `This command reads or writes files, but there's no workspace: the MCP client shared ${roots.length} roots, and toil uses one only when there's exactly one.`
        : "This command reads or writes files, but there's no workspace folder to keep them in.",
      { fix: HOW_TO_SET },
    ),
  };
}

/**
 * `path` with every symlink, junction and `..` resolved, as far as it exists:
 * the longest existing ancestor goes through realpath and the rest is appended.
 * A path that doesn't exist yet (a download target) is judged by where it
 * would land.
 */
function realish(path: string): string {
  let existing = resolve(path);
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    rest.unshift(basename(existing));
    existing = parent;
  }
  let real = existing;
  try {
    real = realpathSync.native(existing);
  } catch {
    // keep the resolved form
  }
  return join(real, ...rest);
}

/**
 * Kernel views of running processes. `/proc/self/environ` holds every env var,
 * and env vars are where toil's tokens live, so a command reading files could
 * otherwise read the credentials it was never given. No toil command has a
 * reason to read anything under either, so both are refused whole. The
 * check takes the path after realpath, so a symlink to them is refused too.
 */
export function isSystemPath(realPath: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return false;
  return /^\/(proc|sys)(\/|$)/.test(realPath);
}

/** Windows paths compare case-insensitively; macOS and Linux paths as written. */
const comparable = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);

/** `child` is `parent` or inside it, both already real and comparable. */
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** A CSV document: header, then rows, LF line ends, fields quoted only when they hold a comma, quote or line break. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly unknown[]>): string {
  const field = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [header, ...rows].map((row) => row.map(field).join(',')).join('\n') + '\n';
}

export const DEFAULT_LIST_LIMIT = 100_000;

/** How much `readStream` reads at a time unless asked otherwise. */
export const STREAM_CHUNK = 64 * 1024;

export function tooManyFiles(dir: string, limit: number): ToilError {
  return new ToilError('INVALID_INPUT', `${forwardSlashes(dir)} holds more than ${limit} files.`, { fix: 'List a narrower folder.' });
}

/**
 * Real files. `stdin: false` for MCP, where `-` can't mean stdin, and
 * `'terminal'` when stdin is an interactive terminal, where `-` refuses at
 * once rather than waiting for someone to type. `protect`
 * lists toil's own config: the config home (`~/.toil`) and the `--config`
 * file. Nothing at or under them is read or written, however the path is
 * spelt, bounded or not, because a command handed a path by an agent (a
 * prompt in an issue description, say) would otherwise send other
 * connections' tokens to its own host. The keys to the filing cabinet are not
 * themselves on file.
 *
 * `workspace` is where every path must land (default: `cwd`, the CLI's
 * case). `unbounded` lifts that one rule. `home` and `env` are for git's
 * global ignore file when listing.
 */
export function nodeFiles(options: {
  cwd: string;
  stdin: boolean | 'terminal';
  protect?: string[];
  workspace?: Workspace;
  unbounded?: boolean;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Where `-` reads from: `process.stdin`, unless a test hands in its own stream. */
  stdinStream?: () => Readable;
}): FileAccess {
  const stdinStream = options.stdinStream ?? (() => process.stdin);
  const ws: Workspace = options.workspace ?? { dir: resolve(options.cwd), source: 'cwd' };
  const wsReal = ws.dir ? comparable(realish(ws.dir)) : undefined;
  const unbounded = options.unbounded === true;
  const noWorkspace = () => ws.error ?? new ToilError('NOT_CONFIGURED', "This command reads or writes files, but there's no workspace folder to keep them in.", { fix: HOW_TO_SET });
  /**
   * Where `path` lands, from its text alone. Every operation starts here, so a
   * network or device path (src/core/local-path.ts) is refused before any
   * `node:fs` call, bound relaxed or not: as typed, and as resolved against the
   * workspace. Inside a workspace that is itself on a share, it's allowed.
   */
  const at = (path: string) => {
    assertLocalPath(path, ws.dir);
    if (isAbsolute(path)) return path;
    // With no workspace there's nothing to be relative to, bounded or not: under
    // MCP the process's own working directory is wherever the client started it.
    if (ws.dir) {
      const resolved = resolve(ws.dir, path);
      assertLocalPath(resolved, ws.dir);
      return resolved;
    }
    throw noWorkspace();
  };
  const guarded = (options.protect ?? []).map((p) => comparable(realish(p)));
  /** Throws unless `target` is within every bound; returns its real path. */
  const check = (target: string): string => {
    const resolved = realish(target);
    if (isSystemPath(resolved)) throw systemPath(target);
    const real = comparable(resolved);
    if (guarded.some((g) => inside(real, g))) throw protectedPath(target);
    if (!unbounded) {
      if (!wsReal) throw noWorkspace();
      if (!inside(real, wsReal)) throw outsideWorkspace(target, ws.dir!);
    }
    return resolved;
  };
  const read = async (path: string, readOptions: ReadOptions = {}): Promise<Buffer> => {
    if (path === '-' && !options.stdin) throw STDIN_OVER_MCP;
    if (path === '-' && options.stdin === 'terminal') throw STDIN_IS_TERMINAL;
    const target = path === '-' ? undefined : at(path);
    if (target !== undefined) check(target);
    const { signal } = readOptions;
    try {
      // A file on disk is read at once; only stdin can keep a caller waiting, so only stdin is a stream.
      return target === undefined ? await readAll(stdinStream(), signal) : readFileSync(target);
    } catch (err) {
      // A time limit or a cancel is execute()'s to report, with its own error.
      if (signal?.aborted) throw signal.reason;
      throw readFailed(path, err);
    }
  };
  const readStream = (path: string, streamOptions: { signal?: AbortSignal; chunkSize?: number } = {}): AsyncIterable<Uint8Array> => {
    if (path === '-' && !options.stdin) throw STDIN_OVER_MCP;
    if (path === '-' && options.stdin === 'terminal') throw STDIN_IS_TERMINAL;
    const target = path === '-' ? undefined : at(path);
    if (target !== undefined) check(target);
    const settings = { highWaterMark: streamOptions.chunkSize ?? STREAM_CHUNK, ...(streamOptions.signal ? { signal: streamOptions.signal } : {}) };
    return (async function* () {
      if (target === undefined) {
        // stdin as the process's own stream, never a second reader on fd 0 (which
        // fails with EAGAIN on a non-blocking pipe), in the chunks it arrives in.
        // It stays open afterwards: it belongs to the process, not to this command.
        const stdin = stdinStream();
        if (stdin.readableEnded || stdin.destroyed) return;
        try {
          // highWaterMark: on() pauses stdin while this many chunks wait unread and resumes
          // it as they drain, so a slow consumer holds a bounded amount however much is piped.
          const chunks = on(stdin, 'data', { close: ['end'], highWaterMark: 16, ...(streamOptions.signal ? { signal: streamOptions.signal } : {}) });
          // A data listener starts a paused stream only the first time; after any pause
          // (an earlier read's finally) it must be resumed, or this waits forever.
          stdin.resume();
          for await (const [chunk] of chunks) {
            yield new Uint8Array(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
          }
        } catch (err) {
          if ((err as Error).name === 'AbortError') throw err;
          throw readFailed(path, err);
        } finally {
          stdin.pause();
        }
        return;
      }
      const stream = createReadStream(target, settings);
      try {
        for await (const chunk of stream) yield new Uint8Array(chunk as Buffer);
      } catch (err) {
        if ((err as Error).name === 'AbortError') throw err;
        throw readFailed(path, err);
      }
    })();
  };
  const writeBytes = (path: string, data: Uint8Array): string => {
    const target = at(path);
    check(target);
    refuseUnsafeName(path);
    try {
      mkdirSync(dirname(target), { recursive: true });
      // wx: fail rather than replace, bound on or off. A download names its own
      // file, and a read-only command must not change what's already on disk
      // (principle 2).
      writeFileSync(target, data, { flag: 'wx' });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw alreadyExists(target);
      throw new ToilError('INVALID_INPUT', `Cannot write "${forwardSlashes(target)}": ${(err as Error).message}.`, {
        fix: 'Choose a directory you can write to.',
      });
    }
    return forwardSlashes(resolve(target));
  };
  return {
    workspace: ws.dir ? forwardSlashes(ws.dir) : undefined,
    resolve: at,
    readText: async (path, readOptions) => (await read(path, readOptions)).toString('utf8'),
    readBytes: async (path, readOptions) => new Uint8Array(await read(path, readOptions)),
    readStream,
    writeBytes,
    exists: (path) => existsSync(check(at(path))),
    stat: (path) => {
      const target = check(at(path));
      let s;
      try {
        s = statSync(target);
      } catch (err) {
        throw readFailed(path, err);
      }
      return { type: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other', size: s.size, modified: s.mtime.toISOString() };
    },
    list: (dir = '.', listOptions = {}) => {
      const root = check(at(dir));
      return listTree(root, { gitignore: listOptions.gitignore !== false, limit: listOptions.limit ?? DEFAULT_LIST_LIMIT, home: options.home ?? '', env: options.env ?? {}, protect: options.protect ?? [], ...(listOptions.warn ? { warn: listOptions.warn } : {}) });
    },
    findUp: (name, from = '.') => {
      let dir = resolve(at(from));
      check(dir);
      const top = unbounded ? undefined : wsReal;
      for (;;) {
        const candidate = join(dir, name);
        if (existsSync(candidate)) {
          check(candidate);
          return forwardSlashes(candidate);
        }
        if (top && comparable(realish(dir)) === top) return undefined;
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
    },
    writeCsv: (path, header, rows) => writeBytes(path, new TextEncoder().encode(toCsv(header, rows))),
  };
}

/**
 * The listing behind `list()`, matching `git ls-files --cached --others
 * --exclude-standard` run in `root`, which is how the files to scan used to be
 * found:
 *   - every tracked path under `root`, read from the index, ignored or not
 *   - every other file that no ignore rule covers, never inside an ignored
 *     folder, and none at all when `root` itself sits in an ignored folder
 *   - an untracked nested repository as its folder name with a trailing `/`,
 *     not walked into
 * Ignore rules are matched against paths relative to the repository's top,
 * as git matches them. They come from `info/exclude` and every `.gitignore`
 * from the repository's top down; the ones above `root` are git metadata,
 * read under the same exception as `.git` (docs/bounds.md) and only to decide
 * what to skip. The global excludes file (`core.excludesFile`) is not read:
 * it isn't on the read-up list, so a pattern only it holds is listed. Outside a repository only
 * the `.gitignore` files under `root` apply (git itself would list nothing).
 */
function listTree(root: string, o: { gitignore: boolean; limit: number; home: string; env: NodeJS.ProcessEnv; protect: readonly string[]; warn?: (warning: { code: string; message: string }) => void }): string[] {
  const found = new Set<string>();
  const repo = o.gitignore ? findGitRepo(root, { home: o.home, protect: o.protect }) : undefined;
  const matchRoot = repo ? resolve(repo.root) : root;
  const prefix = forwardSlashes(relative(matchRoot, root));
  const out = (path: string) => (prefix === '' ? path : path.slice(prefix.length + 1));
  const add = (path: string) => {
    found.add(out(path));
    if (found.size > o.limit) throw tooManyFiles(root, o.limit);
  };
  let caseFold = process.platform === 'win32' || process.platform === 'darwin';
  const base: IgnoreRule[] = [];
  // A missing .gitignore is the usual case and means no rules, and it's the
  // only failure that goes unsaid. One that exists but can't be read (no
  // permission, a lock, a folder of that name) applies no rules either, and is
  // reported, since the files it excludes are now listed (#264). A file that
  // isn't UTF-8 still applies, decoded with replacements, and is reported too.
  // A line that won't compile leaves out only that line, and is reported,
  // because dropping the file's other rules would list what they exclude with
  // nothing to say so (#262).
  const readRules = (file: string, at: string) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // ENOTDIR: a parent of the path is a file (an `info` file where git
      // expects a folder), so there is no ignore file there to read.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') o.warn?.(unreadableIgnoreWarning(file, err));
      return [];
    }
    let text: string;
    try {
      // ignoreBOM keeps a byte-order mark in the text, as readFileSync's 'utf8' did.
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      o.warn?.(undecodableIgnoreWarning(file));
      text = bytes.toString('utf8');
    }
    return parseIgnore(text, at, caseFold, (skipped) => o.warn?.(skippedLineWarning(file, skipped)));
  };
  let others = true;
  let ignoredAt: string | undefined;
  const tracked = new Set<string>();
  if (repo) {
    const config = readGitConfig(repo, { home: o.home, env: o.env, protect: o.protect, ...(o.warn ? { warn: o.warn } : {}) });
    caseFold = gitBool(lastValue(config, 'core.ignorecase')) ?? false;
    base.push(...readRules(join(repo.commonDir, 'info', 'exclude'), ''));
    // .gitignore files between the repository's top and the listing root, and
    // whether one of the folders on the way is itself ignored.
    let rel = '';
    for (const part of prefix === '' ? [] : prefix.split('/')) {
      const parentIgnore = join(matchRoot, rel, '.gitignore');
      if (!refusedGitRead(parentIgnore, o.home, o.protect)) base.push(...readRules(parentIgnore, rel));
      rel = rel === '' ? part : `${rel}/${part}`;
      if (others && isIgnored(rel, true, base)) {
        others = false;
        ignoredAt = rel;
      }
    }
    for (const path of readGitIndex(repo)) {
      tracked.add(path);
      if (prefix === '' || path.startsWith(`${prefix}/`)) add(path);
    }
  }
  const walk = (dir: string, rel: string, rules: IgnoreRule[]) => {
    const here = o.gitignore ? [...rules, ...readRules(join(dir, '.gitignore'), rel)] : rules;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      const isDir = entry.isDirectory();
      if (o.gitignore && isIgnored(path, isDir, here)) continue;
      if (isDir && o.gitignore && existsSync(join(dir, entry.name, '.git'))) {
        // Another repository: git shows it as one entry and doesn't look inside.
        if (!tracked.has(path)) add(`${path}/`);
        continue;
      }
      if (isDir) walk(join(dir, entry.name), path, here);
      else add(path);
    }
  };
  if (others) walk(root, prefix, base);
  else o.warn?.(ignoredFolderWarning(root, ignoredAt!, found.size));
  return [...found].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
