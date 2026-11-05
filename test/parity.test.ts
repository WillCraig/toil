import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CORE_FIELDS } from '../src/core/area.js';
import { aliasInput, aliasPaths, areaOf, changesAnythingFor, commandName, isCliOnly, servedOverMcp, takesAllowWrite, toolName, usesConnection, writesFor, type AnyCommand } from '../src/core/command.js';
import type { Settings } from '../src/core/config.js';
import type { Envelope } from '../src/core/envelope.js';
import { ToilError } from '../src/core/errors.js';
import { SELECT_FIELD } from '../src/core/query/select.js';
import { OUTPUT_FORMAT_FIELD, SUMMARY_FILE_FIELD } from '../src/core/output/fields.js';
import { CORE_OUTPUT_PROPERTIES } from '../src/mcp/server.js';
import type { GitRunner } from '../src/core/git.js';
import type { GitContext } from '../src/core/git-repo.js';
import { runCommand } from '../src/core/run.js';
import { clearTokenCache, watchTokenExchanges } from '../src/core/token.js';
import { argvFor, routedArgvFor } from '../src/program.js';
import { areas as registeredAreas, commands, routedAliases } from '../src/registry.js';
import { EXAMPLE_BRIEF_RECORDS } from '../src/projects/brief.js';
import { demoCommands } from './fixtures/demo-commands.js';
import { runCli } from './harness/cli.js';
import { testContext } from './harness/context.js';
import { withoutExchanges, type Route } from './harness/fake-fetch.js';
import { examplesOf, loadFixtures, setUp, tearDown, writeOperations, type LoadedFixture } from './harness/fixtures.js';
import { toilProjectDisk } from './harness/toil-projects.js';
import { connectMcp, type McpSession } from './harness/mcp.js';
import { recordOperations } from './harness/operations.js';

/**
 * The CLI and MCP are two front doors onto one core, and this suite is what
 * keeps them 1:1. It walks every registered command, one suite per area
 * fixture (test/fixtures/<area>.fixture.ts) plus one for commands outside any
 * area, so a new command is covered the moment it is registered and its area
 * has a fixture, with no test to remember to write.
 *
 * Areas that don't speak HTTP (db) are compared through the operations log
 * instead: their fixture traces the object that does the work, and both doors
 * must make the same calls with the same arguments.
 *
 * The one exclusion: commands that are never MCP tools, the `cli-only` kind
 * (they prompt on a terminal or change connections) and area commands marked
 * `mcp: false` (deletes). They're found by their definition, so no integration
 * edits a list here; a test proves MCP doesn't serve them, and the area ones still
 * run their examples and hold the write gate on the CLI. Aliases are
 * CLI paths onto a command, so each one is run against that command's MCP tool.
 */
const bothDoors = servedOverMcp;

