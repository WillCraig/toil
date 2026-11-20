/**
 * The `when` matcher: which work items a rule applies to, by parent, label,
 * type and title. Classification's rules and a standard's rules (ticket rules)
 * both use it, so "applies to stories under PAY-100" means one thing whichever
 * file says it. Reading a `when` from a file and matching one against an item
 * are both here, pure, so a test can hold the two to each other. The matcher
 * takes no position on whether a rule is a good idea; that is a separate
 * committee.
 */
import type { WorkItem } from '../owi/types.js';
import { RULE_KEYS, type RuleWhen } from './types.js';

export { RULE_KEYS, type RuleWhen } from './types.js';

/** The most values one key of a `when` may list. */
export const WHEN_VALUES = 50;

const lower = (s: string) => s.toLowerCase();
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The ancestors the input shows, nearest first, plus the id of the first parent it doesn't (cycle-safe). */
function ancestry(item: WorkItem, byId: ReadonlyMap<string, WorkItem>): { ancestors: WorkItem[]; missing: string | null } {
  const ancestors: WorkItem[] = [];
  const seen = new Set<string>([item.id]);
  let next = item.parent;
  while (next !== null && next !== undefined) {
    if (seen.has(next)) return { ancestors, missing: null };
    seen.add(next);
    const found = byId.get(next);
    if (!found) return { ancestors, missing: next };
    ancestors.push(found);
    next = found.parent;
  }
  return { ancestors, missing: null };
}

/**
 * Why a `when` matched the item, in words, or null when it didn't. Every key
 * given must match; a key matches when any of its values does. A `when` with no
 * keys matches nothing: "everything" is not a rule, it's a default, and a
 * caller that means every item says so by having no `when` at all.
 */
export function matchWhen(when: RuleWhen, item: WorkItem, byId: ReadonlyMap<string, WorkItem>): string | null {
  const why: string[] = [];
  const { parent, label, type, title } = when;
  if (parent !== undefined) {
    const { ancestors, missing } = ancestry(item, byId);
    const hit = parent.find((value) => {
      const v = lower(value);
      return ancestors.some((a) => lower(a.id) === v || lower(a.source.key) === v) || (missing !== null && (lower(missing) === v || lower(missing).endsWith(`:${v}`)));
    });
    if (hit === undefined) return null;
    why.push(`it sits under ${hit}`);
  }
  if (label !== undefined) {
    const hit = label.find((value) => item.labels.some((l) => lower(l) === lower(value)));
    if (hit === undefined) return null;
    why.push(`it carries the label "${hit}"`);
  }
  if (type !== undefined) {
    const hit = type.find((value) => lower(value) === lower(item.type) || (item.typeName !== null && lower(value) === lower(item.typeName)));
    if (hit === undefined) return null;
    why.push(`its type is ${hit}`);
  }
  if (title !== undefined) {
    const hit = title.find((value) => lower(item.title).includes(lower(value)));
    if (hit === undefined) return null;
    why.push(`its title contains "${hit}"`);
  }
  return why.length === 0 ? null : why.join(' and ');
}

/**
 * Reads a `when` from a file: an object of one or more of `parent`, `label`,
 * `type` and `title`, each a list of 1 to 50 one-line texts. `textProblem` is
 * the file's own text check (one line, a length, no credential shape), so the
 * error says "a scheme never holds one" or "a standard never holds one" as the
 * file is. Every problem goes to `bad` by key path; the result is undefined when
 * there was any.
 */
export function readWhen(value: unknown, at: string, bad: (path: string, message: string) => void, textProblem: (value: unknown, min: number, max: number) => string | undefined): RuleWhen | undefined {
  if (!isRecord(value)) {
    bad(at, `"when" must be an object with at least one of ${RULE_KEYS.join(', ')}.`);
    return undefined;
  }
  let ok = true;
  const when: RuleWhen = {};
  for (const key of Object.keys(value)) {
    if (!(RULE_KEYS as readonly string[]).includes(key)) {
      ok = false;
      bad(`${at}.${key}`, `"${key}" isn't something a rule can match on; "when" takes ${RULE_KEYS.join(', ')}.`);
      continue;
    }
    const values = value[key];
    if (!Array.isArray(values) || values.length === 0 || values.length > WHEN_VALUES) {
      ok = false;
      bad(`${at}.${key}`, `"${key}" must be a list of 1 to ${WHEN_VALUES} texts.`);
      continue;
    }
    const kept: string[] = [];
    values.forEach((v: unknown, j: number) => {
      const why = textProblem(v, 1, 200);
      if (why) {
        ok = false;
        bad(`${at}.${key}[${j}]`, `A value ${why}`);
      } else kept.push((v as string).trim());
    });
    when[key as keyof RuleWhen] = kept;
  }
  if (Object.keys(value).length === 0) {
    ok = false;
    bad(at, `"when" must name at least one of ${RULE_KEYS.join(', ')}.`);
  }
  return ok ? when : undefined;
}
