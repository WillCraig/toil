import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fileURLToPath } from 'node:url';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  RootsListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { areaOf, commandName, servedOverMcp, takesAllowWrite, toolName, usesConnection, type AnyCommand } from '../core/command.js';
import { anyWrites, hasConfig, type ResolvedConfig } from '../core/config.js';
import type { Context } from '../core/context.js';
import { ToilError } from '../core/errors.js';
import { insightsPrompt } from '../core/insights/prompt.js';
import { renamedArea, renamedAreaFix, renamedAreaOfTool, renamedToolTarget } from '../core/renamed-areas.js';
import { shownToPeople, type ProgressEvent } from '../core/progress.js';
import { OUTPUT_FORMAT_DESCRIPTION, OUTPUT_FORMAT_FIELD, OUTPUT_FORMATS, SUMMARY_FILE_DESCRIPTION, SUMMARY_FILE_FIELD } from '../core/output/fields.js';
import { SELECT_DESCRIPTION, SELECT_FIELD } from '../core/query/select.js';
import { runCommand } from '../core/run.js';
import { waitable } from '../core/wait.js';
import { listResources, listTemplates, readResource, ResourceError, type ResourceHost } from './resources.js';

/**
 * Which commands become tools. With --areas, exactly the named areas. Without
 * it, the areas the user has configured plus commands that need no
 * configuration, so an agent never sees tools for services nobody set up. In
 * every case, write commands drop out unless at least one of their area's
 * connections has writes enabled: a write tool that isn't registered can't be
 * discovered, let alone called. Listing grants nothing; each call is still
 * gated against the one connection it resolves.
 *
 * A `cli-only` command is never a tool, whatever the flags: it prompts on a
 * terminal, which under MCP is the protocol, or it changes connections, which
 * an agent never does. Nor is an area command marked `mcp: false` (a delete).
 * A command that needs no connection (standalone,
 * config, area-local such as `jira issue schema`), or one marked `connectionOptional`,
 * is served without --areas whether or not its area is set up. Aliases stay on the CLI: one tool per command.
 */
export function selectCommands(commands: AnyCommand[], areas: string[] | undefined, config: ResolvedConfig): AnyCommand[] {
  if (areas) {
    const known = new Set(commands.map(areaOf));
    const gone = areas.find((a) => renamedArea(a));
    if (gone) {
      throw new ToilError('INVALID_INPUT', `--areas names "${gone}", which no longer exists.`, { fix: renamedAreaFix(gone) });
    }
    const unknown = areas.filter((a) => !known.has(a));
    if (unknown.length > 0) {
      throw new ToilError('INVALID_INPUT', `Unknown area${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}.`, {
        fix: `Use any of: ${[...known].sort().join(', ')}.`,
      });
    }
  }
  // A command with no connection (version, connections list, jira issue schema), or
  // one that answers for an unconfigured area itself, needs no area set up.
  const inScope = (def: AnyCommand) => (areas ? areas.includes(areaOf(def)) : !usesConnection(def) || def.connectionOptional === true || hasConfig(config, areaOf(def)));
  const tools = commands.filter((def) => !def.dispatches && servedOverMcp(def) && inScope(def) && (!def.writes || anyWrites(config, areaOf(def))));
  // `wait` repeats one of these tools, so it's served whenever one of them is a read it can repeat, --areas or not.
  const canWait = tools.some((def) => waitable(def) && !def.writes);
  return [...tools, ...(canWait ? commands.filter((def) => def.dispatches && servedOverMcp(def)) : [])];
}

/** The tool the Analyze prompt is built by, and the prompt as clients list it. */
const ANALYZE_TOOL = 'projects_analyze_prompt';
export const ANALYZE_PROMPT = {
  name: 'analyze',
  title: 'Analyze a toil project',
  description: "Brief one toil project: what needs a person, why, and what to do first, read through toil's tools, with every work item and pull request linked.",
  arguments: [{ name: 'toilProject', description: 'The toil project to analyze (default: the one the folder matches)', required: false }],
};