const fixtures = await loadFixtures();
beforeAll(() => setUp(fixtures));
afterAll(() => tearDown(fixtures));
type Files = Record<string, string | Uint8Array>;
// Config, files and routes are read from the fixture when each test runs, after setup.
// Two connections the toil project build examples bind to, both with writes off, and the
// OWI records `toil projects brief` reads from a file.
const outside: LoadedFixture = { area: '', routes: [], config: { jira: { baseUrl: 'https://jira.imagile.dev' }, openshift: { baseUrl: 'https://api.ocp.imagile.dev:6443' } }, files: { 'owi/brief.owi.json': EXAMPLE_BRIEF_RECORDS }, commands: [], trace: [] };
// A group of standalone commands that read files or run git (`util`) brings
// its own fixture, named after the group, and runs in that suite instead.
const grouped = new Set(fixtures.map((f) => f.area));
const suites: Array<{ name: string; commands: AnyCommand[]; fixture: LoadedFixture }> = [
  { name: 'commands outside an area', commands: commands.filter((def) => !def.area && bothDoors(def) && !grouped.has(areaOf(def))), fixture: outside },
  ...fixtures.map((f) => ({ name: `${f.area} area`, commands: f.commands.filter(bothDoors), fixture: f })),
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The registry's areas as toil projects see them: each one's context inputs. */
const toilProjectAreas = registeredAreas.map((a) => ({ name: a.name, context: Object.keys(a.context) }));

// The toil projects and repos commands sit outside any area and read and write
// toil projects on disk: a temp home and workspace, put back as made before each
// run, so the CLI and MCP runs of a writing example start from the same files.
const outsideDisk = toilProjectDisk({
  'home/.toil/projects/payments.json': {
    name: 'payments',
    description: 'Payments platform',
    repos: [
      { name: 'payments-api', remotes: ['https://bitbucket.imagile.dev/scm/pay/payments-api.git'] },
      { name: 'ledger-svc', remotes: ['https://bitbucket.imagile.dev/scm/pay/ledger-svc.git'] },
    ],
    jira: { project: 'PAY', projects: ['PAY', 'LEDG'] },
  },
  'work/.git/HEAD': 'ref: refs/heads/main\n',
  'work/.toil/projects/team.json': { name: 'team', description: 'Shared by the team', repos: [{ name: 'payments-api', remotes: ['https://bitbucket.imagile.dev/scm/pay/payments-api.git'] }] },
});
afterAll(() => outsideDisk.cleanup());
// An area fixture's own toil project (`toil-project`), as your own and named by TOIL_PROJECT, for its check-toil-project.
const fixtureDisks = new Map<LoadedFixture, ReturnType<typeof toilProjectDisk>>();
afterAll(() => fixtureDisks.forEach((d) => d.cleanup()));
type Local = { repo?: GitContext; git?: GitRunner; home?: Record<string, string>; toilProjects?: ReturnType<typeof toilProjectDisk>['catalog']; configFile?: string };
function localOf(f: LoadedFixture): Local {
  const local: Local = { ...(f.repo ? { repo: f.repo } : {}), ...(f.git ? { git: f.git } : {}), ...(f.home ? { home: f.home } : {}) };
  if (f === outside) {
    // `theme set` writes the config file: one in the temp home, which the reset below empties before each run.
    local.configFile = join(outsideDisk.home, '.toil', 'config.json');
    local.toilProjects = (config) => {
      outsideDisk.reset();
      return outsideDisk.catalog(config, { areas: toilProjectAreas });
    };
  } else if (f.toilProject) {
    const name = String(f.toilProject.name);
    if (!fixtureDisks.has(f)) fixtureDisks.set(f, toilProjectDisk({ [`home/.toil/projects/${name}.json`]: f.toilProject }));
    const disk = fixtureDisks.get(f)!;
    local.toilProjects = (config) => disk.catalog(config, { areas: toilProjectAreas, env: { TOIL_PROJECT: name } });
  }
  return local;
}

// Each test's CLI run starts with no cached token, so it exchanges as a fresh process would.
beforeEach(() => clearTokenCache());

const sessions: McpSession[] = [];
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()));
});

async function mcpFor(list: AnyCommand[], cfg: Record<string, Settings>, routes: Route[], files: Files = {}, local: Local = {}) {
  // The MCP run exchanges its own token, as the CLI run before it did, so both send the same requests.
  clearTokenCache();
  const { context, http, audit } = testContext({ config: cfg, routes, files, ...local });
  const session = await connectMcp({ commands: list, context });
  sessions.push(session);
  return { session, http, audit };
}

/**
 * An audit line with what may differ between the two doors taken out: when,
 * how long, which door, and the input, which is kept as each door sent it
 * (the CLI's `--line 3` is the text "3" where a union keeps text, and a
 * `--no-` flag sends its default).
 */
function sameCall(line: string | undefined): unknown {
  const entry = JSON.parse(line ?? 'null') as Record<string, unknown> | null;
  if (!entry) return entry;
  const rest = { ...entry };
  delete rest.time;
  delete rest.durationMs;
  delete rest.via;
  delete rest.input;
  return rest;
}

/** Every file under `dir`, by path, with its content: what a read-only call must leave as it was. */
function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) snapshot(full, base, out);
    else out[full.slice(base.length).split('\\').join('/')] = readFileSync(full, 'utf8');
  }
  return out;
}

/** Timing is the only field allowed to differ between two runs of the same call. */
function comparable(envelope: Envelope | undefined): unknown {
  if (!envelope) return envelope;
  return { ...envelope, meta: { ...envelope.meta, durationMs: 0, ...(envelope.meta.wait ? { wait: { ...envelope.meta.wait, elapsedMs: 0 } } : {}) } };
}

/** The config with writes switched off on every connection of one area, credentials untouched. */
function withoutWrites(cfg: Record<string, Settings>, area: string): Record<string, Settings> {
  return Object.fromEntries(
    Object.entries(cfg).map(([name, settings]) => {
      if ((typeof settings.area === 'string' ? settings.area : name) !== area) return [name, settings];
      const rest = { ...settings };
      delete rest.writes;
      return [name, rest];
    }),
  );
}

