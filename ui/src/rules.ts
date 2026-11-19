/**
 * Ticket rules on screen (#657): the seam the page reads toil's
 * `standards check` through, and the pure helpers its views share. The local
 * server answers from its cache (ui/server/standards.ts), running toil's own
 * command over the items it synced; the site preview and `toil-ui --sample`
 * answer from the sample's items and the built-in rules
 * (src/fixtures/standards.ts). Nothing here writes: fixing an item is an
 * assignment, whose proposal a person applies through toil's write gate.
 * Toil calls them standards in its files; on screen they are ticket rules,
 * because nobody has ever been reassured by being told a ticket is
 * non-standard.
 */

import type { RuleResult, StandardsCheckResult } from '../../src/core/standards/types.ts';
import { RULES_UNREAD, type RulesReading } from './model/readiness.ts';
import type { WorkItem } from './toil.ts';

export type { RuleResult, StandardsCheckResult };

/** What `api/standards` answers: toil's check, or null when the toil project hasn't synced, so nothing was read; and toil's warnings, in its words. */
export interface RulesView {
  result: StandardsCheckResult | null;
  warnings: string[];
}

/** The page's side: the server's route, or the sample's. Throws with a message the page shows. */
export interface RulesApi {
  check(toilProject: string): Promise<RulesView>;
}

/** One rule's outcome on one item, with the rule's own text: what an assignment to fix it is told. */
export interface RuleFound extends RuleResult {
  text: string;
}

/** The server's side: the page's read, and one rule on one item, as the assignment queue checks it before it queues a fix. */
export interface RulesBackend extends RulesApi {
  ruleFor(toilProject: string, item: string, standard: string, rule: string): Promise<RuleFound | null>;
}

/** A standard's or a rule's name: what the route and an assignment accept. */
export const RULE_REF = /^[a-z][a-z0-9-]{0,62}$/;

/** The page's reading from what the read gave: read (with each item's results), not read yet, or failed with toil's message. */
export function readingOf(view: RulesView | null, error?: string): RulesReading {
  if (error !== undefined) return { state: 'failed', byItem: new Map(), message: error, warnings: [] };
  if (!view?.result) return RULES_UNREAD;
  return { state: 'read', byItem: new Map(view.result.items.map((i) => [i.id, i.results])), message: null, warnings: view.warnings };
}

/** One rule's result on one item in a check, with the rule's text; null when the rule doesn't apply to it, or isn't one the check knows. */
export function ruleIn(result: StandardsCheckResult, item: string, standard: string, rule: string): RuleFound | null {
  const found = result.items.find((i) => i.id === item)?.results.find((r) => r.standard === standard && r.rule === rule);
  const text = result.standards.find((s) => s.name === standard)?.rules.find((r) => r.id === rule)?.text;
  return found && text !== undefined ? { ...found, text } : null;
}

/** A thin or failed rule: one an AI agent could be asked to fix. */
export const fixable = (state: RuleResult['state']) => state === 'thin' || state === 'fail';

const NOUN: Record<string, [string, string]> = { STORY: ['story', 'stories'], BUG: ['bug', 'bugs'], TASK: ['task', 'tasks'], EPIC: ['epic', 'epics'], INCIDENT: ['incident', 'incidents'] };

/**
 * One standard's line on the Command Center: how many of the open items its
 * rules apply to miss any of them, and how many couldn't be checked. A
 * standard with one rule is that rule's line; one with several (bug-repro's
 * steps, expected and actual) is one line, so a bug that misses all three
 * counts once.
 */
export interface RuleLine {
  standard: string;
  /** The rules of the standard that apply to the items, in the check's order, each with what an item that misses it lacks where the rule says. */
  rules: Array<{ rule: string; name: string; missing?: string }>;
  /** `standard/rule` for a one-rule line, the standard's name otherwise: the address filter's value. */
  ref: string;
  applies: number;
  /** Items that miss at least one of the rules. */
  miss: number;
  skipped: number;
  /** "story" or "stories", from the types it applied to; "item" when they are mixed. */
  noun: (n: number) => string;
}

/** A rule's name inside a sentence: its first letter in lower case, unless the name starts with an acronym ("KTLO"). */
export const inSentence = (name: string) => (/^[A-Z][a-z]/.test(name) ? name.charAt(0).toLowerCase() + name.slice(1) : name);

