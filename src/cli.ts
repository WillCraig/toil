import { homedir, userInfo } from 'node:os';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { areaOf, servedOverMcp, type AnyCommand } from './core/command.js';
import { CONTRACT_VERSION, type Envelope } from './core/envelope.js';
import type { AreaInfo } from './core/config.js';
import type { Context } from './core/context.js';
import { createSecretStore } from './core/keychain.js';
import { cliProgress, type ProgressEvent } from './core/progress.js';
import { terminalPrompter } from './core/prompt.js';
import { createMcpServer } from './mcp/server.js';
import { nodeBanner } from './core/runtime.js';
import { checkOutputFile, createNodeContext, writeOutputFile } from './node-context.js';
import { runProgram, type CliIO, type GlobalOptions, type ProgramOptions } from './program.js';
import { areas, commands, routedAliases } from './registry.js';
import { VERSION } from './version.js';
import { commandSummaries, gatherWelcomeData } from './welcome/data.js';
import { runWelcome, wantsWelcome } from './welcome/index.js';
import { saveFor } from './welcome/rogue/save.js';

/**
 * The one bundle of code, dist/toil-lib.js. Loading it runs nothing: no CLI,
 * no SIGINT listener (which would switch off a host's own exit on Ctrl+C), no
 * prompter, however it's loaded or re-bundled. Two thin entries sit beside it,
 * written by tsup.config.ts: dist/toil.js, the bin, which calls `main()`, and
 * dist/api.js, `@imagile-dev/toil/api`, which re-exports the API and nothing else.
 */
export * from './api.js';