describe('coverage', () => {
  it('every registered area that needs config has a fixture', () => {
    const covered = new Set(fixtures.map((f) => f.area));
    const missing = [...new Set(commands.filter((def) => def.area).map(areaOf))].filter((a) => !covered.has(a));
    expect(missing, 'add test/fixtures/<area>.fixture.ts').toEqual([]);
  });

  it('excludes every command MCP must not serve, found by its definition, and MCP never serves them', async () => {
    const cliOnly = [...commands, ...demoCommands].filter((def) => !servedOverMcp(def));
    // Core's own connection setup is cli-only, and the demo delete is mcp: false; if none were found, the check would prove nothing.
    expect(cliOnly.map(commandName)).toContain('connections add');
    expect(cliOnly.map(commandName)).toContain('demo delete-thing');
    // Every area named and writes on: the widest MCP ever gets, and still none of them.
    const { context } = testContext({ config: { demo: { token: 't', writes: true } } });
    const session = await connectMcp({ commands: [...commands, ...demoCommands], context, areas: [...new Set(commands.map(areaOf))] });
    sessions.push(session);
    const tools = (await session.client.listTools()).tools.map((t) => t.name);
    for (const def of cliOnly) expect(tools, commandName(def)).not.toContain(toolName(def));
    expect(tools).toContain('connections_list');
  });
});