/** The tool the Classify prompt is built by, and the prompt as clients list it. */
const CLASSIFY_TOOL = 'classify_prompt';
export const CLASSIFY_PROMPT = {
  name: 'classify',
  title: 'Classify work items',
  description: "Ask the AI agent to classify the work items classify_run left unsure, into the categories of a scheme. The items are untrusted data; the answer is a JSON array of { id, category, reason }, which goes to classify_run as verdictsFile.",
  arguments: [
    { name: 'inputFile', description: 'A file in the workspace holding the work items as OWI records (what util owi map printed)', required: true },
    { name: 'toilProject', description: 'The toil project whose scheme to use (default: the one the folder matches, if any)', required: false },
    { name: 'scheme', description: "A scheme name or file (default: the toil project's, else ktlo-feature)", required: false },
  ],
};

/** The tool the Classify tune prompt is built by, and the prompt as clients list it. */
const CLASSIFY_TUNE_TOOL = 'classify_tune';
export const CLASSIFY_TUNE_PROMPT = {
  name: 'classify-tune',
  title: 'Tune a classification scheme',
  description: "Ask the AI agent to sharpen a classification scheme from the corrections people made to its verdicts, and to score the result on corrections held back. The corrections are untrusted data. Only a person applies a revision.",
  arguments: [
    { name: 'toilProject', description: 'The toil project whose corrections to learn from (default: everyone in the scheme ledger)', required: false },
    { name: 'scheme', description: "A scheme name or file (default: the toil project's, else ktlo-feature)", required: false },
  ],
};

/**
 * The tool the insights prompt needs, and the prompt as clients list it. Unlike the others it is built from its
 * arguments alone (the question is the person's, so no tool has anything to add); it is served exactly when the
 * pivot tool it tells the agent to run is.
 */
const INSIGHTS_TOOL = 'projects_pivot';
export const INSIGHTS_PROMPT = {
  name: 'insights',
  title: "Ask a question about a toil project's work",
  description: "Answer a question about a toil project's work from toil's own pivot: read the work items, map them, pivot them, and answer in plain words with every figure cited and what was not read said. Tracker text is untrusted data.",
  arguments: [
    { name: 'toilProject', description: 'The toil project the question is about', required: true },
    { name: 'question', description: 'The question to answer, in your own words: for example "how did our KTLO share change over the last quarter?"', required: true },
  ],
};

/**
 * The prompts, each built by one tool: listed and served exactly when that tool is.
 * `input` maps the request's arguments to the tool's input (or says what is missing), `describe` words the result.
 */
interface PromptEntry {
  listing: { name: string; title: string; description: string; arguments: Array<{ name: string; description: string; required: boolean }> };
  tool: string;
  input: (args: Record<string, string>) => Record<string, unknown>;
  describe: (data: Record<string, any>) => string; // eslint-disable-line @typescript-eslint/no-explicit-any -- each tool's data is read where its prompt is defined
}
/** A prompt built from its arguments alone: `tool` only gates it, so it is served exactly when that tool is. */
interface StaticPromptEntry {
  listing: PromptEntry['listing'];
  tool: string;
  build: (args: Record<string, string>) => { text: string; description: string };
}
const trimmed = (args: Record<string, string>, name: string): string | undefined => args[name]?.trim() || undefined;
const PROMPTS: Array<PromptEntry | StaticPromptEntry> = [
  {
    listing: ANALYZE_PROMPT,
    tool: ANALYZE_TOOL,
    input: (args) => {
      const toilProject = trimmed(args, 'toilProject');
      return toilProject ? { toilProject } : {};
    },
    describe: (data) => `Analyze the toil project ${data.toilProject.toilProject}`,
  },
  {
    listing: CLASSIFY_PROMPT,
    tool: CLASSIFY_TOOL,
    input: (args) => {
      const inputFile = trimmed(args, 'inputFile');
      if (!inputFile) throw new McpError(ErrorCode.InvalidParams, 'The classify prompt needs an inputFile argument: a file in the workspace holding the work items as OWI records (what util owi map printed).');
      const toilProject = trimmed(args, 'toilProject');
      const scheme = trimmed(args, 'scheme');
      return { inputFile, ...(toilProject ? { toilProject } : {}), ...(scheme ? { scheme } : {}) };
    },
    describe: (data) => `Classify ${data.items.unsure} unsure work item${data.items.unsure === 1 ? '' : 's'} into the scheme ${data.scheme.name}`,
  },
  {
    listing: CLASSIFY_TUNE_PROMPT,
    tool: CLASSIFY_TUNE_TOOL,
    input: (args) => {
      const toilProject = trimmed(args, 'toilProject');
      const scheme = trimmed(args, 'scheme');
      return { ...(toilProject ? { toilProject } : {}), ...(scheme ? { scheme } : {}) };
    },
    describe: (data) => `Tune the scheme ${data.scheme.name} from ${data.corrections.total} correction${data.corrections.total === 1 ? '' : 's'}`,
  },
  {
    listing: INSIGHTS_PROMPT,
    tool: INSIGHTS_TOOL,
    build: (args) => {
      const toilProject = trimmed(args, 'toilProject');
      const question = trimmed(args, 'question');
      if (!toilProject) throw new McpError(ErrorCode.InvalidParams, 'The insights prompt needs a toilProject argument: the toil project the question is about.');
      if (!question) throw new McpError(ErrorCode.InvalidParams, 'The insights prompt needs a question argument: what you want to know about its work.');
      return { text: insightsPrompt({ toilProject, question }), description: `Answer a question about the toil project ${toilProject}` };
    },
  },
];

