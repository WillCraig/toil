/**
 * A catalog of small JSON rulebooks kept by name: classification schemes
 * (`~/.toil/classify/`) and ticket rules, called standards (`~/.toil/standards/`).
 * It is the toil project catalog's sibling and keeps its manners: a path a call
 * names is judged from its text before anything stats it, resolved through
 * realpath so a link can't lead out, kept off toil's own files, and a write is
 * validated, written beside the old file and renamed into place, never over
 * anything that isn't already one of its own kind (docs/bounds.md,
 * `classify.write`, `classify.replace` and `standards.read`). Files are looked up
 * in a fixed order, highest first: a file the call named, your own folder, the
 * repository's `.toil/<folder>/`, a path beside the toil project that names it,
 * and the ones built in. What differs between kinds (the folder, the noun, the
 * reader, the built-ins, the name form, the size cap and the words in a fix) is
 * a parameter; how a path is judged is not. Each file is signed for by exactly
 * one name, which is more than can be said for most spreadsheets of record.
 */
import { mkdirSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Warning } from './envelope.js';
import { ToilError } from './errors.js';
import { forwardSlashes, isSystemPath } from './files.js';
import { findGitRepo } from './git-repo.js';
import { assertLocalPath } from './local-path.js';
import { JsonSyntaxError, parseStrictJson } from './strict-json.js';
import { inside, readCapped, samePath, type CatalogOptions } from './toil-project.js';

/** Where a file was found, highest first: the call named it, your folder, the repository, beside the toil project, built in. */
export type CatalogSource = 'file' | 'user' | 'repo' | 'toil-project' | 'built-in';

/** One entry as resolved: the value, where it came from, its file when it has one, and what was worth saying about reading it. */
export interface Found<T> {
  value: T;
  source: CatalogSource;
  /** Absolute, with forward slashes. Absent for a built-in. */
  file?: string;
  warnings: Warning[];
}

/** What one kind of catalog is: everything a scheme and a standard don't share. */
export interface CatalogKind<T extends { name: string }> {
  /** The folder under `~/.toil/` and `.toil/`: `classify`, `standards`. */
  folder: string;
  /** The word for one entry in messages: `scheme`, `standard`. */
  noun: string;
  /** A name's form; a name is also its file name. */
  nameForm: RegExp;
  /** A name to show in a fix, e.g. `ktlo-feature`. */
  nameExample: string;
  /** The largest file read. */
  maxBytes: number;
  /** The start of every warning code: `SCHEME` gives `SCHEME_PATH_INVALID`, `SCHEME_INVALID`, `SCHEME_DUPLICATE_KEY`. */
  codePrefix: string;
  /** The pure reader: validates a parsed file and returns it normalised, or throws CONFIG_INVALID naming `where`. */
  read: (raw: unknown, where: string) => { value: T; warnings: Warning[] };
  /** The file's text, for `save`. Absent for a kind toil never writes. */
  content?: (value: T) => string;
  builtinNames: readonly string[];
  /** A copy of the built-in called `name`, or undefined. */
  builtin: (name: string) => T | undefined;
  /** The fix when a file is too large: what belongs in one. */
  holds: string;
  /** The fix when a named file is outside every allowed place. */
  outsideFix: string;
  /** The flag a call names a file with, for a fix: `--scheme <file>`. */
  flag: string;
  /** A sentence that creates the missing name, appended to NOT_FOUND's fix; absent when there is no such command. */
  createHint?: (name: string) => string;
}

export type FileCatalogOptions = Omit<CatalogOptions, 'areas'> & { areas?: CatalogOptions['areas'] };

