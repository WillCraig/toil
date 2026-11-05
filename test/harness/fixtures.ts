import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { areaOf, type AnyCommand } from '../../src/core/command.js';
import type { Settings } from '../../src/core/config.js';
import type { GitRunner } from '../../src/core/git.js';
import type { GitContext } from '../../src/core/git-repo.js';
import { commands as registered } from '../../src/registry.js';
import type { Route } from './fake-fetch.js';
import { traceOperations } from './operations.js';

type Files = Record<string, string | Uint8Array>;

/** What a fixture's setup may supply once it has run: anything that depends on state it made. */
export interface FixtureState {
  config?: Record<string, Settings>;
  files?: Files;
  routes?: Route[];
}

/** An object whose method calls go in the operations log (see operations.ts). */
export interface TracedTarget {
  /** Prefix for each logged call: `sqlite` logs `sqlite.query`. */
  label: string;
  target: object;
  /** Methods that change something. A command that doesn't write must never call one. */
  writes?: string[];
}

/**
 * What the parity suite needs to run one area's examples offline: canned
 * responses for every request they send, and a config with credentials set and
 * writes on. One file per area, `test/fixtures/<area>.fixture.ts`, exporting
 * `fixture`. The suite finds it by name, so building an area means adding a
 * file, not editing a list.
 */
export interface AreaFixture {
  area: string;
  routes?: Route[];
  /**
   * Connections by name, each with `writes: true` for an area with write
   * commands, so every example runs. A key that is an area's name is that
   * area's default connection; any other sets its own `area`.
   */
  config?: Record<string, Settings>;
  /**
   * For an area with more than one deployment (`jira`): the connection each
   * deployment's examples run on, by deployment (`{ server: 'jira', cloud:
   * 'jira-cloud' }`). A per-deployment command's example carries its deployment
   * (`exampleDeployments`), and `examplesOf` runs it with that connection.
   */
  deployments?: Record<string, string>;
  /** Local files the examples read (input files, uploads), relative to the test working directory. */
  files?: Files;
  /**
   * The repository the examples run in, as `ctx.repo()` reports it: root,
   * branch and remotes (`bitbucket pr current`). Left out, as outside one.
   */
  repo?: GitContext;
  /**
   * The git the examples run, as `ctx.git` (the `git` area): a canned runner,
   * which the fixture may also `trace`. Left out, a command that runs git gets none.
   */
  git?: GitRunner;
  /**
   * Files in the home folder the examples run against (`ctx.home`), relative
   * paths with forward slashes: the skills area's agent folders and clones.
   * Each run gets a fresh copy at the same path.
   */
  home?: Record<string, string>;
  /**
   * A toil project the examples run with: written to a temp home as your own, and
   * named by TOIL_PROJECT, for an area's `check-toil-project`. Keep context inputs
   * the other examples take out of it, or they'll pick them up.
   */
  toilProject?: Record<string, unknown>;
  /** Defaults to the area's registered commands. Only test-only areas set it. */
  commands?: AnyCommand[];
  /**
   * Objects whose calls go in the operations log, for areas whose work isn't
   * HTTP (the db area's provider). The suite then compares the log between the
   * CLI and MCP runs, as it compares requests.
   */
  trace?: TracedTarget[];
  /**
   * Makes whatever local state the examples need (a seeded database file), run
   * once before the suite. What it returns replaces the matching fields above.
   * Keep it out of module load, so importing a fixture has no side effects.
   */
  setup?: () => FixtureState | void | Promise<FixtureState | void>;
  /** Removes what setup made, run once after the suite. */
  teardown?: () => void | Promise<void>;
}

export function defineFixture(fixture: AreaFixture): AreaFixture {
  return fixture;
}

/**
 * A command's examples as they run against a fixture: a routed command's
 * example runs on the connection of its own deployment, so Data Center's and
 * Cloud's are each proven against the connection they are for.
 */
export function examplesOf(def: AnyCommand, fixture: Pick<AreaFixture, 'area' | 'deployments'>): Array<Record<string, unknown>> {
  return (def.examples as Array<Record<string, unknown>>).map((example, i) => {
    const deployment = def.exampleDeployments?.[i];
    if (deployment === undefined) return example;
    const connection = fixture.deployments?.[deployment];
    if (connection === undefined) throw new Error(`${def.path.join(' ')} example ${i + 1} runs on ${deployment}, and the ${fixture.area} fixture names no ${deployment} connection in deployments.`);
    return { ...example, connection };
  });
}

/** A fixture as the suites use it: every optional list filled in. Config, files and routes are final only after `setUp`. */
export type LoadedFixture = AreaFixture & {
  routes: Route[];
  config: Record<string, Settings>;
  files: Files;
  commands: AnyCommand[];
  trace: TracedTarget[];
};

const dir = join(import.meta.dirname, '..', 'fixtures');

/** Every fixture file, with its commands resolved. */
export async function loadFixtures(): Promise<LoadedFixture[]> {
  const files = readdirSync(dir).filter((f) => f.endsWith('.fixture.ts')).sort();
  const out: LoadedFixture[] = [];
  for (const file of files) {
    const { fixture } = (await import(pathToFileURL(join(dir, file)).href)) as { fixture: AreaFixture };
    if (`${fixture.area}.fixture.ts` !== file) throw new Error(`${file} declares area "${fixture.area}"; name the file after its area.`);
    out.push({
      ...fixture,
      routes: fixture.routes ?? [],
      config: fixture.config ?? {},
      files: fixture.files ?? {},
      trace: fixture.trace ?? [],
      commands: fixture.commands ?? registered.filter((def) => areaOf(def) === fixture.area),
    });
  }
  return out;
}

/** Runs each fixture's setup and starts tracing its targets. Call from beforeAll. */
export async function setUp(fixtures: LoadedFixture[]): Promise<void> {
  for (const f of fixtures) {
    for (const t of f.trace) traceOperations(t.target, t.label);
    const state = (await f.setup?.()) ?? {};
    if (state.config) f.config = state.config;
    if (state.files) f.files = state.files;
    if (state.routes) f.routes = state.routes;
  }
}

/** Runs each fixture's teardown, even when one fails. Call from afterAll. */
export async function tearDown(fixtures: LoadedFixture[]): Promise<void> {
  const failures: unknown[] = [];
  for (const f of fixtures) {
    try {
      await f.teardown?.();
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'fixture teardown failed');
}

/** The traced methods that write, as logged op names: `sqlite.execute`. */
export function writeOperations(f: LoadedFixture): Set<string> {
  return new Set(f.trace.flatMap((t) => (t.writes ?? []).map((m) => `${t.label}.${m}`)));
}