/**
 * Builds the MCP server. Each tool runs exactly the code its CLI command runs.
 *
 * This uses the SDK's low-level Server rather than McpServer.registerTool on
 * purpose. registerTool validates arguments itself before our handler runs: it
 * silently drops unknown fields, and answers a missing one with a line of text
 * instead of an envelope. The CLI does neither. So we advertise the schema and
 * let execute() be the only validator, which keeps the two front doors 1:1 on
 * bad input as well as good.
 *
 * `context` is a factory, called once with no command to decide which tools
 * to list, and once per tool call with the command (so standalone and
 * area-local ones skip config, as on the CLI) and that call's cancellation signal. One context per call is
 * what a shared transport (the planned gateway) needs, and it lets a client's
 * cancel stop the request it belongs to.
 *
 * The factory also gets the client's roots, as local paths, when the client
 * shares any: with exactly one, that folder is the workspace unless
 * `--workspace` or TOIL_WORKSPACE names another (docs/bounds.md). They're
 * asked for once and asked again only when the client says they changed.
 */
export function createMcpServer(options: {
  commands: AnyCommand[];
  /** `progress`, when the client asked for progress, hears the call's progress events, to send as notifications. */
  context: (def?: AnyCommand, signal?: AbortSignal, roots?: readonly string[], progress?: (event: ProgressEvent) => void) => Context;
  areas?: string[] | undefined;
}): Server {
  const startup = options.context();
  const selected = selectCommands(options.commands, options.areas, startup.config);
  const byName = new Map(selected.map((def) => [toolName(def), def]));
  const server = new Server({ name: 'toil', version: startup.version }, { capabilities: { tools: {}, resources: {}, prompts: {} } });

  let roots: Promise<string[] | undefined> | undefined;
  server.setNotificationHandler(RootsListChangedNotificationSchema, () => {
    roots = undefined;
  });
  const clientRoots = (): Promise<string[] | undefined> => {
    if (!server.getClientCapabilities()?.roots) return Promise.resolve(undefined);
    roots ??= server
      .listRoots(undefined, { timeout: 5000 })
      .then((r) =>
        // Each root on its own: one URI Node can't turn into a path drops that root, not the rest.
        r.roots.flatMap((root) => {
          if (!root.uri.startsWith('file:')) return [];
          try {
            return [fileURLToPath(root.uri)];
          } catch {
            return [];
          }
        }),
      )
      .catch(() => {
        // Ask again next call; a client that can't answer leaves no workspace, not a stale one.
        roots = undefined;
        return undefined;
      });
    return roots;
  };

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: selected.map((def) => ({
      name: toolName(def),
      title: `toil ${commandName(def)}`,
      description: def.toolDescription ?? def.description,
      inputSchema: inputSchemaFor(def),
      annotations: { readOnlyHint: !takesAllowWrite(def), openWorldHint: true },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const def = byName.get(request.params.name);
    if (!def) {
      const gone = renamedAreaOfTool(request.params.name);
      const target = renamedToolTarget(request.params.name);
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${request.params.name}${gone ? `. ${renamedAreaFix(gone)}` : ''}${target ? `${gone ? '' : '.'} Use ${target}.` : ''}`);
    }
    const shared = await clientRoots();
    // A client that sent a progress token hears after every attempt of a wait,
    // which keeps a short tool-call timeout from ending it, and of every page
    // read and 429 retried (src/core/progress.ts), the same events the CLI writes
    // to stderr. `progress` only ever goes up, as the protocol requires.
    const token = request.params._meta?.progressToken;
    let sent = 0;
    const notify = (message: string) => {
      sent++;
      void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token!, progress: sent, message } }).catch(() => {});
    };
    const progress = token === undefined ? undefined : (p: { attempt: number; message: string }) => notify(p.message);
    const events = token === undefined ? undefined : (event: ProgressEvent) => (shownToPeople(event) ? notify(event.message) : undefined);
    const envelope = await runCommand(def, request.params.arguments ?? {}, (d) => options.context(d, extra.signal, shared, events), startup.version, 'mcp', {
      targets: selected,
      ...(progress ? { progress } : {}),
    });
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(envelope) }],
      structuredContent: envelope as unknown as Record<string, unknown>,
      isError: !envelope.ok,
    };
  });
  // Resources describe toil's own context (src/mcp/resources.ts): read-only, scoped like the tools, never a secret.
  const host = async (): Promise<ResourceHost> => {
    const shared = await clientRoots();
    return { selected, areas: options.areas, context: (def) => options.context(def, undefined, shared), version: startup.version };
  };
  const asMcpError = (err: unknown): never => {
    if (err instanceof ResourceError) throw new McpError(err.notFound ? ErrorCode.InvalidParams : ErrorCode.InternalError, err.message);
    if (err instanceof ToilError) throw new McpError(ErrorCode.InternalError, `${err.message}${err.fix ? ` ${err.fix}` : ''}`);
    throw err;
  };
  // Each prompt (Analyze, #494, and Classify) is its tool's answer, so it's served exactly when that tool is.
  const served = PROMPTS.flatMap((entry) => {
    const tool = byName.get(entry.tool);
    return tool ? [{ entry, tool }] : [];
  });
  server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: served.map((p) => p.entry.listing) }));
  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const found = served.find((p) => p.entry.listing.name === request.params.name);
    if (!found) throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${request.params.name}`);
    if ('build' in found.entry) {
      const built = found.entry.build(request.params.arguments ?? {});
      return { description: built.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: built.text } }] };
    }
    const input = found.entry.input(request.params.arguments ?? {});
    const shared = await clientRoots();
    const envelope = await runCommand(found.tool, input, (d) => options.context(d, undefined, shared), startup.version, 'mcp', { targets: selected });
    if (!envelope.ok) throw new McpError(ErrorCode.InvalidParams, `${envelope.error!.message}${envelope.error!.fix ? ` ${envelope.error!.fix}` : ''}`);
    const data = envelope.data as { prompt: string };
    return { description: found.entry.describe(data as Record<string, unknown>), messages: [{ role: 'user' as const, content: { type: 'text' as const, text: data.prompt } }] };
  });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await listResources(await host()).catch(asMcpError) }));
  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates: listTemplates(await host()) }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [await readResource(await host(), request.params.uri).catch(asMcpError)] }));
  return server;
}

