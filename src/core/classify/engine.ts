/**
 * The classification engine: items and a scheme in, one verdict per item and a
 * plan out. Pure data in and data out, no files, no network and no config, so
 * `toil classify run` can be exactly as safe as its inputs and a test can run
 * it on a laptop with the wifi off. The order is fixed, first match wins: a
 * category already on the item, a person's recorded say (the ledger), the team's rules, toil's signals, the parent's
 * verdict, and only then "unsure". The agent fills the unsure and never
 * overrules the rest. Every verdict says which step decided it, so the
 * review meeting can argue about the rule instead of the person.
 */
import type { Warning } from '../envelope.js';
import type { Change, WorkItem } from '../owi/types.js';
import { readCategoryField } from './existing.js';
import { detectSignal } from './signals.js';
import { matchWhen } from './when.js';
import {
  CLASSIFY_AREAS,
  UNSURE,
  fieldValueFor,
  labelFor,
  type AgentVerdict,
  type Category,
  type PersonSay,
  type ClassifyArea,
  type ClassifyResult,
  type ClassifySummary,
  type PlanGroup,
  type PlanItem,
  type ResolvedTarget,
  type Scheme,
  type Verdict,
  type VerdictSource,
} from './types.js';

export interface ClassifyInput {
  scheme: Scheme;
  items: WorkItem[];
  /** Pull requests read beside the items. Their author kind says who wrote a change, not who opened an item, so no signal uses them yet. */
  changes?: Change[];
  /** Where the category goes besides labels, per tracker, with the field's id resolved. */
  targets?: Partial<Record<ClassifyArea, ResolvedTarget>>;
  /**
   * Whether the plan may carry a field (default true). False still reads an
   * existing category from the target's field, for a verdict and the summary,
   * but plans labels only: a target the user hasn't adopted may say where a
   * category is read from, never where a write goes.
   */
  planFields?: boolean;
  /** Ignore a category already on the item and classify afresh. */
  recheck?: boolean;
  verdicts?: AgentVerdict[];
  /**
   * What a person said about an item, by id (the ledger's standing correction). It comes after a
   * category already on the item and before every rule: a person's word beats the scheme's rules,
   * and the tracker's own label (or, with no label, field) beats the person's, except one that still says what
   * the person's `from` says: the tracker hasn't caught up with them yet, so their say stands until Apply writes it.
   */
  person?: Record<string, PersonSay>;
  toilProject?: string | null;
}

const lower = (s: string) => s.toLowerCase();
const isClassifyArea = (area: string): area is ClassifyArea => (CLASSIFY_AREAS as readonly string[]).includes(area);
const oneLine = (text: string, max: number) => text.replace(/\s+/g, ' ').trim().slice(0, max);

