/**
 * Checking work items against standards: items and rules in, one result per
 * rule that applies to each item out. Pure data in and data out, no files, no
 * network and no config, so `toil standards check` is exactly as safe as its
 * inputs, Toil UI can run it in the page on items it already holds, and a test
 * can run it with the wifi off. Every result says where its text was read from,
 * and a place the record doesn't carry is `skipped`, "not read", never taken
 * for an empty one (principle 12): a field the read never asked for says
 * nothing about the ticket. The rules are the team's; toil only reads them out
 * loud, which is more than most templates get.
 */
import type { Warning } from '../envelope.js';
import { matchWhen } from '../classify/when.js';
import type { WorkItem } from '../owi/types.js';
import { BODY_SCAN_LIMIT, CRITERIA_HEADINGS, realText, sectionUnder, textOf, wordCount } from './text.js';
import type { FoundStandard, ItemStandards, ItemVerdict, Place, RuleCheck, RuleResult, RuleState, RuleTally, StandardRule, StandardsCheckResult, StandardSummary } from './types.js';

/** Azure DevOps' own acceptance criteria field, on every process that has one. */
export const ADO_ACCEPTANCE_FIELD = 'Microsoft.VSTS.Common.AcceptanceCriteria';

export interface CheckInput {
  standards: FoundStandard[];
  items: WorkItem[];
  toilProject?: string | null;
  /**
   * The toil project's field aliases, by area then alias: `{ jira: { acceptanceCriteria: 'customfield_10300' } }`.
   * A `field:<alias>` place reads the field the alias names, and `criteria` reads `acceptanceCriteria` first.
   */
  fields?: Record<string, Record<string, string>>;
}

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A place as a person would name it: `label` (`acceptance criteria`, `description`, a field's
 * alias or id) is what a reason says, a field read as "the <label> field". `at` is where it
 * really lives (`field customfield_10500`, `description`), kept in `source` because a fix has
 * to write somewhere more precise than "the acceptance criteria".
 */
interface Named {
  label: string;
  field: boolean;
  at?: string;
}

/** One place's text, or null when the record read doesn't carry it, with the places it was read from. */
interface Read {
  text: string | null;
  names: Named[];
}

/**
 * Tracker fields every team of that tracker has, by the words its own screens use, so a reason says "the repro steps"
 * and not the reference name. The id stays in `source`. Naming a field after its label is the one meeting this module skipped.
 */
const KNOWN_FIELDS: Record<string, string> = {
  'Microsoft.VSTS.TCM.ReproSteps': 'repro steps',
  'Microsoft.VSTS.Common.AcceptanceCriteria': 'acceptance criteria',
  'System.Description': 'description',
};
const TITLE: Named = { label: 'title', field: false };
const DESCRIPTION: Named = { label: 'description', field: false };
const CRITERIA: Named = { label: 'acceptance criteria', field: false };

/**
 * A field in the item's source records: `fields[<id>]`, as Jira and Azure DevOps
 * both send it, else a key at the top (GitHub's `body`). A key that is there with
 * no value is read and empty; a key that isn't there was never read.
 */
function nativeField(item: WorkItem, id: string): { read: true; value: unknown } | { read: false } {
  const wanted = id.toLowerCase();
  for (const rec of Object.values(isRec(item.native) ? item.native : {})) {
    if (!isRec(rec)) continue;
    const fields = isRec(rec.fields) ? rec.fields : rec;
    for (const [k, v] of Object.entries(fields)) if (k.toLowerCase() === wanted) return { read: true, value: v };
  }
  return { read: false };
}

const hasWords = (text: string) => wordCount(realText(text)) > 0;

/** Each place once, in the order first met. */
function unique(names: Named[]): Named[] {
  const seen = new Set<string>();
  return names.filter((n) => !seen.has(sourceOf(n)) && (seen.add(sourceOf(n)), true));
}

/** A place in `source`: its plain name, then where it lives when that says more ("acceptance criteria (field customfield_10500)"); a field with no alias is just "field <id>". */
const sourceOf = (n: Named) => (!n.at ? n.label : n.at === `field ${n.label}` ? n.at : `${n.label} (${n.at})`);