/** Names in a sentence: "a", "a and b", "a, b and c" (or "or"). */
export function listed(names: readonly string[], join: 'and' | 'or' = 'and'): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} ${join} ${names.at(-1)}`;
}

/**
 * What a line says the items lack, after its count and a colon (#657): each rule's own `missing` phrase ("no
 * Given/When/Then criteria"), or "missing" and its name where the rule gives none, joined with commas and "or" (an
 * item that misses any one of them counts), with a repeated leading "no" folded: "no steps to reproduce, expected
 * result or actual result". The colon form needs no verb, so no plural to agree with.
 */
export function lineWhat(l: Pick<RuleLine, 'rules'>): string {
  const phrases = l.rules.map((r) => r.missing?.trim() || `missing ${r.name}`);
  const no = /^no\s+/i;
  const folded = no.test(phrases[0] ?? '') ? phrases.map((p, i) => (i > 0 ? p.replace(no, '') : p)) : phrases;
  return listed(folded, 'or');
}

/**
 * Each standard's line over these items (the open ones on screen), in the
 * check's own order: a rule that applies to none of them is left out, and a
 * standard none of whose rules apply has no line.
 */
export function ruleLines(result: StandardsCheckResult, items: readonly WorkItem[]): RuleLine[] {
  const shown = new Set(items.map((i) => i.id));
  const typeOf = new Map(items.map((i) => [i.id, i.type]));
  const out: RuleLine[] = [];
  for (const s of result.standards) {
    const applying: Array<{ rule: string; name: string }> = [];
    const types = new Set<string>();
    let applies = 0;
    let miss = 0;
    let skipped = 0;
    for (const i of result.items) {
      if (!shown.has(i.id)) continue;
      const hits = i.results.filter((x) => x.standard === s.name);
      if (hits.length === 0) continue;
      applies++;
      types.add(typeOf.get(i.id) ?? 'OTHER');
      const missed = hits.filter((h) => fixable(h.state)).length;
      if (missed > 0) miss++;
      else if (hits.some((h) => h.state === 'skipped')) skipped++;
      for (const h of hits) if (!applying.some((a) => a.rule === h.rule)) applying.push({ rule: h.rule, name: h.name });
    }
    if (applies === 0) continue;
    const rules = s.rules.flatMap((r) => (applying.some((a) => a.rule === r.id) ? [{ rule: r.id, name: r.name, ...(r.missing ? { missing: r.missing } : {}) }] : []));
    const [one, many] = types.size === 1 ? (NOUN[[...types][0]!] ?? ['item', 'items']) : ['item', 'items'];
    out.push({ standard: s.name, rules, ref: rules.length === 1 ? `${s.name}/${rules[0]!.rule}` : s.name, applies, miss, skipped, noun: (n) => (n === 1 ? one : many) });
  }
  return out;
}

/**
 * The item a standard's line leads with, and Fix with AI agent asks to fix: the first open item, in the check's order, that
 * misses one of the standard's rules and could start once it meets them; when every one is held up by something else
 * (`blocked`: another item blocks it, say), the first that misses them.
 */
export function firstToFix(result: StandardsCheckResult, standard: string, open: ReadonlySet<string>, blocked: (id: string) => boolean): StandardsCheckResult['items'][number] | undefined {
  const missing = result.items.filter((i) => open.has(i.id) && i.results.some((r) => r.standard === standard && fixable(r.state)));
  return missing.find((i) => !blocked(i.id)) ?? missing[0];
}

/** A filter's reference read: `standard/rule` names one rule, a bare standard every rule in it. */
const refOf = (ref: string) => {
  const [standard, rule] = ref.split('/');
  return { standard: standard ?? '', rule: rule ?? null };
};

/** Whether a result is one the reference names: the rule, or any rule of the standard. */
export const matchesRef = (ref: string, r: { standard: string; rule: string }) => {
  const want = refOf(ref);
  return r.standard === want.standard && (want.rule === null || r.rule === want.rule);
};

/** The items that miss a rule (`standard/rule`), or any rule of a standard (`standard`), by OWI id; null when the reference names nothing the check knows. */
export function missing(result: StandardsCheckResult, ref: string): Set<string> | null {
  const { standard, rule } = refOf(ref);
  const s = result.standards.find((x) => x.name === standard);
  if (!s || (rule !== null && !s.rules.some((r) => r.id === rule))) return null;
  return new Set(result.items.filter((i) => i.results.some((r) => matchesRef(ref, r) && fixable(r.state))).map((i) => i.id));
}

/** What a filter's reference names, for its chip: a rule's name, or a standard's rule names; null when the check doesn't know it. */
export function ruleName(result: StandardsCheckResult, ref: string): string | null {
  const { standard, rule } = refOf(ref);
  const s = result.standards.find((x) => x.name === standard);
  if (!s) return null;
  if (rule === null) return s.rules.length ? listed(s.rules.map((r, i) => (i === 0 ? r.name : inSentence(r.name))), 'or') : null;
  return s.rules.find((r) => r.id === rule)?.name ?? null;
}

/** What the page holds for the toil project on screen: the reading the readiness rows use, and the check itself for the Command Center. */
export interface RulesState {
  reading: RulesReading;
  view: RulesView | null;
}
