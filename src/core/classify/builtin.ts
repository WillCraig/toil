/**
 * The schemes that ship inside toil, so a toil project with no `classify`
 * key still has somewhere to start: `ktlo-feature` (the default), `balance`
 * and `flow`. They are data, read through the same reader as a team's own
 * file (a test holds them to it), and a person who wants different words
 * copies one with `toil classify scheme init`. Every organisation's first
 * taxonomy meeting is hereby pre-adjourned.
 */
import { DEFAULT_SCHEME, type Scheme } from './types.js';

const KTLO = {
  id: 'ktlo',
  short: 'KTLO',
  name: 'Keep the lights on',
  label: 'ktlo',
  definition: 'Security patches, bug fixes, dependency upgrades, compliance updates and incident response.',
};

export const BUILTIN_SCHEMES: readonly Scheme[] = [
  {
    name: 'ktlo-feature',
    revision: 1,
    categories: [
      KTLO,
      {
        id: 'feature',
        short: 'Feature',
        name: 'Feature',
        label: 'feature',
        definition: "Proactive development that creates new user-facing functionality or expands the product's capabilities.",
      },
    ],
    guidance: ['An upgrade that exists to unlock a new user-facing capability is Feature; one that keeps the product supported is KTLO.'],
    examples: [],
    rules: [],
    signals: true,
    labels: {},
  },
  {
    name: 'balance',
    revision: 1,
    categories: [
      { id: 'new', short: 'New', name: 'New capabilities', label: 'new', definition: "Work that adds a product, feature or capability that didn't exist before." },
      {
        id: 'improve',
        short: 'Improve',
        name: 'Improvements',
        label: 'improve',
        definition: 'Work that makes something people already use better: enhancements, performance and usability beyond a fix.',
      },
      KTLO,
      {
        id: 'productivity',
        short: 'Productivity',
        name: 'Productivity',
        label: 'productivity',
        definition: 'Work that makes the team itself faster or safer: tooling, automation, build and test infrastructure, and paying down technical debt.',
      },
    ],
    guidance: [
      'A bug fix is KTLO, even when the bug is in something new; a change that makes a working feature better is Improve.',
      'Tooling, build and test work for the team is Productivity; the same work for customers is New or Improve.',
      'An upgrade that exists to unlock a new capability is New; one that keeps the product supported is KTLO.',
    ],
    examples: [],
    rules: [],
    signals: true,
    labels: {},
  },
  // Flow sorts by what the work is for (feature, defect, risk, debt) rather than whether it keeps the lights on, so
  // toil's signals, which all mean KTLO, are off and only these rules decide. Risk comes before defect: a security
  // bug is reported as risk, because that is the line the audit asks about (docs/decisions/657-ticket-rules-flow.md).
  // The debt title rule is classify's substring match, so "Upgrade" also catches "Upgraded"; a rule that read the
  // title as words would be a new matcher, and the matcher committee meets quarterly.
  {
    name: 'flow',
    revision: 1,
    categories: [
      { id: 'feature', short: 'Feature', name: 'Feature', label: 'feature', definition: 'New value for the people who use the product.' },
      { id: 'defect', short: 'Defect', name: 'Defect', label: 'defect', definition: 'A fix for something that does not work as it should.' },
      { id: 'risk', short: 'Risk', name: 'Risk', label: 'risk', definition: 'Security and compliance work that lowers the chance or cost of something going wrong.' },
      { id: 'debt', short: 'Debt', name: 'Debt', label: 'debt', definition: 'Work that makes future change cheaper: upgrades, refactoring and cleanup.' },
    ],
    guidance: [
      'A security or compliance fix is Risk, even when it is filed as a bug.',
      'A dependency upgrade that keeps the product supported is Debt; one that exists to unlock a new capability is Feature.',
    ],
    examples: [],
    rules: [
      { id: 'risk', when: { label: ['security', 'compliance'] }, then: 'risk' },
      { id: 'defect', when: { type: ['BUG'] }, then: 'defect' },
      // Many trackers file bugs as a task or an issue with a bug label (Jira team-managed projects, GitHub without issue types).
      { id: 'defect-label', when: { label: ['bug', 'defect'] }, then: 'defect' },
      { id: 'debt-title', when: { title: ['Bump', 'Upgrade'] }, then: 'debt' },
      { id: 'tech-debt', when: { label: ['tech-debt'] }, then: 'debt' },
      // Last, so a story labelled security, bug or tech-debt keeps that category; any other story is new value.
      { id: 'story', when: { type: ['STORY'] }, then: 'feature' },
    ],
    signals: false,
    labels: {},
  },
];

/** The built-in scheme called `name`, or undefined. A copy, so a caller can't change what the next call sees. */
export function builtinScheme(name: string): Scheme | undefined {
  const found = BUILTIN_SCHEMES.find((s) => s.name === name);
  return found && structuredClone(found);
}

export const BUILTIN_NAMES: readonly string[] = BUILTIN_SCHEMES.map((s) => s.name);

/** The scheme a toil project gets when it names none. */
export const defaultScheme = (): Scheme => builtinScheme(DEFAULT_SCHEME)!;
