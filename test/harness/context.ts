import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ResolvedConfig, Settings } from '../../src/core/config.js';
import type { Context } from '../../src/core/context.js';
import type { ToilProjectCatalog } from '../../src/core/toil-project.js';
import type { GitRunner } from '../../src/core/git.js';
import type { GitContext } from '../../src/core/git-repo.js';
import type { SecretStore } from '../../src/core/keychain.js';
import type { Prompter } from '../../src/core/prompt.js';
import { memoryAudit, type MemoryAudit } from './audit.js';
import { fakeFetch, type FakeFetch, type Route } from './fake-fetch.js';
import { memoryFiles } from './files.js';

export const TEST_VERSION = '0.0.0-test';

/**
 * A config as if set by TOIL_<AREA>_* env vars: one connection per area, named
 * after it and set as its default. A connection that sets its own `area` is
 * named by its key instead (`'jira-cloud': { area: 'jira', deployment: 'cloud' }`)
 * and is the area's default only when no connection is named after the area. Values are attributed to env because that's
 * where a plaintext credential may live (a config file holds only `keychain:`
 * references), and it's how CI provides them.
 */
export function testConfig(areas: Record<string, Settings> = {}): ResolvedConfig {
  const config: ResolvedConfig = { connections: {}, defaults: {}, sources: {}, files: { global: '/home/test/.toil/config.json' }, warnings: [] };
  for (const [name, settings] of Object.entries(areas)) {
    const area = typeof settings.area === 'string' ? settings.area : name;
    config.connections[name] = { ...settings, area };
    if (name === area || config.defaults[area] === undefined) config.defaults[area] = { connection: name };
    for (const key of Object.keys(settings)) if (key !== 'area') config.sources[`${name}.${key}`] = 'env';
  }
  return config;
}

export interface TestContextOptions {
  config?: Record<string, Settings>;
  routes?: Route[];
  verbose?: boolean;
  files?: Record<string, string | Uint8Array>;
  /** What `-` reads; `{ terminal: true }` for an interactive terminal, where it refuses. */
  stdin?: string | { terminal: true };
  /** The credential store `keychain:` references resolve against; `fakeStore()` in tests. Absent, a reference resolves to unset. */
  secrets?: SecretStore;
  /** The repository `ctx.repo()` reports; absent, as outside one. */
  repo?: GitContext;
  /** The git `ctx.git` runs; absent, as when none is installed for the test. */
  git?: GitRunner;
  /** A scripted terminal, for the CLI-only commands that ask a person (`scriptedPrompter()`). Absent, as under MCP or in CI. */
  prompt?: Prompter;
  /** Toil projects on a temp disk (`toilProjectDisk().catalog`), built over this context's config. Absent, there are none. */
  toilProjects?: (config: ResolvedConfig) => ToilProjectCatalog;
  /** The audit log execute() appends to; a fresh `memoryAudit()` by default, so no test writes to a home folder. */
  audit?: MemoryAudit;
  /**
   * The home folder `ctx.home` names, for the skills commands: a folder to use
   * as it is, or files (relative paths) to seed a fresh one with. Seeded homes
   * share one path per test process, emptied and seeded again on every call,
   * so a CLI run and the MCP run after it see the same paths and the same
   * starting state. Absent, there's no home, and the skills commands refuse.
   */
  home?: string | Record<string, string>;
  /** The config file a config command reads and writes (`toil theme set`); `/home/test/.toil/config.json` by default, which no test should write. */
  configFile?: string;
}

/** The one seeded home per test process; see TestContextOptions.home. */
export const SEEDED_HOME = join(tmpdir(), `toil-test-home-${process.pid}`);
process.once('exit', () => rmSync(SEEDED_HOME, { recursive: true, force: true }));

/** Empties the seeded home and writes `files` into it. */
export function seedHome(files: Record<string, string>): string {
  rmSync(SEEDED_HOME, { recursive: true, force: true });
  mkdirSync(SEEDED_HOME, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const at = join(SEEDED_HOME, ...path.split('/'));
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, content);
  }
  return SEEDED_HOME;
}

/**
 * A Context wired to a fake fetch and in-memory files, plus a credential store
 * and a prompter when the test gives them. Returns the fakes so tests can read
 * `calls` and `files.written`.
 */
export function testContext(options: TestContextOptions = {}): { context: Context; http: FakeFetch; files: ReturnType<typeof memoryFiles>; audit: MemoryAudit } {
  const http = fakeFetch(options.routes);
  const audit = options.audit ?? memoryAudit();
  const files = memoryFiles(options.files, options.stdin === undefined ? {} : { stdin: options.stdin });
  const config = testConfig(options.config);
  if (options.configFile) config.files.global = options.configFile;
  const context: Context = {
    config,
    fetch: http.fetch,
    files,
    env: {},
    version: TEST_VERSION,
    verbose: options.verbose ?? false,
    debug: () => {},
    audit,
    ...(options.secrets ? { secrets: options.secrets } : {}),
    ...(options.prompt ? { prompt: options.prompt } : {}),
    ...(options.repo ? { repo: () => options.repo } : {}),
    ...(options.git ? { git: options.git } : {}),
    ...(options.home === undefined ? {} : { home: typeof options.home === 'string' ? options.home : seedHome(options.home) }),
    ...(options.toilProjects ? { toilProjects: options.toilProjects(config) } : {}),
  };
  return { context, http, files, audit };
}

/** What a scripted prompter was asked, in order, and whether the answer was read hidden. */
export interface Asked {
  question: string;
  hidden: boolean;
}

/**
 * A terminal that answers from a script: each question gets the answer whose
 * key it starts with (`{ 'Base URL': 'https://jira.imagile.dev' }`), and an
 * unscripted question gets the fallback, or ''. `asked` records every
 * question, so a test can check that a secret was read hidden.
 */
export function scriptedPrompter(answers: Record<string, string> = {}): { prompt: Prompter; asked: Asked[] } {
  const asked: Asked[] = [];
  const answer = (question: string, hidden: boolean) => {
    asked.push({ question, hidden });
    const key = Object.keys(answers).find((k) => question.startsWith(k));
    return key === undefined ? undefined : answers[key];
  };
  return {
    asked,
    prompt: {
      ask: async (question, fallback) => answer(question, false) || fallback || '',
      askSecret: async (question) => answer(question, true) ?? '',
    },
  };
}