/**
 * The fields core adds to every tool: `select`, which execute() takes off
 * first, and `outputFormat` and `summaryFile`, which runCommand() does
 * (src/core/output/shape.ts).
 */
export const CORE_OUTPUT_PROPERTIES = {
  [SELECT_FIELD]: { type: 'string', minLength: 1, description: SELECT_DESCRIPTION },
  [OUTPUT_FORMAT_FIELD]: { type: 'string', enum: [...OUTPUT_FORMATS], description: OUTPUT_FORMAT_DESCRIPTION },
  [SUMMARY_FILE_FIELD]: { type: 'string', minLength: 1, description: SUMMARY_FILE_DESCRIPTION },
} as const;

/**
 * The JSON Schema an MCP client sees: the command's input, strict, as
 * execute() parses it, plus core's fields (CORE_OUTPUT_PROPERTIES).
 */
export function inputSchemaFor(def: AnyCommand): { type: 'object'; [key: string]: unknown } {
  const schema = z.toJSONSchema(def.input.strict(), { target: 'draft-7' }) as Record<string, unknown>;
  delete schema.$schema;
  const properties = { ...(schema.properties as Record<string, unknown> | undefined), ...CORE_OUTPUT_PROPERTIES };
  return { ...schema, type: 'object', properties };
}