for (const suite of suites) {
  describe(suite.name, () => {
    // Commands whose examples logged a traced operation, filled in by the example tests below.
    const logged = new Set<string>();
    it('has unique paths and tool names, a description and at least one example per command', () => {
      expect(new Set(suite.commands.map(commandName)).size).toBe(suite.commands.length);
      expect(new Set(suite.commands.map(toolName)).size).toBe(suite.commands.length);
      for (const def of suite.commands) {
        expect(def.description, commandName(def)).not.toBe('');
        expect(def.examples.length, `${commandName(def)} needs an example`).toBeGreaterThan(0);
      }
    });

    it('maps every CLI argument and flag onto an input field, and every input field onto the CLI', () => {
      for (const def of suite.commands) {
        // `toil wait` takes its read's `tool` and `input` as the command line after --; its examples below prove that mapping.
        const fields = Object.keys(def.input.shape).filter((f) => f !== 'allowWrite' && !(def.dispatches && (f === 'tool' || f === 'input')));
        const mapped = [...(def.args ?? []), ...(def.options ?? [])].map((x) => x.field);
        expect(new Set(mapped), `${commandName(def)}: CLI fields`).toEqual(new Set(fields));
        if (takesAllowWrite(def)) expect(def.input.shape, `${commandName(def)} must accept allowWrite`).toHaveProperty('allowWrite');
      }
    });

    it('exposes one MCP tool per command, with the same input schema', async () => {
      const { session } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
      const { tools } = await session.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(suite.commands.map(toolName).sort());
      for (const def of suite.commands) {
        const tool = tools.find((t) => t.name === toolName(def))!;
        const expected = z.toJSONSchema(def.input, { target: 'draft-7' }) as { properties?: object; required?: string[] };
        // Plus core's select, outputFormat and summaryFile, which every tool takes and core applies to data.
        expect(tool.inputSchema.properties ?? {}, toolName(def)).toEqual({ ...(expected.properties ?? {}), ...CORE_OUTPUT_PROPERTIES });
        expect([...(tool.inputSchema.required ?? [])].sort(), toolName(def)).toEqual([...(expected.required ?? [])].sort());
        expect(tool.inputSchema.additionalProperties, `${toolName(def)} advertises that unknown fields are refused`).toBe(false);
        expect(tool.annotations?.readOnlyHint, toolName(def)).toBe(!takesAllowWrite(def));
      }
    });

    it('uses every input field in at least one example, so parity covers every flag', () => {
      for (const def of suite.commands) {
        const used = new Set(def.examples.flatMap((e) => Object.keys(e as object)));
        // `connection`, `toil-project` and `cwd` are added by core to every area command; the suites below cover them.
        // A command with an implementation per deployment lists the area's other-deployment inputs too (`--ws` on `pr create-many`), which no deployment of it takes.
        const taken = def.deployments ? new Set(Object.values(def.deployments.routes).flatMap((r) => r.fields)) : undefined;
        const unused = Object.keys(def.input.shape).filter((f) => !used.has(f) && !CORE_FIELDS.includes(f) && (taken === undefined || taken.has(f)));
        expect(unused, `${commandName(def)}: fields no example sets`).toEqual([]);
      }
    });

    for (const def of suite.commands) {
      examplesOf(def, suite.fixture).forEach((example, i) => {
        it(`${commandName(def)} example ${i + 1}: CLI and MCP send the same requests and return the same envelope`, async () => {
          const cli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
          const exchanges = watchTokenExchanges();
          const { result: viaCli, operations: cliOps } = await recordOperations(() => runCli(argvFor(def, example, def.path, suite.commands), { commands: suite.commands, context: cli.context })).finally(exchanges.stop);

          const { session, http, audit } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
          const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), example));
          // Exactly one audit line per call through each door, recording the same call.
          expect(cli.audit.lines, 'one audit line from the CLI').toHaveLength(1);
          expect(audit.lines, 'one audit line from MCP').toHaveLength(1);
          expect(cli.audit.entries()[0]!.via).toBe('cli');
          expect(audit.entries()[0]!.via).toBe('mcp');
          expect(sameCall(audit.lines[0]), 'the same audit line through both doors').toEqual(sameCall(cli.audit.lines[0]));

          expect(viaCli.envelope?.ok, viaCli.stdout + viaCli.stderr).toBe(true);
          expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
          expect(JSON.parse(viaMcp.text), 'MCP text and structured content agree').toEqual(viaMcp.envelope);
          expect(viaMcp.isError).toBe(false);
          expect(http.calls, 'same HTTP requests').toEqual(cli.http.calls);
          expect(mcpOps, 'same operations').toEqual(cliOps);
          // A traced fixture may hold commands that log nothing (`util jwt decode` beside `util deps diff`);
          // the comparison above holds every call either door makes, and the check after the examples
          // makes sure the trace records something at all.
          if (cliOps.length > 0) logged.add(commandName(def));
          expect(viaCli.exitCode).toBe(0);
          if (!writesFor(def, example)) {
            const allowed = def.queryByPost ? new Set([...READ_METHODS, 'POST']) : READ_METHODS;
            const methods = withoutExchanges(cli.http.calls, exchanges.sent).map((c) => c.method).filter((m) => !allowed.has(m));
            expect(methods, `${commandName(def)} is read-only but sent`).toEqual([]);
            const writing = writeOperations(suite.fixture);
            expect(cliOps.map((o) => o.op).filter((op) => writing.has(op)), `${commandName(def)} is read-only but called`).toEqual([]);
          }
        });

        it(`${commandName(def)} example ${i + 1}: under readOnly, refused before anything runs if it writes anything, otherwise runs and changes nothing`, async () => {
          const ro = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
          // The toil projects commands write straight to disk, where no guard sees: compare the disk itself.
          const before = suite.fixture === outside ? snapshot(outsideDisk.root) : undefined;
          const exchanges = watchTokenExchanges();
          const { result: envelope, operations } = await recordOperations(() => runCommand(def, example, () => ro.context, ro.context.version, 'api', { targets: suite.commands }, { readOnly: true })).finally(exchanges.stop);
          if (changesAnythingFor(def, example)) {
            expect(envelope.error?.message, `${commandName(def)} writes, so readOnly refuses it`).toMatch(/this call was made read-only, so it was refused before anything ran/);
            expect(ro.http.calls, 'nothing sent').toEqual([]);
            expect(operations, 'nothing run').toEqual([]);
          } else {
            // An unmarked writer is caught here: ctx.files refuses its write, or the disk or an operation shows it.
            expect(envelope.ok, `${commandName(def)} under readOnly: ${JSON.stringify(envelope.error)}`).toBe(true);
            const allowed = def.queryByPost ? new Set([...READ_METHODS, 'POST']) : READ_METHODS;
            expect(withoutExchanges(ro.http.calls, exchanges.sent).map((c) => c.method).filter((m) => !allowed.has(m)), `${commandName(def)} under readOnly sent`).toEqual([]);
            const writing = writeOperations(suite.fixture);
            expect(operations.map((o) => o.op).filter((op) => writing.has(op)), `${commandName(def)} under readOnly called`).toEqual([]);
            if (before) expect(snapshot(outsideDisk.root), `${commandName(def)} under readOnly changed files on disk: mark it writesLocal`).toEqual(before);
          }
        });
      });

      for (const path of aliasPaths(def)) {
        it(`${commandName(def)}: the alias toil ${path.join(' ')} gives the same envelope and requests as the MCP tool`, async () => {
          for (const example of examplesOf(def, suite.fixture)) {
            const cli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
            const { result: viaAlias, operations: aliasOps } = await recordOperations(() => runCli(argvFor(def, example, path), { commands: suite.commands, context: cli.context }));
            const { session, http } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
            // A preset alias (`jenkins instance list`) is the tool with those fields set.
            const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), { ...example, ...aliasInput(def, path) }));

            expect(viaAlias.envelope?.ok, viaAlias.stdout + viaAlias.stderr).toBe(true);
            expect(viaAlias.envelope?.meta.command, 'meta.command names the command, not the alias').toBe(commandName(def));
            expect(comparable(viaMcp.envelope)).toEqual(comparable(viaAlias.envelope));
            expect(http.calls).toEqual(cli.http.calls);
            expect(mcpOps).toEqual(aliasOps);
          }
        });
      }

      it(`${commandName(def)}: --select is applied the same way through both doors, and a bad one is refused before any request`, async () => {
        const example = { ...examplesOf(def, suite.fixture)[0]!, [SELECT_FIELD]: 'type(@)' };
        const cli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
        const viaCli = await runCli(argvFor(def, example, def.path, suite.commands), { commands: suite.commands, context: cli.context });
        const { session, http } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
        const viaMcp = await session.call(toolName(def), example);
        expect(viaCli.envelope?.ok, viaCli.stdout + viaCli.stderr).toBe(true);
        expect(['object', 'array', 'string', 'number', 'boolean', 'null']).toContain(viaCli.envelope?.data);
        expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
        expect(http.calls).toEqual(cli.http.calls);

        const bad = { ...example, [SELECT_FIELD]: 'items[?' };
        const badCli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
        const { result: refusedCli, operations: cliOps } = await recordOperations(() => runCli(argvFor(def, bad, def.path, suite.commands), { commands: suite.commands, context: badCli.context }));
        const badMcp = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
        const { result: refusedMcp, operations: mcpOps } = await recordOperations(() => badMcp.session.call(toolName(def), bad));
        expect(refusedCli.envelope?.error?.code).toBe('INVALID_INPUT');
        expect(comparable(refusedMcp.envelope)).toEqual(comparable(refusedCli.envelope));
        expect([...badCli.http.calls, ...badMcp.http.calls]).toHaveLength(0);
        expect([...cliOps, ...mcpOps]).toHaveLength(0);
      });

      it(`${commandName(def)}: --output-format toon and --summary-file shape data the same way through both doors`, async () => {
        const example = { ...examplesOf(def, suite.fixture)[0]!, [OUTPUT_FORMAT_FIELD]: 'toon', [SUMMARY_FILE_FIELD]: 'parity-summary.json' };
        const cli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
        const viaCli = await runCli(argvFor(def, example, def.path, suite.commands), { commands: suite.commands, context: cli.context });
        const { session, http } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
        const viaMcp = await session.call(toolName(def), example);
        expect(viaCli.envelope?.ok, viaCli.stdout + viaCli.stderr).toBe(true);
        expect(typeof viaCli.envelope?.data).toBe('string');
        expect(viaCli.envelope?.meta).toMatchObject({ format: 'toon', summary: { file: expect.stringMatching(/parity-summary\.json$/) } });
        expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
        expect(http.calls).toEqual(cli.http.calls);
      });

      it(`${commandName(def)}: an unknown field is INVALID_INPUT through both doors, before any request`, async () => {
        const example = examplesOf(def, suite.fixture)[0]!;
        const cli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
        const { result: viaCli, operations: cliOps } = await recordOperations(() => runCli([...argvFor(def, example, def.path, suite.commands), '--not-a-real-flag'], { commands: suite.commands, context: cli.context }));
        const { session, http } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
        const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), { ...example, notARealField: true }));

        expect(viaCli.envelope?.error?.code).toBe('INVALID_INPUT');
        expect(viaMcp.envelope?.error?.code).toBe('INVALID_INPUT');
        expect(viaMcp.envelope.meta.command).toBe(viaCli.envelope?.meta.command);
        expect(viaMcp.isError).toBe(true);
        expect([...cli.http.calls, ...http.calls]).toHaveLength(0);
        expect([...cliOps, ...mcpOps]).toHaveLength(0);
      });

      it(`${commandName(def)}: a config error while building the context is the same envelope through both doors`, async () => {
        const broken = () => {
          throw new ToilError('CONFIG_INVALID', '/home/test/.toil/config.json is not valid JSON.', { fix: 'Fix the JSON.' });
        };
        const example = examplesOf(def, suite.fixture)[0]!;
        const { context } = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
        const viaCli = await runCli(argvFor(def, example, def.path, suite.commands), { commands: suite.commands, context, createContext: broken });
        const session = await connectMcp({ commands: suite.commands, context, perCall: broken });
        sessions.push(session);
        const viaMcp = await session.call(toolName(def), example);

        expect(viaCli.envelope?.error?.code).toBe('CONFIG_INVALID');
        expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
        expect(viaMcp.isError).toBe(true);
      });

      // A write command's first example, or the first example a `writesWhen` command writes with.
      const writing = examplesOf(def, suite.fixture).find((e) => writesFor(def, e));
      if (takesAllowWrite(def)) {
        it(`${commandName(def)}: has an example that writes, so the gate below is proven`, () => {
          expect(writing).toBeDefined();
        });
      }
      if (writing) {
        const area = areaOf(def);
        const example = writing;
        const withoutFlag = { ...example };
        delete withoutFlag.allowWrite;

        if (def.writes) {
          it(`${commandName(def)}: hidden from MCP when writes are off for ${area}`, async () => {
            const { session } = await mcpFor(suite.commands, withoutWrites(suite.fixture.config, area), suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
            expect((await session.client.listTools()).tools.map((t) => t.name)).not.toContain(toolName(def));
          });
        } else {
          // Its reads are free, so the tool stays listed; the writing call is what's refused.
          it(`${commandName(def)}: served over MCP with writes off for ${area}, and its writing call refused through both doors, before any request`, async () => {
            const off = withoutWrites(suite.fixture.config, area);
            const cli = testContext({ config: off, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
            const viaCli = await runCli(argvFor(def, example, def.path, suite.commands), { commands: suite.commands, context: cli.context });
            const { session, http } = await mcpFor(suite.commands, off, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
            expect((await session.client.listTools()).tools.map((t) => t.name)).toContain(toolName(def));
            const viaMcp = await session.call(toolName(def), example);
            expect(viaCli.envelope?.error?.code).toBe('WRITE_DISABLED');
            expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
            expect([...cli.http.calls, ...http.calls]).toHaveLength(0);
          });
        }

        it(`${commandName(def)}: WRITE_DISABLED on the CLI when writes are off, before any request`, async () => {
          const { context, http } = testContext({ config: withoutWrites(suite.fixture.config, area), routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
          const { result: run, operations } = await recordOperations(() => runCli(argvFor(def, example, def.path, suite.commands), { commands: suite.commands, context }));
          expect(run.envelope?.error?.code).toBe('WRITE_DISABLED');
          expect(run.exitCode).toBe(1);
          expect(http.calls).toHaveLength(0);
          expect(operations).toHaveLength(0);
        });

        it(`${commandName(def)}: refused without allowWrite through both doors, even with writes on`, async () => {
          const cli = testContext({ config: suite.fixture.config, routes: suite.fixture.routes, files: suite.fixture.files, ...localOf(suite.fixture) });
          const { result: viaCli, operations: cliOps } = await recordOperations(() => runCli(argvFor(def, withoutFlag, def.path, suite.commands), { commands: suite.commands, context: cli.context }));
          const { session, http } = await mcpFor(suite.commands, suite.fixture.config, suite.fixture.routes, suite.fixture.files, localOf(suite.fixture));
          const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), withoutFlag));

          expect(viaCli.envelope?.error?.code).toBe('WRITE_DISABLED');
          expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
          expect(viaMcp.isError).toBe(true);
          expect([...cli.http.calls, ...http.calls]).toHaveLength(0);
          expect([...cliOps, ...mcpOps]).toHaveLength(0);
        });
      }
    }

    // Runs after the example tests above, in file order. An empty trace would
    // otherwise pass every comparison by comparing nothing with nothing.
    if (suite.fixture.trace.length > 0) {
      it('records at least one traced operation from its examples, so the trace is not empty', () => {
        expect([...logged], `${suite.name}: the fixture traces ${suite.fixture.trace.map((t) => t.label).join(', ')}, but no example logged an operation`).not.toEqual([]);
      });
    }
  });
}

