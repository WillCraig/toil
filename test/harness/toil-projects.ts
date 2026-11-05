import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedConfig } from '../../src/core/config.js';
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
  const write = (path: string, content: unknown) => {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
    return full;
  };
  const seed = () => {
    mkdirSync(join(home, '.toil', 'projects'), { recursive: true });
    mkdirSync(workspace, { recursive: true });
    for (const [path, content] of Object.entries(files)) write(path, content);
  };
  seed();
  return {
    root,
    home,
    workspace,
    write,
    reset: () => {
      for (const entry of readdirSync(root)) rmSync(join(root, entry), { recursive: true, force: true });
      seed();
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
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
