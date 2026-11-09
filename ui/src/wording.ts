/**
 * Wording (#283), split by what a person does with it (the maintainer's call,
 * 2026-11-05; CLAUDE.md, principle 11, and ui/docs/themes.md, Words).
 *
 * FUNCTIONAL keys are words a person reads to ACT or to find something by
 * name: an eyebrow that names the page, a field's placeholder, the status
 * line that says where a figure was read from and how long it took. They read
 * the one plain text in every theme. A theme's `lexicon` may not set one
 * (test/themes.test.ts), and `wordFor` ignores a theme's value for one, so a
 * script, a screen reader and voice control find the same name everywhere
 * (WCAG 2.5.3).
 *
 * FLAVOUR keys are words nothing depends on: a lede or an explanation under a
 * heading, an empty-state sentence, a loading or progress line. A theme's
 * `lexicon` may say these in its own voice, and the plain text is what shows
 * when a theme has none, in Plain, and with themed wording off. Flavour never
 * replaces a number, a command, an id, an error or its fix: a `{name}` and
 * every `toil ...` command in the plain text stays in the theme's text.
 *
 * To add a key, put it in `FUNCTIONAL` or in `FLAVOUR` below, whichever it is,
 * and add it to the lists in test/words-classification.test.ts, which exist
 * so that nobody decides by accident. A flavour key then gets a line in every
 * theme's `lexicon`. A not-found notice, a control's name, a command, a
 * number, a date and an error with its fix are never keys at all: they are
 * written where they are drawn, in plain words.
 *
 * The plain text is the one a person reads by default: everyday words, with
 * toil's own term one hover away (src/plain-words.ts). The standard wording,
 * filed in two folders so that the dialects can be audited separately.
 */

/** Words a person acts on or finds by name: one plain text, in every theme. */
export const FUNCTIONAL = {
  'toilProject.eyebrow': 'Toil project',
  'settings.eyebrow': 'Settings',
  // The chat (#343): the Ask bar's placeholder, and the status line's words, which a tool's name follows. Where a figure was read from is a fact (principle 4).
  'ask.placeholder': 'Ask a question about {name}',
  // On a narrow screen the bar is too short for a toil project's name, so it says what to do and leaves the name to the page.
  'ask.placeholder.short': 'Ask a question',
  'status.cache': 'Reading saved data',
  'status.live': 'Reading live from your tools',
  'status.registry': 'Reading what a tool can answer',
  'status.done': 'Done in {seconds} s',
  'status.stopped': 'Stopped after {seconds} s',
} as const;

/** Words nothing depends on: a theme may say these its own way. */
export const FLAVOUR = {
  'toilProjects.lede': 'Pick a Toil project to see its stories, code reviews and releases together.',
  'attention.note': 'Open items ranked by their insights, weightiest first. Each insight names the data it rests on.',
  'aging.note': 'How long each item in progress has been in progress, from its history, oldest first.',
  'trace.note': 'Each work item with the code reviews that name it, their latest builds, and the environments running them.',
  'graph.note': "Arrows run the way each link reads, from the source's own links. Blocking chains run left to right.",
  'ask.note': 'Every answer says which items it comes from. The AI agent only reads: it never changes a ticket. Anything it suggests comes back for you to approve.',
  'ask.welcome': 'Ask anything about {name}: its sprint, its people, what is stuck or waiting on a review. Every answer says which items it comes from.',
  'empty.toilProjects': 'toil sees no Toil projects yet.',
  'empty.sprint': "No sprint is running in this Toil project's work items.",
  'empty.burnup': 'No sprint is running, so there is nothing to burn up.',
  'empty.column': 'Nothing here.',
  'empty.prs': 'No code reviews for this Toil project.',
  'empty.builds': "No builds for this Toil project's code reviews.",
  'empty.deployments': 'This Toil project names no environment to read deployments from.',
  'empty.links': "No links between this Toil project's items.",
  'empty.ask': 'Pick a question, or ask your own, to see how answers cite their sources.',
  'empty.briefings': 'No briefing kept for this Toil project yet.',
  'loading.toilProjects': 'Reading your Toil projects…',
  'loading.toilProject': 'Reading {name}…',
  'loading.graph': 'Drawing the graph…',
  'loading.answer': 'Thinking…',
  'loading.briefings': 'Reading the briefings…',
  'loading.briefing': 'Writing the briefing…',
  'loading.analysis': 'Reading the analysis…',
  'loading.card': 'Reading the latest update…',
  'loading.agents': 'Reading the AI agents…',
  'loading.audit': 'Reading the audit log…',
  'note.unchanged': 'Nothing changed since you last looked.',
  'status.writing': 'Writing the answer',
} as const;

export const STANDARD = { ...FUNCTIONAL, ...FLAVOUR } as const;

export type WordKey = keyof typeof STANDARD;
export type FlavourKey = keyof typeof FLAVOUR;
export const WORD_KEYS = Object.keys(STANDARD) as WordKey[];
export const FLAVOUR_KEYS = Object.keys(FLAVOUR) as FlavourKey[];
export const FUNCTIONAL_KEYS = Object.keys(FUNCTIONAL) as Exclude<WordKey, FlavourKey>[];

/** Whether a key is functional: read to act, so one plain text in every theme. */
export const isFunctional = (key: WordKey): boolean => key in FUNCTIONAL;

/** The `{name}` placeholders in a text, in order. */
export const placeholders = (text: string) => [...text.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!);

/** The `toil …` commands a text names, which a theme's wording keeps word for word. */
export const commandsIn = (text: string) => [...text.matchAll(/\btoil (?:projects|connections|feedback|skill|skills|setup|mcp) [a-z-]+/g)].map((m) => m[0]);

/**
 * The text for a key: for a flavour key, the theme's own when wording is on and
 * it has one; else the plain text. A functional key is always the plain text,
 * whatever a theme says. Each `{name}` is filled from `vars`.
 */
export function wordFor(lexicon: Partial<Record<WordKey, string>> | undefined, on: boolean, key: WordKey, vars: Record<string, string> = {}): string {
  const text = (on && !isFunctional(key) ? lexicon?.[key] : undefined) ?? STANDARD[key];
  return text.replace(/\{([a-z]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