/**
 * One command per path whatever the deployment: what a connection's
 * deployment has no implementation of (a command, or a flag only another
 * deployment takes) is refused, the same way through both doors, before a
 * request is sent and before the write gate speaks.
 */
describe('a command with an implementation per deployment refuses what the connection\'s deployment cannot serve, through both front doors', () => {
  for (const f of fixtures.filter((x) => x.deployments)) {
    const routed = f.commands.filter((d) => d.deployments && servedOverMcp(d));
    const deployments = Object.entries(f.deployments!);

    it(`${f.area}: finds commands with a deployment lacking them, and a flag only one deployment takes, so this proves something`, () => {
      expect(routed.some((d) => deployments.some(([deployment]) => !d.deployments!.routes[deployment]))).toBe(true);
      expect(routed.some((d) => deployments.some(([deployment]) => Object.keys(d.input.shape).some((field) => !CORE_FIELDS.includes(field) && !d.deployments!.routes[deployment]?.fields.includes(field) && d.deployments!.routes[deployment])))).toBe(true);
    });

    for (const def of routed) {
      const examples = examplesOf(def, f);
      for (const [deployment, connection] of deployments) {
        const route = def.deployments!.routes[deployment];
        // An example written for another deployment is the call to refuse, aimed at this connection.
        const aimed = (i: number) => ({ ...examples[i]!, connection });
        const refuse = async (input: Record<string, unknown>) => {
          const cli = testContext({ config: f.config, routes: f.routes, files: f.files, ...localOf(f) });
          const { result: viaCli, operations: cliOps } = await recordOperations(() => runCli(argvFor(def, input, def.path, f.commands), { commands: f.commands, context: cli.context }));
          const { session, http } = await mcpFor(f.commands, f.config, f.routes, f.files, localOf(f));
          const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), input));
          expect(viaCli.envelope?.error?.code, viaCli.stdout).toBe('UNSUPPORTED');
          expect(viaCli.exitCode).toBe(1);
          expect(viaMcp.envelope?.error?.code).toBe('UNSUPPORTED');
          expect(viaMcp.isError).toBe(true);
          expect([...cli.http.calls, ...http.calls], 'no request is sent').toHaveLength(0);
          expect([...cliOps, ...mcpOps]).toHaveLength(0);
          // The envelope says which deployment ran, even for a refusal.
          expect(viaCli.envelope?.meta.context?.connection).toMatchObject({ value: connection, deployment });
          return { cli: viaCli.envelope!, mcp: viaMcp.envelope! };
        };

        if (!route) {
          it(`${commandName(def)}: refused on ${connection} (${deployment}), which has no such command, naming the deployments that do`, async () => {
            const i = (def.exampleDeployments ?? []).findIndex((d) => d !== deployment);
            const { cli } = await refuse(aimed(i));
            expect(cli.error?.message).toContain(def.deployments!.labels[deployment]);
            expect(cli.error?.message).toContain(commandName(def));
            expect(cli.error?.fix).toContain('connection');
          });
          continue;
        }

        // A flag only another deployment takes, set on a call to this one.
        const foreign = [...new Set((def.exampleDeployments ?? []).flatMap((d, i) => (d === deployment ? [] : Object.keys(examples[i]!).filter((field) => field in def.input.shape && !route.fields.includes(field)))))];
        for (const field of foreign) {
          it(`${commandName(def)}: ${field} is refused on ${connection} (${deployment}), which doesn't take it`, async () => {
            const i = examples.findIndex((e, j) => def.exampleDeployments?.[j] !== deployment && field in e);
            const { cli, mcp } = await refuse(aimed(i));
            expect(cli.error?.message).toContain(def.deployments!.labels[deployment]);
            // The CLI names the flag, MCP the field.
            const flag = def.options?.find((o) => o.field === field)?.flags.split(/[\s,|]+/).find((p) => p.startsWith('--'));
            expect(cli.error?.message).toContain(flag ?? field);
            expect(mcp.error?.message).toContain(field);
          });
        }
      }
    }
  }
});

