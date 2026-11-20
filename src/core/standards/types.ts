/**
 * Ticket rules, called standards in files and commands: the shapes a team's
 * rules for writing a work item take, and the shape `toil standards check`
 * returns. A standard is one JSON file holding one set of rules ("stories state
 * acceptance criteria as Given/When/Then", "a bug says how to reproduce it").
 * Everything here is data: no secret, host, connection or `writes` ever lives in
 * a standard or a result, so a checked-in one can't make toil talk to anything.
 * Toil UI reads these types to draw its readiness rows, which is why they are
 * kept apart from the code that fills them. The rules describe a well-written
 * ticket; nobody has yet proposed a rule for a well-read one.
 */
import type { RuleWhen } from '../classify/types.js';

export type { RuleWhen } from '../classify/types.js';

/** A standard's name is its file name (`<name>.json`), so it is held to one safe form. */
export const STANDARD_NAME = /^[a-z][a-z0-9-]{0,62}$/;
/** A rule's id within its standard: what a result and `?rule=<standard>/<rule>` name. */
export const STANDARD_RULE_ID = /^[a-z][a-z0-9-]{0,40}$/;

/**
 * Where a rule looks, its text joined in the order given:
 * - `title`: the item's title;
 * - `description`: its body, as plain lines;
 * - `criteria`: the acceptance criteria: the toil project's
 *   `<area>.fields.acceptanceCriteria` field, then Azure DevOps'
 *   `Microsoft.VSTS.Common.AcceptanceCriteria`, then the description's
 *   "Acceptance criteria" section, then the whole description;
 * - `field:<alias|id>`: one field from the item's source record, by the toil
 *   project's alias for it or its own id.
 */
export type Place = 'title' | 'description' | 'criteria' | `field:${string}`;

/**
 * What a rule checks. `judge` is reserved for an AI agent's reading: toil accepts it and never passes it.
 * A pattern's `labels`, when given, name each of `match` in plain words ("a Given line"), in the same
 * order, so a reason says what is missing instead of quoting a regular expression.
 */
export type RuleCheck =
  | { kind: 'pattern'; in: Place[]; match: string[]; flags: string; labels?: string[] }
  | { kind: 'section'; in: Place[]; heading: string[]; minWords: number }
  | { kind: 'field'; in: Place[] }
  | { kind: 'words'; in: Place[]; min: number }
  | { kind: 'judge'; in: Place[] };
export type CheckKind = RuleCheck['kind'];
export const CHECK_KINDS: readonly CheckKind[] = ['pattern', 'section', 'field', 'words', 'judge'];

/** What a rule that doesn't hold makes of the item: `thin` (needs work) or `fail` (not ready). */
export type FailAs = 'thin' | 'fail';

export interface StandardRule {
  id: string;
  /** A few plain words a screen shows ("Acceptance criteria as Given/When/Then"). */
  name: string;
  /** What an item that misses it lacks, as a short noun phrase a count can lead into ("no Given/When/Then criteria"); absent when the file gives none. */
  missing?: string;
  /** One line saying what the rule asks for, which an AI agent is told when asked to fix an item. */
  text: string;
  /** Which items it applies to; absent applies to every item. */
  when?: RuleWhen;
  fail: FailAs;
  check: RuleCheck;
}

export interface Standard {
  name: string;
  revision: number;
  /** One line about the standard; absent when the file gives none. */
  description?: string;
  rules: StandardRule[];
}

/** Where a standard was found: a file the call named, your folder, the repository, beside the toil project, built in. */
export type StandardSource = 'file' | 'user' | 'repo' | 'toil-project' | 'built-in';

/** A standard as resolved: where it came from, and its file when it has one. */
export interface FoundStandard {
  standard: Standard;
  source: StandardSource;
  /** Absolute, with forward slashes. Absent for a built-in. */
  file?: string;
}

/** A standard's rule as a result lists it: everything but how it is checked in detail. */
export interface RuleSummary {
  id: string;
  name: string;
  /** Absent when the rule names none. */
  missing?: string;
  text: string;
  /** Null when the rule applies to every item. */
  when: RuleWhen | null;
  fail: FailAs;
  kind: CheckKind;
}

export interface StandardSummary {
  name: string;
  revision: number;
  source: StandardSource;
  file?: string;
  rules: RuleSummary[];
}

/**
 * One rule's outcome on one item. `skipped` is neither a pass nor a miss: the
 * text the rule reads wasn't in the record read ("not read"), or it needs an AI
 * agent (`judge`). An unread field is never taken for an empty one.
 */
export type RuleState = 'pass' | 'thin' | 'fail' | 'skipped';

export interface RuleResult {
  standard: string;
  rule: string;
  name: string;
  state: RuleState;
  /** Why, in plain words. */
  reason: string;
  /**
   * Where the text was read from, in plain words (`acceptance criteria`, `description`, a field's alias
   * or id), comma-separated, then `; not read: ` and what wasn't; or only `not read: ...` when nothing was.
   */
  source: string;
}

/** An item's verdict: the worst state of the rules that could be checked. Null when no rule applies, or every one that does was skipped. */
export type ItemVerdict = 'pass' | 'thin' | 'fail' | null;

export interface ItemStandards {
  id: string;
  key: string;
  area: string;
  title: string;
  url: string | null;
  verdict: ItemVerdict;
  /** One per rule that applies to the item, in standard and rule order. */
  results: RuleResult[];
}

export interface RuleTally {
  standard: string;
  rule: string;
  name: string;
  /** The OWI types of the items the rule applied to, sorted. */
  types: string[];
  /** How many items it applied to; the four states below add up to it. */
  applies: number;
  pass: number;
  thin: number;
  fail: number;
  skipped: number;
}

export interface StandardsCheckResult {
  toilProject: string | null;
  standards: StandardSummary[];
  items: ItemStandards[];
  summary: {
    items: number;
    /** Items with a verdict: at least one rule applied and could be checked. */
    checked: number;
    byRule: RuleTally[];
  };
}

/** What a toil project says about standards: the ones its work is held to, in order. */
export interface StandardsSettings {
  use: string[];
}
