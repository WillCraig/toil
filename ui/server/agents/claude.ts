/**
 * The Claude adapter (#251): the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`,
 * an optional peer dependency) running the Claude Code CLI already on this
 * machine, through `pathToClaudeCodeExecutable`, so the SDK's own bundled
 * binary is never used. The endpoint follows Claude Code's own environment
 * switches: the Anthropic API (the default), Bedrock (`CLAUDE_CODE_USE_BEDROCK`),
 * Foundry (`CLAUDE_CODE_USE_FOUNDRY`) or Vertex (`CLAUDE_CODE_USE_VERTEX`).
 * Credentials stay where Claude Code keeps them; Toil UI passes none.
 *
 * Locked down: no built-in tools (`tools: []`), no settings, hooks, plugins or
 * MCP servers from the machine (`settingSources: []`, `strictMcpConfig`), only
 * Toil UI's own read tools on an in-process MCP server, each allowed by name,
 * everything else denied without asking (`permissionMode: 'dontAsk'`), and no
 * session file written. A failed sign-in, which Claude Code reports as a
 * "successful" result marked `is_error`, is an error, not an answer. The SDK takes tool inputs as zod
 * shapes, so the JSON Schemas are turned into zod with the `zod` the SDK
 * names as its own peer dependency. Options checked against the SDK's
 * sdk.d.ts at 0.3.289.
 */

import { higherFigures } from '../../src/model-usage.ts';
import type { Endpoint, Runtime, UsageReport } from './runtime.ts';
import type { ToolSpec } from './tools.ts';

/** The env switch Claude Code reads for each endpoint. */
export const ENDPOINT_ENV: Record<Exclude<Endpoint, 'anthropic'>, string> = {
  bedrock: 'CLAUDE_CODE_USE_BEDROCK',
  foundry: 'CLAUDE_CODE_USE_FOUNDRY',
  vertex: 'CLAUDE_CODE_USE_VERTEX',
};

/** The MCP server's name, and so the prefix of every tool name Claude sees: `mcp__toil_ui__owi_query`. */
export const SERVER = 'toil_ui';
export const claudeToolName = (name: string) => `mcp__${SERVER}__${name}`;

/** The environment for Claude Code: the server's own, with the chosen endpoint's switch on and the others off. */
export function claudeEnv(env: Record<string, string | undefined>, endpoint: Endpoint | null, version: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: `toil-ui/${version}` };
  for (const [name, variable] of Object.entries(ENDPOINT_ENV)) {
    if (name === endpoint) out[variable] = '1';
    else if (endpoint) delete out[variable];
  }
  return out;
}

// The part of zod this file uses. zod is the Claude SDK's own peer dependency, loaded beside it.
interface ZodType {
  describe(d: string): ZodType;
  optional(): ZodType;
  int(): ZodType;
  min(n: number): ZodType;
  max(n: number): ZodType;
}
interface Zod {
  string(): ZodType;
  number(): ZodType;
  boolean(): ZodType;
  unknown(): ZodType;
  array(t: ZodType): ZodType;
  enum(values: [string, ...string[]]): ZodType;
  object(shape: Record<string, ZodType>): ZodType;
  union(types: [ZodType, ZodType, ...ZodType[]]): ZodType;
}

type Schema = Record<string, unknown>;

/** One JSON Schema property as zod. Anything this doesn't model becomes `unknown`, and toil's own strict check still applies. */
export function zodOf(z: Zod, s: Schema): ZodType {
  let t: ZodType;
  const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
  if (Array.isArray(s.enum) && s.enum.length && s.enum.every((v) => typeof v === 'string')) t = z.enum(s.enum as [string, ...string[]]);
  else if (types.length > 1) {
    const parts = types.map((type) => zodOf(z, { ...s, type, description: undefined }));
    t = parts.length >= 2 ? z.union(parts as [ZodType, ZodType, ...ZodType[]]) : parts[0]!;
  } else if (types[0] === 'string') t = z.string();
  else if (types[0] === 'integer' || types[0] === 'number') {
    t = types[0] === 'integer' ? z.number().int() : z.number();
    if (typeof s.minimum === 'number') t = t.min(s.minimum);
    if (typeof s.maximum === 'number') t = t.max(s.maximum);
  } else if (types[0] === 'boolean') t = z.boolean();
  else if (types[0] === 'array') t = z.array(s.items && typeof s.items === 'object' ? zodOf(z, s.items as Schema) : z.unknown());
  else if (types[0] === 'object' && s.properties && typeof s.properties === 'object') t = z.object(zodShape(z, s as ToolSpec['inputSchema']));
  else t = z.unknown();
  return typeof s.description === 'string' ? t.describe(s.description) : t;
}

