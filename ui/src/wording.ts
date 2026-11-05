/**
 * Themed wording (#283): the microcopy a game theme may say in its own words,
 * looked up by key with the standard text as the fallback, the way an i18n
 * catalogue works with one language and four dialects. A theme's `lexicon`
 * in `theme.json` replaces any of these; a key it leaves out, Plain, and
 * "Themed wording" switched off all read the standard text below.
 *
 * Only microcopy is here: eyebrows, ledes and notes, empty states, loading
 * lines. Never a not-found notice, such as an item the toil project doesn't have,
 * which says what went wrong in plain words. Never a control's name (a button, a link, a field's label), a
 * heading a test or a screen reader finds a region by, a command, an id, a
 * number, a date, an error or its fix: those read the same in every theme,
 * so what a person, a script or voice control looks for is always there
 * (WCAG 2.5.3). A `{name}` in the text is filled in from the view, and a
 * theme's wording must keep every one, and every `toil …` command, that the
 * standard text has (test/themes.test.ts).
 * The standard wording, approved once and translated into four dialects without a vote.
 */

export const STANDARD = {
  'toilProjects.lede': 'Each Toil project is one body of work: its repositories, its tracker, its pipelines and its environments. Pick one to see its stories, pull requests, builds and deployments together.',
  'toilProject.eyebrow': 'Toil project',
  'settings.eyebrow': 'Settings',
  'attention.note': 'Open items ranked by their insights, weightiest first. Each insight names the data it rests on.',
  'aging.note': 'How long each item in progress has been in progress, from its history, oldest first.',
  'trace.note': 'Each work item with the pull requests that name it, their latest builds, and the environments running them.',
  'graph.note': "Arrows run the way each link reads, from the source's own links. Blocking chains run left to right.",
  'ask.note': 'Answers cite the items they rest on. The agent reads; it never changes a ticket. What it suggests comes back as a proposal for you to apply.',
  'empty.toilProjects': 'toil sees no Toil projects yet. A Toil project is made with toil projects init.',
  'empty.sprint': "No sprint is running in this Toil project's work items.",
  'empty.burnup': 'No sprint is running, so there is nothing to burn up.',
  'empty.column': 'Nothing here.',
  'empty.prs': 'No pull requests for this Toil project.',
  'empty.builds': "No builds for this Toil project's pull requests.",
  'empty.deployments': 'This Toil project names no environment to read deployments from.',
  'empty.links': "No links between this Toil project's items.",
  'empty.ask': 'Pick a question, or ask your own, to see how answers cite their sources.',
  'loading.toilProjects': 'Reading the Toil projects…',
  'loading.toilProject': 'Reading {name}…',
  'loading.graph': 'Drawing the graph…',
  'loading.answer': 'Thinking…',
  // The chat (#343): the Ask bar's placeholder, the focused view's welcome, and the status line's words, which a tool's name follows.
  'ask.placeholder': 'Ask about {name}',
  // On a narrow screen the bar is too short for a toil project's name, so it says what to do and leaves the name to the page.
  'ask.placeholder.short': 'Ask a question',
  'ask.welcome': 'Ask anything about {name}: its sprint, its people, what is blocked or waiting on review. Every answer cites the items it rests on.',
  'status.cache': 'Reading the cache',
  'status.live': 'Reading live through toil',
  'status.registry': "Reading a command's fields",
  'status.writing': 'Writing',
  'status.done': 'Done in {seconds} s',
  'status.stopped': 'Stopped after {seconds} s',
} as const;

export type WordKey = keyof typeof STANDARD;
export const WORD_KEYS = Object.keys(STANDARD) as WordKey[];

/** The `{name}` placeholders in a text, in order. */
export const placeholders = (text: string) => [...text.matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]!);

/** The `toil …` commands a text names, which a theme's wording keeps word for word. */
export const commandsIn = (text: string) => [...text.matchAll(/\btoil (?:projects|connections|feedback|skill|skills|setup|mcp) [a-z-]+/g)].map((m) => m[0]);

/**
 * The text for a key: the theme's own when wording is on and it has one,
 * else the standard, with each `{name}` filled from `vars`.
 */
export function wordFor(lexicon: Partial<Record<WordKey, string>> | undefined, on: boolean, key: WordKey, vars: Record<string, string> = {}): string {
  const text = (on ? lexicon?.[key] : undefined) ?? STANDARD[key];
  return text.replace(/\{([a-z]+)\}/g, (whole, name: string) => vars[name] ?? whole);
}