describe('area commands kept off MCP, on the CLI', () => {
  for (const f of fixtures) {
    for (const def of f.commands.filter((d) => isCliOnly(d) === false && !servedOverMcp(d))) {
      it(`${commandName(def)}: every example succeeds on the CLI`, async () => {
        for (const example of examplesOf(def, f)) {
          const { context } = testContext({ config: f.config, routes: f.routes, files: f.files, ...localOf(f) });
          const run = await runCli(argvFor(def, example), { commands: f.commands, context });
          expect(run.envelope?.ok, run.stdout + run.stderr).toBe(true);
          expect(run.exitCode).toBe(0);
        }
      });
      if (def.writes) {
        it(`${commandName(def)}: WRITE_DISABLED on the CLI without writes on or without --allow-write, before any request`, async () => {
          const example = examplesOf(def, f)[0]!;
          const withoutFlag = { ...example };
          delete withoutFlag.allowWrite;
          for (const [config, input] of [[withoutWrites(f.config, f.area), example], [f.config, withoutFlag]] as const) {
            const { context, http } = testContext({ config, routes: f.routes, files: f.files, ...localOf(f) });
            const run = await runCli(argvFor(def, input), { commands: f.commands, context });
            expect(run.envelope?.error?.code).toBe('WRITE_DISABLED');
            expect(http.calls).toHaveLength(0);
          }
        });
      }
    }
  }
});

