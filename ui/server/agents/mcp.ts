/**
 * A small MCP server over loopback HTTP, for the one SDK that takes tools
 * only from an MCP server (Codex, codex.ts). Each run gets a grant: a random
 * bearer token and the toil project's read tools, gone when the run ends. The
 * server (server.ts) answers `POST <base>api/agent/mcp` with the grant the
 * token names, and only with no `Origin` header, so a web page can't use it
 * (browsers always send one on a POST, and this server sends no CORS headers).
 *
 * It speaks the streamable HTTP transport's plain-JSON form: one JSON-RPC
 * message per POST, answered with one JSON response (`initialize`,
 * `tools/list`, `tools/call`, `ping`), and 202 for a notification. No
 * sessions, no SSE stream, no resources or prompts: the tools are the whole
 * point. A hatch in the wall for one courier, bricked up behind them.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { ServedTools } from './runtime.ts';
import type { ToolSpec } from './tools.ts';

/** The protocol versions this answers; it echoes the client's when it knows it. */
export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class McpGrants {
  private readonly grants = new Map<string, ToolSpec[]>();
  constructor(private readonly url: () => string) {}

  /** Serves these tools until `close()`. */
  serve(tools: ToolSpec[]): ServedTools {
    const token = randomBytes(32).toString('base64url');
    this.grants.set(token, tools);
    return { url: this.url(), token, close: () => void this.grants.delete(token) };
  }

  /** The tools a bearer token was granted, or undefined. */
  tools(authorization: string | undefined): ToolSpec[] | undefined {
    const m = /^Bearer (\S+)$/.exec(authorization ?? '');
    if (!m) return undefined;
    const given = Buffer.from(m[1]!);
    for (const [token, tools] of this.grants) {
      const t = Buffer.from(token);
      if (t.length === given.length && timingSafeEqual(t, given)) return tools;
    }
    return undefined;
  }

  get size() {
    return this.grants.size;
  }
}

interface Rpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

const reply = (id: Rpc['id'], result: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result });
const fail = (id: Rpc['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** One JSON-RPC message for one grant's tools: the response, or null for a notification (202, no body). */
export async function answerMcp(message: unknown, tools: ToolSpec[], version: string, signal?: AbortSignal): Promise<unknown | null> {
  if (Array.isArray(message)) return fail(null, -32600, 'Batches are not supported; send one message per request.');
  const rpc = (typeof message === 'object' && message !== null ? message : {}) as Rpc;
  if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return fail(rpc.id, -32600, 'Not a JSON-RPC 2.0 request.');
  if (rpc.id === undefined) return null;
  switch (rpc.method) {
    case 'initialize': {
      const asked = typeof rpc.params?.protocolVersion === 'string' ? rpc.params.protocolVersion : '';
      return reply(rpc.id, {
        protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'toil-ui', version },
        instructions: "Toil UI's read-only tools for one Toil project. Nothing here writes.",
      });
    }
    case 'ping':
      return reply(rpc.id, {});
    case 'tools/list':
      return reply(rpc.id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: true } })) });
    case 'tools/call': {
      const name = rpc.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return fail(rpc.id, -32602, `There is no tool ${JSON.stringify(name)}; Toil UI serves only its read tools.`);
      const args = rpc.params?.arguments;
      const result = await tool.run(typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {}, signal);
      return reply(rpc.id, { content: [{ type: 'text', text: JSON.stringify(result) }], isError: typeof result === 'object' && result !== null && 'error' in result });
    }
    default:
      return fail(rpc.id, -32601, `Toil UI's MCP server has no method ${rpc.method}.`);
  }
}
