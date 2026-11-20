/**
 * Reading and writing a classification scheme: the file a team keeps its
 * categories, guidance and rules in. A scheme is the rulebook every verdict is
 * held to, and an agent may be handed a checked-in one, so nothing in it is
 * taken on trust: shapes, lengths and one-line text are checked before any
 * word of it reaches a prompt or a tracker, and a value shaped like a
 * credential is refused, since a scheme holds none. The reader is pure (no
 * files), so the catalog, the commands and a test all read a scheme one way.
 * The definitions of "maintenance" remain the team's own; the form merely
 * requires that they fit on one line.
 */
import type { Warning } from '../envelope.js';
import { ToilError } from '../errors.js';
import { findSecrets } from '../secret-shapes.js';
import {
  CATEGORY_ID,
  CLASSIFY_AREAS,
  SCHEME_NAME,
  UNSURE,
  type Category,
  type Rule,
  type Scheme,
  type SchemeExample,
} from './types.js';
import { readWhen } from './when.js';

/** A tracker label: no space (Jira) and no comma or semicolon (Azure DevOps splits tags on `;`). */
export const LABEL_FORM = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,49}$/;
const RULE_ID = /^[a-z][a-z0-9-]{0,40}$/;
const TOP_KEYS = ['name', 'revision', 'categories', 'guidance', 'examples', 'rules', 'signals', 'labels'];

export const SCHEME_LIMITS = { categories: [2, 12], guidance: 20, guidanceText: 300, examples: 40, rules: 100, whenValues: 50 } as const;

interface Problem {
  path: string;
  message: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Why a text can't go in a scheme, or undefined when it can: one line, within `max`, no credential shape. */
function textProblem(value: unknown, min: number, max: number): string | undefined {
  if (typeof value !== 'string') return 'must be text.';
  if (value.trim().length < min) return 'must not be empty.';
  if (value.length > max) return `is ${value.length} characters; the most is ${max}.`;
  // One line each: a line break would let a checked-in scheme's words pass as another label in the prompt.
  if ([...value].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)) return 'must be one line of text, with no line breaks or control characters.';
  if (findSecrets(value).length > 0) return 'holds something shaped like a credential, and a scheme never holds one.';
  return undefined;
}

/**
 * Validates a parsed scheme and returns it normalised, with defaults filled in
 * and texts trimmed. `where` names the file (or "the built-in scheme") in the
 * error; the first problem is in the message and up to five are in `details`.
 */
