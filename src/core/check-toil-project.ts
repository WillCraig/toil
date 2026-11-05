import type { CommandContext } from './context.js';
import type { ToilProjectView, viewScopes } from './toil-project.js';
import { ToilError } from './errors.js';

/**
 * What every `toil <area> check-toil-project` shares: finding the call's toil project,
 * looking each value up on the service, and the result's shape. Each area
 * says only which keys to look up and how. A command talks to one service,
 * so a toil project is checked one area at a time and the caller composes them
 * (principle 3). Inspection is by appointment, one department per visit.
 */
export interface ToilProjectCheck {
  /** Where in the toil project the value is, e.g. `jira.projects[1]`. */
  path: string;
  /** What it was looked up as: `project`, `field`, `space`. */
  kind: string;
  value: string;
  found: boolean;
  /** How it was looked up, when that isn't plain from the value: a deployment tried in several namespaces. */
  note?: string;
}

/**
 * The call's toil project, as this area sees it, for the call's environment only:
 * the area's own section, plus the section of the environment the call is in
 * (its `--env`, else the toil project's). Another environment's section may select
 * another connection, so it's checked by a call in that environment, never
 * against this one's server. INVALID_INPUT when no toil project applies.
 */
export function toilProjectToCheck(ctx: CommandContext<unknown, Record<string, string | undefined>>, area: string): ToilProjectView {
  const view = ctx.toilProjectView();
  if (!view) {
    throw new ToilError('INVALID_INPUT', 'No toil project applies to this call, so there is nothing to check.', {
      fix: `Pass --toil-project <name>, or run it in one of the toil project's repositories (toil projects context shows what this folder resolves to). Then toil ${area} check-toil-project checks its ${area} section.`,
    });
  }
  const env = ctx.context.env ?? view.env;
  const own = view.sections.filter((s) => s.env !== null && s.env === env);
  // A key the environment's section sets shadows the area's own, as it does when a call resolves it
  // (sectionsFor), so a value only another environment uses is never looked up on this one's server.
  // A per-repo value shadows only the repos it names.
  const sections = view.sections
    .filter((s) => s.env === null || s.env === env)
    .map((s) => {
      if (s.env !== null) return s;
      const values: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(s.values)) {
        const over = own.map((e) => e.values[key]).find((v) => v !== undefined);
        if (over === undefined) values[key] = value;
        else if (isRecord(over) && isRecord(value)) {
          const left = Object.fromEntries(Object.entries(value).filter(([repo]) => !(repo in over)));
          if (Object.keys(left).length > 0) values[key] = left;
        } else if (isRecord(over) && typeof value === 'string') values[key] = value;
      }
      return { ...s, values };
    });
  return { ...view, env, sections };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value the toil project names that couldn't be looked up, and why: a repo with no project to look it up in. */
export interface Unchecked {
  path: string;
  value: string;
  reason: string;
}

/** The incomplete scopes `viewScopes` found, as values that couldn't be checked. */
export function uncheckedScopes(incomplete: ReturnType<typeof viewScopes>['incomplete'], what: string): Unchecked[] {
  return incomplete.flatMap((i) => Object.entries(i.found).map(([path, value]) => ({ path, value, reason: `no ${i.lacks.join(' or ')} to look this ${what} up ${i.lacks.length > 1 ? 'with' : 'in'}${i.repo ? ` for repo ${i.repo}` : ''}` })));
}

/**
 * Looks each distinct value up once, in order. `exists` returns false for a
 * value the service doesn't have; it throws for anything else (a bad token,
 * an unreachable host), which fails the check rather than calling every value
 * missing.
 */
export async function checkEach(items: ReadonlyArray<{ path: string; value: string }>, kind: string, exists: (value: string) => Promise<boolean>): Promise<ToilProjectCheck[]> {
  const seen = new Map<string, boolean>();
  const out: ToilProjectCheck[] = [];
  for (const item of items) {
    if (!seen.has(item.value)) seen.set(item.value, await exists(item.value));
    out.push({ path: item.path, kind, value: item.value, found: seen.get(item.value)! });
  }
  return out;
}

/** True for a NOT_FOUND from the service, the one failure that means "the value isn't there". */
export function notFound(err: unknown): boolean {
  return err instanceof ToilError && err.code === 'NOT_FOUND';
}

/** A lookup that is one GET: true when it answers, false on NOT_FOUND, and anything else fails the check. */
export function exists(get: () => Promise<unknown>): Promise<boolean> {
  return get().then(
    () => true,
    (err: unknown) => {
      if (notFound(err)) return false;
      throw err;
    },
  );
}

/**
 * The result: which toil project, which connection, every check, and every value
 * that couldn't be checked. A missing value, or one that couldn't be checked,
 * makes `ok` false and the CLI exit 1, and the unchecked ones are a warning
 * too, so `ok` never stands for a value nobody looked at.
 */
export function toilProjectCheckResult(ctx: CommandContext<{ name: string } | undefined>, view: ToilProjectView, checks: ToilProjectCheck[], unchecked: Unchecked[] = []) {
  for (const u of unchecked) ctx.warn({ code: 'TOIL_PROJECT_UNCHECKED', message: `${u.path} ("${u.value}") wasn't checked: ${u.reason}.` });
  const ok = checks.every((c) => c.found) && unchecked.length === 0;
  if (!ok) ctx.setExitCode(1);
  return { toilProject: { name: view.name, source: view.source, file: view.file }, connection: ctx.connection?.name ?? null, env: view.env, ok, checked: checks.length, checks, unchecked };
}
