/**
 * The three standards that ship inside toil: Given/When/Then acceptance
 * criteria for stories, the "As a …, I want …, so that …" story form, and a bug
 * that says how to reproduce it. They are data, read through the same reader as
 * a team's own file (a test holds them to it), and none applies until a toil
 * project or a call names it: toil never decides on a team's behalf what a good
 * ticket looks like. The template committee may now stand down.
 */
import type { Standard } from './types.js';

const BUG_REPRO_IN = ['field:Microsoft.VSTS.TCM.ReproSteps', 'description'] as const;

export const BUILTIN_STANDARDS: readonly Standard[] = [
  {
    name: 'gherkin',
    revision: 1,
    description: "A story's acceptance criteria are written as Given/When/Then scenarios.",
    rules: [
      {
        id: 'scenarios',
        name: 'Acceptance criteria as Given/When/Then',
        missing: 'no Given/When/Then criteria',
        text: 'State the acceptance criteria as scenarios: a Given line (context), a When line (action), a Then line (outcome).',
        when: { type: ['STORY'] },
        fail: 'thin',
        check: { kind: 'pattern', in: ['criteria'], match: ['^\\W*given\\b', '^\\W*when\\b', '^\\W*then\\b'], flags: 'im', labels: ['a Given line', 'a When line', 'a Then line'] },
      },
    ],
  },
  {
    name: 'user-story',
    revision: 1,
    description: 'A story says who wants it, what they want, and why.',
    rules: [
      {
        id: 'story-form',
        name: 'Written as a user story',
        missing: 'not written as a user story',
        text: 'Open the description with the story: "As a <who>, I want <what>, so that <why>".',
        when: { type: ['STORY'] },
        fail: 'thin',
        check: { kind: 'pattern', in: ['description'], match: ['\\bas an? [^,\\n]{1,80},? i want\\b[^\\n]{1,300}\\bso that\\b'], flags: 'i', labels: ['the "As a …, I want …, so that …" form'] },
      },
    ],
  },
  {
    name: 'bug-repro',
    revision: 1,
    description: 'A bug says how to reproduce it, what should happen, and what happens instead.',
    rules: [
      {
        id: 'steps',
        name: 'Steps to reproduce',
        missing: 'no steps to reproduce',
        text: 'List the steps that reproduce the bug under a "Steps to reproduce" heading.',
        when: { type: ['BUG'] },
        fail: 'thin',
        check: { kind: 'section', in: [...BUG_REPRO_IN], heading: ['Steps to reproduce', 'Repro steps', 'Steps'], minWords: 1 },
      },
      {
        id: 'expected',
        name: 'Expected result',
        missing: 'no expected result',
        text: 'Say what should happen under an "Expected" heading.',
        when: { type: ['BUG'] },
        fail: 'thin',
        check: { kind: 'section', in: [...BUG_REPRO_IN], heading: ['Expected', 'Expected result', 'Expected behavior'], minWords: 1 },
      },
      {
        id: 'actual',
        name: 'Actual result',
        missing: 'no actual result',
        text: 'Say what happens instead under an "Actual" heading.',
        when: { type: ['BUG'] },
        fail: 'thin',
        check: { kind: 'section', in: [...BUG_REPRO_IN], heading: ['Actual', 'Actual result', 'Actual behavior'], minWords: 1 },
      },
    ],
  },
];

/** The built-in standard called `name`, or undefined. A copy, so a caller can't change what the next call sees. */
export function builtinStandard(name: string): Standard | undefined {
  const found = BUILTIN_STANDARDS.find((s) => s.name === name);
  return found && structuredClone(found);
}

export const BUILTIN_STANDARD_NAMES: readonly string[] = BUILTIN_STANDARDS.map((s) => s.name);