describe('choosing a connection, through both front doors', () => {
  for (const f of fixtures) {
    // Only commands that resolve a connection take one; an area of area-local commands alone (osv) has none to choose.
    const served = f.commands.filter((d) => servedOverMcp(d) && usesConnection(d));
    const def = served.find((d) => !d.writes) ?? served[0];
    if (!def) continue;
    const example = def.examples[0] as Record<string, unknown>;

    it(`${f.area}: --connection <name> gives the same envelope and requests as MCP's connection field`, async () => {
      const cli = testContext({ config: f.config, routes: f.routes, files: f.files, ...localOf(f) });
      const { result: viaCli, operations: cliOps } = await recordOperations(() => runCli([...argvFor(def, example), '--connection', f.area], { commands: f.commands, context: cli.context }));
      const { session, http } = await mcpFor(f.commands, f.config, f.routes, f.files, localOf(f));
      const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), { ...example, connection: f.area }));

      expect(viaCli.envelope?.ok, viaCli.stdout).toBe(true);
      expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
      expect(http.calls).toEqual(cli.http.calls);
      expect(mcpOps).toEqual(cliOps);
    });

    it(`${f.area}: an unknown connection is INVALID_INPUT on both sides, before any request`, async () => {
      const cli = testContext({ config: f.config, routes: f.routes, files: f.files, ...localOf(f) });
      const { result: viaCli, operations: cliOps } = await recordOperations(() => runCli([...argvFor(def, example), '--connection', 'no-such-connection'], { commands: f.commands, context: cli.context }));
      const { session, http } = await mcpFor(f.commands, f.config, f.routes, f.files, localOf(f));
      const { result: viaMcp, operations: mcpOps } = await recordOperations(() => session.call(toolName(def), { ...example, connection: 'no-such-connection' }));

      expect(viaCli.envelope?.error?.code).toBe('INVALID_INPUT');
      expect(comparable(viaMcp.envelope)).toEqual(comparable(viaCli.envelope));
      expect([...cli.http.calls, ...http.calls]).toHaveLength(0);
      expect([...cliOps, ...mcpOps]).toHaveLength(0);
    });
  }
});