export interface FileCatalog<T extends { name: string }> {
  /** A value a call gives: one ending in `.json` or holding a path separator is a file (source `file`), anything else a name. */
  byRef(ref: string, cwd?: string): Found<T>;
  /** A value a toil project gives: one starting `./` or `../`, or ending `.json`, is a file beside `toilProjectFile` (source `toil-project`); anything else a name. */
  fromToilProject(ref: string, toilProjectFile: string | undefined, cwd?: string): Found<T>;
  /** Every entry visible by name (yours, the repository's, built in), each name once from its highest source. A file that can't be read is a warning. */
  list(cwd?: string): { found: Found<T>[]; warnings: Warning[] };
  /** Your own folder, `~/.toil/<folder>`, and the repository's `.toil/<folder>` when `cwd` is in one. */
  places(cwd?: string): { user: string; repo?: string };
  /** Where your own entry named `name` lives. */
  userFile(name: string): string;
  /** `.toil/<folder>/` in the repository whose root is `dir`; INVALID_INPUT when `dir` isn't a repository's root. */
  repoFolder(dir: string): string;
  /** A path a call gave, absolute: relative to the CLI's working directory, or under MCP the workspace. */
  pathFor(value: string, what: string): string;
  /** Reads one file a call named, inside the bounds, whatever it is called; a file with no `name` takes `defaultName`. */
  readFile(path: string, cwd?: string, defaultName?: string): Found<T>;
  /**
   * Writes an entry, validated, to `path`: `create` refuses a file that is there,
   * `replace` replaces only a valid one. The path must be a `.json` file in your
   * own folder, a repository's `.toil/<folder>/` (named for the entry), or the
   * workspace, or, with `beside`, in the folder of that toil project file. Never
   * toil's own files, /proc or /sys. Returns the absolute path written.
   */
  save(path: string, value: T, mode: 'create' | 'replace', beside?: string): string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function createFileCatalog<T extends { name: string }>(kind: CatalogKind<T>, o: FileCatalogOptions): FileCatalog<T> {
  const { noun, folder: folderName } = kind;
  const Noun = capital(noun);
  const own = join(o.home, '.toil');
  const user = join(own, folderName);
  const guard = { home: o.home, env: o.env, protect: o.protect };
  const unbounded = o.config.bounds?.files === 'unbounded';

  /** A folder's canonical form whether or not it exists yet: the nearest folder that does, real-pathed, with the rest added back. */
  const real = (path: string) => {
    let existing = resolve(path);
    const rest: string[] = [];
    for (;;) {
      try {
        return join(realpathSync.native(existing), ...rest);
      } catch {
        const parent = resolve(existing, '..');
        if (parent === existing) return resolve(path);
        rest.unshift(basename(existing));
        existing = parent;
      }
    }
  };

  const fromBase = (value: string, what: string): string => {
    assertLocalPath(value, o.workspace.dir, what);
    const path = isAbsolute(value) ? resolve(value) : o.base === undefined ? undefined : resolve(o.base, value);
    if (path !== undefined) {
      assertLocalPath(path, o.workspace.dir, what);
      return path;
    }
    throw new ToilError('INVALID_INPUT', `${what} "${value}" is relative, and there's no folder to resolve it against.`, {
      fix: 'Pass an absolute path, or give the MCP server a workspace with --workspace <dir> or TOIL_WORKSPACE.',
    });
  };

  const folderOf = (cwd?: string): string | undefined => {
    if (cwd === undefined) return o.workspace.dir;
    const path = fromBase(cwd, 'The folder');
    let isDir = false;
    try {
      isDir = statSync(path).isDirectory();
    } catch {
      // said below
    }
    if (!isDir) throw new ToilError('INVALID_INPUT', `The folder ${forwardSlashes(path)} (from cwd) doesn't exist where toil is running.`, { fix: 'Pass a folder on this machine.' });
    return path;
  };

  const places = (cwd?: string) => {
    const dir = folderOf(cwd);
    const root = dir ? findGitRepo(dir, guard)?.root : undefined;
    const repo = root ? join(root, '.toil', folderName) : undefined;
    // A home folder that is itself a repository has one folder of these, not two.
    return { user, ...(repo && !samePath(real(repo), real(user)) ? { repo } : {}) };
  };

  /**
   * toil's own files, the --config file, /proc and /sys: never read or written as
   * one of these. Your own folder of them is the part of `~/.toil` a call may name,
   * and `also` is a folder the caller vetted (the one beside a toil project).
   */
  const forbidden = (realPath: string, also: readonly string[] = []) => {
    if (isSystemPath(realPath)) return true;
    if (o.protect.some((p) => !samePath(p, own) && inside(realPath, real(p)))) return true;
    return [own, ...o.protect].some((p) => inside(realPath, real(p))) && ![user, ...also].some((d) => inside(realPath, real(d)));
  };

  const inWorkspace = (realPath: string) => o.workspace.dir !== undefined && inside(realPath, real(o.workspace.dir));

  const missing = (path: string) =>
    new ToilError('INVALID_INPUT', `${forwardSlashes(path)} doesn't exist where toil is running.`, {
      fix: `Check the path. If toil runs somewhere else (a container, WSL, another host), its paths aren't yours: pass the ${noun} by name instead.`,
    });

  /** Reads and validates one file already judged to be in bounds. */
  const readAt = (path: string, source: CatalogSource, defaultName?: string): Found<T> => {
    const file = forwardSlashes(path);
    let text: string | undefined;
    try {
      text = readCapped(path, kind.maxBytes);
    } catch (err) {
      throw new ToilError('CONFIG_INVALID', `${Noun} ${file} can't be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}.`, { fix: `Check that ${file} is readable.` });
    }
    if (text === undefined) {
      throw new ToilError('CONFIG_INVALID', `${Noun} ${file} is larger than ${kind.maxBytes / 1024} KiB, the most a ${noun} file may be, so it wasn't read.`, { fix: kind.holds });
    }
    let parsed: ReturnType<typeof parseStrictJson>;
    try {
      parsed = parseStrictJson(text);
    } catch (err) {
      // Where, never what: the content stays in the file.
      const where = err instanceof JsonSyntaxError ? err.message : 'unreadable';
      throw new ToilError('CONFIG_INVALID', `${Noun} ${file} can't be used: it isn't valid JSON: ${where}.`, { fix: `Fix it in ${file}.` });
    }
    const raw = defaultName !== undefined && isRecord(parsed.value) && parsed.value.name === undefined ? { ...parsed.value, name: defaultName } : parsed.value;
    const { value, warnings } = kind.read(raw, file);
    for (const path of parsed.duplicates) warnings.push({ code: `${kind.codePrefix}_DUPLICATE_KEY`, message: `${file} (${path}): "${path}" is set twice; the last one is used.` });
    return { value, source, file, warnings };
  };

  /** A path a call names, in bounds and read: a `.json` file in the workspace or one of the places, never toil's config or /proc and /sys. */
  const readBounded = (path: string, source: CatalogSource, cwd: string | undefined, also: readonly string[], what: string, defaultName?: string): Found<T> => {
    const refuse = (why: string, fix: string) => new ToilError('INVALID_INPUT', `${forwardSlashes(path)} can't be read as a ${noun}: ${why}`, { fix });
    if (!path.toLowerCase().endsWith('.json')) throw refuse(`${what} ends in .json.`, `Pass a ${noun} file, or a ${noun} by name.`);
    // Decided before anything is looked at, so a path outside can't be probed for whether it exists.
    const target = real(path);
    if (forbidden(target, also)) throw refuse("that's one of toil's own files, or a system path.", `Pass a ${noun} file, or a ${noun} by name.`);
    const where = places(cwd);
    const allowed = inWorkspace(target) || [where.user, ...(where.repo ? [where.repo] : []), ...also].some((d) => inside(target, real(d)));
    if (!allowed && !unbounded) {
      throw refuse(`it's outside the workspace${o.workspace.dir ? ` (${forwardSlashes(o.workspace.dir)})` : ''} and outside every ${noun} folder.`, kind.outsideFix);
    }
    let realPath: string;
    try {
      realPath = realpathSync.native(path);
      if (!statSync(realPath).isFile()) throw new Error('not a file');
    } catch {
      throw missing(path);
    }
    return readAt(realPath, source, defaultName);
  };

  /** `<dir>/<name>.json` as the entry called `name`, or undefined when no such file; a link out of `dir` is a warning and no entry. */
  const named = (dir: string | undefined, name: string, source: CatalogSource, warnings: Warning[]): Found<T> | undefined => {
    if (!dir) return undefined;
    const file = join(dir, `${name}.json`);
    try {
      if (!statSync(file).isFile()) return undefined;
    } catch {
      return undefined;
    }
    const target = real(file);
    if (!inside(target, real(dir)) || forbidden(target, [dir])) {
      warnings.push({ code: `${kind.codePrefix}_PATH_INVALID`, message: `${forwardSlashes(file)} was skipped: it's a link to a file outside ${forwardSlashes(dir)}.` });
      return undefined;
    }
    const found = readAt(target, source);
    if (found.value.name !== name) {
      throw new ToilError('CONFIG_INVALID', `${Noun} ${forwardSlashes(file)} is named "${found.value.name}", and a ${noun}'s name must be its file name ("${name}").`, {
        fix: `Set "name" to "${name}" in the file, or rename the file to ${found.value.name}.json.`,
      });
    }
    return { ...found, warnings: [...found.warnings, ...warnings] };
  };

  const isFileRef = (value: string) => value.toLowerCase().endsWith('.json') || /[\\/]/.test(value);
  const isRelativeRef = (value: string) => /^\.\.?[\\/]/.test(value) || value.toLowerCase().endsWith('.json');

  const listNames = (cwd?: string): string[] => {
    try {
      return list(cwd).found.map((s) => s.value.name);
    } catch {
      return [...kind.builtinNames];
    }
  };

  const byName = (name: string, cwd: string | undefined): Found<T> => {
    if (!kind.nameForm.test(name)) {
      throw new ToilError('INVALID_INPUT', `"${name}" isn't a ${noun} name or a ${noun} file.`, {
        fix: `A name is lowercase letters, digits and single hyphens, e.g. ${kind.nameExample}; a file ends in .json.`,
      });
    }
    const where = places(cwd);
    const warnings: Warning[] = [];
    const found = named(where.user, name, 'user', warnings) ?? named(where.repo, name, 'repo', warnings);
    if (found) return found;
    const built = kind.builtin(name);
    if (built) return { value: built, source: 'built-in', warnings };
    throw new ToilError('NOT_FOUND', `There's no ${noun} named "${name}" here.`, {
      fix: `Use one of: ${listNames(cwd).join(', ')}; or pass a path to a ${noun} file.${kind.createHint ? ` ${kind.createHint(name)}` : ''}`,
    });
  };

  const byRef: FileCatalog<T>['byRef'] = (ref, cwd) => {
    if (isFileRef(ref)) return readBounded(fromBase(ref, `The ${noun} file`), 'file', cwd, [], `a ${noun} file`);
    return byName(ref, cwd);
  };

  const fromToilProject: FileCatalog<T>['fromToilProject'] = (wanted, beside, cwd) => {
    if (!isRelativeRef(wanted)) return byName(wanted, cwd);
    if (!beside) {
      throw new ToilError('INVALID_INPUT', `The toil project's ${noun} "${wanted}" is a path, and the toil project has no file to take it from.`, { fix: `Name the ${noun} instead, or pass ${kind.flag}.` });
    }
    const folder = dirname(beside);
    const path = resolve(folder, wanted);
    assertLocalPath(path, o.workspace.dir, `The ${noun} file`);
    return readBounded(path, 'toil-project', cwd, [folder], `a ${noun} file`);
  };

  const list: FileCatalog<T>['list'] = (cwd) => {
    const where = places(cwd);
    const found: Found<T>[] = [];
    const warnings: Warning[] = [];
    const taken = new Set<string>();
    for (const [dir, source] of [[where.user, 'user'], [where.repo, 'repo']] as const) {
      if (!dir) continue;
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')).sort();
      } catch {
        continue;
      }
      for (const n of names) {
        const name = n.replace(/\.json$/i, '');
        if (taken.has(name)) continue;
        // A broken file still holds its name, as it does for a call: the next source down doesn't speak for it.
        taken.add(name);
        try {
          if (!kind.nameForm.test(name)) {
            warnings.push({ code: `${kind.codePrefix}_PATH_INVALID`, message: `${forwardSlashes(join(dir, n))} was skipped: "${name}" isn't a valid ${noun} name.` });
            continue;
          }
          const local: Warning[] = [];
          const one = named(dir, name, source, local);
          if (one) {
            warnings.push(...one.warnings);
            found.push({ ...one, warnings: [] });
          } else warnings.push(...local);
        } catch (err) {
          if (!(err instanceof ToilError)) throw err;
          warnings.push({ code: `${kind.codePrefix}_INVALID`, message: err.message });
        }
      }
    }
    for (const name of kind.builtinNames) if (!taken.has(name)) found.push({ value: kind.builtin(name)!, source: 'built-in', warnings: [] });
    return { found, warnings };
  };