/** A tool's input schema as the zod raw shape the SDK's `tool()` takes. */
export function zodShape(z: Zod, schema: Pick<ToolSpec['inputSchema'], 'properties' | 'required'>): Record<string, ZodType> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(Object.entries(schema.properties).map(([k, s]) => [k, required.has(k) ? zodOf(z, s) : zodOf(z, s).optional()]));
}

/** A message as its message_start streams it: the id, model and usage its step is recorded under. */
interface Streaming {
  id?: unknown;
  model?: unknown;
  usage?: Record<string, unknown>;
}

interface ClaudeSdk {
  query(params: { prompt: string; options: Record<string, unknown> }): AsyncIterable<Record<string, unknown>>;
  tool(name: string, description: string, shape: Record<string, ZodType>, handler: (args: Record<string, unknown>) => Promise<unknown>, extras?: Record<string, unknown>): unknown;
  createSdkMcpServer(options: { name: string; version?: string; tools: unknown[]; alwaysLoad?: boolean }): unknown;
}

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/** Figures without the ones the SDK left out: a missing field stays absent, never 0. */
function figures(f: Pick<UsageReport, 'inputTokens' | 'cachedInputTokens' | 'cacheWriteTokens' | 'outputTokens'>): Partial<UsageReport> {
  return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined));
}

/** One step's usage, from an assistant message's Messages API `usage`: steps share a message id when one message streams in pieces. */
export function claudeStepUsage(message: unknown): UsageReport | null {
  const m = message as { id?: unknown; model?: unknown; usage?: Record<string, unknown> } | undefined;
  if (!m || typeof m.id !== 'string' || !m.usage || typeof m.usage !== 'object') return null;
  // Claude Code writes its own errors ("Not logged in") as an assistant message from the model `<synthetic>`, with
  // zeroed usage: no model ran, so it is no report at all rather than a row of zeros in the ledger (#318, seen live).
  if (m.model === '<synthetic>') return null;
  const u = m.usage;
  return {
    id: `claude:${m.id}`,
    model: typeof m.model === 'string' ? m.model : null,
    costSource: 'none',
    ...figures({ inputTokens: count(u.input_tokens), cachedInputTokens: count(u.cache_read_input_tokens), cacheWriteTokens: count(u.cache_creation_input_tokens), outputTokens: count(u.output_tokens) }),
  };
}

/**
 * The result's `modelUsage`, one report per model: the SDK's own figures for
 * the whole query, which the docs name as the field for accounting, and its
 * `costUSD`, an estimate. On a Claude plan (no API key, the first-party API)
 * that estimate is what the tokens would cost on the API, not a bill.
 */
export function claudeResultUsage(result: Record<string, unknown>, plan: boolean): UsageReport[] {
  const per = result.modelUsage;
  if (!per || typeof per !== 'object') return [];
  const session = typeof result.session_id === 'string' ? result.session_id : 'session';
  return Object.entries(per as Record<string, Record<string, unknown>>).map(([model, u]) => {
    const cost = count(u.costUSD);
    return {
      id: `claude:${session}:${model}`,
      model,
      costSource: cost === undefined ? 'none' : 'sdk-estimate',
      ...(cost === undefined ? {} : { costUsd: cost }),
      ...(plan && cost !== undefined ? { plan: true } : {}),
      ...figures({ inputTokens: count(u.inputTokens), cachedInputTokens: count(u.cacheReadInputTokens), cacheWriteTokens: count(u.cacheCreationInputTokens), outputTokens: count(u.outputTokens) }),
    };
  });
}

/** Whether a run is on a Claude plan: the init message says no API key was used, and the model was served by Anthropic's own API. */
export const onPlan = (apiKeySource: unknown, provider: unknown, endpoint: Endpoint | null) =>
  apiKeySource === 'none' && (provider === 'firstParty' || (provider === undefined && (endpoint === null || endpoint === 'anthropic')));

const textOf = (content: unknown): string =>
  Array.isArray(content) ? content.filter((b: { type?: string }) => b?.type === 'text').map((b: { text?: string }) => b.text ?? '').join('') : '';

