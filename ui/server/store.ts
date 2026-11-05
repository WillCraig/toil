/**
 * The Store: where the server gets what a view shows (#206, Hosting-ready by
 * design). The SPA reads through one seam, toil's own `execute()` signature
 * (src/toil.ts), so a Store answers toil calls. Three ship beside each other
 * and one is chosen at startup:
 *
 * - `sqliteStore`: the SQLite cache (#250), answering the views' calls from
 *   what a sync stored (server/sync.ts). `toil-ui` picks it.
 * - `toilStore`: toil itself, in-process through `@imagile-dev/toil/api`, with
 *   the user's own connections and toil projects, every call live. Every call is
 *   `caller: 'toil-ui'` in the audit log.
 * - `fixtureStore`: the preview's fixture `execute()` and its sample data, for
 *   `toil-ui --sample`, the site preview and the tests.
 *
 * The server, not the Store, decides what a call may do: a read
 * from `READ_COMMANDS` always goes `readOnly`, a config change only for a
 * command in the server's config allowlist (#253), and anything else is
 * refused before a Store sees it. Two locks on one door, and both keys stay
 * with the tenant.
 */

import { fixtureConfigExecute } from '../src/fixtures/config.ts';
import { fixtureFeedbackEnvelope } from '../src/fixtures/feedback.ts';
import { FIXTURE_NOW, fixtureExecute } from '../src/fixtures/execute.ts';
import { windowFor, withWindow } from '../src/load.ts';
import type { Envelope, Execute, ExecuteOptions, ExecutePerson } from '../src/toil.ts';
import type { Cache } from './cache.ts';
import { READ_COMMANDS, WORKFLOW_READS } from './reads.ts';
import type { RequestContext } from './context.ts';

export { READ_COMMANDS, WORKFLOW_READS };

/**
 * What a call is allowed to do. `read` is every view; `config` is #253's
 * settings pages; `feedback` is `toil feedback` from the Feedback dialog
 * (#265), and nothing else.
 */
export type Access = 'read' | 'config' | 'feedback';

export interface Store {
  /** `toil`, `fixture`, and later `sqlite`: shown in the session, so a view can say where its data came from. */
  readonly kind: string;
  /** Sample data: the views carry the preview banner. */
  readonly sample: boolean;
  /** The moment the views work their figures out at: now, or the sample's fixed day. */
  now(): string;
  /**
   * Runs one toil call for the viewer and returns its envelope; never throws.
   * `access` is the server's decision, already checked against its
   * allowlists: `read` must run read-only, and so must a `config` call the
   * server marks `readOnly`. `person` carries a config change's answers
   * (ui/server/config.ts), for the commands that ask a person questions.
   */
  execute(ctx: RequestContext, command: string, input: Record<string, unknown>, access: Access, how?: ConfigCall): Promise<Envelope>;
}

/** How a `config` or `feedback` call runs: read-only for the pages' reads and a feedback preview, and with the person's answers for a change or a send. */
export interface ConfigCall {
  readOnly: boolean;
  person?: ExecutePerson;
}

/** Every Toil UI call names itself, so the audit log says which lines were the UI's. */
export const CALLER = 'toil-ui';

/**
 * The options a call to toil's own `execute()` gets: read-only for every read
 * and for a config read, and a config change's person only on a config call.
 */
function toilOptions(ctx: RequestContext, access: Access, how: ConfigCall | undefined): ExecuteOptions {
  return {
    readOnly: access === 'read' || how?.readOnly !== false,
    caller: CALLER,
    signal: ctx.signal,
    ...(access !== 'read' && how?.person ? { person: how.person } : {}),
  };
}

/** toil's own `execute()`, read-only for every read; `config` calls go through toil's write rules unchanged. */
export function toilStore(execute: Execute): Store {
  return {
    kind: 'toil',
    sample: false,
    now: () => new Date().toISOString(),
    execute: (ctx, command, input, access, how) => execute(command, input, toilOptions(ctx, access, how)),
  };
}

/** The commands a cache answers by passing them to toil: the toil projects are toil's own config on this machine, read fresh, and the readiness gate's workflow reads are live by design. */
const LIVE_COMMANDS = new Set<string>(['projects list', 'projects show', ...WORKFLOW_READS]);

/**
 * The SQLite cache (#250): the views' calls answered from what the last sync
 * stored (server/sync.ts), so a dashboard opens without reaching a tracker.
 * The toil projects themselves are toil's own config on this machine and go to
 * toil, read-only. A call the sync never stored gets a refusal saying to
 * sync; a call whose source failed on its latest sync gets the last good copy
 * with a `STALE` warning. `config` calls go to toil's write rules unchanged.
 * `cache` is a getter so a wipe can swap the file underneath.
 */
export function sqliteStore(cache: () => Cache, execute: Execute, toil: { version: string; contractVersion: number }): Store {
  return {
    kind: 'sqlite',
    sample: false,
    now: () => new Date().toISOString(),
    async execute(ctx, command, input, access, how) {
      if (access !== 'read' || LIVE_COMMANDS.has(command)) return execute(command, input, toilOptions(ctx, access, how));
      const meta = { command, durationMs: 0, version: toil.version, contractVersion: toil.contractVersion };
      const toilProject = typeof input.toilProject === 'string' ? input.toilProject : null;
      // The dashboard's own search names a window of days; the sync stored the cache's. Only the window may differ (src/load.ts), so another project's search is never answered.
      const stored = toilProject ? cache().response(toilProject, command, withWindow(input, windowFor(cache().retentionDays))) : null;
      if (!stored) {
        return {
          ok: false,
          data: null,
          error: {
            code: 'NOT_FOUND',
            message: toilProject ? `Toil UI hasn't synced ${command} for ${toilProject} yet.` : `Toil UI answers ${command} from its cache, which is kept per Toil project, and this call named none.`,
            fix: 'Press Sync now in the Sync panel at the foot of the page; the dashboards read what the sync stores.',
          },
          meta,
        } as Envelope;
      }
      const source = cache().source(toilProject!, stored.area);
      if (source?.status !== 'failed') return stored.envelope;
      const warning = { code: 'STALE', message: `The latest sync of ${stored.area} failed (${source.error ?? 'no message'}), so this is the copy synced ${source.lastSuccessAt ?? stored.syncedAt}.` };
      return { ...stored.envelope, meta: { ...stored.envelope.meta, warnings: [...(stored.envelope.meta.warnings ?? []), warning] } } as Envelope;
    },
  };
}

/** The preview's fixture `execute()`. It answers read-only calls only, so a `config` call comes back refused. */
export function fixtureStore(): Store {
  const fixture = fixtureExecute();
  const config = fixtureConfigExecute();
  return {
    kind: 'fixture',
    sample: true,
    now: () => FIXTURE_NOW,
    // The settings pages read the sample config; a change is refused, since the sample has nothing of yours to change.
    // Feedback builds the sample's report with toil's own code and refuses to send it.
    execute: async (ctx, command, input, access, how) =>
      access === 'config' ? config(command, input) : access === 'feedback' ? fixtureFeedbackEnvelope(input, how?.readOnly === false) : fixture.execute(command, input, { readOnly: true, caller: CALLER, signal: ctx.signal }),
  };
}