/** Runs toil as the CLI on this process: argv, stdio, Ctrl+C, the exit code. Only dist/toil.js calls it. */
export async function main(): Promise<void> {
  const areaInfo: AreaInfo[] = areas.map((a) => ({ name: a.name, fallbacks: a.fallbacks, ...(a.fallbackWhen ? { fallbackWhen: a.fallbackWhen } : {}), contextInputs: Object.keys(a.context), ...(a.siteApis ? { siteApis: a.siteApis } : {}) }));

  // Ctrl-C cancels the command in flight; execute() turns it into a CANCELLED
  // envelope. Installing this listener switches off Node's own exit on SIGINT,
  // so anything long-lived (toil mcp) has to exit on it itself.
  const interrupt = new AbortController();
  process.once('SIGINT', () => interrupt.abort());

  // Nothing is spawned until a `keychain:` reference is actually read.
  const secrets = createSecretStore();
  // Progress (src/core/progress.ts) on stderr, never stdout: every retry, piped
  // or not, and pages on a terminal only (cliProgress).
  const toStderr = cliProgress(process.stderr);
  // Setup commands may ask questions, only of a person at a terminal. MCP never gets a prompter.
  const prompt = process.stdin.isTTY && process.stderr.isTTY ? terminalPrompter(process.stdin, process.stderr) : undefined;

  const progressOn = (progress: ((event: ProgressEvent) => void) | undefined) => (progress ? { progress } : {});

  const createContext = (globals: GlobalOptions, def?: AnyCommand, signal: AbortSignal = interrupt.signal, mcp = false, roots?: readonly string[], mcpProgress?: (event: ProgressEvent) => void): Context =>
    createNodeContext({
      globals,
      def,
      signal,
      // Under `toil mcp` stdin carries the protocol, so `-` can't mean it, and
      // the workspace comes from the flag, the env or the client's one root.
      // On an interactive terminal nothing is piped in, so `-` refuses rather than waits.
      stdin: mcp ? false : process.stdin.isTTY ? 'terminal' : true,
      roots,
      env: process.env,
      cwd: process.cwd(),
      home: homedir(),
      areas: areaInfo,
      version: VERSION,
      stderr: (t) => process.stderr.write(t),
      secrets,
      prompt: mcp ? undefined : prompt,
      ...progressOn(mcp ? mcpProgress : toStderr),
    });

  const io: CliIO = {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    writeFile: (path, content, globals) => writeOutputFile({ path, content, cwd: process.cwd(), home: homedir(), config: globals.config }),
    checkFile: (path, globals) => checkOutputFile({ path, cwd: process.cwd(), home: homedir(), config: globals.config }),
  };

  const program = (overrides: Partial<ProgramOptions> = {}): ProgramOptions => ({
    commands,
    routed: routedAliases,
    version: VERSION,
    io,
    createContext: (globals, def) => createContext(globals, def),
    startMcp: async ({ areas, globals }) => {
      // stdout belongs to the protocol from here on; diagnostics go to stderr.
      // Each tool call gets its own context, cancelled by the client's own signal.
      const server = createMcpServer({ commands, context: (def, signal, roots, progress) => createContext(globals, def, signal ?? interrupt.signal, true, roots, progress), areas });
      process.once('SIGINT', () => {
        void server.close().finally(() => process.exit(130));
      });
      await server.connect(new StdioServerTransport());
    },
    ...overrides,
  });

  /**
   * What the welcome menu runs: a real command, through the same program as the
   * shell, prompting on this terminal, with its envelope captured instead of
   * printed. Each run gets its own cancel, so Ctrl+C at a prompt stops that
   * command and leaves the menu standing.
   */
  const runForMenu = async (args: string[], signal: AbortSignal): Promise<Envelope> => {
    let out = '';
    await runProgram(
      program({
        io: { ...io, stdout: (text) => (out += text) },
        createContext: (globals, def) => createContext(globals, def, signal),
        startMcp: () => Promise.reject(new Error('The menu never starts the MCP server.')),
      }),
      args,
      'user',
    );
    try {
      return JSON.parse(out) as Envelope;
    } catch {
      // Every command prints one envelope; if one didn't, say so rather than pretend.
      return { ok: false, data: null, error: { code: 'INTERNAL', message: `toil ${args.join(' ')} printed no envelope.` }, meta: { command: args.join(' '), durationMs: 0, version: VERSION, contractVersion: CONTRACT_VERSION } };
    }
  };

  const welcomeData = () =>
    gatherWelcomeData({
      version: VERSION,
      env: process.env,
      cwd: process.cwd(),
      home: homedir(),
      areas: areaInfo,
      catalog: areas.map((a) => ({ name: a.name, description: a.description, signsIn: a.secrets.length > 0, live: Boolean(a.probe && a.request), configurable: Object.keys(a.connection.shape).length > 0, context: Object.keys(a.context), ...(a.siteApis ? { siteApis: a.siteApis } : {}), checksToilProject: commands.some((def) => def.path[0] === a.name && def.path[1] === 'check-toil-project'), commands: commandSummaries(a.name, commands) })),
      mcpAreas: [...new Set(commands.filter((def) => servedOverMcp(def) && def.kind !== 'standalone').map(areaOf))].sort(),
      script: process.argv[1],
    });

  /** The account name the game's save key is derived from. `userInfo()` throws for a user ID with no account entry, as in some containers. */
  const accountName = (): string => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER ?? process.env.USERNAME ?? '';
    }
  };

  const banner = nodeBanner(process.versions.node);
  if (banner) process.stderr.write(banner);

  try {
    if (wantsWelcome(process.argv.slice(2), process.stdin, process.stdout, process.env)) {
      const data = welcomeData();
      const save = saveFor(data.configPath, { user: accountName(), home: homedir() });
      const ended = await runWelcome({ input: process.stdin, output: process.stdout, env: process.env, run: runForMenu, reload: welcomeData, save, probeBackground: true }, data);
      if (ended === 'interrupted') process.exitCode = 130;
    } else {
      process.exitCode = await runProgram(program(), process.argv);
    }
    if (interrupt.signal.aborted) process.exitCode = 130;
  } catch (err) {
    process.exitCode = 1;
    process.stderr.write(`${(err as Error).message}\n`);
  }
}
