/**
 * Where classification schemes live, and the only place that reads or writes
 * them: the generic file catalog (src/core/file-catalog.ts) set up for schemes,
 * which keeps the toil project catalog's manners (docs/bounds.md,
 * `classify.write` and `classify.replace`). Schemes are looked up in a fixed
 * order, highest first: a file the call named, your own folder
 * (`~/.toil/classify/`), the repository's `.toil/classify/`, a path beside the
 * toil project that names it, and the built-ins; with none of those, the
 * default. The ledger a later slice keeps in your own folder is found through
 * `places().user`, so the folder's path is spelled once. Each file is signed
 * for by exactly one name, which is more than can be said for most
 * spreadsheets of record.
 */
import type { Warning } from '../envelope.js';
import { createFileCatalog, type Found } from '../file-catalog.js';
import type { CatalogOptions } from '../toil-project.js';
import { BUILTIN_NAMES, builtinScheme, defaultScheme } from './builtin.js';
import { readScheme, schemeContent } from './scheme.js';
import { SCHEME_NAME, type FoundScheme, type Scheme } from './types.js';

/** The largest scheme file toil reads: a scheme is a few categories and rules, and every classify call reads one. */
export const MAX_SCHEME_BYTES = 256 * 1024;

export type SchemeCatalogOptions = Omit<CatalogOptions, 'areas'> & { areas?: CatalogOptions['areas'] };

/** A scheme as resolved, with what was worth saying about reading it. */
export type ResolvedScheme = FoundScheme & { warnings: Warning[] };

export interface SchemeCatalog {
  /**
   * The scheme a call uses. `scheme` is the call's `--scheme`: a value ending in
   * `.json` or holding a path separator is a file, anything else a name (yours,
   * the repository's, built in). Without it the toil project's `classify.scheme`
   * applies (`./x.json` is beside the toil project's own `file`), and without that
   * the built-in `ktlo-feature`. `cwd` picks the repository, as it does for toil projects.
   */
  resolve(ref: { scheme?: string | undefined; toilProject?: { scheme?: string | undefined; file?: string | undefined } | undefined; cwd?: string | undefined }): ResolvedScheme;
  /** Every scheme visible by name (yours, the repository's, built in), each name once from its highest source. A file that can't be read is a warning. */
  list(cwd?: string): { schemes: ResolvedScheme[]; warnings: Warning[] };
  /** Your own folder, `~/.toil/classify`, and the repository's `.toil/classify` when `cwd` is in one. */
  places(cwd?: string): { user: string; repo?: string };
  /** Where your own scheme named `name` lives. */
  userFile(name: string): string;
  /** `.toil/classify/` in the repository whose root is `dir`; INVALID_INPUT when `dir` isn't a repository's root. */
  repoFolder(dir: string): string;
  /** A path a call gave, absolute: relative to the CLI's working directory, or under MCP the workspace. */
  pathFor(value: string, what: string): string;
  /** Reads one scheme file a call named, inside the bounds, whatever it is called. For `import` and `set --from`; a file with no `name` takes `defaultName`. */
  readFile(path: string, cwd?: string, defaultName?: string): ResolvedScheme;
  /**
   * Writes a scheme, validated, to `path`: `create` refuses a file that is there,
   * `replace` replaces only a valid scheme. The path must be a `.json` file in
   * `~/.toil/classify/`, a repository's `.toil/classify/` (named for the scheme), or
   * the workspace, or, with `beside`, in the folder of that toil project file.
   * Never toil's own files, /proc or /sys. Returns the absolute path written.
   */
  save(path: string, scheme: Scheme, mode: 'create' | 'replace', beside?: string): string;
}

export function createSchemeCatalog(o: SchemeCatalogOptions): SchemeCatalog {
  const files = createFileCatalog<Scheme>(
    {
      folder: 'classify',
      noun: 'scheme',
      nameForm: SCHEME_NAME,
      nameExample: 'ktlo-feature',
      maxBytes: MAX_SCHEME_BYTES,
      codePrefix: 'SCHEME',
      read: (raw, where) => {
        const { scheme, warnings } = readScheme(raw, where);
        return { value: scheme, warnings };
      },
      content: schemeContent,
      builtinNames: BUILTIN_NAMES,
      builtin: builtinScheme,
      holds: 'A scheme holds categories, guidance and rules; move anything else out of it.',
      outsideFix: 'Move it into the workspace, copy it in with toil classify scheme import, or pass the scheme by name.',
      flag: '--scheme <file>',
      createHint: (name) => `toil classify scheme init ${name} creates one.`,
    },
    o,
  );
  const asScheme = (f: Found<Scheme>): ResolvedScheme => ({ scheme: f.value, source: f.source, ...(f.file !== undefined ? { file: f.file } : {}), warnings: f.warnings });

  return {
    resolve: (ref) => {
      if (ref.scheme !== undefined) return asScheme(files.byRef(ref.scheme, ref.cwd));
      const wanted = ref.toilProject?.scheme;
      if (wanted === undefined) return { scheme: defaultScheme(), source: 'built-in', warnings: [] };
      return asScheme(files.fromToilProject(wanted, ref.toilProject?.file, ref.cwd));
    },
    list: (cwd) => {
      const { found, warnings } = files.list(cwd);
      return { schemes: found.map(asScheme), warnings };
    },
    places: files.places,
    userFile: files.userFile,
    repoFolder: files.repoFolder,
    pathFor: files.pathFor,
    readFile: (path, cwd, defaultName) => asScheme(files.readFile(path, cwd, defaultName)),
    save: files.save,
  };
}
