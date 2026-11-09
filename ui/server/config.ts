/**
 * The server's side of the settings pages (#253, item 4). `/api/config` runs
 * only `CONFIG_COMMANDS` (src/config.ts): toil's own commands for its
 * connections and toil projects, through the Store's `execute()`, with the
 * `toil-ui` caller label like every other call. The reads among them run
 * read-only; the changes run with readOnly off and each command's own write
 * gate unchanged.
 *
 * A change's questions (a connection's settings and secrets, "Save it?", the
 * typed name that turns writes on) come with the request, as the person typed
 * them on the page. `personFrom()` makes toil's `person` from them: it answers
 * each question by its id, and a hidden question only from `secrets`, so a
 * secret is never the answer to a visible question. Nothing here logs,
 * stores or returns any of it. Answers in, envelope out, nothing kept.
 */

import { CONFIG_COMMANDS, CONFIG_READS, DEFAULT_TIMEOUT_MS, type AreaInfo, type ConnectionField, type SettingsInfo } from '../src/config.ts';
import type { ExecutePerson } from '../src/toil.ts';

export { CONFIG_COMMANDS };

const READS: ReadonlySet<string> = new Set(CONFIG_READS);

/** A config command that only reads: it runs read-only. */
export const isConfigRead = (command: string): boolean => READS.has(command);

/** Why a body's answers were refused, in the page's words. */
export class AnswersError extends Error {
  constructor(message: string, readonly fix: string) {
    super(message);
  }
}

function strings(value: unknown, what: string): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.values(value).some((v) => typeof v !== 'string')) {
    throw new AnswersError(`The call's ${what} must be an object of text values.`, `Send { "${what}": { "<id>": "<what was typed>" } }.`);
  }
  return value as Record<string, string>;
}

/**
 * toil's `person` for one call, from what the page sent: `answers` by question
 * id, `secrets` by connection key. A question the page didn't answer gets
 * `undefined`, and toil saves nothing.
 */
export function personFrom(body: Record<string, unknown>): ExecutePerson {
  const answers = strings(body.answers, 'answers');
  const secrets = strings(body.secrets, 'secrets');
  const own = (o: Record<string, string>, key: string) => (Object.hasOwn(o, key) ? o[key] : undefined);
  return {
    ask: (question) => {
      if (question.secret) return question.id.startsWith('secret:') ? own(secrets, question.id.slice('secret:'.length)) : undefined;
      return own(answers, question.id);
    },
  };
}

/** The registry's areas, as the add-connection form needs them. An older toil's areas have no `connection`. */
export function areasFrom(registry: { areas: ReadonlyArray<{ name: string; description: string; connection?: readonly ConnectionField[]; scopes?: AreaInfo["scopes"]; variantBy?: string }> }): AreaInfo[] {
  return registry.areas.map((a) => ({ name: a.name, description: a.description, connection: [...(a.connection ?? [])], ...(a.scopes ? { scopes: a.scopes } : {}), ...(a.variantBy ? { variantBy: a.variantBy } : {}) }));
}

/** The time limit toil applies in this process: TOIL_TIMEOUT_MS when it's a positive number, else the default. */
export function settingsFrom(env: NodeJS.ProcessEnv): SettingsInfo {
  const value = env.TOIL_TIMEOUT_MS ?? null;
  const ms = value === null ? NaN : Number(value);
  return { timeout: { variable: 'TOIL_TIMEOUT_MS', value, effectiveMs: Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_TIMEOUT_MS, defaultMs: DEFAULT_TIMEOUT_MS } };
}