export function readScheme(raw: unknown, where: string): { scheme: Scheme; warnings: Warning[] } {
  const problems: Problem[] = [];
  const warnings: Warning[] = [];
  const bad = (path: string, message: string) => problems.push({ path, message });
  const fail = (): never => {
    const first = problems[0]!;
    const more = problems.length > 1 ? ` (and ${problems.length - 1} more problem${problems.length > 2 ? 's' : ''})` : '';
    throw new ToilError('CONFIG_INVALID', `Scheme ${where} can't be used${first.path ? `: ${first.path}` : ''}: ${first.message}${more}`, {
      fix: `Fix it in ${where}; toil classify scheme show <file> reads it again.`,
      details: problems.slice(0, 5),
    });
  };
  if (!isRecord(raw)) {
    bad('', 'A scheme must be a JSON object.');
    return fail();
  }
  for (const key of Object.keys(raw)) {
    if (key === '$schema' || TOP_KEYS.includes(key)) continue;
    warnings.push({ code: 'SCHEME_UNKNOWN_KEY', message: `${where} (${key}): "${key}" isn't a scheme key; a scheme takes ${TOP_KEYS.join(', ')}. It was ignored.` });
  }

  const name = raw.name;
  if (typeof name !== 'string' || !SCHEME_NAME.test(name)) bad('name', '"name" must be lowercase letters, digits and single hyphens, starting with a letter, e.g. "ktlo-feature".');

  let revision = 1;
  if (raw.revision !== undefined) {
    if (typeof raw.revision === 'number' && Number.isInteger(raw.revision) && raw.revision > 0) revision = raw.revision;
    else bad('revision', '"revision" must be a whole number above 0.');
  }

  const categories: Category[] = [];
  if (!Array.isArray(raw.categories)) bad('categories', '"categories" must be a list of 2 to 12 categories, each { id, short, name, label, definition }.');
  else {
    const [min, max] = SCHEME_LIMITS.categories;
    if (raw.categories.length < min || raw.categories.length > max) bad('categories', `"categories" holds ${raw.categories.length}; a scheme has ${min} to ${max}.`);
    const ids = new Set<string>();
    const labels = new Map<string, string>();
    raw.categories.forEach((c: unknown, i: number) => {
      const at = `categories[${i}]`;
      if (!isRecord(c)) return bad(at, 'Each category must be an object { id, short, name, label, definition }.');
      for (const key of Object.keys(c)) if (!['id', 'short', 'name', 'label', 'definition'].includes(key)) warnings.push({ code: 'SCHEME_UNKNOWN_KEY', message: `${where} (${at}.${key}): "${key}" isn't a category key; a category takes id, short, name, label and definition. It was ignored.` });
      const id = c.id;
      if (typeof id !== 'string' || !CATEGORY_ID.test(id)) bad(`${at}.id`, '"id" must be lowercase letters, digits and single hyphens, starting with a letter.');
      else if (id === UNSURE) bad(`${at}.id`, `"${UNSURE}" is what a verdict says when nothing settled the item, so it can't be a category.`);
      else if (ids.has(id)) bad(`${at}.id`, `"${id}" is used by two categories.`);
      else ids.add(id);
      for (const [key, min, max] of [['short', 1, 24], ['name', 1, 60], ['definition', 1, 600]] as const) {
        const why = textProblem(c[key], min, max);
        if (why) bad(`${at}.${key}`, `"${key}" ${why}`);
      }
      const label = c.label;
      if (typeof label !== 'string' || !LABEL_FORM.test(label)) bad(`${at}.label`, '"label" must be 1 to 50 letters, digits, ".", "_", ":" or "-" with no space, comma or semicolon (a Jira label can\'t hold a space and Azure DevOps splits tags on ";").');
      else if (labels.has(label.toLowerCase())) bad(`${at}.label`, `"${label}" is also the label of ${labels.get(label.toLowerCase())}; labels are compared without regard to case and must differ.`);
      else labels.set(label.toLowerCase(), at);
      if (typeof id === 'string' && typeof label === 'string' && typeof c.short === 'string' && typeof c.name === 'string' && typeof c.definition === 'string') {
        categories.push({ id, short: c.short.trim(), name: c.name.trim(), label, definition: c.definition.trim() });
      }
    });
  }
  const categoryIds = new Set(categories.map((c) => c.id));

  const guidance: string[] = [];
  if (raw.guidance !== undefined) {
    if (!Array.isArray(raw.guidance)) bad('guidance', '"guidance" must be a list of sentences.');
    else {
      if (raw.guidance.length > SCHEME_LIMITS.guidance) bad('guidance', `"guidance" holds ${raw.guidance.length} sentences; the most is ${SCHEME_LIMITS.guidance}.`);
      raw.guidance.forEach((g: unknown, i: number) => {
        const why = textProblem(g, 1, SCHEME_LIMITS.guidanceText);
        if (why) bad(`guidance[${i}]`, `A sentence ${why}`);
        else guidance.push((g as string).trim());
      });
    }
  }

  const examples: SchemeExample[] = [];
  if (raw.examples !== undefined) {
    if (!Array.isArray(raw.examples)) bad('examples', '"examples" must be a list of { item, title, category, why }.');
    else {
      if (raw.examples.length > SCHEME_LIMITS.examples) bad('examples', `"examples" holds ${raw.examples.length}; the most is ${SCHEME_LIMITS.examples}.`);
      raw.examples.forEach((e: unknown, i: number) => {
        const at = `examples[${i}]`;
        if (!isRecord(e)) return bad(at, 'Each example must be an object { item, title, category, why }.');
        for (const key of Object.keys(e)) if (!['item', 'title', 'category', 'why'].includes(key)) warnings.push({ code: 'SCHEME_UNKNOWN_KEY', message: `${where} (${at}.${key}): "${key}" isn't an example key; an example takes item, title, category and why. It was ignored.` });
        let ok = true;
        for (const [key, max, required] of [['item', 200, true], ['title', 200, true], ['why', 200, false]] as const) {
          if (e[key] === undefined && !required) continue;
          const why = textProblem(e[key], 1, max);
          if (why) {
            ok = false;
            bad(`${at}.${key}`, `"${key}" ${why}`);
          }
        }
        if (typeof e.category !== 'string' || !categoryIds.has(e.category)) {
          ok = false;
          bad(`${at}.category`, `"category" must be one of the scheme's category ids${categories.length ? ` (${categories.map((c) => c.id).join(', ')})` : ''}.`);
        }
        if (ok) examples.push({ item: (e.item as string).trim(), title: (e.title as string).trim(), category: e.category as string, ...(e.why !== undefined ? { why: (e.why as string).trim() } : {}) });
      });
    }
  }

  const rules: Rule[] = [];
  if (raw.rules !== undefined) {
    if (!Array.isArray(raw.rules)) bad('rules', '"rules" must be a list of { id, when, then }.');
    else {
      if (raw.rules.length > SCHEME_LIMITS.rules) bad('rules', `"rules" holds ${raw.rules.length}; the most is ${SCHEME_LIMITS.rules}.`);
      const seen = new Set<string>();
      raw.rules.forEach((r: unknown, i: number) => {
        const at = `rules[${i}]`;
        if (!isRecord(r)) return bad(at, 'Each rule must be an object { id, when, then }.');
        for (const key of Object.keys(r)) if (!['id', 'when', 'then'].includes(key)) warnings.push({ code: 'SCHEME_UNKNOWN_KEY', message: `${where} (${at}.${key}): "${key}" isn't a rule key; a rule takes id, when and then. It was ignored.` });
        let ok = true;
        if (typeof r.id !== 'string' || !RULE_ID.test(r.id)) {
          ok = false;
          bad(`${at}.id`, '"id" must be lowercase letters, digits and single hyphens, starting with a letter, up to 41 characters.');
        } else if (seen.has(r.id)) {
          ok = false;
          bad(`${at}.id`, `"${r.id}" is used by two rules.`);
        } else seen.add(r.id);
        const when = readWhen(r.when, `${at}.when`, bad, textProblem);
        if (when === undefined) ok = false;
        if (typeof r.then !== 'string' || !categoryIds.has(r.then)) {
          ok = false;
          bad(`${at}.then`, `"then" must be one of the scheme's category ids${categories.length ? ` (${categories.map((c) => c.id).join(', ')})` : ''}.`);
        }
        if (ok && when) rules.push({ id: r.id as string, when, then: r.then as string });
      });
    }
  }

  let signals = true;
  if (raw.signals !== undefined) {
    if (typeof raw.signals === 'boolean') signals = raw.signals;
    else bad('signals', '"signals" must be true or false.');
  }

  const labels: Scheme['labels'] = {};
  if (raw.labels !== undefined) {
    if (!isRecord(raw.labels)) bad('labels', `"labels" must be an object keyed by tracker: { "ado": { "ktlo": "KTLO" } }.`);
    else {
      for (const [area, byCategory] of Object.entries(raw.labels)) {
        const at = `labels.${area}`;
        if (!(CLASSIFY_AREAS as readonly string[]).includes(area)) {
          bad(at, `"${area}" isn't a tracker a scheme labels; use ${CLASSIFY_AREAS.join(', ')}.`);
          continue;
        }
        if (!isRecord(byCategory)) {
          bad(at, `"${area}" must be an object of category id to label.`);
          continue;
        }
        const own: Record<string, string> = {};
        for (const [id, label] of Object.entries(byCategory)) {
          if (!categoryIds.has(id)) bad(`${at}.${id}`, `"${id}" isn't one of the scheme's category ids${categories.length ? ` (${categories.map((c) => c.id).join(', ')})` : ''}.`);
          else if (typeof label !== 'string' || !LABEL_FORM.test(label)) bad(`${at}.${id}`, 'A label must be 1 to 50 letters, digits, ".", "_", ":" or "-" with no space, comma or semicolon.');
          else own[id] = label;
        }
        // The labels this tracker will really use must still be told apart the way trackers tell them apart.
        const used = new Map<string, string>();
        for (const c of categories) {
          const label = own[c.id] ?? c.label;
          const clash = used.get(label.toLowerCase());
          if (clash) bad(`${at}.${c.id}`, `"${label}" is also the label of ${clash} in ${area}; labels are compared without regard to case and must differ.`);
          else used.set(label.toLowerCase(), c.id);
        }
        if (Object.keys(own).length > 0) labels[area] = own;
      }
    }
  }

  if (problems.length > 0) return fail();
  return {
    scheme: { name: name as string, revision, categories, guidance, examples, rules, signals, labels },
    warnings,
  };
}

