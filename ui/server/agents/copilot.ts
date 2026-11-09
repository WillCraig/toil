/**
 * The Copilot adapter (#251): the GitHub Copilot SDK (`@github/copilot-sdk`,
 * an optional peer dependency) driving the Copilot CLI already on this
 * machine over stdio (`RuntimeConnection.forStdio({ path })`), so the SDK's
 * bundled runtime is never started. It signs in the way the CLI does (the
 * user's Copilot seat); Toil UI passes no token and stores none.
 *
 * Locked down: the session's tools are Toil UI's read tools and nothing else
 * (`availableTools` names only them, as `custom:<name>`), each marked
 * `skipPermission` because it only reads, and every other permission request
 * is rejected. The CLI gets an explicit environment, the allowlist in env.ts,
 * rather than inheriting Toil UI's. The system message is replaced with Toil UI's. Options checked
 * against the SDK's types.d.ts at 1.0.16.
 */

import type { PremiumQuota } from '../../src/model-usage.ts';
import type { Runtime, UsageReport } from './runtime.ts';

interface CopilotSession {
  on(event: string, handler: (e: { id?: string; data?: Record<string, unknown> }) => void): () => void;
  sendAndWait(options: { prompt: string }, timeout?: number): Promise<{ data?: { content?: string } } | undefined>;
  abort(): Promise<void>;
  disconnect(): Promise<void>;
}
interface CopilotClient {
  /** The server RPC; `account.getQuota` is experimental and may not be there. */
  rpc?: { account?: { getQuota?: (params: Record<string, unknown>) => Promise<unknown> } };
  start(): Promise<void>;
  stop(): Promise<Error[]>;
  createSession(config: Record<string, unknown>): Promise<CopilotSession>;
}
interface CopilotSdk {
  CopilotClient: new (options: Record<string, unknown>) => CopilotClient;
  RuntimeConnection: { forStdio(options: { path: string; env: Record<string, string> }): unknown };
  defineTool(name: string, config: Record<string, unknown>): unknown;
}

/** How long one question may take before the adapter gives up waiting (Bounds). */
export const COPILOT_TIMEOUT_MS = 10 * 60_000;

const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined);

/**
 * One `assistant.usage` event as a report (#295): one model call, with its
 * tokens and `cost`, the premium-request multiplier the SDK bills it at. The
 * events are live only (never replayed on resume), so each is reported as it
 * arrives, by its own event id. There is never a dollar figure.
 */
export function copilotUsage(data: Record<string, unknown> | undefined, id: string): UsageReport {
  const d = data ?? {};
  const out: UsageReport = { id, model: typeof d.model === 'string' ? d.model : null, costSource: 'none' };
  // Copilot bills the multiplier once per prompt the person sent: only the call it initiated (`initiator` "user", or
  // absent) is charged, and the agent's own follow-up calls in the tool loop report the same `cost` but bill nothing,
  // as the session's `usage.getMetrics` totals show (#317, measured live). Counting every call overstated a question 3-6x.
  const billed = d.initiator === undefined || d.initiator === 'user';
  const figures = { inputTokens: count(d.inputTokens), cachedInputTokens: count(d.cacheReadTokens), cacheWriteTokens: count(d.cacheWriteTokens), outputTokens: count(d.outputTokens), premiumRequests: count(d.cost) === undefined ? undefined : billed ? count(d.cost) : 0 };
  for (const [k, v] of Object.entries(figures)) if (v !== undefined) (out as unknown as Record<string, number>)[k] = v;
  return out;
}

/** The premium-interactions snapshot from `account.getQuota` (experimental), or null when it has none. */
export function premiumQuota(result: unknown): PremiumQuota | null {
  const snap = (result as { quotaSnapshots?: Record<string, Record<string, unknown> | undefined> } | undefined)?.quotaSnapshots?.premium_interactions;
  if (!snap || typeof snap !== 'object') return null;
  const unlimited = snap.isUnlimitedEntitlement === true;
  const entitlement = count(snap.entitlementRequests) ?? null;
  const used = count(snap.usedRequests);
  return { unlimited, entitlement: unlimited ? null : entitlement, remaining: unlimited || entitlement === null || used === undefined ? null : Math.max(0, entitlement - used), resetDate: typeof snap.resetDate === 'string' ? snap.resetDate : null };
}

export function copilotRuntime(): Runtime {
  return {
    name: 'copilot',
    label: 'GitHub Copilot',
    package: '@github/copilot-sdk',
    command: 'copilot',
    cliLabel: 'the Copilot CLI',
    // RuntimeConnection.forStdio runs a .js path with Node (client.js at 1.0.16), so npm's copilot.cmd resolves to its npm-loader.js.
    scripts: true,
    cliPackage: { name: '@github/copilot', script: 'npm-loader.js' },
    async run(module, r) {
      const sdk = module as CopilotSdk;
      const client = new sdk.CopilotClient({ connection: sdk.RuntimeConnection.forStdio({ path: r.cli, env: Object.fromEntries(Object.entries(r.env).filter((e): e is [string, string] => typeof e[1] === 'string')) }), workingDirectory: r.workDir, logLevel: 'error' });
      await client.start();
      try {
        const session = await client.createSession({
          ...(r.model ? { model: r.model } : {}),
          systemMessage: { mode: 'replace', content: r.system },
          tools: r.tools.map((t) =>
            sdk.defineTool(t.name, { description: t.description, parameters: t.inputSchema, skipPermission: true, handler: async (args: Record<string, unknown>) => JSON.stringify(await t.run(args ?? {}, r.signal)) }),
          ),
          availableTools: r.tools.map((t) => `custom:${t.name}`),
          streaming: true,
          onPermissionRequest: () => ({ kind: 'reject', feedback: 'Toil UI allows only its own read tools.' }),
        });
        let current = '';
        session.on('assistant.message_start', () => {
          current = '';
        });
        session.on('assistant.message_delta', (e) => {
          current += String(e.data?.deltaContent ?? '');
          r.onText(current);
        });
        // Usage (#295): every model call's event, stored as it arrives, and the context window's fill.
        const calls: UsageReport[] = [];
        session.on('assistant.usage', (e) => {
          calls.push(copilotUsage(e.data, `copilot:${e.id ?? `${r.runId}:${calls.length + 1}`}`));
          r.usage.report([...calls]);
        });
        session.on('session.usage_info', (e) => {
          const used = count(e.data?.currentTokens);
          const window = count(e.data?.tokenLimit);
          if (used !== undefined && window) r.usage.context({ used, window });
        });
        const abort = () => void session.abort();
        r.signal.addEventListener('abort', abort, { once: true });
        try {
          const reply = await session.sendAndWait({ prompt: r.prompt }, COPILOT_TIMEOUT_MS);
          if (r.signal.aborted) throw new Error('The question was stopped.');
          // The premium requests left, where the pinned SDK has the experimental call; its absence or failure costs the answer nothing.
          try {
            const account = client.rpc?.account;
            const quota = typeof account?.getQuota === 'function' ? premiumQuota(await account.getQuota({})) : null;
            if (quota) r.usage.quota(quota);
          } catch {
            // Experimental, so a refusal here only means no quota line under the answer.
          }
          return reply?.data?.content ?? current;
        } finally {
          r.signal.removeEventListener('abort', abort);
          await session.disconnect().catch(() => undefined);
        }
      } finally {
        await client.stop().catch(() => undefined);
      }
    },
  };
}
