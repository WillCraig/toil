/**
 * Where standards (ticket rules) live: the generic file catalog
 * (src/core/file-catalog.ts) set up for them. A standard is found, highest
 * first, as a file the call named, in your own folder (`~/.toil/standards/`),
 * in the repository's `.toil/standards/`, beside the toil project that names it
 * (`./rules.json`), or built in, with the same path rules schemes have
 * (docs/bounds.md, `standards.read`). toil only reads standards: a team writes
 * its own file by hand and checks it in, so there is no write here to bound.
 * Every file is read under the reader's caps before any rule runs, which is the
 * closest thing to a change advisory board a regular expression will ever meet.
 */
import type { Warning } from '../envelope.js';
import { createFileCatalog, type FileCatalogOptions, type Found } from '../file-catalog.js';
import { BUILTIN_STANDARD_NAMES, builtinStandard } from './builtin.js';
import { readStandard, standardContent } from './read.js';
import { STANDARD_NAME, type FoundStandard, type Standard } from './types.js';

/**
 * A repository's standard that takes a built-in's name (`gherkin`) is set aside
 * for the built-in, with a warning naming the file: anyone who can open a pull
 * request could otherwise rewrite what "gherkin" means for everyone who checks
 * out the repository, under a name they already trust. Your own folder may
 * replace a built-in, as your config may replace a default; a file named by path
 * is named on purpose and keeps its own name.
 */
function builtinKept(found: ResolvedStandard): ResolvedStandard {
  if (found.source !== 'repo' || !BUILTIN_STANDARD_NAMES.includes(found.standard.name)) return found;
  return {
    standard: builtinStandard(found.standard.name)!,
    source: 'built-in',
    warnings: [
      {
        code: 'STANDARD_SHADOWS_BUILTIN',
        message: `${found.file ?? 'A repository standard'} was set aside: "${found.standard.name}" is a built-in standard's name, and a repository's standard can't replace a built-in one, so the built-in ${found.standard.name} is used. Rename the file and its "name" (say, team-${found.standard.name}) and name that in the toil project's standards.`,
      },
    ],
  };
}

/** The largest standard file toil reads: a standard is a few rules, and every check reads each one it uses. */
export const MAX_STANDARD_BYTES = 256 * 1024;

/** A standard as resolved, with what was worth saying about reading it. */
export type ResolvedStandard = FoundStandard & { warnings: Warning[] };

export interface StandardCatalog {
  /**
   * The standard a call names: a value ending in `.json` or holding a path
   * separator is a file (source `file`), anything else a name (yours, the
   * repository's, built in). `cwd` picks the repository.
   */
  resolve(ref: string, cwd?: string): ResolvedStandard;
  /**
   * The standard a toil project names: `./x.json`, `../x.json` or any `.json` is a
   * file beside `toilProjectFile` (source `toil-project`); anything else a name.
   */
  resolveFromToilProject(ref: string, toilProjectFile: string | undefined, cwd?: string): ResolvedStandard;
  /** Every standard visible by name (yours, the repository's, built in), each name once from its highest source. A file that can't be read is a warning. */
  list(cwd?: string): { standards: ResolvedStandard[]; warnings: Warning[] };
  /** Your own folder, `~/.toil/standards`, and the repository's `.toil/standards` when `cwd` is in one. */
  places(cwd?: string): { user: string; repo?: string };
}

export function createStandardCatalog(o: FileCatalogOptions): StandardCatalog {
  const files = createFileCatalog<Standard>(
    {
      folder: 'standards',
      noun: 'standard',
      nameForm: STANDARD_NAME,
      nameExample: 'gherkin',
      maxBytes: MAX_STANDARD_BYTES,
      codePrefix: 'STANDARD',
      read: (raw, where) => {
        const { standard, warnings } = readStandard(raw, where);
        return { value: standard, warnings };
      },
      content: standardContent,
      builtinNames: BUILTIN_STANDARD_NAMES,
      builtin: builtinStandard,
      holds: 'A standard holds a name, a description and its rules; move anything else out of it.',
      outsideFix: 'Move it into the workspace, into ~/.toil/standards, or into the repository\'s .toil/standards, or pass the standard by name.',
      flag: '--standard <file>',
    },
    o,
  );
  const asStandard = (f: Found<Standard>): ResolvedStandard => {
    const found: ResolvedStandard = { standard: f.value, source: f.source, ...(f.file !== undefined ? { file: f.file } : {}), warnings: f.warnings };
    return builtinKept(found);
  };
  return {
    resolve: (ref, cwd) => asStandard(files.byRef(ref, cwd)),
    resolveFromToilProject: (ref, file, cwd) => asStandard(files.fromToilProject(ref, file, cwd)),
    list: (cwd) => {
      const { found, warnings } = files.list(cwd);
      const standards = found.map(asStandard);
      // A refused repository file's warning belongs to the listing, as a broken file's does.
      for (const s of standards) if (s.source === 'built-in' && s.warnings.length > 0) warnings.push(...s.warnings.splice(0));
      return { standards, warnings };
    },
    places: files.places,
  };
}