function readers(item: WorkItem, fields: Record<string, string>) {
  /** A record without a `body` key never had its description read; `body: null` is a description read and found empty. */
  const description = (): Read => {
    const body = (item as { body?: WorkItem['body'] }).body;
    if (body === undefined) return { text: null, names: [DESCRIPTION] };
    return { text: body ? textOf(body.content, body.format) : '', names: [DESCRIPTION] };
  };
  /** A field by the toil project's alias or its own id, named by whichever the place gave: the alias is the team's word for it. */
  const field = (name: string, label = KNOWN_FIELDS[name] ?? name): Read => {
    const id = fields[name] ?? name;
    const found = nativeField(item, id);
    return { text: found.read ? textOf(found.value) : null, names: [{ label, field: label === name, at: `field ${id}` }] };
  };
  /** The acceptance criteria: the first of these that holds any words, else what was read of them, empty. */
  const criteria = (): Read => {
    const tried: Read[] = [];
    const named = fields.acceptanceCriteria;
    const candidates: Array<() => Read> = [];
    if (named) candidates.push(() => field('acceptanceCriteria', CRITERIA.label));
    if (item.source.area.startsWith('ado') && named !== ADO_ACCEPTANCE_FIELD) candidates.push(() => field(ADO_ACCEPTANCE_FIELD, CRITERIA.label));
    for (const next of candidates) {
      const r = next();
      if (r.text !== null && hasWords(r.text)) return r;
      tried.push(r);
    }
    const desc = description();
    if (desc.text !== null) {
      const section = sectionUnder(desc.text, CRITERIA_HEADINGS);
      if (section && hasWords(section.text)) return { text: section.text, names: [{ ...CRITERIA, at: 'in the description' }] };
      // The whole description stands in; a criteria field read and found empty is still named, since it was looked at.
      if (hasWords(desc.text)) return { text: desc.text, names: unique([...tried.filter((r) => r.text !== null).flatMap((r) => r.names), DESCRIPTION]) };
    }
    tried.push(desc);
    const read = tried.filter((r) => r.text !== null);
    if (read.length === 0) return { text: null, names: unique(tried.flatMap((r) => r.names)) };
    return { text: '', names: unique(read.flatMap((r) => r.names)) };
  };
  return (place: Place): Read => {
    if (place === 'title') return { text: item.title, names: [TITLE] };
    if (place === 'description') return description();
    if (place === 'criteria') return criteria();
    return field(place.slice('field:'.length));
  };
}

const list = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const either = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const labelsOf = (names: Named[]) => names.map(sourceOf).join(', ');
/** "the acceptance criteria or description": one article for the lot, a field said as "the risk field". */
const where = (names: Named[], join: (xs: string[]) => string) => `the ${join([...new Set(names.map((n) => (n.field ? `${n.label} field` : n.label)))])}`;