describe('paths routed by a flag value, against the MCP tool of the command each value picks', () => {
  it('come from the registry table, with an unregistered target skipped rather than guessed', () => {
    for (const alias of routedAliases) {
      expect(Object.keys(alias.routes).sort()).toEqual(Object.keys(alias.targets).sort());
      for (const [value, def] of Object.entries(alias.routes)) if (def) expect(commandName(def)).toBe(alias.targets[value]);
    }
  });

  for (const alias of routedAliases) {
    for (const [value, def] of Object.entries(alias.routes)) {
      if (!def || !servedOverMcp(def)) continue;
      const f = fixtures.find((x) => x.area === areaOf(def));
      if (!f) continue; // The coverage suite above fails for an area with no fixture.
      it(`toil ${alias.path.join(' ')} --source ${value} is toil ${commandName(def)}, through both doors`, async () => {
        for (const example of examplesOf(def, f)) {
          const argvs = [routedArgvFor(alias, value, def, example), ...(value === alias.default ? [[...alias.path, ...argvFor(def, example).slice(def.path.length)]] : [])];
          for (const argv of argvs) {
            clearTokenCache();
            const cli = testContext({ config: f.config, routes: f.routes, files: f.files, ...localOf(f) });
            const viaAlias = await runCli(argv, { commands: f.commands, routed: routedAliases, context: cli.context });
            const { session, http } = await mcpFor(f.commands, f.config, f.routes, f.files, localOf(f));
            const viaMcp = await session.call(toolName(def), example);
            expect(viaAlias.envelope?.ok, viaAlias.stdout + viaAlias.stderr).toBe(true);
            expect(viaAlias.envelope?.meta.command).toBe(commandName(def));
            expect(comparable(viaMcp.envelope)).toEqual(comparable(viaAlias.envelope));
            expect(http.calls).toEqual(cli.http.calls);
          }
        }
      });
    }
  }
});

describe('which tools MCP serves', () => {
  it('without --areas: configured areas plus commands that need no connection, never an unconfigured service', async () => {
    const all = [...commands, ...demoCommands];
    const bare = testContext();
    const s1 = await connectMcp({ commands: all, context: bare.context });
    sessions.push(s1);
    const names = (await s1.client.listTools()).tools.map((t) => t.name);
    expect(names).toContain('version');
    expect(names, 'an area-local command needs no connection, so it is served unconfigured').toContain('jira_issue_schema');
    expect(names).not.toContain('jira_issue_get');
    expect(names).not.toContain('demo_get_thing');

    const configured = testContext({ config: { demo: { token: 't' } } });
    const s2 = await connectMcp({ commands: all, context: configured.context });
    sessions.push(s2);
    expect((await s2.client.listTools()).tools.map((t) => t.name)).toContain('demo_get_thing');
  });

  it('with --areas: exactly the named areas, configured or not, plus wait over their reads', async () => {
    const { context } = testContext();
    const session = await connectMcp({ commands: [...commands, ...demoCommands], context, areas: ['demo'] });
    sessions.push(session);
    expect((await session.client.listTools()).tools.map((t) => t.name)).toEqual(['demo_get_thing', 'demo_status', 'wait']);
  });
});