  const repoFolder = (dir: string): string => {
    const path = fromBase(dir, 'The repository');
    const repo = findGitRepo(path, guard);
    if (!repo || !samePath(repo.root, path)) {
      throw new ToilError('INVALID_INPUT', `${forwardSlashes(path)} isn't the root of a git repository${repo ? ` (its root is ${repo.root})` : ''}.`, {
        fix: repo ? `Pass ${repo.root}.` : 'Pass the top folder of a working tree, the one that holds .git.',
      });
    }
    return join(path, '.toil', folderName);
  };

  const save: FileCatalog<T>['save'] = (path, value, mode, beside) => {
    const content = kind.content;
    if (!content) throw new Error(`toil never writes a ${noun}; this catalog has no content function.`);
    assertLocalPath(path, o.workspace.dir, `The ${noun} file`);
    const target = resolve(path);
    assertLocalPath(target, o.workspace.dir, `The ${noun} file`);
    const refuse = (why: string, fix: string) => new ToilError('INVALID_INPUT', `toil won't write a ${noun} to ${forwardSlashes(target)}: ${why}`, { fix });
    if (!target.toLowerCase().endsWith('.json')) throw refuse(`a ${noun} file ends in .json.`, 'Name a .json file.');
    // Judged where it would really land, through any link in the folders above it.
    const realTarget = real(target);
    const next = beside ? [dirname(beside)] : [];
    if (forbidden(realTarget, next)) throw refuse("that's one of toil's own files, or a system path.", `Write it to your ${noun} folder, a repository, or the workspace.`);
    const folder = resolve(realTarget, '..');
    const root = resolve(folder, '..', '..');
    const inRepoFolder = basename(folder) === folderName && basename(resolve(folder, '..')) === '.toil' && samePath(findGitRepo(root, guard)?.root ?? '', root);
    const yours = inside(realTarget, real(user));
    const besideToilProject = next.some((d) => samePath(real(d), folder));
    if (!yours && !inRepoFolder && !besideToilProject && !inWorkspace(realTarget) && !unbounded) {
      throw refuse(`it's outside the workspace${o.workspace.dir ? ` (${forwardSlashes(o.workspace.dir)})` : ''} and outside every ${noun} folder.`, 'Write it inside the workspace (--workspace <dir> chooses another), or to a repository with --repo.');
    }
    // In a folder of these the file name is how a name finds the entry, so the two must agree.
    if ((yours || inRepoFolder) && basename(realTarget).toLowerCase() !== `${value.name}.json`) {
      throw refuse(`a ${noun} in a ${noun} folder is kept in <name>.json, and this one is named "${value.name}".`, `Write it to ${value.name}.json.`);
    }
    let exists = false;
    try {
      exists = statSync(realTarget).isFile();
    } catch {
      // nothing there yet
    }
    if (exists && mode === 'create') throw refuse('a file is already there.', `Pass --replace to replace a ${noun}, or choose another name.`);
    if (exists) {
      let valid = true;
      try {
        readAt(realTarget, 'file');
      } catch {
        valid = false;
      }
      if (!valid) throw refuse(`the file there isn't a valid ${noun}, and toil only ever replaces a ${noun}.`, 'Choose another path, or move that file aside.');
    }
    // Checked with the reader that will load it, so toil never writes one it would refuse.
    const checked = kind.read(JSON.parse(content(value)) as unknown, value.name).value;
    // Your own folder is yours alone, as the config is; a repository's files take the repository's.
    mkdirSync(folder, { recursive: true, ...(yours ? { mode: 0o700 } : {}) });
    // Written alongside and renamed into place, so a crash halfway leaves the old file, not half a new one.
    const temp = `${realTarget}.${process.pid}.tmp`;
    writeFileSync(temp, content(checked), { encoding: 'utf8', ...(yours ? { mode: 0o600 } : {}) });
    renameSync(temp, realTarget);
    return forwardSlashes(realTarget);
  };

  return {
    byRef,
    fromToilProject,
    list,
    places,
    userFile: (name) => join(user, `${name}.json`),
    repoFolder,
    pathFor: fromBase,
    readFile: (path, cwd, defaultName) => readBounded(fromBase(path, `The ${noun} file`), 'file', cwd, [], `a ${noun} file`, defaultName),
    save,
  };
}
