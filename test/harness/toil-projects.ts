import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import type { ResolvedConfig } from '../../src/core/config.js';
import { createSchemeCatalog, type SchemeCatalog } from '../../src/core/classify/catalog.js';
import { Ledger } from '../../src/core/classify/ledger.js';
import { createStandardCatalog, type StandardCatalog } from '../../src/core/standards/catalog.js';
import { createDiagramCatalog, type DiagramCatalog } from '../../src/core/diagrams.js';
import { createToilProjectCatalog, stripUserinfo, type ToilProjectArea, type ToilProjectCatalog } from '../../src/core/toil-project.js';
import { findGitRepo, readGitContext, readGitRemotes } from '../../src/core/git-repo.js';

/**
 * Toil projects on a real disk, in a temp folder: a home (with `~/.toil/projects`)
 * and a workspace, plus whatever else a test lays out. Toil projects are read
 * straight from disk by core (src/core/toil-project.ts), as config is, so the
 * tests that cover them use real files rather than the in-memory file
 * service. Nothing here touches the network.
 */
export interface ToilProjectDisk {
  root: string;
  home: string;
  workspace: string;
  /** Writes a file under root: an object becomes pretty JSON, a string is written as is. */
  write: (path: string, content: unknown) => string;
  /** Puts the disk back as it was made, for a suite whose commands write toil projects and runs each twice. */
  reset: () => void;
  /** A catalog over this disk, for `testContext({ toilProjects })` or a direct call. */
  catalog: (config: ResolvedConfig, options?: { env?: NodeJS.ProcessEnv; mcp?: boolean; workspace?: string | null; areas?: readonly ToilProjectArea[] }) => ToilProjectCatalog;
  /** A scheme catalog over the same disk, for `testContext({ schemes })` or a direct call. */
  schemes: (config: ResolvedConfig, options?: { env?: NodeJS.ProcessEnv; mcp?: boolean; workspace?: string | null }) => SchemeCatalog;
  /** A standards catalog over the same disk, for `testContext({ standards })` or a direct call. */
  standards: (config: ResolvedConfig, options?: { env?: NodeJS.ProcessEnv; mcp?: boolean; workspace?: string | null }) => StandardCatalog;
  /** The classification ledger in this disk's home, for `testContext({ ledger })` or a direct call. */
  ledger: () => Ledger;
  /** A diagram catalog over the same disk's home, for `testContext({ diagrams })` or a direct call. */
  diagrams: () => DiagramCatalog;
  cleanup: () => void;
}

/** Areas with the context inputs the demo fixtures declare, plus a few real names for section tests. */
export const TEST_TOIL_PROJECT_AREAS: readonly ToilProjectArea[] = [
  { name: 'demo', context: [] },
  { name: 'demo-context', context: ['project', 'board', 'env'] },
  { name: 'jira', context: ['project'] },
  { name: 'openshift', context: ['env', 'instance'] },
  { name: 'sonar', context: ['project'] },
];

export function toilProjectDisk(files: Record<string, unknown> = {}): ToilProjectDisk {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'toil-toil-projects-')));
  const home = join(root, 'home');
  const workspace = join(root, 'work');
  mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  // How a file's content is written: a string as it is, anything else as JSON with a final newline.
  const text = (content: unknown) => (typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  const write = (path: string, content: unknown) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text(content));
    return full;
  };
  // Every seeded file and the folders above it, as full paths: what a reset leaves alone.
  const seeded = new Map(Object.entries(files).map(([path, content]) => [join(root, path), text(content)] as const));
  const kept = new Set<string>([home, workspace, join(home, '.toil'), join(home, '.toil', 'projects')]);
  for (const full of seeded.keys()) for (let dir = dirname(full); dir.length > root.length; dir = dirname(dir)) kept.add(dir);
  const seed = () => {
    mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    for (const [path, content] of Object.entries(files)) write(path, content);
  };
  seed();
  // Deleting and rewriting a temp tree on every run is what made the toil projects suites the slowest
  // per test (each run is reset twice, and Windows pays for every create and delete). A reset now
  // removes what the run added or moved and rewrites a seeded file only if it no longer reads as seeded;
  // reading is cheap, and the disk ends up exactly as seed() made it.
  const prune = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && kept.has(full)) prune(full);
      else if (entry.isFile() && seeded.get(full) !== undefined && readFileSync(full, 'utf8') === seeded.get(full)) continue;
      else rmSync(full, { recursive: true, force: true });
    }
  };
  return {
    root,
    home,
    workspace,
    write,
    reset: () => {
      prune(root);
      for (const [full, content] of seeded) if (!existsSync(full)) write(relative(root, full), content);
      mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
      mkdirSync(workspace, { recursive: true });
    },
    catalog: (config, options = {}) => {
      const dir = options.workspace === null ? undefined : (options.workspace ?? workspace);
      return createToilProjectCatalog({
        home,
        env: options.env ?? {},
        config,
        areas: options.areas ?? TEST_TOIL_PROJECT_AREAS,
        workspace: dir ? { dir, source: options.mcp ? 'mcp-root' : 'cwd' } : { source: 'none' },
        base: dir,
        protect: [join(home, '.toil')],
        // As the shipped context reads a folder's git: origin first, http(s) userinfo dropped.
        git: (folder) => ({
          gitRemote: async () => {
            const repo = findGitRepo(folder, { home });
            const remotes = repo ? readGitRemotes(repo, { home }) : [];
            return [...remotes.filter((r) => r.name === 'origin'), ...remotes.filter((r) => r.name !== 'origin')];
          },
          repo: () => {
            const found = readGitContext(folder, { home });
            return found && { ...found, remotes: found.remotes.map(stripUserinfo) };
          },
        }),
      });
    },
    schemes: (config, options = {}) => {
      const dir = options.workspace === null ? undefined : (options.workspace ?? workspace);
      return createSchemeCatalog({
        home,
        env: options.env ?? {},
        config,
        workspace: dir ? { dir, source: options.mcp ? 'mcp-root' : 'cwd' } : { source: 'none' },
        base: dir,
        protect: [join(home, '.toil')],
        git: (folder) => ({
          gitRemote: async () => [],
          repo: () => readGitContext(folder, { home }),
        }),
      });
    },
    standards: (config, options = {}) => {
      const dir = options.workspace === null ? undefined : (options.workspace ?? workspace);
      return createStandardCatalog({
        home,
        env: options.env ?? {},
        config,
        workspace: dir ? { dir, source: options.mcp ? 'mcp-root' : 'cwd' } : { source: 'none' },
        base: dir,
        protect: [join(home, '.toil')],
        git: (folder) => ({
          gitRemote: async () => [],
          repo: () => readGitContext(folder, { home }),
        }),
      });
    },
    ledger: () => new Ledger({ home }),
    diagrams: () => createDiagramCatalog({ home, protect: [join(home, '.toil')] }),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