export function claudeRuntime(version: string): Runtime {
  return {
    name: 'claude',
    label: 'Claude',
    package: '@anthropic-ai/claude-agent-sdk',
    command: 'claude',
    cliLabel: 'Claude Code',
    async run(module, r) {
      const sdk = module as ClaudeSdk;
      const zodModule = (await r.importer('zod')) as { z?: Zod; default?: Zod };
      const z = zodModule.z ?? zodModule.default ?? (zodModule as unknown as Zod);
      const allowed = r.tools.map((t) => claudeToolName(t.name));
      const server = sdk.createSdkMcpServer({
        name: SERVER,
        version,
        alwaysLoad: true,
        tools: r.tools.map((t) =>
          sdk.tool(t.name, t.description, zodShape(z, t.inputSchema), async (args) => ({ content: [{ type: 'text', text: JSON.stringify(await t.run(args ?? {}, r.signal)) }] }), { annotations: { readOnlyHint: true } }),
        ),
      });
      const abortController = new AbortController();
      const abort = () => abortController.abort();
      r.signal.addEventListener('abort', abort, { once: true });
      let current = '';
      let last = '';
      // Usage (#295): each step's, by message id, until the result's per-model figures replace them.
      const steps = new Map<string, UsageReport>();
      let apiKeySource: unknown;
      let lastStep: UsageReport | null = null;
      // The message streaming now, from its message_start: the assistant messages carry only that event's usage, so
      // message_delta's final figures (a tool call's output tokens, say) are added to it here (#318, seen live).
      let streaming = null as Streaming | null;
      const step = (s: UsageReport | null) => {
        if (!s) return;
        const seen = steps.get(s.id);
        // One message streamed in pieces repeats its usage: the same id, so the highest of each figure.
        const merged = seen ? higherFigures(seen, s) : s;
        steps.set(s.id, merged);
        lastStep = merged;
        r.usage.report([...steps.values()]);
      };
      const settle = (m: Record<string, unknown>) => {
        const per = (m.modelUsage ?? {}) as Record<string, { provider?: unknown; contextWindow?: unknown }>;
        const first = Object.values(per)[0];
        const totals = m.subtype === 'success' ? claudeResultUsage(m, onPlan(apiKeySource, first?.provider, r.endpoint)) : [];
        // An error result may carry zeroed figures, so the steps seen stand instead.
        r.usage.report(totals.length ? totals : [...steps.values()]);
        const window = count(lastStep?.model ? per[lastStep.model]?.contextWindow : first?.contextWindow);
        if (lastStep && window) r.usage.context({ used: (lastStep.inputTokens ?? 0) + (lastStep.cachedInputTokens ?? 0) + (lastStep.cacheWriteTokens ?? 0) + (lastStep.outputTokens ?? 0), window });
      };
      try {
        for await (const m of sdk.query({
          prompt: r.prompt,
          options: {
            pathToClaudeCodeExecutable: r.cli,
            ...(r.model ? { model: r.model } : {}),
            systemPrompt: r.system,
            tools: [],
            mcpServers: { [SERVER]: server },
            strictMcpConfig: true,
            allowedTools: allowed,
            permissionMode: 'dontAsk',
            settingSources: [],
            persistSession: false,
            includePartialMessages: true,
            maxTurns: 30,
            cwd: r.workDir,
            env: claudeEnv(r.env, r.endpoint, version),
            abortController,
          },
        })) {
          // Stopped (the page's cancel): nothing more is read, whether or not the SDK has noticed yet.
          if (r.signal.aborted) throw new Error('The question was stopped.');
          if (m.type === 'system' && m.subtype === 'init') apiKeySource = m.apiKeySource;
          if (m.parent_tool_use_id) continue;
          if (m.type === 'stream_event') {
            const event = m.event as { type?: string; message?: Streaming; usage?: Record<string, unknown>; delta?: { type?: string; text?: string } };
            if (event.type === 'message_start') {
              current = '';
              streaming = event.message ?? null;
            } else if (event.type === 'message_delta' && event.usage && streaming) step(claudeStepUsage({ ...streaming, usage: { ...streaming.usage, ...event.usage } }));
            else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
              current += event.delta.text ?? '';
              r.onText(current);
            }
          } else if (m.type === 'assistant') {
            const t = textOf((m.message as { content?: unknown } | undefined)?.content);
            if (t) last = t;
            step(claudeStepUsage(m.message));
          } else if (m.type === 'result') {
            settle(m);
            // A failed sign-in still comes back as subtype success, with is_error set and the reason as its text.
            if (m.subtype === 'success' && m.is_error !== true && typeof m.result === 'string') return m.result || last;
            if (m.subtype === 'success') throw new Error(`Claude Code answered with an error: ${typeof m.result === 'string' && m.result ? m.result : 'no message'}`);
            const errors = Array.isArray(m.errors) ? (m.errors as string[]).join('; ') : String(m.subtype);
            throw new Error(`Claude Code stopped without an answer (${errors}).`);
          }
        }
        return last;
      } finally {
        r.signal.removeEventListener('abort', abort);
      }
    },
  };
}