/** The file's text: a stable key order, two-space JSON, a trailing line feed. */
export function schemeContent(scheme: Scheme): string {
  const ordered = {
    name: scheme.name,
    revision: scheme.revision,
    categories: scheme.categories.map((c) => ({ id: c.id, short: c.short, name: c.name, label: c.label, definition: c.definition })),
    guidance: scheme.guidance,
    examples: scheme.examples.map((e) => ({ item: e.item, title: e.title, category: e.category, ...(e.why !== undefined ? { why: e.why } : {}) })),
    rules: scheme.rules.map((r) => ({ id: r.id, when: r.when, then: r.then })),
    signals: scheme.signals,
    labels: scheme.labels,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface SchemeChanges {
  categories: { added: string[]; removed: string[]; changed: string[] };
  rules: { added: string[]; removed: string[]; changed: string[] };
  guidance: boolean;
  examples: boolean;
  signals: boolean;
  labels: boolean;
  /** Whether anything at all differs (the revision aside). */
  any: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function diffById<T extends { id: string }>(before: readonly T[], after: readonly T[]) {
  const was = new Map(before.map((x) => [x.id, x]));
  const now = new Map(after.map((x) => [x.id, x]));
  return {
    added: after.filter((x) => !was.has(x.id)).map((x) => x.id),
    removed: before.filter((x) => !now.has(x.id)).map((x) => x.id),
    changed: after.filter((x) => was.has(x.id) && !same(was.get(x.id), x)).map((x) => x.id),
  };
}

/** A short summary of what `scheme set` changed; the revision and the name are not part of it. */
export function diffSchemes(before: Scheme, after: Scheme): SchemeChanges {
  const categories = diffById(before.categories, after.categories);
  const rules = diffById(before.rules, after.rules);
  const out = {
    categories,
    rules,
    guidance: !same(before.guidance, after.guidance),
    examples: !same(before.examples, after.examples),
    signals: before.signals !== after.signals,
    labels: !same(before.labels, after.labels),
  };
  // A reordering changes how rules and categories read, so it counts even when no id was added, removed or edited.
  const reordered = !same(before.categories.map((c) => c.id), after.categories.map((c) => c.id)) || !same(before.rules.map((r) => r.id), after.rules.map((r) => r.id));
  const any =
    reordered ||
    [categories, rules].some((d) => d.added.length + d.removed.length + d.changed.length > 0) ||
    out.guidance || out.examples || out.signals || out.labels;
  return { ...out, any };
}