const ARTICLE = /^(?:a|an|the)\s+/i;
const pluralOf = (w: string) => (/[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : /(?:s|x|z|ch|sh)$/i.test(w) ? `${w}es` : `${w}s`);

/**
 * Labels said together: "a Given line", "a When line", "a Then line" share their last word,
 * so they read "Given, When or Then line" (or "lines" for a pass); labels that don't share
 * one are listed whole. Grammar by committee, but a shorter committee.
 */
function together(labels: string[], join: (xs: string[]) => string, many: boolean): string {
  const bare = labels.map((l) => l.replace(ARTICLE, ''));
  const split = bare.map((b) => /^(.+)\s(\S+)$/.exec(b));
  const last = split[0]?.[2];
  if (labels.length > 1 && last && split.every((m) => m && m[2] === last)) return `${join(split.map((m) => m![1]!))} ${many ? pluralOf(last) : last}`;
  return many ? join(labels) : join(bare);
}

/** Whether the joined text meets the check, and why, in plain words. `names` are the places the text was read from. */
function judge(check: RuleCheck, text: string, names: Named[], compiled: RegExp[]): { ok: boolean; reason: string } {
  const inAll = where(names, list);
  const inAny = where(names, either);
  switch (check.kind) {
    case 'pattern': {
      const missing = check.match.map((_, i) => i).filter((i) => !compiled[i]!.test(text));
      const labels = check.labels;
      if (labels) {
        if (missing.length === 0) return { ok: true, reason: `Has ${together(labels, list, true)}.` };
        if (missing.length === labels.length) return { ok: false, reason: `No ${together(labels, either, false)} in ${inAny}.` };
        return { ok: false, reason: `Missing ${list(missing.map((i) => labels[i]!))} in ${inAny}.` };
      }
      // A team's own pattern with no label: the regular expression is the only name it has.
      if (missing.length === 0) return { ok: true, reason: `${check.match.length === 1 ? 'The pattern was' : `All ${check.match.length} patterns were`} found in ${inAll}.` };
      const what = check.match.length === 1 ? "The pattern wasn't" : missing.length === check.match.length ? `None of the ${check.match.length} patterns was` : `${missing.length} of the ${check.match.length} patterns weren't`;
      return { ok: false, reason: `${what} found in ${inAny}; missing: ${missing.map((i) => `/${check.match[i]}/`).join(', ')}.` };
    }
    case 'section': {
      const found = sectionUnder(text, check.heading);
      if (!found) return { ok: false, reason: `No "${check.heading[0]}" section in ${inAny}.` };
      const words = wordCount(realText(found.text));
      if (words < check.minWords) return { ok: false, reason: words === 0 ? `The "${found.heading}" section is empty.` : `The "${found.heading}" section has ${plural(words, 'word')}; the rule asks for at least ${check.minWords}.` };
      return { ok: true, reason: check.minWords > 1 ? `Has a "${found.heading}" section of ${plural(words, 'word')}.` : `Has a "${found.heading}" section.` };
    }
    case 'field': {
      const words = wordCount(realText(text));
      const one = names.length === 1;
      if (words > 0) return { ok: true, reason: `${capital(inAll)} ${one ? 'holds' : 'hold'} ${plural(words, 'word')}.` };
      return { ok: false, reason: text.trim() === '' ? `${capital(inAll)} ${one ? 'is' : 'are'} empty.` : `${capital(inAll)} ${one ? 'holds' : 'hold'} only placeholder text.` };
    }
    case 'words': {
      const words = wordCount(realText(text));
      if (words >= check.min) return { ok: true, reason: `${plural(words, 'word')} in ${inAll}.` };
      return { ok: false, reason: `${plural(words, 'word')} in ${inAll}; the rule asks for at least ${check.min}.` };
    }
    case 'judge':
      return { ok: false, reason: '' };
  }
}

const ORDER: Record<Exclude<RuleState, 'skipped'>, number> = { fail: 0, thin: 1, pass: 2 };

/** Checks every item against every rule of every standard, in the order given. */
export function checkStandards(input: CheckInput): { result: StandardsCheckResult; warnings: Warning[] } {
  const warnings: Warning[] = [];
  const fieldsByArea = input.fields ?? {};

  // One result per item: the first of a repeated id stands.
  const items: WorkItem[] = [];
  const byId = new Map<string, WorkItem>();
  const repeated = new Set<string>();
  for (const item of input.items) {
    if (byId.has(item.id)) repeated.add(item.id);
    else {
      byId.set(item.id, item);
      items.push(item);
    }
  }
  if (repeated.size > 0) {
    warnings.push({ code: 'STANDARDS_DUPLICATE_ITEM', message: `${plural(repeated.size, 'item appears', 'items appear')} more than once in the input and ${repeated.size === 1 ? 'was' : 'were'} checked once, the first time: ${[...repeated].slice(0, 3).join(', ')}${repeated.size > 3 ? ', ...' : ''}.` });
  }

  // One standard per name: the first given stands.
  const standards: FoundStandard[] = [];
  const names = new Set<string>();
  for (const s of input.standards) {
    if (names.has(s.standard.name)) {
      warnings.push({ code: 'STANDARDS_DUPLICATE', message: `The standard "${s.standard.name}" was given more than once and is checked once, from the first: ${s.file ?? s.source}.` });
      continue;
    }
    names.add(s.standard.name);
    standards.push(s);
  }

  // Compiled once per rule; the reader already proved each compiles and is safe to run.
  const compiled = new Map<StandardRule, RegExp[]>();
  for (const s of standards) for (const r of s.standard.rules) compiled.set(r, r.check.kind === 'pattern' ? r.check.match.map((m) => new RegExp(m, r.check.kind === 'pattern' ? r.check.flags : '')) : []);

  const tallies = new Map<string, RuleTally & { typeSet: Set<string> }>();
  for (const s of standards) for (const r of s.standard.rules) tallies.set(`${s.standard.name}/${r.id}`, { standard: s.standard.name, rule: r.id, name: r.name, types: [], typeSet: new Set(), applies: 0, pass: 0, thin: 0, fail: 0, skipped: 0 });

  const out: ItemStandards[] = items.map((item) => {
    const read = readers(item, fieldsByArea[item.source.area] ?? {});
    const results: RuleResult[] = [];
    for (const s of standards) {
      for (const rule of s.standard.rules) {
        if (rule.when && matchWhen(rule.when, item, byId) === null) continue;
        const base = { standard: s.standard.name, rule: rule.id, name: rule.name };
        const reads = rule.check.in.map(read);
        const got = reads.filter((r): r is { text: string; names: Named[] } => r.text !== null);
        const gotNames = unique(got.flatMap((r) => r.names));
        const unread = unique(reads.filter((r) => r.text === null).flatMap((r) => r.names));
        let result: RuleResult;
        if (rule.check.kind === 'judge') {
          result = { ...base, state: 'skipped', reason: 'Needs an AI agent to judge; toil never passes this rule on its own.', source: labelsOf(unique(reads.flatMap((r) => r.names))) };
        } else if (got.length === 0) {
          result = { ...base, state: 'skipped', reason: `Not read: ${where(unread, list)} ${unread.length === 1 ? "isn't" : "aren't"} in the record read, so this wasn't checked.`, source: `not read: ${labelsOf(unread)}` };
        } else {
          // A place that wasn't read stays in `source`; the sentence speaks only of what was, which is the reading behind its claim.
          // The joined places are capped like one place: a pattern accepted as quadratic stays near its 20,000-character cost, and
          // matching is synchronous, so neither the time limit nor Toil UI's event loop could interrupt a longer run.
          const verdict = judge(rule.check, got.map((r) => r.text).join('\n').slice(0, BODY_SCAN_LIMIT), gotNames, compiled.get(rule)!);
          result = {
            ...base,
            state: verdict.ok ? 'pass' : rule.fail,
            reason: verdict.reason,
            source: `${labelsOf(gotNames)}${unread.length > 0 ? `; not read: ${labelsOf(unread)}` : ''}`,
          };
        }
        results.push(result);
        const t = tallies.get(`${s.standard.name}/${rule.id}`)!;
        t.applies++;
        t[result.state]++;
        t.typeSet.add(item.type);
      }
    }
    const checked = results.filter((r): r is RuleResult & { state: Exclude<RuleState, 'skipped'> } => r.state !== 'skipped');
    const verdict: ItemVerdict = checked.length === 0 ? null : checked.reduce((worst, r) => (ORDER[r.state] < ORDER[worst] ? r.state : worst), 'pass' as Exclude<RuleState, 'skipped'>);
    return { id: item.id, key: item.source.key, area: item.source.area, title: item.title, url: item.url ?? null, verdict, results };
  });

  const summaries: StandardSummary[] = standards.map((s) => ({
    name: s.standard.name,
    revision: s.standard.revision,
    source: s.source,
    ...(s.file ? { file: s.file } : {}),
    rules: s.standard.rules.map((r) => ({ id: r.id, name: r.name, ...(r.missing ? { missing: r.missing } : {}), text: r.text, when: r.when ?? null, fail: r.fail, kind: r.check.kind })),
  }));

  return {
    result: {
      toilProject: input.toilProject ?? null,
      standards: summaries,
      items: out,
      summary: {
        items: out.length,
        checked: out.filter((i) => i.verdict !== null).length,
        byRule: [...tallies.values()].map(({ typeSet, ...t }) => ({ ...t, types: [...typeSet].sort() })),
      },
    },
    warnings,
  };
}