export function classify(input: ClassifyInput): { result: ClassifyResult; warnings: Warning[] } {
  const { scheme } = input;
  const warnings: Warning[] = [];
  const targets = input.targets ?? {};
  const planFields = input.planFields !== false;
  const category = new Map<string, Category>(scheme.categories.map((c) => [c.id, c]));

  // One verdict per item: the first of a repeated id stands.
  const items: WorkItem[] = [];
  const byId = new Map<string, WorkItem>();
  const repeated: string[] = [];
  for (const item of input.items) {
    if (byId.has(item.id)) repeated.push(item.id);
    else {
      byId.set(item.id, item);
      items.push(item);
    }
  }
  if (repeated.length > 0) {
    warnings.push({ code: 'CLASSIFY_DUPLICATE_ITEM', message: `${repeated.length} ${repeated.length === 1 ? 'item appears' : 'items appear'} more than once in the input and was classified once, the first time: ${[...new Set(repeated)].slice(0, 3).join(', ')}${new Set(repeated).size > 3 ? ', ...' : ''}.` });
  }

  const base = (item: WorkItem): Verdict => ({
    id: item.id,
    key: item.source.key,
    area: item.source.area,
    connection: item.source.connection,
    title: item.title,
    url: item.url,
    category: null,
    name: null,
    short: null,
    source: 'unsure',
    reason: 'Nothing settled it: no category on it, no rule or signal matched, and its parent is unsettled.',
    scheme: scheme.name,
    revision: scheme.revision,
  });
  const settle = (item: WorkItem, id: string, source: VerdictSource, reason: string): Verdict => {
    const c = category.get(id)!;
    return { ...base(item), category: c.id, name: c.name, short: c.short, source, reason };
  };

  const person = input.person ?? {};
  const unknownPerson = new Set<string>();
  const ktlo = category.get('ktlo');
  const brokenRules = new Set<string>();

  const decide = (item: WorkItem): Verdict => {
    const area = item.source.area;

    const said = Object.hasOwn(person, item.id) ? person[item.id] : undefined;
    // A person's say the tracker hasn't caught up with: what is on the item is what it held before they spoke, so it is not news.
    const stale = (id: string) => said !== undefined && said.from === id && said.category !== id && category.has(said.category);

    // 1. A category already on the item. The label is the record and a field only mirrors it (the maintainer's call,
    // 12 November 2026): exactly one scheme label settles it, whatever the field says, and the plan then puts the field
    // right. A field settles it only when no label can: none on the item, or two that disagree with each other.
    if (!input.recheck) {
      const held = scheme.categories.filter((c) => item.labels.some((l) => lower(l) === lower(labelFor(scheme, area, c))));
      if (held.length === 1) {
        // A stale label is the person's say not yet written; the field is a mirror of that label, so it has nothing to add.
        if (!stale(held[0]!.id)) return settle(item, held[0]!.id, 'label', `It already carries the label "${item.labels.find((l) => lower(l) === lower(labelFor(scheme, area, held[0]!)))}".`);
      } else {
        const target = isClassifyArea(area) ? targets[area] : undefined;
        const value = target?.field ? readCategoryField(item, target) : undefined;
        if (typeof value === 'string') {
          const hits = scheme.categories.filter((c) => lower(fieldValueFor(target, c)) === lower(value));
          if (hits.length === 1 && !stale(hits[0]!.id)) return settle(item, hits[0]!.id, 'field', `The ${target!.field} field already says "${value}"${held.length > 1 ? ', and its labels disagree with each other' : ', and the item has no scheme label'}.`);
        }
      }
    }

    // 2. A person's say, recorded in the ledger.
    if (said) {
      if (category.has(said.category)) {
        const name = category.get(said.category)!.name;
        const why = said.reason ? oneLine(said.reason, 300) : null;
        // Over MCP an AI agent recorded it for a person, and in the tracker it was a label someone changed: the source stays `person`, the words say which.
        const reason =
          said.via === 'mcp' ? `Recorded by an AI agent for a person: ${name}${why ? ` (${why})` : ''}.`
          : said.via === 'tracker' ? `Changed in the tracker to ${name}.`
          : `A person chose ${name}${why ? `: ${why}` : ''}.`;
        return settle(item, said.category, 'person', reason);
      }
      unknownPerson.add(item.id);
    }

    // 3. The team's rules, in file order.
    for (const rule of scheme.rules) {
      if (!category.has(rule.then)) {
        brokenRules.add(rule.id);
        continue;
      }
      const why = matchWhen(rule.when, item, byId);
      if (why !== null) return settle(item, rule.then, `rule:${rule.id}`, `Rule ${rule.id}: ${why}.`);
    }

    // 4. Toil's signals, which all mean keep the lights on.
    if (scheme.signals && ktlo) {
      const hit = detectSignal(item, byId);
      if (hit) return settle(item, ktlo.id, `signal:${hit.name}`, hit.reason);
    }
    return base(item);
  };

  const verdicts = new Map<string, Verdict>(items.map((item) => [item.id, decide(item)]));

  // 5. The parent's verdict, recursively so the order of the input doesn't matter.
  const inherit = (): void => {
    const done = new Map<string, Verdict>();
    const resolve = (item: WorkItem, stack: Set<string>): Verdict => {
      const own = verdicts.get(item.id)!;
      if (own.source !== 'unsure') return own;
      const cached = done.get(item.id);
      if (cached) return cached;
      let out = own;
      const parent = item.parent ? byId.get(item.parent) : undefined;
      stack.add(item.id);
      if (parent && !stack.has(parent.id)) {
        const above = resolve(parent, stack);
        if (above.category !== null) out = settle(item, above.category, 'parent', `Its parent ${parent.source.key} ("${oneLine(parent.title, 80)}") is ${above.name}.`);
      }
      stack.delete(item.id);
      done.set(item.id, out);
      return out;
    };
    for (const item of items) {
      if (verdicts.get(item.id)!.source === 'unsure') verdicts.set(item.id, resolve(item, new Set()));
    }
  };
  inherit();

  // The agent's verdicts fill only what is still unsure.
  const ignored: string[] = [];
  if (input.verdicts?.length) {
    const taken = new Set<string>();
    for (const v of input.verdicts) {
      const item = byId.get(v.id);
      const open = item !== undefined && verdicts.get(v.id)!.source === 'unsure' && !taken.has(v.id);
      if (!open) {
        ignored.push(v.id);
        continue;
      }
      taken.add(v.id);
      if (v.category === UNSURE || !category.has(v.category)) continue;
      const reason = oneLine(v.reason, 300) || `The agent chose ${category.get(v.category)!.name}.`;
      verdicts.set(v.id, settle(item, v.category, 'agent', reason));
    }
    // An epic the agent settled carries its children.
    inherit();
  }
  if (ignored.length > 0) {
    warnings.push({
      code: 'CLASSIFY_VERDICT_IGNORED',
      message: `${ignored.length} agent ${ignored.length === 1 ? 'verdict was' : 'verdicts were'} ignored: they name an item already settled by a label, field, rule, signal or parent, or one that isn't in the input. Agent verdicts fill only unsure items. First: ${ignored.slice(0, 3).join(', ')}${ignored.length > 3 ? ', ...' : ''}.`,
    });
  }
  if (unknownPerson.size > 0) {
    warnings.push({
      code: 'CLASSIFY_PERSON_UNKNOWN_CATEGORY',
      message: `${unknownPerson.size} recorded ${unknownPerson.size === 1 ? 'correction names' : 'corrections name'} a category the scheme "${scheme.name}" no longer has and ${unknownPerson.size === 1 ? 'was' : 'were'} ignored: ${[...unknownPerson].slice(0, 3).join(', ')}${unknownPerson.size > 3 ? ', ...' : ''}.`,
    });
  }
  if (brokenRules.size > 0) {
    warnings.push({ code: 'CLASSIFY_RULE_UNKNOWN_CATEGORY', message: `Rules skipped because they name a category the scheme "${scheme.name}" doesn't have: ${[...brokenRules].join(', ')}.` });
  }

  const ordered = items.map((item) => verdicts.get(item.id)!);

  // The plan: a diff against what the input shows.
  const groups = new Map<string, PlanGroup>();
  const noWriteBack = new Set<string>();
  for (const item of items) {
    const verdict = verdicts.get(item.id)!;
    if (verdict.category === null) continue;
    const area = item.source.area;
    if (!isClassifyArea(area)) {
      noWriteBack.add(area);
      continue;
    }
    const target = targets[area];
    const chosen = category.get(verdict.category)!;
    const wanted = labelFor(scheme, area, chosen);
    const others = new Set(scheme.categories.map((c) => lower(labelFor(scheme, area, c))));
    others.delete(lower(wanted));

    const add = item.labels.some((l) => lower(l) === lower(wanted)) ? [] : [wanted];
    const remove = [...new Set(item.labels.filter((l) => others.has(lower(l))))];
    let field: PlanItem['field'];
    if (target?.field && planFields) {
      const value = fieldValueFor(target, chosen);
      const read = readCategoryField(item, target);
      if (read === undefined || read === null || lower(read) !== lower(value)) field = { value };
    }
    if (add.length === 0 && remove.length === 0 && !field) continue;

    const slot = `${area}\u0000${item.source.connection}`;
    let group = groups.get(slot);
    if (!group) {
      group = {
        area,
        connection: item.source.connection,
        labels: Object.fromEntries(scheme.categories.map((c) => [c.id, labelFor(scheme, area, c)])),
        ...(target?.field && planFields ? { field: { name: target.field, ...(target.project ? { project: target.project } : {}) } } : {}),
        items: [],
      };
      groups.set(slot, group);
    }
    group.items.push({ id: item.id, key: item.source.key, category: chosen.id, labels: { add, remove }, ...(field ? { field } : {}) });
  }
  if (noWriteBack.size > 0) {
    warnings.push({ code: 'CLASSIFY_NO_WRITE_BACK', message: `Items from ${[...noWriteBack].join(', ')} got verdicts but no plan entry: toil writes a category back only to ${CLASSIFY_AREAS.join(', ')}.` });
  }

  // The summary.
  const byCategory: Record<string, number> = Object.fromEntries([...scheme.categories.map((c) => [c.id, 0] as const), [UNSURE, 0] as const]);
  const bySource: Record<string, number> = {};
  for (const v of ordered) {
    byCategory[v.category ?? UNSURE]!++;
    bySource[v.source] = (bySource[v.source] ?? 0) + 1;
  }
  const byRule = ordered.filter((v) => v.source.startsWith('rule:') || v.source.startsWith('signal:') || v.source === 'parent').length;
  const alreadyLabelled: Record<string, number> = Object.fromEntries(scheme.categories.map((c) => [c.id, 0]));
  for (const item of items) {
    for (const c of scheme.categories) {
      if (item.labels.some((l) => lower(l) === lower(labelFor(scheme, item.source.area, c)))) alreadyLabelled[c.id]!++;
    }
  }
  const summary: ClassifySummary = {
    items: ordered.length,
    byCategory,
    bySource,
    settledByRules: ordered.length === 0 ? null : Math.round((byRule / ordered.length) * 1000) / 1000,
    alreadyLabelled,
  };

  return {
    result: {
      scheme: { name: scheme.name, revision: scheme.revision },
      categories: scheme.categories,
      plan: [...groups.values()],
      toilProject: input.toilProject ?? null,
      verdicts: ordered,
      summary,
    },
    warnings,
  };
}
